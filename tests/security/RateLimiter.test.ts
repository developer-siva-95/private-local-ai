import { describe, expect, it } from "vitest";
import {
  RateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
} from "../../src/security/RateLimiter.js";

describe("RateLimiter", () => {
  /*
   * There are no hard limits.
   * Only informational warnings for large files.
   * These tests verify the warning threshold logic.
   */

  it("does not block any file reads", () => {
    const limiter = new RateLimiter(
      DEFAULT_RATE_LIMITER_CONFIG,
    );

    /*
     * Even a 100MB file should not be blocked.
     * warnIfLarge returns void — it never blocks.
     */
    expect(() => {
      limiter.warnIfLarge(
        104_857_600,
        "huge-file.bin",
      );
    }).not.toThrow();
  });

  it("does not warn for files below threshold", () => {
    const limiter = new RateLimiter(
      DEFAULT_RATE_LIMITER_CONFIG,
    );

    /*
     * Small file — no warning expected.
     * warnIfLarge should complete silently.
     */
    expect(() => {
      limiter.warnIfLarge(
        512_000,
        "small-file.ts",
      );
    }).not.toThrow();
  });

  it("warns for files above 1MB threshold", () => {
    const messages: string[] = [];

    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      messages.push(msg);
    };

    const limiter = new RateLimiter(
      DEFAULT_RATE_LIMITER_CONFIG,
    );

    limiter.warnIfLarge(
      2_097_152,
      "large-file.json",
    );

    console.warn = originalWarn;

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("large-file.json");
  });

  it("does not warn for files exactly at threshold", () => {
    const messages: string[] = [];

    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      messages.push(msg);
    };

    const limiter = new RateLimiter({
      largeFileWarnBytes: 1_048_576,
    });

    limiter.warnIfLarge(
      1_048_576,
      "exactly-at-limit.txt",
    );

    console.warn = originalWarn;

    /*
     * Exactly at threshold — no warning.
     * Only files ABOVE threshold warn.
     */
    expect(messages.length).toBe(0);
  });

  it("warns for package-lock.json sized files", () => {
    const messages: string[] = [];

    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      messages.push(msg);
    };

    const limiter = new RateLimiter(
      DEFAULT_RATE_LIMITER_CONFIG,
    );

    /*
     * Typical package-lock.json is 2-5MB.
     * Should warn but NOT block.
     */
    limiter.warnIfLarge(
      3_145_728,
      "package-lock.json",
    );

    console.warn = originalWarn;

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain(
      "package-lock.json",
    );
  });

  it("allows reading any size file without blocking", () => {
    const limiter = new RateLimiter(
      DEFAULT_RATE_LIMITER_CONFIG,
    );

    /*
     * Verify that warnIfLarge returns void
     * for all file sizes — it never returns
     * false or throws.
     */
    const result500KB = limiter.warnIfLarge(
      512_000,
      "small.ts",
    );
    const result5MB = limiter.warnIfLarge(
      5_242_880,
      "medium.json",
    );
    const result50MB = limiter.warnIfLarge(
      52_428_800,
      "huge.bin",
    );

    expect(result500KB).toBeUndefined();
    expect(result5MB).toBeUndefined();
    expect(result50MB).toBeUndefined();
  });

  it("uses custom warning threshold", () => {
    const messages: string[] = [];

    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      messages.push(msg);
    };

    /*
     * Custom threshold of 500KB.
     * A 600KB file should trigger a warning.
     */
    const limiter = new RateLimiter({
      largeFileWarnBytes: 512_000,
    });

    limiter.warnIfLarge(
      614_400,
      "medium-file.ts",
    );

    console.warn = originalWarn;

    expect(messages.length).toBeGreaterThan(0);
  });
});