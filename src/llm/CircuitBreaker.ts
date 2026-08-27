/*
 * CircuitBreaker
 *
 * Prevents cascading failures when Ollama is down.
 *
 * States:
 *   CLOSED   — Normal operation. All requests pass through.
 *   OPEN     — Ollama is down. Fail immediately.
 *              No requests sent to Ollama.
 *   HALF     — Testing recovery. One request allowed.
 *              Success → CLOSED. Failure → OPEN.
 *
 * Transitions:
 *   CLOSED + 3 consecutive failures → OPEN
 *   OPEN + 30 seconds elapsed      → HALF
 *   HALF + success                 → CLOSED
 *   HALF + failure                 → OPEN (reset timer)
 *
 * User experience:
 *   OPEN: immediate error with clear message
 *         "Ollama is not responding. Retrying in Xs."
 *   Recovers automatically when Ollama comes back.
 *   No user action needed.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF";

export interface CircuitBreakerOptions {
  /*
   * Number of consecutive failures to open circuit.
   * Default: 3
   */
  failureThreshold: number;

  /*
   * Milliseconds to wait before testing recovery.
   * Default: 30000 (30 seconds)
   */
  recoveryMs: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  recoveryMs: 30_000,
};

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /*
   * Get current state.
   * Used by tests and status bar.
   */
  getState(): CircuitState {
    /*
     * Check if OPEN circuit should transition to HALF.
     * This is evaluated lazily on every getState() call.
     */
    if (
      this.state === "OPEN" &&
      this.openedAt !== null
    ) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.options.recoveryMs) {
        this.state = "HALF";
        console.log(
          "[CircuitBreaker] Testing recovery — " +
          "allowing one request through.",
        );
      }
    }

    return this.state;
  }

  /*
   * Check if a request should be allowed through.
   *
   * Returns true if the request should proceed.
   * Returns false if the circuit is OPEN.
   *
   * Also handles HALF-OPEN → CLOSED transition check.
   */
  isOpen(): boolean {
    const state = this.getState();
    return state === "OPEN";
  }

  /*
   * Record a successful request.
   *
   * CLOSED: reset failure count.
   * HALF:   transition to CLOSED (recovery confirmed).
   * OPEN:   should not happen but handle gracefully.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;

    if (this.state === "HALF") {
      console.log(
        "[CircuitBreaker] Recovery confirmed — circuit CLOSED.",
      );
    }

    this.state = "CLOSED";
    this.openedAt = null;
  }

  /*
   * Record a failed request.
   *
   * CLOSED: increment failure count.
   *         If threshold reached → OPEN.
   * HALF:   failure during test → back to OPEN.
   * OPEN:   already open, update timer.
   */
  recordFailure(): void {
    this.consecutiveFailures++;

    if (this.state === "HALF") {
      /*
       * Test request failed.
       * Ollama still down — reset timer and stay OPEN.
       */
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.log(
        "[CircuitBreaker] Recovery test failed — " +
        "circuit remains OPEN.",
      );
      return;
    }

    if (
      this.state === "CLOSED" &&
      this.consecutiveFailures >= this.options.failureThreshold
    ) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.log(
        `[CircuitBreaker] ${this.consecutiveFailures} consecutive ` +
        `failures — circuit OPEN. ` +
        `Ollama appears to be down.`,
      );
    }
  }

  /*
   * Get seconds remaining until recovery test.
   * Returns 0 if circuit is not OPEN.
   */
  getSecondsUntilRecovery(): number {
    if (this.state !== "OPEN" || this.openedAt === null) {
      return 0;
    }

    const elapsed = Date.now() - this.openedAt;
    const remaining = this.options.recoveryMs - elapsed;
    return Math.max(0, Math.ceil(remaining / 1_000));
  }

  /*
   * Build the user-facing error message when circuit is OPEN.
   */
  getOpenMessage(): string {
    const seconds = this.getSecondsUntilRecovery();

    if (seconds > 0) {
      return (
        `Ollama is not responding. ` +
        `Will retry automatically in ${seconds} seconds. ` +
        `You can also restart Ollama and try again.`
      );
    }

    return (
      `Ollama is not responding. ` +
      `Testing recovery now...`
    );
  }

  /*
   * Reset circuit to CLOSED state.
   * Used when Ollama is manually restarted
   * or for testing.
   */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }
}