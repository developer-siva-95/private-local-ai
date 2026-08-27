import * as vscode from "vscode";
import type { OutputChannelLogger } from "./OutputChannelLogger.js";

/*
 * StatusBarManager
 *
 * Shows a persistent status item at the bottom
 * of VS Code indicating the current state of
 * Private AI.
 *
 * States:
 *   ● Ready          — agent idle, waiting for input
 *   ⠋ Thinking...    — agent processing a request
 *   ⚠ Approval       — waiting for user approval
 *   ✗ Error          — something went wrong
 *   ○ Offline        — Ollama not reachable
 *
 * Click → opens the Output channel for details.
 */

export type AgentStatus =
  | "ready"
  | "thinking"
  | "approval"
  | "error"
  | "offline";

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private currentStatus: AgentStatus = "ready";

  constructor(
    private readonly logger?: OutputChannelLogger,
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );

    this.item.command = "private-ai.showStatus";
    this.setStatus("ready");
    this.item.show();
  }

  /*
   * Update the displayed status.
   * Logs transition to Output Channel.
   * Only updates if the status actually changed.
   */
  setStatus(status: AgentStatus): void {
    if (this.currentStatus === status) return;

    const previous = this.currentStatus;
    this.currentStatus = status;

    /*
     * Log the status transition.
     */
    this.logger?.statusChange(previous, status);

    switch (status) {
      case "ready":
        this.item.text = "$(check) Private AI: Ready";
        this.item.tooltip =
          "Private AI is ready. Click for status.";
        this.item.backgroundColor = undefined;
        break;

      case "thinking":
        this.item.text = "$(loading~spin) Private AI: Thinking...";
        this.item.tooltip =
          "Private AI is processing your request...";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;

      case "approval":
        this.item.text = "$(warning) Private AI: Approval Needed";
        this.item.tooltip =
          "Private AI needs your permission to proceed.";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;

      case "error":
        this.item.text = "$(error) Private AI: Error";
        this.item.tooltip =
          "Private AI encountered an error. Click for details.";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;

      case "offline":
        this.item.text = "$(circle-slash) Private AI: Offline";
        this.item.tooltip =
          "Ollama is not responding. Start Ollama and reload.";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
    }
  }

  getStatus(): AgentStatus {
    return this.currentStatus;
  }

  dispose(): void {
    this.item.dispose();
  }
}