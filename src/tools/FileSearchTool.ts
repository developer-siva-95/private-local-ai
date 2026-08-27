import { readdir, readFile, lstat  } from "node:fs/promises";
import path from "node:path";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolInputSchema,
} from "./Tool.js";
import { withTimeout } from "./ToolTimeout.js";

import { Permission } from "../permissions/Permission.js";

/*
 * Folders that are always excluded from search.
 *
 * These folders contain auto-generated or
 * third-party code that the agent should
 * never need to search through.
 *
 * node_modules — millions of dependency files
 * .git         — git internal data, not source code
 * dist         — compiled output, not source code
 * logs         — audit logs, not source code
 * .cache       — build cache files
 */
const EXCLUDED_FOLDERS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-ext",
  "logs",
  ".cache",
  "coverage",
  ".nyc_output",
]);

/*
 * Maximum number of matches to return.
 *
 * Prevents overwhelming the LLM context window
 * with too many results. The agent can narrow
 * the search if there are too many matches.
 */
const MAX_MATCHES = 50;

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  lineContent: string;
}

export class FileSearchTool implements Tool {
  readonly name = "search_files";

  readonly description =
    "Search for text across all files in a " +
    "directory within the authorized workspace. " +
    "Returns matching lines with file paths and " +
    "line numbers. " +
    "Use this to find where a function, variable, " +
    "or pattern is defined or used across the " +
    "project. " +
    "Search is case-insensitive by default. " +
    "Automatically skips node_modules, .git, " +
    "dist, and logs folders.";

  readonly permission = Permission.READ_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      term: {
        type: "string",
        description:
          "The text to search for. " +
          "Search is case-insensitive.",
      },
      path: {
        type: "string",
        description:
          "Directory to search in, relative " +
          "to workspace root. " +
          "Use '.' to search the entire project.",
      },
    },
    required: ["term", "path"],
  };

  readonly retryable = true;

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const searchTerm = input.term;
    const dirPath = input.path;

    /*
     * Validate search term.
     */
    if (
      typeof searchTerm !== "string" ||
      searchTerm.trim() === ""
    ) {
      return {
        success: false,
        output: "",
        error:
          "A valid search term is required.",
      };
    }

    /*
     * Validate directory path.
     */
    if (
      typeof dirPath !== "string" ||
      dirPath.trim() === ""
    ) {
      return {
        success: false,
        output: "",
        error:
          "A valid directory path is required.",
      };
    }

    const resolvedPath = path.resolve(
      context.workspaceRoot,
      dirPath,
    );

    /*
     * Defence in depth: verify the resolved
     * path is inside the workspace root.
     */
    const relativePath = path.relative(
      context.workspaceRoot,
      resolvedPath,
    );

    const isInside =
      relativePath === "" ||
      (
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
      );

    if (!isInside) {
      return {
        success: false,
        output: "",
        error:
          "Security violation: " +
          "Path is outside the workspace.",
      };
    }

    try {
      const matches = await withTimeout(
        this.searchDirectory(
          resolvedPath,
          context.workspaceRoot,
          searchTerm.trim(),
        ),
        30_000,
        this.name,
      );

      if (matches.length === 0) {
        return {
          success: true,
          output:
            `No matches found for "${searchTerm}" ` +
            `in ${dirPath === "." ? "project" : dirPath}.`,
        };
      }

      const truncated =
        matches.length > MAX_MATCHES;

      const displayMatches = truncated
        ? matches.slice(0, MAX_MATCHES)
        : matches;

      const lines = displayMatches.map(
        (match) =>
          `${match.filePath}:${match.lineNumber}: ${match.lineContent}`,
      );

      if (truncated) {
        lines.push(
          `\n... and ${matches.length - MAX_MATCHES} more matches.` +
          ` Narrow your search term to see fewer results.`,
        );
      }

      return {
        success: true,
        output: lines.join("\n"),
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error:
          error instanceof Error
            ? error.message
            : "Search failed.",
      };
    }
  }

  private async searchDirectory(
    absolutePath: string,
    workspaceRoot: string,
    searchTerm: string,
  ): Promise<SearchMatch[]> {
    const matches: SearchMatch[] = [];

    let items: string[];

    try {
      items = await readdir(absolutePath);
    } catch {
      /*
       * Cannot read directory — skip it.
       */
      return matches;
    }

    const sorted = items.sort();

    for (const item of sorted) {
      /*
       * Skip excluded folders immediately.
       * Do not even stat them.
       */
      if (EXCLUDED_FOLDERS.has(item)) {
        continue;
      }

      const itemAbsolutePath = path.join(
        absolutePath,
        item,
      );

      const itemRelativePath = path.relative(
        workspaceRoot,
        itemAbsolutePath,
      );

      let itemStat;

      try {
        itemStat = await lstat (itemAbsolutePath);
      } catch {
        /*
         * Cannot stat — skip this entry.
         * Broken symlinks, permission errors etc.
         */
        continue;
      }

      if (itemStat.isDirectory()) {
        /*
         * Recurse into subdirectories.
         */
        const subMatches =
          await this.searchDirectory(
            itemAbsolutePath,
            workspaceRoot,
            searchTerm,
          );

        matches.push(...subMatches);
      } else if (itemStat.isFile()) {
        /*
         * Search this file.
         */
        const fileMatches =
          await this.searchFile(
            itemAbsolutePath,
            itemRelativePath,
            searchTerm,
          );

        matches.push(...fileMatches);
      }

      /*
       * Stop early if we have found enough
       * matches to fill the display limit.
       * No need to search further files.
       *
       * We use 2x the limit so we can
       * accurately report "X more matches"
       * without searching the entire project.
       */
      if (matches.length >= MAX_MATCHES * 2) {
        break;
      }
    }

    return matches;
  }

  private async searchFile(
    absolutePath: string,
    relativePath: string,
    searchTerm: string,
  ): Promise<SearchMatch[]> {
    const matches: SearchMatch[] = [];

    let content: string;

    try {
      content = await readFile(
        absolutePath,
        "utf8",
      );
    } catch {
      /*
       * Cannot read file — skip it.
       * Binary files, permission errors etc.
       * Search continues with other files.
       */
      return matches;
    }

    /*
     * Detect binary files by checking for
     * null bytes in the first 512 bytes.
     *
     * Binary files are not source code and
     * searching them produces garbage output.
     */
    if (this.isBinary(content)) {
      return matches;
    }

    const lines = content.split("\n");

    /*
     * Escape special regex characters in the
     * search term so the user can safely search
     * for literal strings like "tool.execute()"
     * without regex injection.
     */
    const escapedTerm = searchTerm.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

    const pattern = new RegExp(
      escapedTerm,
      "i", // case insensitive
    );

    for (
      let i = 0;
      i < lines.length;
      i++
    ) {
      const line = lines[i];

      if (line === undefined) {
        continue;
      }

      if (pattern.test(line)) {
        matches.push({
          filePath: relativePath,
          lineNumber: i + 1,
          lineContent: line.trim(),
        });
      }
    }

    return matches;
  }

  /*
   * Detect binary files by looking for
   * null bytes (\x00) in the content.
   *
   * This is a fast, reliable heuristic used
   * by git and many other tools.
   *
   * Only checks the first 512 bytes for speed.
   */
  private isBinary(content: string): boolean {
    const checkLength = Math.min(
      content.length,
      512,
    );

    for (let i = 0; i < checkLength; i++) {
      if (content.charCodeAt(i) === 0) {
        return true;
      }
    }

    return false;
  }
}