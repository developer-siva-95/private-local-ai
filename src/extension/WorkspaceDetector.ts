import * as vscode from "vscode";
import * as path from "node:path";

/*
 * WorkspaceDetector
 *
 * Detects the active workspace root from VS Code.
 *
 * Priority:
 * 1. First workspace folder open in VS Code
 * 2. Parent directory of the active file
 * 3. Fallback to home directory (safe default)
 *
 * This replaces WorkspaceProvider from the terminal
 * version which reads from config/environment.
 */
export class WorkspaceDetector {
  /*
   * Get the workspace root path.
   *
   * Returns the first workspace folder if open.
   * Falls back to the active file's directory.
   * Final fallback is the user's home directory.
   */
  static getWorkspaceRoot(): string {
    /*
     * Check for open workspace folders first.
     * This is the most reliable source.
     */
    const folders = vscode.workspace.workspaceFolders;

    if (folders !== undefined && folders.length > 0) {
      const firstFolder = folders[0];
      if (firstFolder !== undefined) {
        return firstFolder.uri.fsPath;
      }
    }

    /*
     * Fall back to active editor's file directory.
     * Useful when a single file is open without
     * a workspace folder.
     */
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor !== undefined) {
      return path.dirname(
        activeEditor.document.uri.fsPath,
      );
    }

    /*
     * Final fallback — use home directory.
     * This should rarely happen.
     */
    return process.env["HOME"] ??
      process.env["USERPROFILE"] ??
      process.cwd();
  }

  /*
   * Watch for workspace folder changes.
   * Calls callback when workspace changes.
   *
   * Returns a disposable that stops watching.
   */
  static onWorkspaceChange(
    callback: (newRoot: string) => void,
  ): vscode.Disposable {
    return vscode.workspace.onDidChangeWorkspaceFolders(() => {
      callback(WorkspaceDetector.getWorkspaceRoot());
    });
  }
}