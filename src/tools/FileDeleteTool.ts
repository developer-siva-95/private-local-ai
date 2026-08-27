import { rm } from "node:fs/promises";
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

/**
 * FileDeleteTool
 * 
 * Allows the agent to delete a file.
 * 
 * SECURITY:
 * 1. Requires Permission.DELETE_FILE.
 * 2. Enforces workspace boundaries.
 * 3. Does not allow directory deletion (for safety, can be added later).
 */
export class FileDeleteTool implements Tool {
  readonly name = "delete_file";

  readonly description =
    "Delete a file inside the authorized workspace. " +
    "This operation is permanent and requires explicit user approval.";

  readonly permission = Permission.DELETE_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path of the file to delete, relative to workspace root.",
      },
    },
    required: ["path"],
  };

  readonly retryable = false;

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const filePath = input.path;

    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { success: false, output: "", error: "Valid path is required." };
    }

    const resolvedPath = path.resolve(context.workspaceRoot, filePath);

    // Defense-in-depth boundary check
    const relativePath = path.relative(context.workspaceRoot, resolvedPath);
    const isInside = !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

    if (!isInside && relativePath !== "") {
      return {
        success: false,
        output: "",
        error: "Security violation: Attempted delete outside workspace.",
      };
    }

    try {
      // For safety, we only allow deleting files, not directories, in this version
      await withTimeout(rm(resolvedPath, { force: false }), 5_000, this.name);

      return {
        success: true,
        output: `Successfully deleted ${filePath}`,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : "Failed to delete file.",
      };
    }
  }
}