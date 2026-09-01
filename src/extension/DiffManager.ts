import * as vscode from "vscode";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OutputChannelLogger } from "./OutputChannelLogger.js";

const MAX_DIFF_SIZE = 1_000_000;

export class DiffManager {
  private readonly tempDir: string;
  private diffQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    private readonly logger?: OutputChannelLogger,
  ) {
    this.tempDir = path.join(workspaceRoot, ".private_ai", "temp");
  }

  async previewWriteDiff(
    filePath: string,
    newContent: string,
  ): Promise<boolean> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);

    let oldContent = "";
    let isNewFile = true;

    if (existsSync(resolvedPath)) {
      try {
        oldContent = await readFile(resolvedPath, "utf8");
        isNewFile = false;
      } catch {
        oldContent = "";
      }
    }

    /*
     * No changes — nothing to show.
     */
    if (oldContent === newContent) return true;

    /*
     * File too large for diff — skip preview, allow.
     */
    if (
      oldContent.length > MAX_DIFF_SIZE ||
      newContent.length > MAX_DIFF_SIZE
    ) {
      return true;
    }

    return this.showDiffAndAsk(
      filePath,
      oldContent,
      newContent,
      isNewFile ? "Create" : "Modify",
    );
  }

  async previewPatchDiff(
    filePath: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const resolvedPath = path.resolve(this.workspaceRoot, filePath);

    if (!existsSync(resolvedPath)) return true;

    let oldContent: string;

    try {
      oldContent = await readFile(resolvedPath, "utf8");
    } catch {
      return true;
    }

    if (oldContent.length > MAX_DIFF_SIZE) return true;

    const newContent = this.applyPatchInMemory(oldContent, operation, args);

    if (newContent === null || oldContent === newContent) {
      return true;
    }

    return this.showDiffAndAsk(filePath, oldContent, newContent, "Patch");
  }

  private async showDiffAndAsk(
    filePath: string,
    oldContent: string,
    newContent: string,
    actionLabel: string,
  ): Promise<boolean> {
    let resolvePromise!: (value: boolean) => void;
    const resultPromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    /*
     * Serialize all concurrent diff previews so they wait in line.
     * This avoids VS Code layout and window focus clashing when Gemma
     * processes multiple writes/patches in parallel.
     */
    this.diffQueue = this.diffQueue
      .then(async () => {
        try {
          const approved = await this.executeShowDiffAndAsk(
            filePath,
            oldContent,
            newContent,
            actionLabel,
          );
          resolvePromise(approved);
        } catch (error) {
          this.logger?.error(
            "Diff queue execution failed",
            error instanceof Error ? error.message : String(error),
          );
          /*
           * Fail open on diff queue error to preserve fail-safe behavior.
           */
          resolvePromise(true);
        }
      })
      .catch((err) => {
        this.logger?.error("Unhandled diff queue error", String(err));
        resolvePromise(true);
      });

    return resultPromise;
  }

  private async executeShowDiffAndAsk(
    filePath: string,
    oldContent: string,
    newContent: string,
    actionLabel: string,
  ): Promise<boolean> {
    const timerId = this.logger?.diffStart(filePath, actionLabel);

    const id = randomUUID().slice(0, 8);
    const ext = path.extname(filePath) || ".txt";
    const oldFile = path.join(this.tempDir, `current-${id}${ext}`);
    const newFile = path.join(this.tempDir, `proposed-${id}${ext}`);

    try {
      await mkdir(this.tempDir, { recursive: true });
      await writeFile(oldFile, oldContent, "utf8");
      await writeFile(newFile, newContent, "utf8");

      const oldUri = vscode.Uri.file(oldFile);
      const newUri = vscode.Uri.file(newFile);

      await vscode.commands.executeCommand(
        "vscode.diff",
        oldUri,
        newUri,
        `${actionLabel}: ${path.basename(filePath)} (Current ↔ Proposed)`,
        {
          preview: true,
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.One,
        },
      );

      /*
       * Brief delay (200ms) to allow VS Code layout transition
       * and focus changes to complete before opening the prompt.
       * This prevents focus-stealing from auto-dismissing the warning dialog.
       */
      await new Promise((resolve) => setTimeout(resolve, 200));

      const choice = await vscode.window.showWarningMessage(
        `Apply changes to ${path.basename(filePath)}?`,
        "Apply",
        "Cancel",
      );

      /*
       * Close the diff editor tab.
       */
      try {
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
      } catch {
        /* ignore */
      }

      /*
       * Clean up temp files.
       */
      await this.cleanupTemp(oldFile);
      await this.cleanupTemp(newFile);

      const applied = choice === "Apply";

      if (timerId !== undefined) {
        this.logger?.diffEnd(timerId, filePath, applied);
      }

      if (applied) {
        /*
         * Open actual file after write completes.
         * Short delay lets tool finish writing.
         */
        setTimeout(() => {
          void this.openFileAtChangedLine(filePath, oldContent, newContent);
        }, 500);
      }

      return applied;
    } catch (error) {
      await this.cleanupTemp(oldFile);
      await this.cleanupTemp(newFile);

      if (timerId !== undefined) {
        this.logger?.diffEnd(timerId, filePath, false);
      }

      this.logger?.error(
        "Diff preview failed",
        error instanceof Error ? error.message : "Unknown",
      );

      /*
       * Fail open on diff error — let tool proceed.
       * The security checks already passed.
       */
      return true;
    }
  }

  private async cleanupTemp(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      /* ignore — temp file may not exist */
    }
  }

  private async openFileAtChangedLine(
    filePath: string,
    oldContent: string,
    newContent: string,
  ): Promise<void> {
    try {
      const actualPath = path.resolve(this.workspaceRoot, filePath);
      const fileUri = vscode.Uri.file(actualPath);
      const changedLine = this.findFirstChangedLine(oldContent, newContent);

      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, {
        /*
         * ALWAYS open files in column One (editor column).
         * Never in Beside (which would be the chat column).
         * preview: false = full tab, not peek.
         * preserveFocus: false = focus the file so user can edit.
         */
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });

      if (changedLine >= 0) {
        const line = Math.min(changedLine, doc.lineCount - 1);
        const range = new vscode.Range(line, 0, line, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(line, 0, line, 0);
      }
    } catch {
      /* silent — best effort */
    }
  }

  private applyPatchInMemory(
    content: string,
    operation: string,
    args: Record<string, unknown>,
  ): string | null {
    const op = String(operation).toLowerCase();
    const lines = content.split("\n");

    /*
     * Search/replace mode.
     */
    if (typeof args["search"] === "string" && args["search"] !== "") {
      const search = args["search"] as string;
      const replace =
        typeof args["replace"] === "string" ? (args["replace"] as string) : "";
      if (!content.includes(search)) return null;
      return content.replace(search, replace);
    }

    const startLine =
      typeof args["start_line"] === "number"
        ? (args["start_line"] as number)
        : 0;
    const endLine =
      typeof args["end_line"] === "number"
        ? (args["end_line"] as number)
        : startLine;
    const newContent =
      typeof args["content"] === "string" ? (args["content"] as string) : "";

    switch (op) {
      case "replace": {
        if (startLine < 1 || endLine > lines.length) return null;
        return [
          ...lines.slice(0, startLine - 1),
          ...newContent.split("\n"),
          ...lines.slice(endLine),
        ].join("\n");
      }
      case "insert": {
        if (startLine < 0 || startLine > lines.length) return null;
        return [
          ...lines.slice(0, startLine),
          ...newContent.split("\n"),
          ...lines.slice(startLine),
        ].join("\n");
      }
      case "delete": {
        if (startLine < 1 || endLine > lines.length) return null;
        return [...lines.slice(0, startLine - 1), ...lines.slice(endLine)].join(
          "\n",
        );
      }
      default:
        return null;
    }
  }

  /*
   * Find the first line that differs between
   * old and new content. Returns 0-based line number.
   */
  private findFirstChangedLine(oldContent: string, newContent: string): number {
    if (oldContent === "") return 0;

    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) return i;
    }

    return 0;
  }
}