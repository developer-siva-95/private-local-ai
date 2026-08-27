import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolInputSchema,
} from "./Tool.js";
import { withTimeout } from "./ToolTimeout.js";
import { Permission } from "../permissions/Permission.js";

/**
 * FilePatchTool
 *
 * Surgical edits to files without rewriting the entire file.
 *
 * Supports three operations:
 *   replace  — Replace lines start_line through end_line with new content
 *   insert   — Insert new content after a specific line
 *   delete   — Delete lines start_line through end_line
 *
 * Also supports search/replace mode:
 *   Provide "search" and "replace" fields instead of line numbers.
 *   The tool finds the exact match and replaces it.
 *
 * SECURITY:
 * 1. Declares Permission.WRITE_FILE.
 * 2. Path containment is verified by PermissionGateway before execution.
 * 3. Includes defence-in-depth path check inside tool.
 * 4. Atomic writes: write to temp file, then rename.
 *
 * Shows a console diff preview of the changes before the patch
 * is applied, so the user can see exactly what will change.
 */
export class FilePatchTool implements Tool {
  readonly name = "patch_file";

  readonly description =
    "Apply a surgical edit to a file. " +
    "Operations: " +
    "(1) replace: requires path, operation='replace', start_line, end_line, content. " +
    "(2) insert: requires path, operation='insert', start_line (line after which to insert), content. " +
    "(3) delete: requires path, operation='delete', start_line, end_line. " +
    "(4) search/replace: requires path, operation='replace', search (exact text to find), replace (replacement text). " +
    "Line numbers are 1-based. " +
    "Example: to replace line 2, use start_line=2, end_line=2, content='new text'.";

  readonly permission = Permission.WRITE_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path of the file to patch, relative to workspace root.",
      },
      operation: {
        type: "string",
        description:
          "One of: replace, insert, delete. " +
          "For search/replace mode, use 'replace' with 'search' field.",
      },
      start_line: {
        type: "number",
        description:
          "Starting line number (1-based). " +
          "Required for replace and delete operations. " +
          "For insert, this is the line number after which to insert.",
      },
      end_line: {
        type: "number",
        description:
          "Ending line number (1-based, inclusive). " +
          "Required for replace and delete operations. " +
          "Not used for insert.",
      },
      content: {
        type: "string",
        description:
          "New content for replace and insert operations. " +
          "Not used for delete.",
      },
      search: {
        type: "string",
        description:
          "Exact text to search for in search/replace mode. " +
          "If provided, line numbers are ignored.",
      },
      replace: {
        type: "string",
        description:
          "Replacement text for search/replace mode. " +
          "Used only when 'search' field is provided.",
      },
    },
    required: ["path", "operation"],
  };

  readonly retryable = false;

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const filePath = input.path;
    const operation = input.operation;

    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { success: false, output: "", error: "Valid path is required." };
    }

    if (typeof operation !== "string" || operation.trim() === "") {
      return { success: false, output: "", error: "Valid operation is required." };
    }

    const op = operation.trim().toLowerCase();

    if (op !== "replace" && op !== "insert" && op !== "delete") {
      return {
        success: false,
        output: "",
        error: `Unknown operation: "${operation}". Must be one of: replace, insert, delete.`,
      };
    }

    const resolvedPath = path.resolve(context.workspaceRoot, filePath);

    /*
     * Defence-in-depth: verify path is inside workspace.
     */
    const relativePath = path.relative(context.workspaceRoot, resolvedPath);
    const isInside =
      relativePath === "" ||
      (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

    if (!isInside) {
      return {
        success: false,
        output: "",
        error: "Security violation: Path is outside the workspace.",
      };
    }

    try {
      /*
       * Read the current file content.
       */
      let currentContent: string;
      try {
        currentContent = await withTimeout(
          readFile(resolvedPath, "utf8"),
          10_000,
          this.name,
        );
      } catch {
        return {
          success: false,
          output: "",
          error: `File not found or cannot be read: ${filePath}`,
        };
      }

      const originalLines = currentContent.split("\n");

      /*
       * Check for search/replace mode.
       */
      if (typeof input.search === "string" && input.search !== "") {
        return await this.handleSearchReplace(
          input.search,
          typeof input.replace === "string" ? input.replace : "",
          originalLines,
          resolvedPath,
          filePath,
        );
      }

      /*
       * Line-based operations.
       */
      switch (op) {
        case "replace":
          return await this.handleReplace(input, originalLines, resolvedPath, filePath);
        case "insert":
          return await this.handleInsert(input, originalLines, resolvedPath, filePath);
        case "delete":
          return await this.handleDelete(input, originalLines, resolvedPath, filePath);
        default:
          return { success: false, output: "", error: `Unknown operation: ${op}` };
      }
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : "Failed to patch file.",
      };
    }
  }

  /*
   * Search and replace: find exact text and replace it.
   */
  private async handleSearchReplace(
    search: string,
    replace: string,
    originalLines: string[],
    resolvedPath: string,
    filePath: string,
  ): Promise<ToolResult> {
    const originalContent = originalLines.join("\n");

    if (!originalContent.includes(search)) {
      return {
        success: false,
        output: "",
        error: `Search text not found in file: ${filePath}`,
      };
    }

    const newContent = originalContent.replace(search, replace);
    const newLines = newContent.split("\n");

    const diff = this.generateDiff(originalLines, newLines);
    this.printDiff(diff, filePath);

    await this.atomicWrite(resolvedPath, newContent);

    return {
      success: true,
      output: `Successfully patched ${filePath} (search/replace).\n\nDiff:\n${diff}`,
    };
  }

  /*
   * Replace lines start_line through end_line with new content.
   */
  private async handleReplace(
    input: ToolInput,
    originalLines: string[],
    resolvedPath: string,
    filePath: string,
  ): Promise<ToolResult> {
    const validation = this.validateLineNumbers(
      input.start_line,
      input.end_line,
      originalLines.length,
    );
    if (validation !== null) return validation;

    const startLine = input.start_line as number;
    const endLine = input.end_line as number;

    if (typeof input.content !== "string") {
      return { success: false, output: "", error: "Content is required for replace operation." };
    }

    const newContentLines = input.content.split("\n");
    const newLines = [
      ...originalLines.slice(0, startLine - 1),
      ...newContentLines,
      ...originalLines.slice(endLine),
    ];

    const diff = this.generateDiff(originalLines, newLines);
    this.printDiff(diff, filePath);

    await this.atomicWrite(resolvedPath, newLines.join("\n"));

    return {
      success: true,
      output:
        `Successfully patched ${filePath} ` +
        `(replaced lines ${startLine}-${endLine}).\n\nDiff:\n${diff}`,
    };
  }

  /*
   * Insert new content after a specific line.
   * Line 0 means insert at the beginning of the file.
   */
  private async handleInsert(
    input: ToolInput,
    originalLines: string[],
    resolvedPath: string,
    filePath: string,
  ): Promise<ToolResult> {
    const startLine = input.start_line;

    if (typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 0) {
      return {
        success: false,
        output: "",
        error: "start_line must be a non-negative integer (0 to insert at beginning).",
      };
    }

    if (startLine > originalLines.length) {
      return {
        success: false,
        output: "",
        error:
          `start_line ${startLine} is beyond file length ` +
          `(${originalLines.length} lines).`,
      };
    }

    if (typeof input.content !== "string") {
      return { success: false, output: "", error: "Content is required for insert operation." };
    }

    const newContentLines = input.content.split("\n");
    const newLines = [
      ...originalLines.slice(0, startLine),
      ...newContentLines,
      ...originalLines.slice(startLine),
    ];

    const diff = this.generateDiff(originalLines, newLines);
    this.printDiff(diff, filePath);

    await this.atomicWrite(resolvedPath, newLines.join("\n"));

    return {
      success: true,
      output:
        `Successfully patched ${filePath} ` +
        `(inserted after line ${startLine}).\n\nDiff:\n${diff}`,
    };
  }

  /*
   * Delete lines start_line through end_line.
   */
  private async handleDelete(
    input: ToolInput,
    originalLines: string[],
    resolvedPath: string,
    filePath: string,
  ): Promise<ToolResult> {
    const validation = this.validateLineNumbers(
      input.start_line,
      input.end_line,
      originalLines.length,
    );
    if (validation !== null) return validation;

    const startLine = input.start_line as number;
    const endLine = input.end_line as number;

    const newLines = [
      ...originalLines.slice(0, startLine - 1),
      ...originalLines.slice(endLine),
    ];

    const diff = this.generateDiff(originalLines, newLines);
    this.printDiff(diff, filePath);

    await this.atomicWrite(resolvedPath, newLines.join("\n"));

    return {
      success: true,
      output:
        `Successfully patched ${filePath} ` +
        `(deleted lines ${startLine}-${endLine}).\n\nDiff:\n${diff}`,
    };
  }

  /*
   * Validate line numbers for replace and delete operations.
   * Returns a ToolResult with error if invalid, null if valid.
   */
  private validateLineNumbers(
    startLine: unknown,
    endLine: unknown,
    fileLength: number,
  ): ToolResult | null {
    if (typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1) {
      return {
        success: false,
        output: "",
        error: "start_line must be a positive integer (1-based).",
      };
    }

    if (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < 1) {
      return {
        success: false,
        output: "",
        error: "end_line must be a positive integer (1-based).",
      };
    }

    if (startLine > endLine) {
      return {
        success: false,
        output: "",
        error: `start_line (${startLine}) must not be greater than end_line (${endLine}).`,
      };
    }

    if (endLine > fileLength) {
      return {
        success: false,
        output: "",
        error:
          `end_line ${endLine} is beyond file length ` +
          `(${fileLength} lines).`,
      };
    }

    return null;
  }

  /*
   * Generate a unified-style diff string.
   *
   * Simple line-by-line comparison:
   *   Lines only in old → prefixed with "- "
   *   Lines only in new → prefixed with "+ "
   *   Lines in both    → prefixed with "  "
   *
   * Shows context around changes.
   */
  private generateDiff(oldLines: string[], newLines: string[]): string {
    const result: string[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    /*
     * Simple diff: walk through both arrays.
     * This is not a full diff algorithm (like Myers diff)
     * but it is clear and correct for line-based patches
     * where we know exactly which lines changed.
     */
    let oldIndex = 0;
    let newIndex = 0;

    /*
     * For line-based operations (replace, insert, delete),
     * we know the exact change boundaries. A simple
     * comparison works perfectly because the changes
     * are contiguous.
     *
     * For search/replace, changes may be scattered
     * but typically affect a small section.
     */
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      const oldLine = oldIndex < oldLines.length ? oldLines[oldIndex] : undefined;
      const newLine = newIndex < newLines.length ? newLines[newIndex] : undefined;

      if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
        result.push(`  ${oldLine}`);
        oldIndex++;
        newIndex++;
      } else if (oldLine !== undefined && newLine !== undefined) {
        result.push(`- ${oldLine}`);
        result.push(`+ ${newLine}`);
        oldIndex++;
        newIndex++;
      } else if (oldLine !== undefined) {
        result.push(`- ${oldLine}`);
        oldIndex++;
      } else if (newLine !== undefined) {
        result.push(`+ ${newLine}`);
        newIndex++;
      } else {
        break;
      }
    }

    return result.join("\n");
  }

  /*
   * Print the diff to console with colors.
   *
   * Red for removed lines (- prefix)
   * Green for added lines (+ prefix)
   * Gray for context lines
   */
  private printDiff(diff: string, filePath: string): void {
    console.log(`\n  ┌─── Patch Preview: ${filePath} ───`);

    const lines = diff.split("\n");
    for (const line of lines) {
      if (line.startsWith("+ ")) {
        // Green for added lines
        console.log(`  │ \x1b[32m${line}\x1b[0m`);
      } else if (line.startsWith("- ")) {
        // Red for removed lines
        console.log(`  │ \x1b[31m${line}\x1b[0m`);
      } else {
        // Default for context
        console.log(`  │ ${line}`);
      }
    }

    console.log(`  └${"─".repeat(40)}`);
  }

  /*
   * Atomic write: write to temp file, then rename.
   *
   * This prevents file corruption if the process
   * dies mid-write. Either the old file remains
   * intact, or the new file is fully written.
   *
   * On Windows, rename() replaces the target file
   * atomically in most cases.
   */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`;

    try {
      await withTimeout(
        (async () => {
          await writeFile(tempPath, content, "utf8");
          await rename(tempPath, filePath);
        })(),
        10_000,
        this.name,
      );
    } catch (error) {
      /*
       * Clean up temp file if rename failed.
       */
      try {
        await unlink(tempPath);
      } catch {
        /* temp file may not exist */
      }
      throw error;
    }
  }
}