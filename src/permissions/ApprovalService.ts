import type {
  PermissionManager,
  PermissionRequest,
} from "./PermissionManager.js";

import { ApprovalController } from "./ApprovalController.js";
import type { AuditLog } from "../audit/AuditLog.js";

/*
 * Permissions that always require fresh approval.
 * These have side effects — same path, different content.
 */
const ALWAYS_ASK_PERMISSIONS = new Set([
  "write_file",
  "delete_file",
  "run_command",
  "git_operation",
]);

/*
 * Permissions safe to auto-approve once workspace
 * read is granted by the user.
 */
const WORKSPACE_READ_PERMISSIONS = new Set([
  "read_file",
]);

export class ApprovalService implements PermissionManager {
  private readonly sessionMemory = new Set<string>();

  /*
   * Workspace-level read approval.
   *
   * When true: all read_file within workspace
   * auto-approved without per-file prompts.
   *
   * Set once at session start when user grants
   * workspace read permission.
   *
   * Matches Copilot/Cursor behavior — opening a
   * workspace implies consent to read its files.
   *
   * Security: SecurityPolicy and WorkspaceManager
   * still enforce workspace boundary. This only
   * skips the user prompt, not the security check.
   */
  private workspaceReadApproved = false;

  constructor(
    private readonly controller: ApprovalController,
    private readonly auditLog?: AuditLog,
  ) {}

  /*
   * Grant workspace-level read approval.
   * Called once at session start by the VS Code
   * extension or terminal startup flow.
   */
  approveWorkspaceRead(workspaceRoot: string): void {
    this.workspaceReadApproved = true;
    void workspaceRoot;
  }

  isWorkspaceReadApproved(): boolean {
    return this.workspaceReadApproved;
  }

  async check(request: PermissionRequest): Promise<boolean> {
    const approvalKey =
      `${request.permission}:${request.target ?? "no-target"}`;

    this.auditLog?.logRequest(
      request.permission,
      request.target,
      request.reason,
    );

    /*
     * Workspace read auto-approval.
     *
     * If workspace read was granted and this is a
     * read_file request, auto-approve.
     *
     * Security checks (path validation, workspace
     * boundary) already ran in PermissionGateway.
     * This only skips the user prompt.
     */
    if (
      this.workspaceReadApproved &&
      WORKSPACE_READ_PERMISSIONS.has(request.permission)
    ) {
      this.auditLog?.logApproval(
        request.permission,
        request.target,
      );
      return true;
    }

    /*
     * Session memory: safe operations auto-approve
     * for same path within session.
     * Write/delete/command always ask fresh.
     */
    if (
      this.sessionMemory.has(approvalKey) &&
      !ALWAYS_ASK_PERMISSIONS.has(request.permission)
    ) {
      console.log(
        `\n[Session] Previously approved — ` +
        `auto-allowing: ${approvalKey}`,
      );
      this.auditLog?.logApproval(
        request.permission,
        request.target,
      );
      return true;
    }

    const approved = await this.controller.request(request);

    if (approved) {
      this.auditLog?.logApproval(
        request.permission,
        request.target,
      );
      this.sessionMemory.add(approvalKey);
    } else {
      this.auditLog?.logDenial(
        request.permission,
        request.target,
      );
    }

    return approved;
  }
}