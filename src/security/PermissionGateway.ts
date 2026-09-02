import type {
  PermissionManager,
  PermissionRequest,
} from "../permissions/PermissionManager.js";

import { Permission } from "../permissions/Permission.js";
import { SecurityPolicy } from "./SecurityPolicy.js";
import type { ToolOperation } from "./Policy.js";
import { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import type { AuditLog } from "../audit/AuditLog.js";

export interface PermissionGatewayRequest {
  permission: Permission;
  target?: string;
  reason: string;
  /*
   * Optional working directory for RUN_COMMAND.
   * Validated through the same path checks as file operations.
   * Displayed to the user in the approval popup.
   */
  cwd?: string;
}

export class PermissionGateway {
  constructor(
    private readonly securityPolicy: SecurityPolicy,
    private readonly permissionManager: PermissionManager,
    private readonly workspaceManager: WorkspaceManager,
    private readonly auditLog?: AuditLog,
  ) {}

  async authorize(
    request: PermissionGatewayRequest,
  ): Promise<boolean> {
    const securityPassed = await this.runSecurityChecks(request);
    if (!securityPassed) return false;

    const permissionRequest: PermissionRequest = {
      permission: request.permission,
      reason: request.reason,
    };

    if (request.target !== undefined) {
      permissionRequest.target = request.target;
    }

    return this.permissionManager.check(permissionRequest);
  }

  async securityCheckOnly(
    request: PermissionGatewayRequest,
  ): Promise<boolean> {
    const securityPassed = await this.runSecurityChecks(request);

    if (securityPassed) {
      this.auditLog?.logRequest(
        request.permission,
        request.target,
        `${request.reason} [diff-preview approval]`,
      );
    }

    return securityPassed;
  }

  private async runSecurityChecks(
    request: PermissionGatewayRequest,
  ): Promise<boolean> {
    const operation = this.permissionToOperation(request.permission);

    const filesystemPermissions = new Set([
      Permission.READ_FILE,
      Permission.WRITE_FILE,
      Permission.DELETE_FILE,
    ]);

    if (
      filesystemPermissions.has(request.permission) &&
      request.target === undefined
    ) {
      this.auditLog?.logSecurityBlock(
        request.permission,
        undefined,
        "Filesystem permission missing target.",
      );
      return false;
    }

    if (request.target !== undefined && operation !== undefined) {
      const policyDecision = this.securityPolicy.checkPath(
        request.target,
        operation,
      );

      if (!policyDecision.allowed) {
        console.log(
          `\n[SECURITY] Blocked: ${request.target}` +
          ` — ${policyDecision.reason}`,
        );
        this.auditLog?.logSecurityBlock(
          request.permission,
          request.target,
          policyDecision.reason,
        );
        return false;
      }

      if (
        request.permission === Permission.READ_FILE ||
        request.permission === Permission.WRITE_FILE ||
        request.permission === Permission.DELETE_FILE
      ) {
        const realPathAllowed =
          await this.workspaceManager.isRealPathAllowed(request.target);

        if (!realPathAllowed) {
          console.log(
            `\n[SECURITY] Blocked: ${request.target}` +
            ` — real path escapes workspace.`,
          );
          this.auditLog?.logSecurityBlock(
            request.permission,
            request.target,
            "Real path escapes workspace boundary.",
          );
          return false;
        }
      }
    }

    if (request.permission === Permission.RUN_COMMAND && request.target) {
      const commandDecision = this.securityPolicy.checkCommand(request.target);

      if (!commandDecision.allowed) {
        console.log(
          `\n[SECURITY] Blocked command: ` +
          `${request.target} — ${commandDecision.reason}`,
        );
        this.auditLog?.logSecurityBlock(
          request.permission,
          request.target,
          commandDecision.reason,
        );
        return false;
      }
    }

    /*
     * NEW: Validate cwd for RUN_COMMAND.
     *
     * The cwd is a filesystem path, so it must pass the same
     * logical boundary + real path checks as file operations.
     *
     * This prevents the LLM from escaping the workspace by
     * passing a malicious cwd like "../../Windows/System32".
     */
    if (request.permission === Permission.RUN_COMMAND && request.cwd) {
      const cwdDecision = this.securityPolicy.checkPath(
        request.cwd,
        "read",
      );

      if (!cwdDecision.allowed) {
        console.log(
          `\n[SECURITY] Blocked command cwd: ` +
          `${request.cwd} — ${cwdDecision.reason}`,
        );
        this.auditLog?.logSecurityBlock(
          request.permission,
          request.cwd,
          `cwd ${cwdDecision.reason}`,
        );
        return false;
      }

      const cwdRealPathAllowed =
        await this.workspaceManager.isRealPathAllowed(request.cwd);

      if (!cwdRealPathAllowed) {
        console.log(
          `\n[SECURITY] Blocked command cwd: ` +
          `${request.cwd} — real path escapes workspace.`,
        );
        this.auditLog?.logSecurityBlock(
          request.permission,
          request.cwd,
          "cwd real path escapes workspace boundary.",
        );
        return false;
      }
    }

    return true;
  }

  private permissionToOperation(
    permission: Permission,
  ): ToolOperation | undefined {
    switch (permission) {
      case Permission.READ_FILE: return "read";
      case Permission.WRITE_FILE: return "write";
      case Permission.DELETE_FILE: return "delete";
      case Permission.RUN_COMMAND: return "execute";
      case Permission.GIT_OPERATION: return "execute";
      case Permission.WEB_ACCESS: return undefined;
      default: return undefined;
    }
  }
}