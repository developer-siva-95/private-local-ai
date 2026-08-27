import { exec } from "node:child_process";
import { promisify } from "node:util";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolInputSchema,
} from "./Tool.js";

import { Permission } from "../permissions/Permission.js";

const execAsync = promisify(exec);

const ALLOWED_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "branch", "show"]);
const ALLOWED_WRITE_SUBCOMMANDS = new Set(["add", "commit"]);
const BLOCKED_FLAGS = new Set(["--hard", "--force", "-f", "-fd", "-fx", "--mirror", "--delete", "-d", "--orphan"]);
const INJECTION_PATTERNS = ["&&", "||", ";", "|", "`", "$(", "${"];

export class GitTool implements Tool {
  readonly name = "git_operation";
  readonly description = "Execute safe git operations (status, diff, log, branch, show, add, commit). commit requires staged changes.";
  readonly permission = Permission.GIT_OPERATION;
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      subcommand: { type: "string", description: "git subcommand" },
      args: { type: "string", description: "subcommand arguments" },
    },
    required: ["subcommand"],
  };

  readonly retryable = false;

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const subcommand = input.subcommand;
    if (typeof subcommand !== "string" || subcommand.trim() === "") {
      return { success: false, output: "", error: "A valid git subcommand is required." };
    }

    const cleanSubcommand = subcommand.trim().toLowerCase();
    if (!ALLOWED_READ_SUBCOMMANDS.has(cleanSubcommand) && !ALLOWED_WRITE_SUBCOMMANDS.has(cleanSubcommand)) {
      return { success: false, output: "", error: `Git subcommand '${cleanSubcommand}' is not permitted.` };
    }

    const cleanArgs = typeof input.args === "string" ? input.args.trim() : "";
    for (const pattern of INJECTION_PATTERNS) {
      if (cleanArgs.includes(pattern)) {
        return { success: false, output: "", error: `Injection pattern detected: ${pattern}` };
      }
    }

    // Flag blocking
    if (cleanArgs.length > 0) {
      const tokens = cleanArgs.split(/\s+/).map(t => t.replace(/[^a-z0-9\-_]/g, ""));
      for (const token of tokens) {
        if (BLOCKED_FLAGS.has(token)) {
          return { success: false, output: "", error: `Blocked flag: ${token}` };
        }
      }
    }

    /*
     * Staging Check for Commits
     */
    let stagingInfo = "";
    if (cleanSubcommand === "commit") {
      try {
        const { stdout: statusOut } = await execAsync("git status --short", {
          cwd: context.workspaceRoot,
          windowsHide: true,
          signal: context.abortSignal // Pass signal to status check too
        });

        if (statusOut.trim() === "") {
          return {
            success: false,
            output: "",
            error: "Aborting commit: Nothing staged. Use 'git add' first.",
          };
        }
        stagingInfo = `[Staged for commit]\n${statusOut.trim()}\n\n`;
      } catch (err) {
        // Fall through; if git is broken, the main command will report it
      }
    }

    const fullCommand = cleanArgs ? `git ${cleanSubcommand} ${cleanArgs}` : `git ${cleanSubcommand}`;

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: context.workspaceRoot,
        timeout: 30_000,
        windowsHide: true,
        /* 
         * Use the AbortSignal from context. 
         * On timeout, Node will kill this process automatically.
         */
        signal: context.abortSignal,
        env: { ...process.env },
      });

      const output = stdout.trim() || stderr.trim() || "Success.";
      return { success: true, output: stagingInfo + output };
    } catch (error) {
      if (error instanceof Error) {
        // Specific handling for aborted processes
        if (error.name === "AbortError") {
          return { success: false, output: "", error: "Git process was killed (timeout or cancellation)." };
        }
        const execError = error as any;
        const msg = execError.stderr?.trim() || execError.stdout?.trim() || error.message;
        return { success: false, output: "", error: msg };
      }
      return { success: false, output: "", error: "Git operation failed." };
    }
  }
}