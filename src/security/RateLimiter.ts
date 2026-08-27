import type { AuditLog } from "../audit/AuditLog.js";

export interface RateLimiterConfig {
  /*
   * Files larger than this threshold will
   * trigger an informational warning.
   *
   * This is NOT a hard block.
   * The file will still be read.
   *
   * This just informs the user that the file
   * is large and may slow down the LLM response
   * or exceed the model's context window.
   */
  largeFileWarnBytes: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig =
  {
    /*
     * Warn for files larger than 1MB.
     * No hard limit — the agent can read
     * any size file within the workspace.
     */
    largeFileWarnBytes: 1_048_576,
  };

/*
 * RateLimiter
 *
 * Provides informational warnings for large
 * file reads. Does NOT block any operations.
 *
 * Hard limits are intentionally removed because:
 *
 * 1. The user approves every operation manually.
 *    The human is the ultimate rate limiter.
 *
 * 2. MAX_TOOL_ITERATIONS = 10 inside Agent.ts
 *    prevents runaway loops per single request.
 *
 * 3. Professional agents like Antigravity and
 *    Cursor do not impose arbitrary session limits.
 *    They trust the user to remain in control.
 *
 * 4. Blocking by file size would prevent the
 *    agent from reading large but legitimate
 *    files like package-lock.json, database
 *    schemas, or generated config files.
 */
export class RateLimiter {
  constructor(
    private readonly config: RateLimiterConfig,
    private readonly auditLog?: AuditLog,
  ) {}

  /*
   * Warn if a file is large enough to potentially
   * cause problems with the LLM context window.
   *
   * This is purely informational.
   * The file WILL still be read regardless.
   */
  warnIfLarge(
    fileSizeBytes: number,
    filePath: string,
  ): void {
    if (
      fileSizeBytes > this.config.largeFileWarnBytes
    ) {
      const sizeMB = (
        fileSizeBytes / 1_048_576
      ).toFixed(2);

      const warnMB = (
        this.config.largeFileWarnBytes / 1_048_576
      ).toFixed(0);

      console.warn(
        `\n[Notice] Large file detected: ${filePath}` +
          ` (${sizeMB}MB > ${warnMB}MB threshold).` +
          ` The model may not process the full` +
          ` content if it exceeds its context window.` +
          ` Consider asking the agent to search for` +
          ` specific sections instead of reading` +
          ` the entire file.`,
      );
    }
  }
}