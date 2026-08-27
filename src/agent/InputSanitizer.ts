/*
 * InputSanitizer
 *
 * Validates and sanitizes user input before
 * it reaches the agent or LLM.
 *
 * Security concerns addressed:
 * 1. Oversized input wastes LLM context window
 * 2. Null bytes cause undefined behavior in strings
 * 3. Control characters corrupt terminal output
 * 4. Prompt injection patterns are flagged (not blocked)
 *
 * Design decisions:
 * - Length checked FIRST before any processing
 *   to avoid doing work on malicious huge inputs
 * - Null bytes and control chars removed in ONE pass
 * - Empty checked again AFTER sanitization
 * - Injection patterns flagged but NOT blocked
 *   because our security gateway handles authorization
 *   regardless of what the LLM is told
 * - Specific patterns only to avoid false positives
 */
export interface SanitizeResult {
  valid: boolean;
  value: string;
  error?: string;
  warning?: string;
}

export class InputSanitizer {
  /*
   * Maximum input length in characters.
   * 10000 chars is approximately 2500 tokens.
   * More than enough for any coding request.
   */
  private static readonly MAX_LENGTH = 10_000;

  /*
   * Prompt injection patterns to warn about.
   *
   * These are specific enough to avoid false
   * positives on normal conversation.
   *
   * We WARN but never BLOCK because:
   * 1. User may have legitimate reasons to
   *    discuss these topics
   * 2. Our gateway prevents actual bypass
   *    regardless of LLM instructions
   */
  private static readonly INJECTION_PATTERNS = [
    "ignore all previous instructions",
    "ignore your previous instructions",
    "disregard all previous instructions",
    "forget all previous instructions",
    "your new instructions are",
    "you are now a different",
    "pretend you have no restrictions",
    "act as if you have no",
  ];

  static sanitize(input: string): SanitizeResult {
    /*
     * Step 1: Type check.
     * Input must be a string.
     */
    if (typeof input !== "string") {
      return {
        valid: false,
        value: "",
        error: "Input must be a string.",
      };
    }

    /*
     * Step 2: Length check FIRST.
     *
     * Check raw input length before any processing.
     * This prevents doing expensive regex work on
     * maliciously oversized input.
     */
    if (input.length > InputSanitizer.MAX_LENGTH) {
      return {
        valid: false,
        value: "",
        error:
          `Input too long: ${input.length} characters. ` +
          `Maximum allowed: ${InputSanitizer.MAX_LENGTH} characters.`,
      };
    }

    /*
     * Step 3: Trim whitespace.
     */
    let value = input.trim();

    /*
     * Step 4: Empty check after trim.
     */
    if (value === "") {
      return {
        valid: false,
        value: "",
        error: "A valid message is required.",
      };
    }

    /*
     * Step 5: Remove null bytes and control characters
     * in a single pass.
     *
     * Removed:
     *   \x00       null byte
     *   \x01-\x08  SOH through BS
     *   \x0B       VT (vertical tab)
     *   \x0C       FF (form feed)
     *   \x0E-\x1F  SO through US
     *   \x7F       DEL
     *
     * Kept intentionally:
     *   \x09 (\t)  horizontal tab — valid in code
     *   \x0A (\n)  newline — valid in multi-line input
     *   \x0D (\r)  carriage return — valid on Windows
     */
    value = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    /*
     * Step 6: Empty check after control char removal.
     *
     * Input of only null bytes would pass step 2
     * (short length) but become empty after step 5.
     */
    if (value.trim() === "") {
      return {
        valid: false,
        value: "",
        error: "Input contained only invalid characters.",
      };
    }

    /*
     * Step 7: Check for prompt injection patterns.
     *
     * We warn but do NOT block.
     * Our security gateway handles authorization
     * regardless of LLM instructions.
     */
    const lowerValue = value.toLowerCase();
    let warning: string | undefined;

    for (const pattern of InputSanitizer.INJECTION_PATTERNS) {
      if (lowerValue.includes(pattern)) {
        warning =
          `[Notice] Your message contains a pattern ` +
          `that resembles a prompt injection attempt ` +
          `("${pattern}"). ` +
          `This is logged in the audit trail. ` +
          `Our security gateway enforces all permissions ` +
          `regardless of LLM instructions — ` +
          `tool authorization cannot be bypassed.`;
        break;
      }
    }

    return {
      valid: true,
      value,
      ...(warning !== undefined ? { warning } : {}),
    };
  }
}