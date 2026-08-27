import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker } from "../../src/llm/CircuitBreaker.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    /*
     * Use short recovery time for tests.
     * 100ms instead of 30000ms.
     */
    cb = new CircuitBreaker({
      failureThreshold: 3,
      recoveryMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────
  // Initial state
  // ─────────────────────────────────────────

  it("starts in CLOSED state", () => {
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
  });

  it("returns 0 seconds until recovery when CLOSED", () => {
    expect(cb.getSecondsUntilRecovery()).toBe(0);
  });

  // ─────────────────────────────────────────
  // Success recording
  // ─────────────────────────────────────────

  it("stays CLOSED after a success", () => {
    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
  });

  it("resets failure count on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    /*
     * Only 2 failures after reset — not 4.
     * Circuit should still be CLOSED.
     */
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
  });

  // ─────────────────────────────────────────
  // Failure recording — CLOSED → OPEN
  // ─────────────────────────────────────────

  it("stays CLOSED after fewer failures than threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
  });

  it("opens after reaching failure threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.isOpen()).toBe(true);
  });

  it("provides user-friendly message when OPEN", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    const message = cb.getOpenMessage();
    expect(message).toContain("Ollama");
    expect(message).toContain("not responding");
  });

  // ─────────────────────────────────────────
  // Recovery — OPEN → HALF → CLOSED
  // ─────────────────────────────────────────

  it("transitions to HALF after recovery time", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    /*
     * Wait for recovery time to elapse.
     */
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(cb.getState()).toBe("HALF");
    expect(cb.isOpen()).toBe(false);
  });

  it("closes circuit after successful recovery", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(cb.getState()).toBe("HALF");

    cb.recordSuccess();

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
  });

  it("reopens circuit after failed recovery test", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(cb.getState()).toBe("HALF");

    /*
     * Recovery test failed.
     */
    cb.recordFailure();

    expect(cb.getState()).toBe("OPEN");
    expect(cb.isOpen()).toBe(true);
  });

  // ─────────────────────────────────────────
  // Seconds until recovery
  // ─────────────────────────────────────────

  it("returns positive seconds when OPEN", () => {
    /*
     * Use longer recovery for this test.
     */
    const slowCb = new CircuitBreaker({
      failureThreshold: 3,
      recoveryMs: 30_000,
    });

    slowCb.recordFailure();
    slowCb.recordFailure();
    slowCb.recordFailure();

    const seconds = slowCb.getSecondsUntilRecovery();
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it("returns 0 seconds when HALF", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(cb.getState()).toBe("HALF");
    expect(cb.getSecondsUntilRecovery()).toBe(0);
  });

  // ─────────────────────────────────────────
  // Reset
  // ─────────────────────────────────────────

  it("reset returns circuit to CLOSED", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    cb.reset();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
    expect(cb.getSecondsUntilRecovery()).toBe(0);
  });

  it("reset clears failure count", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.reset();

    /*
     * After reset, need 3 new failures to open.
     */
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");

    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
  });

  // ─────────────────────────────────────────
  // Default options
  // ─────────────────────────────────────────

  it("uses default threshold of 3 failures", () => {
    const defaultCb = new CircuitBreaker();

    defaultCb.recordFailure();
    defaultCb.recordFailure();
    expect(defaultCb.getState()).toBe("CLOSED");

    defaultCb.recordFailure();
    expect(defaultCb.getState()).toBe("OPEN");
  });
});