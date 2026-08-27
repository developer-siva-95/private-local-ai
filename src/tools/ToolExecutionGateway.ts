import type { Tool, ToolContext, ToolInput, ToolResult } from "./Tool.js";

import type { PermissionGateway } from "../security/PermissionGateway.js";
import { Permission } from "../permissions/Permission.js";
import type { AuditLog } from "../audit/AuditLog.js";
import { withTimeout } from "./ToolTimeout.js";

export interface ToolExecutionRequest {
  tool: Tool;
  input: ToolInput;
  context: ToolContext;
  reason: string;
}

const MAX_RETRIES = 3;
const TIMEOUT_MULTIPLIERS = [1.0, 1.5, 2.0];

const RECOVERY_HINTS: Partial<Record<string, string>> = {
  read_file: "The file may be locked or busy. Try again.",
  list_directory: "The directory may be busy. Try again.",
  search_files: "Try a narrower search scope.",
  web_access: "The network may be slow. Check the URL and try again.",
};

const TRANSIENT_ERROR_PATTERNS = [
  "timed out",
  "timeout",
  "network error",
  "econnrefused",
  "econnreset",
  "etimedout",
  "fetch failed",
];

/*
 * Tool names that show diff preview before execution.
 * Only write operations that modify file content.
 */
const DIFF_PREVIEW_TOOLS = new Set(["write_file", "patch_file"]);

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

export class ToolExecutionGateway {
  /*
   * Optional hook for VS Code diff preview.
   *
   * When set: called AFTER security checks pass
   * but BEFORE tool execution.
   * Returns true to proceed, false to cancel.
   *
   * When not set (terminal mode): ignored.
   * All operations use normal approval flow.
   *
   * Security: hook only runs if security checks pass.
   * A blocked operation never reaches the hook.
   */
  private beforeExecuteHook:
    | ((toolName: string, input: ToolInput) => Promise<boolean>)
    | undefined;

  /*
   * Optional hook called AFTER tool execution.
   * Used for UI cleanup like closing editor tabs
   * after file deletion. Non-blocking.
   */
  private afterExecuteHook:
    | ((toolName: string, input: ToolInput, success: boolean) => Promise<void>)
    | undefined;

  constructor(
    private readonly permissionGateway: PermissionGateway,
    private readonly auditLog?: AuditLog,
  ) {}

  /*
   * Set the diff preview hook.
   * Called by VS Code extension at startup.
   * Not called in terminal mode.
   */
  setBeforeExecuteHook(
    hook: (toolName: string, input: ToolInput) => Promise<boolean>,
  ): void {
    this.beforeExecuteHook = hook;
  }

  setAfterExecuteHook(
    hook: (
      toolName: string,
      input: ToolInput,
      success: boolean,
    ) => Promise<void>,
  ): void {
    this.afterExecuteHook = hook;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResult> {
    const { tool, input, context, reason } = request;

    const permission = tool.permission;
    const target = this.getSecurityTarget(tool, input);

    const permissionRequest = {
      permission,
      reason,
      ...(target !== undefined ? { target } : {}),
    };

    /*
     * Determine the authorization path:
     *
     * Path A — Diff preview flow (VS Code only):
     *   Used when: beforeExecuteHook is set AND
     *              this is a write/patch operation.
     *
     *   1. Run security checks only (no prompt)
     *   2. If security fails → block immediately
     *   3. If security passes → show diff preview
     *   4. Diff preview handles user approval (Apply/Cancel)
     *   5. If cancelled → return cancelled error
     *   6. If approved → execute tool
     *
     * Path B — Normal flow (all other cases):
     *   Used when: no hook, or not a write operation.
     *
     *   1. Run full authorize() = security + user prompt
     *   2. If denied → block
     *   3. If approved → execute tool
     *
     * Security invariant: path validation, workspace
     * boundary, and real path checks run in BOTH paths.
     */
    const useDiffFlow =
      this.beforeExecuteHook !== undefined && DIFF_PREVIEW_TOOLS.has(tool.name);

    if (useDiffFlow) {
      /*
       * Path A: Security check only.
       * No user prompt — diff preview handles approval.
       */
      const securityPassed =
        await this.permissionGateway.securityCheckOnly(permissionRequest);

      if (!securityPassed) {
        console.log(`\n[SECURITY] Blocked by security check: ${tool.name}`);
        this.auditLog?.logExecution(
          permission,
          target,
          false,
          "Security check failed.",
        );
        return {
          success: false,
          output: "",
          error: "Permission denied.",
        };
      }

      /*
       * Security passed. Now show diff preview.
       * The hook shows the diff and asks Apply/Cancel.
       */
      const userApproved = await this.beforeExecuteHook!(tool.name, input);

      if (!userApproved) {
        this.auditLog?.logExecution(
          permission,
          target,
          false,
          "Cancelled in diff preview.",
        );
        return {
          success: false,
          output: "",
          error: "Operation cancelled by user.",
        };
      }

      /*
       * Log approval (diff preview = user approved).
       */
      this.auditLog?.logApproval(permission, target);
    } else {
      /*
       * Path B: Normal authorization with user prompt.
       * Same as always — no change from terminal behavior.
       */
      const allowed = await this.permissionGateway.authorize(permissionRequest);

      if (!allowed) {
        this.auditLog?.logExecution(
          permission,
          target,
          false,
          "Permission denied.",
        );
        return {
          success: false,
          output: "",
          error: "Permission denied.",
        };
      }
    }

    /*
     * Authorization complete (via either path).
     * Execute the tool.
     */
    const controller = new AbortController();
    const enrichedContext: ToolContext = {
      ...context,
      abortSignal: controller.signal,
    };

    try {
      const result = tool.retryable
        ? await this.executeWithRetry(tool, input, enrichedContext)
        : await tool.execute(input, enrichedContext);

      const truncatedResult = this.truncateResult(result);

      this.auditLog?.logExecution(
        permission,
        target,
        truncatedResult.success,
        truncatedResult.error,
      );

      /*
       * After-execute UI hook.
       * Non-blocking — hook errors never fail tool.
       */
      if (this.afterExecuteHook !== undefined) {
        try {
          await this.afterExecuteHook(
            tool.name,
            input,
            truncatedResult.success,
          );
        } catch {
          /* silent — UI cleanup is best-effort */
        }
      }

      return truncatedResult;
    } catch (error) {
      controller.abort();

      const errorMsg =
        error instanceof Error ? error.message : "Tool execution failed.";

      this.auditLog?.logExecution(permission, target, false, errorMsg);

      return {
        success: false,
        output: "",
        error: errorMsg,
      };
    }
  }

  private async executeWithRetry(
    tool: Tool,
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    let lastResult: ToolResult | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(
          `\n  ⚠️  ${tool.name} timed out. ` +
            `Retrying (${attempt}/${MAX_RETRIES - 1})...`,
        );
      }

      const baseTimeout = 30_000;
      const currentTimeout =
        baseTimeout * (TIMEOUT_MULTIPLIERS[attempt] ?? 1.0);

      try {
        const result = await withTimeout(
          tool.execute(input, context),
          currentTimeout,
          tool.name,
          context.abortSignal,
        );

        if (result.success) return result;

        const errorMsg = result.error ?? "";
        if (!isTransientError(errorMsg)) return result;

        lastResult = result;
      } catch (error) {
        if (error instanceof Error && error.message.includes("timed out")) {
          lastResult = {
            success: false,
            output: "",
            error: error.message,
          };
          continue;
        }
        throw error;
      }
    }

    const hint = RECOVERY_HINTS[tool.name] ?? "Try again.";

    return {
      success: false,
      output: "",
      error:
        `${tool.name} failed after ${MAX_RETRIES} attempts. ` +
        (lastResult?.error ? `Last error: ${lastResult.error}. ` : "") +
        hint,
    };
  }

  private truncateResult(result: ToolResult): ToolResult {
    const MAX_OUTPUT_CHARS = 8_000;
    const KEEP_START = 3_500;
    const KEEP_END = 3_500;

    if (result.success && result.output.length > MAX_OUTPUT_CHARS) {
      const start = result.output.slice(0, KEEP_START);
      const end = result.output.slice(result.output.length - KEEP_END);
      const omitted = result.output.length - KEEP_START - KEEP_END;

      return {
        ...result,
        output:
          start +
          `\n\n[... ${omitted} characters omitted — ` +
          `use search_files to find specific content ...]\n\n` +
          end,
      };
    }

    return result;
  }

  private getSecurityTarget(tool: Tool, input: ToolInput): string | undefined {
    switch (tool.permission) {
      case Permission.READ_FILE:
      case Permission.WRITE_FILE:
      case Permission.DELETE_FILE: {
        const target = input.path;
        if (typeof target !== "string") return undefined;
        return target;
      }
      case Permission.RUN_COMMAND: {
        const target = input.command;
        if (typeof target !== "string") return undefined;
        return target;
      }
      case Permission.GIT_OPERATION: {
        const subcommand = input.subcommand;
        const args = input.args;
        if (typeof subcommand !== "string") return undefined;
        const cleanArgs =
          typeof args === "string" && args.trim() !== ""
            ? ` ${args.trim()}`
            : "";
        return `git ${subcommand}${cleanArgs}`;
      }
      case Permission.WEB_ACCESS: {
        const target = input.url;
        if (typeof target !== "string") return undefined;
        return target;
      }
      default:
        return undefined;
    }
  }
}
