/*
 * ContentScanner
 *
 * Scans external and file content for potentially
 * dangerous patterns before passing to the LLM.
 *
 * Applied to:
 *   - File contents read via read_file
 *   - Web content fetched via web_access
 *
 * NOT applied to:
 *   - User-typed messages (user owns their input)
 *   - User-selected code for slash commands
 *
 * Behavior:
 *   - WARN only — never blocks content
 *   - Returns list of warning strings
 *   - Empty list means no suspicious content
 *   - Warnings are included in tool output
 *   - User sees warnings via assistant response
 *
 * Security invariant:
 *   ContentScanner never prevents tool execution.
 *   It only annotates content with warnings.
 *   The user approved the operation already.
 */

export interface ScanResult {
  warnings: string[];
  hasWarnings: boolean;
}

/*
 * Patterns that indicate potentially dangerous content.
 * Each entry: [pattern, human-readable description]
 */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [
    /eval\s*\(/g,
    "contains eval() — potential code execution risk",
  ],
  [
    /exec\s*\(/g,
    "contains exec() — potential process execution risk",
  ],
  [
    /spawn\s*\(/g,
    "contains spawn() — potential process execution risk",
  ],
  [
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    "contains a private key — sensitive credential detected",
  ],
  [
    /-----BEGIN\s+CERTIFICATE-----/g,
    "contains a certificate — sensitive credential detected",
  ],
];

/*
 * Prompt injection patterns.
 * These attempt to override the LLM's instructions.
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
    "contains prompt injection: 'ignore previous instructions'",
  ],
  [
    /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
    "contains prompt injection: 'disregard instructions'",
  ],
  [
    /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
    "contains prompt injection: 'forget instructions'",
  ],
  [
    /you\s+are\s+now\s+(?:a\s+)?(?:an?\s+)?(?:different|new|another)/gi,
    "contains prompt injection: role override attempt",
  ],
  [
    /new\s+system\s+instructions?\s*:/gi,
    "contains prompt injection: system instruction override",
  ],
  [
    /\[system\]\s*:/gi,
    "contains prompt injection: [system] tag",
  ],
];

export class ContentScanner {
  /*
   * Scan content for dangerous patterns.
   *
   * Returns a ScanResult with warnings.
   * Empty warnings array means content is clean.
   *
   * This method is pure — no side effects.
   * Callers decide what to do with warnings.
   */
  scan(content: string, source: string): ScanResult {
    const warnings: string[] = [];

    /*
     * Check dangerous code patterns.
     */
    for (const [pattern, description] of DANGEROUS_PATTERNS) {
      /*
       * Reset lastIndex for global regex.
       */
      pattern.lastIndex = 0;

      if (pattern.test(content)) {
        warnings.push(
          `[SECURITY WARNING] ${source} ${description}.`,
        );
        console.log(
          `\n[SECURITY] ContentScanner: ${source} ${description}.`,
        );
      }
    }

    /*
     * Check prompt injection patterns.
     */
    for (const [pattern, description] of INJECTION_PATTERNS) {
      pattern.lastIndex = 0;

      if (pattern.test(content)) {
        warnings.push(
          `[SECURITY WARNING] ${source} ${description}.`,
        );
        console.log(
          `\n[SECURITY] ContentScanner: ${source} ${description}.`,
        );
      }
    }

    return {
      warnings,
      hasWarnings: warnings.length > 0,
    };
  }

  /*
   * Format warnings as a compact block to prepend
   * to tool output so the LLM sees them.
   *
   * Returns empty string if no warnings.
   */
  formatWarnings(warnings: string[]): string {
    if (warnings.length === 0) {
      return "";
    }

    return (
      "⚠️  SECURITY SCAN WARNINGS:\n" +
      warnings.map((w) => `  ${w}`).join("\n") +
      "\n\n"
    );
  }
}

/*
 * Singleton instance for use across tools.
 * ContentScanner is stateless — safe to share.
 */
export const contentScanner = new ContentScanner();