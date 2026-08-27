import * as vscode from "vscode";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { OutputChannelLogger } from "./OutputChannelLogger.js";

const execAsync = promisify(exec);

/*
 * ContextProvider
 *
 * Collects lightweight metadata about the user's
 * current VS Code editor state and injects it
 * into agent messages.
 *
 * What is collected:
 *   - Active file relative path
 *   - Detected language
 *   - Cursor line number
 *   - Selected text (if any, max 500 chars)
 *   - Git branch (cached 5s)
 *
 * What is NOT collected:
 *   - Full file contents (requires read_file approval)
 *   - Files from other open tabs
 *   - Anything outside the workspace
 *
 * Bug 3 fix: all collected fields now appear in the
 * returned context string, not just active_file and
 * cursor_line.
 */
export class ContextProvider {
  private cachedBranch: string | undefined;
  private cachedBranchTime = 0;
  private readonly BRANCH_CACHE_MS = 5_000;

  constructor(
    private readonly workspaceRoot: string,
    private readonly logger?: OutputChannelLogger,
  ) {}

  /*
   * Build a compact context block for injection
   * into the current turn's user message.
   *
   * Returns empty string if no useful context.
   *
   * Bug 3 fix: previously only active_file and
   * cursor_line appeared in the output string.
   * Now all collected fields are included.
   */
  async buildContext(): Promise<string> {
    const fields: Record<string, string> = {};

    /*
     * When chat panel is focused, activeTextEditor
     * may be undefined. Fall back to the first visible
     * text editor which is usually the file the user
     * was just looking at.
     */
    const editor =
      vscode.window.activeTextEditor ??
      vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.scheme === "file",
      );

    if (editor !== undefined) {
      const doc = editor.document;
      const filePath = this.getRelativePath(doc.uri.fsPath);

      if (filePath !== undefined) {
        fields["active_file"] = filePath;

        const language = doc.languageId;
        if (language !== "" && language !== "plaintext") {
          fields["language"] = language;
        }

        fields["cursor_line"] = String(
          editor.selection.active.line + 1,
        );

        /*
         * Selected text (if any).
         * Only include if short — avoid injecting
         * huge selections into context.
         */
        const selection = doc.getText(editor.selection);

        if (selection !== "" && selection.length <= 500) {
          const preview = selection
            .replace(/\n/g, "\\n")
            .slice(0, 300);
          fields["selected"] = `"${preview}"`;
        } else if (selection.length > 500) {
          fields["selected"] = `(${selection.length} chars selected)`;
        }
      }
    }

    /*
     * Git branch (cached to avoid frequent git calls).
     */
    const branch = await this.getGitBranch();
    if (branch !== undefined) {
      fields["git_branch"] = branch;
    }

    if (Object.keys(fields).length === 0) {
      return "";
    }

    /*
     * Build human-readable context string.
     * All fields included — Bug 3 fix.
     *
     * Format:
     * [Context]
     * active_file: src/agent/Agent.ts
     * language: typescript
     * cursor_line: 42
     * selected: "const foo = ..."
     * git_branch: main
     *
     * Agent instruction: use this to answer "which file",
     * "what line", "what branch" without calling any tool.
     */
    const fieldLines = Object.entries(fields)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    const contextStr =
      `[Editor Context — use to answer questions about ` +
      `current file, cursor position, selection, and git branch ` +
      `without calling any tool. Only call read_file if you need ` +
      `actual file contents.]\n` +
      fieldLines;

    /*
     * Log context summary to Output Channel.
     */
    const summary = Object.entries(fields)
      .map(([k, v]) =>
        k === "selected"
          ? `${k}: ${v.slice(0, 30)}…`
          : `${k}: ${v}`,
      )
      .join(" | ");

    this.logger?.contextInjected(summary);

    return contextStr;
  }

  /*
   * Get relative path from workspace root.
   * Returns undefined if file is outside workspace.
   */
  private getRelativePath(fsPath: string): string | undefined {
    const relative = path.relative(this.workspaceRoot, fsPath);

    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }

    return relative.replace(/\\/g, "/");
  }

  /*
   * Get current git branch.
   * Cached for 5 seconds to avoid repeated git calls.
   * Returns undefined if not a git repo or git fails.
   */
  private async getGitBranch(): Promise<string | undefined> {
    const now = Date.now();

    if (
      this.cachedBranch !== undefined &&
      now - this.cachedBranchTime < this.BRANCH_CACHE_MS
    ) {
      return this.cachedBranch;
    }

    try {
      const { stdout } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        {
          cwd: this.workspaceRoot,
          timeout: 2_000,
          windowsHide: true,
        },
      );

      const branch = stdout.trim();

      if (branch !== "" && branch !== "HEAD") {
        this.cachedBranch = branch;
        this.cachedBranchTime = now;
        return branch;
      }
    } catch {
      /* not a git repo or git not installed */
    }

    this.cachedBranch = undefined;
    return undefined;
  }
}