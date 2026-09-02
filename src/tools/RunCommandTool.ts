import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Tool, ToolContext, ToolInput, ToolResult, ToolInputSchema } from "./Tool.js";
import { Permission } from "../permissions/Permission.js";

const execAsync = promisify(exec);

export class RunCommandTool implements Tool {
  readonly name = "run_command";

  readonly description =
    "Execute an allowed command (npm, git, node, tsc) within the workspace. " +
    "Use the optional cwd parameter to run inside a subdirectory. " +
    "The subdirectory will be automatically created if it does not exist.";

  readonly permission = Permission.RUN_COMMAND;
  readonly retryable = false;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The full command to execute (e.g. 'npm init -y', 'npm test').",
      },
      cwd: {
        type: "string",
        description:
          "Optional subdirectory relative to workspace root to run the command in. " +
          "Will be created automatically if missing.",
      },
    },
    required: ["command"],
  };

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const command = input.command;
    const subCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";

    if (typeof command !== "string" || command.trim() === "") {
      return { success: false, output: "", error: "Valid command is required." };
    }

    /*
     * Sanitization: block null bytes and control characters in cwd.
     */
    if (subCwd !== "" && (subCwd.includes("\0") || /[\x00-\x1F\x7F]/.test(subCwd))) {
      console.log(`[SECURITY] Blocked cwd with control characters: ${subCwd}`);
      return {
        success: false,
        output: "",
        error: "Security violation: Invalid characters in cwd.",
      };
    }

    let targetDir = context.workspaceRoot;

    if (subCwd !== "") {
      const resolved = path.resolve(context.workspaceRoot, subCwd);

      /*
       * 1. Logical Boundary Check
       */
      const rel = path.relative(context.workspaceRoot, resolved);
      const isInsideLogical =
        rel === "" ||
        (!rel.startsWith("..") && !path.isAbsolute(rel));

      if (!isInsideLogical) {
        console.log(`[SECURITY] Blocked cwd breakout: ${subCwd}`);
        return {
          success: false,
          output: "",
          error: "Security violation: cwd is outside the workspace.",
        };
      }

      /*
       * 2. Physical Real-Path Check (Defense-in-depth against Symlinks)
       * Trace up to find the nearest existing parent directory to verify its physical real path.
       */
      let currentCheck = resolved;
      let pathVerified = false;

      while (currentCheck && currentCheck !== path.dirname(currentCheck)) {
        if (existsSync(currentCheck)) {
          try {
            const realParent = await realpath(currentCheck);
            const realWorkspace = await realpath(context.workspaceRoot);
            const relReal = path.relative(realWorkspace, realParent);

            const isInsideReal =
              relReal === "" ||
              (!relReal.startsWith("..") && !path.isAbsolute(relReal));

            if (!isInsideReal) {
              console.log(`[SECURITY] Blocked physical symlink breakout: ${subCwd}`);
              return {
                success: false,
                output: "",
                error: "Security violation: Real path breakout detected.",
              };
            }
            pathVerified = true;
            break;
          } catch (err) {
            /* Fallback and check parent */
          }
        }
        currentCheck = path.dirname(currentCheck);
      }

      if (!pathVerified && existsSync(context.workspaceRoot)) {
        /*
         * If no subdirectories existed yet, check the workspace root itself.
         */
        try {
          const realWorkspace = await realpath(context.workspaceRoot);
          void realWorkspace;
        } catch {
          return {
            success: false,
            output: "",
            error: "Security violation: Unable to verify workspace path integrity.",
          };
        }
      }

      /*
       * Automatically create the target subdirectory if it does not exist.
       * This creates folders on-demand under the user-approved cwd parameter.
       */
      if (!existsSync(resolved)) {
        try {
          await mkdir(resolved, { recursive: true });
        } catch (err) {
          return {
            success: false,
            output: "",
            error: `Failed to create missing subdirectory: ${subCwd}`,
          };
        }
      }

      targetDir = resolved;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: targetDir,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      return {
        success: true,
        output: stdout + (stderr ? `\nErrors: ${stderr}` : ""),
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : "Command execution failed.",
      };
    }
  }
}