/*
 * ConfigTypes
 *
 * All configuration types for Private AI.
 * Used by ConfigLoader and all consumers.
 */

export interface PrivateAiConfig {
  /*
   * Ollama server URL.
   * Must be a valid HTTP/HTTPS URL.
   * Default: http://127.0.0.1:11434
   */
  ollamaUrl: string;

  /*
   * Primary Ollama model name.
   * Default: deepseek-coder-fix
   */
  modelName: string;

  /*
   * Fallback model if primary fails.
   * Empty string means no fallback.
   * Default: "" (no fallback)
   */
  fallbackModel: string;

  /*
   * Seconds to wait for user approval
   * before auto-denying.
   * Default: 60
   */
  approvalTimeoutSeconds: number;

  /*
   * Enable debug logging.
   * Shows raw LLM responses in console.
   * Default: false
   */
  debugMode: boolean;

  /*
   * Comma-separated list of enabled tools.
   * Empty string means all tools enabled.
   * Example: "read_file,write_file,git_operation"
   * Default: "" (all enabled)
   */
  enabledTools: string;
  /*
   * Context window size for Ollama.
   * Lower = less RAM. Higher = more context.
   * Default: 4096
   */
  contextSize: number;

}

/*
 * Default configuration values.
 * Used when no config file or env var overrides.
 */
export const DEFAULT_CONFIG: PrivateAiConfig = {
  ollamaUrl: "http://127.0.0.1:11434",
  modelName: "deepseek-coder-fix",
  fallbackModel: "",
  approvalTimeoutSeconds: 60,
  debugMode: false,
  enabledTools: "",
  contextSize: 8192,
};

/*
 * Raw config as read from files/environment.
 * All values are strings before parsing.
 * All fields are optional — only overrides present.
 */
export interface RawConfig {
  OLLAMA_URL?: string;
  MODEL_NAME?: string;
  FALLBACK_MODEL?: string;
  APPROVAL_TIMEOUT_SECONDS?: string;
  DEBUG_MODE?: string;
  ENABLED_TOOLS?: string;
  CONTEXT_SIZE?: string;
}