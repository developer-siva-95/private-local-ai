import { readdir, lstat  } from "node:fs/promises";
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

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes?: number;
  path: string;
}

export class DirectoryListTool implements Tool {
  readonly name = "list_directory";

  readonly description =
    "List the files and folders inside a " +
    "directory within the authorized workspace. " +
    "Lists recursively by default to show all " +
    "files and their sizes. " +
    "Use '.' to list the project root. " +
    "Pass recursive: 'false' for shallow listing.";

  readonly permission = Permission.READ_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path of the directory to list, " +
          "relative to workspace root. " +
          "Use '.' for the project root.",
      },
      recursive: {
        type: "string",
        description:
          "Pass 'false' for shallow listing. " +
          "Default is 'true' — lists all files " +
          "recursively including subdirectories.",
      },
    },
    required: ["path"],
  };

  readonly retryable = true;

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const dirPath = input.path;

    /*
     * Default to recursive = true.
     * Only explicitly passing "false" disables it.
     */
    const recursive =
      input.recursive !== "false" &&
      input.recursive !== false;

    if (
      typeof dirPath !== "string" ||
      dirPath.trim() === ""
    ) {
      return {
        success: false,
        output: "",
        error: "A valid directory path is required.",
      };
    }

    const resolvedPath = path.resolve(
      context.workspaceRoot,
      dirPath,
    );

    /*
     * Defence in depth: verify resolved path
     * is inside workspace root.
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
      const entries = await withTimeout(
        this.listDirectory(resolvedPath, context.workspaceRoot, recursive, 0),
        15_000,
        this.name,
      );

      if (entries.length === 0) {
        return {
          success: true,
          output: "Directory is empty.",
        };
      }

      const lines = entries.map((entry) => {
        const typeLabel =
          entry.type === "directory"
            ? "[DIR] "
            : "[FILE]";

        const sizeLabel =
          entry.type === "file" &&
          entry.sizeBytes !== undefined
            ? ` (${this.formatSize(
                entry.sizeBytes,
              )})`
            : "";

        return (
          `${typeLabel} ${entry.path}${sizeLabel}`
        );
      });

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
            : "Failed to list directory.",
      };
    }
  }

  private async listDirectory(
    absolutePath: string,
    workspaceRoot: string,
    recursive: boolean,
    depth: number,
  ): Promise<DirectoryEntry[]> {
    /*
     * Limit recursion depth to 10.
     * Prevents overwhelming output from
     * very deep directory trees.
     */
    if (depth > 10) {
      return [];
    }

    const entries: DirectoryEntry[] = [];
    const items = await readdir(absolutePath);
    const sorted = items.sort();

    for (const item of sorted) {
      const itemAbsolutePath = path.join(
        absolutePath,
        item,
      );

      const itemRelativePath = path.relative(
        workspaceRoot,
        itemAbsolutePath,
      );

      try {
        const itemStat = await lstat(itemAbsolutePath);

        if (itemStat.isDirectory()) {
          entries.push({
            name: item,
            type: "directory",
            path: itemRelativePath,
          });

          if (recursive) {
            const subEntries =
              await this.listDirectory(
                itemAbsolutePath,
                workspaceRoot,
                recursive,
                depth + 1,
              );

            entries.push(...subEntries);
          }
        } else if (itemStat.isFile()) {
          entries.push({
            name: item,
            type: "file",
            sizeBytes: itemStat.size,
            path: itemRelativePath,
          });
        }

        /*
         * Symlinks intentionally ignored.
         * They could point outside workspace.
         * Fail closed — skip anything that is
         * not a plain file or directory.
         */
      } catch {
        /*
         * Skip entries we cannot stat.
         * Permission errors, broken symlinks.
         */
      }
    }

    return entries;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1_048_576) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
}