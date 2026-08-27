import path from "node:path";
import type { PolicyDecision, ToolOperation } from "./Policy.js";

export class SecurityPolicy {
  private readonly workspaceRoot: string;

  private readonly allowedCommands = new Set([
    "npm",
    "node",
    "git",
    "tsc",
  ]);

  /*
   * When git is used through RunCommandTool,
   * these are the only allowed subcommands.
   *
   * This prevents bypassing GitTool's security
   * by using RunCommandTool with git push etc.
   */
  private readonly allowedGitSubcommands = new Set([
    "status",
    "diff",
    "log",
    "branch",
    "show",
    "add",
    "commit",
  ]);

  private readonly blockedCommandWords = new Set([
    "del", "rd", "rmdir", "rm", "erase",
    "format", "shutdown", "taskkill", "reg",
    "regedit", "sc", "net", "netsh", "cipher",
    "bcdedit", "diskpart", "cmd", "cmd.exe",
    "powershell", "powershell.exe", "wscript",
    "cscript", "mshta", "rundll32", "regsvr32",
    "curl", "wget", "python", "python3", "pip",
    "pip3", "ruby", "perl", "bash", "sh", "zsh",
  ]);

  private readonly dangerousSubstrings: string[] = [
    "&&", "||", "`", ";", "|",
    "child_process", "exec(", "spawn(",
    "execsync", "spawnsync",
    "../", "..\\",
    "%systemroot%", "%windir%", "%appdata%",
    "%temp%", "%comspec%",
    "/etc/", "/usr/", "/bin/", "/root/",
  ];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  checkPath(
    targetPath: string,
    _operation: ToolOperation,
  ): PolicyDecision {
    const resolvedPath = path.resolve(
      this.workspaceRoot,
      targetPath,
    );

    const relativePath = path.relative(
      this.workspaceRoot,
      resolvedPath,
    );

    const insideWorkspace =
      relativePath === "" ||
      (
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
      );

    if (!insideWorkspace) {
      return {
        allowed: false,
        reason: "Path is outside the allowed workspace.",
      };
    }

    return {
      allowed: true,
      reason: "Path is inside the allowed workspace.",
    };
  }

  checkCommand(command: string): PolicyDecision {
    const trimmed = command.trim();
    const lower = trimmed.toLowerCase();

    /*
     * Step 1: Check base command is in allowlist.
     */
    const baseCommand =
      lower.split(/\s+/)[0] ?? "";

    if (!this.allowedCommands.has(baseCommand)) {
      return {
        allowed: false,
        reason:
          `Command '${baseCommand}' is not permitted. ` +
          `Only [${Array.from(
            this.allowedCommands,
          ).join(", ")}] are allowed.`,
      };
    }

    /*
     * Step 2: Special git subcommand check.
     *
     * Even though "git" is in the allowlist,
     * only specific git subcommands are allowed.
     *
     * This prevents bypassing GitTool security
     * by using RunCommandTool with:
     * "git push", "git clone", "git reset --hard"
     */
    if (baseCommand === "git") {
      const afterGit = lower
        .slice("git".length)
        .trim();

      const gitSubcommand =
        afterGit.split(/\s+/)[0] ?? "";

      if (
        gitSubcommand !== "" &&
        !this.allowedGitSubcommands.has(
          gitSubcommand,
        )
      ) {
        return {
          allowed: false,
          reason:
            `Git subcommand '${gitSubcommand}' is ` +
            `not permitted through run_command. ` +
            `Use the git_operation tool instead, ` +
            `which enforces additional safety checks.`,
        };
      }
    }

    /*
     * Step 3: Check every token against
     * blocked command words.
     */
    const tokens = lower.split(/\s+/);

    for (const token of tokens) {
      const cleaned = token.replace(
        /^[^a-z0-9]+|[^a-z0-9]+$/g,
        "",
      );

      if (
        cleaned.length > 0 &&
        this.blockedCommandWords.has(cleaned)
      ) {
        return {
          allowed: false,
          reason:
            `Command contains a blocked word: ` +
            `'${cleaned}'.`,
        };
      }
    }

    /*
     * Step 4: Check dangerous substrings.
     */
    for (const pattern of this.dangerousSubstrings) {
      if (lower.includes(pattern)) {
        return {
          allowed: false,
          reason:
            `Command contains a dangerous pattern: ` +
            `'${pattern}'.`,
        };
      }
    }

    /*
     * Step 5: Check for Windows absolute paths.
     */
    const windowsAbsolutePathPattern =
      /[a-z]:[\\\/]/i;

    if (
      windowsAbsolutePathPattern.test(trimmed)
    ) {
      return {
        allowed: false,
        reason:
          "Command contains an absolute path. " +
          "Only relative paths within the " +
          "workspace are permitted.",
      };
    }

    return {
      allowed: true,
      reason: "Command is permitted.",
    };
  }
}