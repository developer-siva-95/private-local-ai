import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolInput, ToolResult, ToolInputSchema } from "./Tool.js";
import { Permission } from "../permissions/Permission.js";

const execAsync = promisify(exec);

export class RunCommandTool implements Tool {
  readonly name = "run_command";
  readonly description = "Execute a shell command (npm, git, node, tsc) within the workspace.";
  readonly permission = Permission.RUN_COMMAND;
  readonly retryable = false;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The full command to execute.",
      },
    },
    required: ["command"],
  };

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const command = input.command;

    if (typeof command !== "string" || command.trim() === "") {
      return { success: false, output: "", error: "Valid command is required." };
    }

    try {
      // Execute with a 30-second timeout to prevent hanging
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.workspaceRoot,
        timeout: 30000,
        shell: "powershell.exe",
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