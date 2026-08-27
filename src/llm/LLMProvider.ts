export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  /*
   * Force the model to call a tool.
   * Ollama uses this via tool_choice option.
   * Used by Agent when enforcer detects a destructive intent
   * and refuses to accept a text-only response.
   */
  requireToolCall?: boolean;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description?: string;
      }
    >;
    required?: string[];
  };
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMResponse>;
}