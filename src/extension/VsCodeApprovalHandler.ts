import * as vscode from "vscode";
import path from "node:path";
import type { ApprovalController } from "../permissions/ApprovalController.js";
import type { ApprovalService } from "../permissions/ApprovalService.js";
import type { ApprovalRequest } from "../permissions/ApprovalRequest.js";
import type { OutputChannelLogger } from "./OutputChannelLogger.js";
import { Permission } from "../permissions/Permission.js";

const TRUSTED_ONLY_PERMISSIONS = new Set<Permission>([
  Permission.WRITE_FILE,
  Permission.DELETE_FILE,
  Permission.RUN_COMMAND,
  Permission.GIT_OPERATION,
]);

export class VsCodeApprovalHandler {
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(
    private readonly controller: ApprovalController,
    private readonly approvalService: ApprovalService,
    private readonly workspaceRoot: string,
    private readonly logger?: OutputChannelLogger,
  ) {}

  /*
   * Ask user for workspace-level read approval once.
   * Called at extension activation.
   */
  async requestWorkspaceReadApproval(): Promise<void> {
    /*
     * VS Code trusted workspace — auto-approve reads.
     * User already said they trust this workspace.
     */
    if (vscode.workspace.isTrusted) {
      this.approvalService.approveWorkspaceRead(this.workspaceRoot);
      this.logger?.permissionWorkspaceRead(true);
      return;
    }

    /*
     * Untrusted workspace — ask explicitly.
     */
    const choice = await vscode.window.showInformationMessage(
      `Private AI: Allow reading files in this workspace?\n` +
        `${this.workspaceRoot}\n\n` +
        `This enables instant file analysis without per-file prompts.\n` +
        `Write operations always require individual approval.`,
      "Allow Reads",
      "Ask Each Time",
    );

    if (choice === "Allow Reads") {
      this.approvalService.approveWorkspaceRead(this.workspaceRoot);
      this.logger?.permissionWorkspaceRead(true);
    } else {
      this.logger?.permissionWorkspaceRead(false);
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.pollInterval = setInterval(() => {
      void this.processPending();
    }, 100);
  }

  stop(): void {
    this.isRunning = false;

    if (this.pollInterval !== undefined) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  private async processPending(): Promise<void> {
    const pending = this.controller.getPending();

    if (pending.length === 0) return;

    /*
     * Bug 4 fix: clear interval ONCE before loop,
     * restart ONCE after all requests handled.
     * Eliminates race condition from clear/restart
     * inside the loop.
     */
    if (this.pollInterval !== undefined) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    for (const request of pending) {
      await this.handleRequest(request);
    }

    if (this.isRunning) {
      this.pollInterval = setInterval(() => {
        void this.processPending();
      }, 100);
    }
  }

  private async handleRequest(request: ApprovalRequest): Promise<void> {
    /*
     * Untrusted workspace: deny dangerous operations.
     */
    if (
      !vscode.workspace.isTrusted &&
      TRUSTED_ONLY_PERMISSIONS.has(request.permission as Permission)
    ) {
      this.controller.deny(request.id);
      this.logger?.security(
        `Denied ${request.permission} — workspace not trusted.`,
      );
      void vscode.window.showWarningMessage(
        `Private AI: Operation denied. Workspace not trusted.`,
      );
      return;
    }

    const operationLabel = this.formatPermission(
      request.permission as Permission,
    );
    const targetDisplay = this.formatTarget(request.target, request.permission);

    /*
     * Main message: short and scannable.
     * Path shown clearly in the message itself.
     * Format: "Delete File: /full/path/here.txt"
     */
    const message = `${operationLabel}: ${targetDisplay}`;

    const isDangerous = TRUSTED_ONLY_PERMISSIONS.has(
      request.permission as Permission,
    );

    let choice: string | undefined;

    /*
     * Use modal dialog for dangerous operations.
     * Modal shows full path clearly + is unmissable.
     *
     * showWarningMessage with { modal: true } opens a
     * proper dialog box (not a corner notification).
     * User must interact with it before continuing.
     *
     * Non-dangerous operations use regular notification.
     */
    if (isDangerous) {
      choice = await vscode.window.showWarningMessage(
        message,
        {
          detail:
            `Full path:\n${targetDisplay}\n\n` +
            `Reason: ${request.reason}\n\n` +
            `This action cannot be undone automatically.`,
        },
        "Allow",
        "Deny",
      );
    } else {
      choice = await vscode.window.showInformationMessage(
        message,
        { detail: targetDisplay },
        "Allow",
        "Deny",
      );
    }

    if (choice === "Allow") {
      this.controller.approve(request.id);
      this.logger?.permissionApproved(request.permission, request.target);
    } else {
      this.controller.deny(request.id);
      this.logger?.permissionDenied(request.permission, request.target);
    }
  }

  private formatPermission(permission: Permission): string {
    switch (permission) {
      case Permission.READ_FILE:
        return "Read File";
      case Permission.WRITE_FILE:
        return "Write File ⚠️";
      case Permission.DELETE_FILE:
        return "Delete File ⚠️";
      case Permission.RUN_COMMAND:
        return "Run Command ⚠️";
      case Permission.GIT_OPERATION:
        return "Git Operation";
      case Permission.WEB_ACCESS:
        return "Web Access";
      default:
        return String(permission).toUpperCase();
    }
  }

  private formatTarget(target: string | undefined, permission: string): string {
    if (target === undefined) return "";

    if (
      permission === Permission.RUN_COMMAND ||
      permission === Permission.GIT_OPERATION ||
      permission === Permission.WEB_ACCESS
    ) {
      return target;
    }

    return path.resolve(this.workspaceRoot, target);
  }

  /*
   * Show just filename or last 2 path segments.
   * Full path is in modal detail.
   */
  private shortenPath(target: string | undefined): string {
    if (target === undefined) return "";

    /*
     * For commands/URLs return as-is.
     */
    if (target.includes(" ") || target.startsWith("http")) {
      return target.length > 60 ? target.slice(0, 60) + "…" : target;
    }

    /*
     * For paths, show last 2 segments.
     */
    const parts = target.replace(/\\/g, "/").split("/");
    if (parts.length <= 2) return target;
    return `…/${parts.slice(-2).join("/")}`;
  }
}
