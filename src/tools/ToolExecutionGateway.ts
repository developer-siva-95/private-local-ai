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

const DIFF_PREVIEW_TOOLS = new Set(["write_file", "patch_file"]);

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

export class ToolExecutionGateway {
  private beforeExecuteHook:
    | ((toolName: string, input: ToolInput) => Promise<boolean>)
    | undefined;

  private afterExecuteHook:
    | ((toolName: string, input: ToolInput, success: boolean) => Promise<void>)
    | undefined;

  constructor(
    private readonly permissionGateway: PermissionGateway,
    private readonly auditLog?: AuditLog,
  ) {}

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
    const cwd = this.getSecurityCwd(tool, input);

    const permissionRequest = {
      permission,
      reason,
      ...(target !== undefined ? { target } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };

    const useDiffFlow =
      this.beforeExecuteHook !== undefined && DIFF_PREVIEW_TOOLS.has(tool.name);

    if (useDiffFlow) {
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

      this.auditLog?.logApproval(permission, target);
    } else {
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
        /*
         * Include cwd in the display target so the user sees
         * exactly WHERE the command will run in the approval popup.
         * Example: "npm init -y (in: mysqldbstudy)"
         */
        const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
        return cwd !== "" ? `${target} (in: ${cwd})` : target;
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

  /*
   * Extract the optional cwd parameter from run_command input.
   * Passed to the gateway for path validation (logical + realpath).
   */
  private getSecurityCwd(tool: Tool, input: ToolInput): string | undefined {
    if (tool.permission === Permission.RUN_COMMAND) {
      const cwd = input.cwd;
      if (typeof cwd === "string" && cwd.trim() !== "") {
        return cwd.trim();
      }
    }
    return undefined;
  }
}