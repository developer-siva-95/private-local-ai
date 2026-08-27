export interface AgentRequest {
  message: string;
  /*
   * Called once per streamed token from the LLM.
   * Passed through to LLMProvider.generate().
   *
   * Optional — existing callers unaffected.
   * Used by InteractiveLoop to print tokens
   * as they arrive for Copilot-like feel.
   */
  userIntent?: string;   // ADD THIS — original user text for intent detection
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface AgentResponse {
  success: boolean;
  content: string;
  error?: string;
  /*
   * Present when conversation history is approaching
   * the context window limit.
   *
   * Estimated at chars/4 tokens.
   * Threshold: 70% of 8192 tokens = 5734 tokens.
   *
   * Non-blocking — response is still returned.
   * InteractiveLoop prints this as a visible warning.
   *
   * Optional — only present when threshold exceeded.
   * Existing callers unaffected when not present.
   */
  contextWarning?: string;
}

export interface AgentContext {
  workspaceRoot: string;
}