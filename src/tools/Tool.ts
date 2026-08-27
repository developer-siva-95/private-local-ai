import type { Permission } from "../permissions/Permission.js";

export interface ToolContext {
  workspaceRoot: string;
  /*
   * Optional signal to cancel the tool execution.
   * Used to kill child processes or abort fetches
   * when a timeout occurs.
   */
  abortSignal?: AbortSignal;
}

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description?: string;
    }
  >;
  required?: string[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly permission: Permission;
  readonly inputSchema: ToolInputSchema;
  readonly retryable: boolean;

  execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult>;
}