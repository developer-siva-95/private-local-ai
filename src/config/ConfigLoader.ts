import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { PrivateAiConfig, RawConfig } from "./ConfigTypes.js";
import { DEFAULT_CONFIG } from "./ConfigTypes.js";

/*
 * ConfigLoader
 *
 * Loads configuration from multiple sources
 * with the following priority order:
 *
 * Priority 1: .private_ai/config.json (project-specific)
 * Priority 2: .env file (project environment)
 * Priority 3: process.env (system environment)
 * Priority 4: DEFAULT_CONFIG (hardcoded defaults)
 *
 * Higher priority values override lower priority values.
 * Missing values fall through to next priority level.
 *
 * Security:
 *   Config files must resolve inside the workspace.
 *   All values validated before use.
 *   Never executes config values.
 */
export class ConfigLoader {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /*
   * Load and merge all configuration sources.
   * Returns the final merged configuration.
   */
  load(): PrivateAiConfig {
    /*
     * Start with defaults.
     * Each layer overrides only the keys it provides.
     */
    const raw: RawConfig = {};

    /*
     * Layer 3: process.env (system environment).
     * Applied first so higher priorities can override.
     */
    this.mergeFromProcessEnv(raw);

    /*
     * Layer 2: .env file.
     * Overrides system environment.
     */
    const envFilePath = path.join(
      this.workspaceRoot,
      ".env",
    );

    if (this.isPathSafe(envFilePath)) {
      const envRaw = this.loadEnvFile(envFilePath);
      this.mergeRaw(raw, envRaw);
    }

    /*
     * Layer 1: .private_ai/config.json.
     * Highest priority — overrides everything.
     */
    const projectConfigPath = path.join(
      this.workspaceRoot,
      ".private_ai",
      "config.json",
    );

    if (this.isPathSafe(projectConfigPath)) {
      const projectRaw = this.loadJsonConfig(
        projectConfigPath,
      );
      this.mergeRaw(raw, projectRaw);
    }

    /*
     * Parse and validate the merged raw config.
     * Apply defaults for any missing values.
     */
    return this.parseAndValidate(raw);
  }

  /*
   * Check if a path is safe to read.
   * Must exist and resolve inside workspace.
   */
  private isPathSafe(filePath: string): boolean {
    if (!existsSync(filePath)) {
      return false;
    }

    const resolved = path.resolve(filePath);
    const relative = path.relative(
      this.workspaceRoot,
      resolved,
    );

    /*
     * Path must be inside workspace.
     * Cannot be outside (../../etc/passwd).
     */
    const isInside =
      relative === "" ||
      (!relative.startsWith("..") &&
        !path.isAbsolute(relative));

    return isInside;
  }

  /*
   * Load and parse a .env file.
   *
   * Format:
   *   KEY=VALUE
   *   KEY="VALUE WITH SPACES"
   *   KEY='VALUE WITH SPACES'
   *   # comment lines ignored
   *   empty lines ignored
   *
   * Handles both LF and CRLF line endings (Windows).
   */
  private loadEnvFile(filePath: string): RawConfig {
    const result: RawConfig = {};

    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return result;
    }

    /*
     * Normalize line endings.
     * Replace CRLF with LF for Windows compatibility.
     */
    const lines = content
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      /*
       * Skip empty lines and comments.
       */
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }

      /*
       * Find the first = sign.
       * Value may contain = signs.
       */
      const eqIndex = trimmed.indexOf("=");

      if (eqIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      if (key === "") {
        continue;
      }

      /*
       * Strip surrounding quotes if present.
       * Handles both single and double quotes.
       */
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      this.setRawKey(result, key, value);
    }

    return result;
  }

  /*
   * Load and parse a .private_ai/config.json file.
   *
   * Accepts both formats:
   *   { "OLLAMA_URL": "..." }  ← uppercase keys
   *   { "ollamaUrl": "..." }   ← camelCase keys
   */
  private loadJsonConfig(filePath: string): RawConfig {
    const result: RawConfig = {};

    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return result;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(
        `[ConfigLoader] Invalid JSON in ${filePath} — using defaults.`,
      );
      return result;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return result;
    }

    const obj = parsed as Record<string, unknown>;

    /*
     * Support both UPPER_CASE and camelCase keys.
     */
    const keyMap: Record<string, keyof RawConfig> = {
      OLLAMA_URL: "OLLAMA_URL",
      ollamaUrl: "OLLAMA_URL",
      MODEL_NAME: "MODEL_NAME",
      modelName: "MODEL_NAME",
      FALLBACK_MODEL: "FALLBACK_MODEL",
      fallbackModel: "FALLBACK_MODEL",
      APPROVAL_TIMEOUT_SECONDS: "APPROVAL_TIMEOUT_SECONDS",
      approvalTimeoutSeconds: "APPROVAL_TIMEOUT_SECONDS",
      DEBUG_MODE: "DEBUG_MODE",
      debugMode: "DEBUG_MODE",
      ENABLED_TOOLS: "ENABLED_TOOLS",
      enabledTools: "ENABLED_TOOLS",
      CONTEXT_SIZE: "CONTEXT_SIZE",
      contextSize: "CONTEXT_SIZE",
    };

    for (const [jsonKey, rawKey] of Object.entries(keyMap)) {
      const val = obj[jsonKey];
      if (val !== undefined) {
        result[rawKey] = String(val);
      }
    }

    return result;
  }

  /*
   * Merge relevant keys from process.env into raw config.
   */
  private mergeFromProcessEnv(raw: RawConfig): void {
    const envKeys: Array<keyof RawConfig> = [
      "OLLAMA_URL",
      "MODEL_NAME",
      "FALLBACK_MODEL",
      "APPROVAL_TIMEOUT_SECONDS",
      "DEBUG_MODE",
      "ENABLED_TOOLS",
      "CONTEXT_SIZE",
    ];

    for (const key of envKeys) {
      const val = process.env[key];
      if (val !== undefined && val !== "") {
        raw[key] = val;
      }
    }

    /*
     * Also check PROJECT_ROOT for backward compatibility.
     * This is handled separately in config.ts.
     */
  }

  /*
   * Merge source into target.
   * Only overwrites keys that are present in source.
   */
  private mergeRaw(
    target: RawConfig,
    source: RawConfig,
  ): void {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== "") {
        (target as Record<string, string>)[key] = value;
      }
    }
  }

  /*
   * Set a key in RawConfig by string key name.
   * Ignores unknown keys silently.
   */
  private setRawKey(
    result: RawConfig,
    key: string,
    value: string,
  ): void {
    const validKeys: Record<string, keyof RawConfig> = {
      OLLAMA_URL: "OLLAMA_URL",
      MODEL_NAME: "MODEL_NAME",
      FALLBACK_MODEL: "FALLBACK_MODEL",
      APPROVAL_TIMEOUT_SECONDS: "APPROVAL_TIMEOUT_SECONDS",
      DEBUG_MODE: "DEBUG_MODE",
      ENABLED_TOOLS: "ENABLED_TOOLS",
      CONTEXT_SIZE: "CONTEXT_SIZE",
    };

    const rawKey = validKeys[key];
    if (rawKey !== undefined) {
      result[rawKey] = value;
    }
  }

  /*
   * Parse raw string values into typed config.
   * Apply defaults for missing values.
   * Validate all values — use default if invalid.
   */
  private parseAndValidate(raw: RawConfig): PrivateAiConfig {
    return {
      ollamaUrl: this.parseUrl(
        raw.OLLAMA_URL,
        DEFAULT_CONFIG.ollamaUrl,
      ),

      modelName: this.parseString(
        raw.MODEL_NAME,
        DEFAULT_CONFIG.modelName,
      ),

      fallbackModel: this.parseString(
        raw.FALLBACK_MODEL,
        DEFAULT_CONFIG.fallbackModel,
      ),

      approvalTimeoutSeconds: this.parsePositiveInt(
        raw.APPROVAL_TIMEOUT_SECONDS,
        DEFAULT_CONFIG.approvalTimeoutSeconds,
      ),

      debugMode: this.parseBool(
        raw.DEBUG_MODE,
        DEFAULT_CONFIG.debugMode,
      ),

      enabledTools: this.parseString(
        raw.ENABLED_TOOLS,
        DEFAULT_CONFIG.enabledTools,
      ),

      contextSize: this.parsePositiveInt(
        raw.CONTEXT_SIZE,
        DEFAULT_CONFIG.contextSize,
      ),
    };
  }

  /*
   * Parse and validate a URL string.
   * Must be http:// or https://.
   * Falls back to default if invalid.
   */
  private parseUrl(
    value: string | undefined,
    defaultValue: string,
  ): string {
    if (value === undefined || value.trim() === "") {
      return defaultValue;
    }

    const trimmed = value.trim();

    try {
      const url = new URL(trimmed);
      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:"
      ) {
        console.warn(
          `[ConfigLoader] Invalid URL protocol: ${trimmed} — using default.`,
        );
        return defaultValue;
      }
      return trimmed;
    } catch {
      console.warn(
        `[ConfigLoader] Invalid URL: ${trimmed} — using default.`,
      );
      return defaultValue;
    }
  }

  /*
   * Parse a non-empty string value.
   * Falls back to default if empty or missing.
   * Strips whitespace.
   * Rejects values containing shell injection chars.
   */
  private parseString(
    value: string | undefined,
    defaultValue: string,
  ): string {
    if (value === undefined || value.trim() === "") {
      return defaultValue;
    }

    const trimmed = value.trim();

    /*
     * Reject injection attempts in config values.
     */
    const dangerousChars = [
      ";", "&&", "||", "`", "$(",
      "\n", "\r", "\0",
    ];

    for (const char of dangerousChars) {
      if (trimmed.includes(char)) {
        console.warn(
          `[ConfigLoader] Rejected config value containing ` +
          `dangerous character — using default.`,
        );
        return defaultValue;
      }
    }

    return trimmed;
  }

  /*
   * Parse a positive integer.
   * Falls back to default if invalid.
   */
  private parsePositiveInt(
    value: string | undefined,
    defaultValue: number,
  ): number {
    if (value === undefined || value.trim() === "") {
      return defaultValue;
    }

    const parsed = parseInt(value.trim(), 10);

    if (isNaN(parsed) || parsed <= 0) {
      console.warn(
        `[ConfigLoader] Invalid positive integer: ${value} — using default.`,
      );
      return defaultValue;
    }

    return parsed;
  }

  /*
   * Parse a boolean value.
   * Accepts: true/false/1/0/yes/no (case-insensitive).
   * Falls back to default if unrecognized.
   */
  private parseBool(
    value: string | undefined,
    defaultValue: boolean,
  ): boolean {
    if (value === undefined || value.trim() === "") {
      return defaultValue;
    }

    const lower = value.trim().toLowerCase();

    if (lower === "true" || lower === "1" || lower === "yes") {
      return true;
    }

    if (lower === "false" || lower === "0" || lower === "no") {
      return false;
    }

    console.warn(
      `[ConfigLoader] Unrecognized boolean value: ${value} — using default.`,
    );
    return defaultValue;
  }
}