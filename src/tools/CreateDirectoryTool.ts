import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolInputSchema,
} from "./Tool.js";
import { Permission } from "../permissions/Permission.js";

export class CreateDirectoryTool implements Tool {
  readonly name = "create_directory";

  readonly description =
    "Create a new directory (and any necessary parent directories) " +
    "inside the authorized workspace.";

  /*
   * WRITE_FILE permission = always prompts the user.
   * No session memory, no auto-approval.
   * Every directory creation requires explicit user consent.
   */
  readonly permission = Permission.WRITE_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path of the directory to create, relative to workspace root.",
      },
    },
    required: ["path"],
  };

  readonly retryable = false;

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const dirPath = input.path;

    if (typeof dirPath !== "string" || dirPath.trim() === "") {
      return {
        success: false,
        output: "",
        error: "A valid directory path is required.",
      };
    }

    /*
     * Sanitization: block null bytes and control characters.
     */
    if (dirPath.includes("\0") || /[\x00-\x1F\x7F]/.test(dirPath)) {
      console.log(`[SECURITY] Blocked directory path with control characters: ${dirPath}`);
      return {
        success: false,
        output: "",
        error: "Security violation: Invalid characters in path.",
      };
    }

    const resolvedPath = path.resolve(context.workspaceRoot, dirPath);

    /*
     * Defense-in-depth: logical boundary check.
     * The gateway already validated this, but we verify again.
     */
    const relativePath = path.relative(context.workspaceRoot, resolvedPath);
    const isInside =
      relativePath === "" ||
      (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

    if (!isInside) {
      console.log(`[SECURITY] Blocked directory breakout: ${dirPath}`);
      return {
        success: false,
        output: "",
        error: "Security violation: Path is outside the workspace.",
      };
    }

    try {
      await mkdir(resolvedPath, { recursive: true });
      return {
        success: true,
        output: `Directory created: ${relativePath || "."}`,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error:
          error instanceof Error
            ? error.message
            : "Failed to create directory.",
      };
    }
  }
}