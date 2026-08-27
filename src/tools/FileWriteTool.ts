import { writeFile, mkdir } from "node:fs/promises";
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
 * FileWriteTool
 * 
 * Allows the agent to write content to a file within the workspace.
 * 
 * SECURITY:
 * 1. Declares Permission.WRITE_FILE.
 * 2. Path containment is verified by the PermissionGateway before execution.
 * 3. Includes defense-in-depth checks to ensure no out-of-bounds writes.
 */
export class FileWriteTool implements Tool {
  readonly name = "write_file";

  readonly description =
    "Write content to a file inside the authorized workspace. " +
    "Creates the file and parent directories if they do not exist. " +
    "Overwrites existing files. " +
    "Requires explicit user approval.";

  readonly permission = Permission.WRITE_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path of the file to write, relative to workspace root.",
      },
      content: {
        type: "string",
        description: "Content to be written to the file.",
      },
    },
    required: ["path", "content"],
  };

  readonly retryable = false;

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const filePath = input.path;
    const content = input.content;

    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { success: false, output: "", error: "Valid path is required." };
    }

    if (typeof content !== "string") {
      return { success: false, output: "", error: "Content must be a string." };
    }

    const resolvedPath = path.resolve(context.workspaceRoot, filePath);

    // Defense-in-depth: Final check that resolved path is inside workspace
    const relativePath = path.relative(context.workspaceRoot, resolvedPath);
    const isInside = !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

    if (!isInside && relativePath !== "") {
      return {
        success: false,
        output: "",
        error: "Security violation: Attempted write outside workspace.",
      };
    }

    try {
      // Ensure parent directory exists
      await withTimeout(
        (async () => {
          await mkdir(path.dirname(resolvedPath), { recursive: true });
          await writeFile(resolvedPath, content, "utf8");
        })(),
        10_000,
        this.name,
      );

      return {
        success: true,
        output: `Successfully wrote to ${filePath}`,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : "Failed to write file.",
      };
    }
  }
}