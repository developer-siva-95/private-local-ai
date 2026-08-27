import * as vscode from "vscode";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/*
 * OutputChannelLogger
 *
 * Structured, timestamped logging for the Private AI
 * VS Code Output Channel.
 *
 * Design principles:
 *   1. Recent entries (TIER 1): full detail + ms timing
 *   2. Older entries (TIER 2): compressed by minute bucket
 *   3. Oldest entries (TIER 3): block summary only
 *   4. SECURITY / ERROR / SESSION / HEALTH: never compressed
 *   5. Debug file: full detail per date, separate from audit
 *
 * Mirrors SessionMemory compression philosophy:
 *   recent = full, older = summarized, critical = always full.
 *
 * No hard line removal — old entries rewritten as summaries.
 * User scrolls up and sees summaries, not gaps.
 */

/*
 * Tier boundaries.
 * Mirrors SessionMemory layer sizes.
 */
const TIER1_MAX = 20; // last 20 entries: full detail
const TIER2_MAX = 100; // entries 21-100: minute buckets
// beyond 100: block summaries only

/*
 * Max chars for a single Output Channel line.
 * Fits on screen without wrapping.
 * Security entries exempt — always full.
 */
const MAX_LINE_CHARS = 120;

/*
 * Max chars for debug file lines.
 * No limit — full detail always.
 */
const DEBUG_LINE_NO_LIMIT = 0;

/*
 * Categories that are NEVER compressed.
 * Always shown in full regardless of tier.
 */
const NEVER_COMPRESS = new Set(["SECURITY", "ERROR", "SESSION", "HEALTH"]);

/*
 * Internal log entry.
 */
interface LogEntry {
  timestamp: Date;
  category: string;
  message: string;
  neverCompress: boolean;
  durationMs?: number;
}

/*
 * Minute bucket for TIER 2 compression.
 * Groups entries by "YYYY-MM-DD HH:MM".
 */
interface MinuteBucket {
  minuteKey: string; // "14:32"
  tools: number;
  toolsOk: number;
  toolsFail: number;
  llmCalls: number;
  llmTotalMs: number;
  permsAuto: number;
  permsApproved: number;
  permsDenied: number;
  firstTimestamp: Date;
  lastTimestamp: Date;
}

/*
 * Block summary for TIER 3.
 * One line covering a range of time.
 */
interface BlockSummary {
  startMinute: string;
  endMinute: string;
  tools: number;
  toolsOk: number;
  toolsFail: number;
  llmCalls: number;
  permsAuto: number;
  permsApproved: number;
  permsDenied: number;
  securityBlocks: number;
}

/*
 * Active timer for duration measurement.
 */
interface ActiveTimer {
  startMs: number;
  category: string;
}

export class OutputChannelLogger {
  /*
   * TIER 1 — recent full entries.
   */
  private tier1: LogEntry[] = [];

  /*
   * TIER 2 — minute bucket summaries.
   */
  private tier2: MinuteBucket[] = [];

  /*
   * TIER 3 — block summaries.
   */
  private tier3: BlockSummary[] = [];

  /*
   * Pinned entries — never compressed.
   * SESSION, HEALTH, SECURITY, ERROR.
   * Always visible at top + inline.
   */
  private pinnedEntries: LogEntry[] = [];

  /*
   * Active timers indexed by timer ID.
   */
  private readonly timers = new Map<string, ActiveTimer>();

  /*
   * Debug file path — set at construction.
   * Null if no workspace root provided.
   */
  private readonly debugDir: string | null;

  /*
   * Today's debug log file path.
   * Rotates daily.
   */
  private currentDebugDate = "";
  private currentDebugPath = "";

  /*
   * Timer counter for unique IDs.
   */
  private timerCounter = 0;

  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly debugMode: boolean = false,
    workspaceRoot?: string,
  ) {
    this.debugDir =
      workspaceRoot !== undefined
        ? path.join(workspaceRoot, ".private_ai", "logs", "debug")
        : null;
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Session lifecycle
   * ─────────────────────────────────────────
   */

  sessionStart(workspaceRoot: string, model: string, ollamaUrl: string): void {
    const line = "═".repeat(60);
    this.writePinned("SESSION", `${line}`);
    this.writePinned("SESSION", `  Private AI — Session Started`);
    this.writePinned("SESSION", `  Workspace : ${workspaceRoot}`);
    this.writePinned("SESSION", `  Model     : ${model}`);
    this.writePinned("SESSION", `  Ollama    : ${ollamaUrl}`);
    this.writePinned("SESSION", `${line}`);
  }

  sessionEnd(): void {
    this.writePinned("SESSION", "Private AI session ended.");
    this.flushSummary();
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Health
   * ─────────────────────────────────────────
   */

  healthStart(): string {
    return this.startTimer("HEALTH");
  }

  healthEnd(timerId: string, ok: boolean, detail?: string): void {
    const durationMs = this.endTimer(timerId);
    const icon = ok ? "✓" : "✗";
    const msg =
      detail !== undefined
        ? `${icon} Ollama ${ok ? "connected" : "failed"} — ${detail} (${durationMs}ms)`
        : `${icon} Ollama ${ok ? "connected" : "failed"} (${durationMs}ms)`;

    this.writePinned("HEALTH", msg);
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — User messages
   * ─────────────────────────────────────────
   */

  userMessage(text: string, fileCount: number, contextChars: number): void {
    /*
     * Truncate user text for display.
     * Full text goes to debug file.
     */
    const preview = text.length > 80 ? text.slice(0, 80).trimEnd() + "…" : text;

    const contextNote =
      fileCount > 0
        ? ` (+${fileCount} file${fileCount > 1 ? "s" : ""}, ${contextChars} chars context)`
        : "";

    this.writeEntry("USER", `"${preview}"${contextNote}`);

    if (this.debugMode) {
      void this.writeDebug("USER", `Full message: ${text}`);
    }
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — LLM
   * ─────────────────────────────────────────
   */

  llmStart(): string {
    this.writeEntry("LLM", "⠋ Thinking...");
    return this.startTimer("LLM");
  }

  llmEnd(timerId: string, tokenEstimate: number, isFinal: boolean): void {
    const durationMs = this.endTimer(timerId);
    const label = isFinal ? "Final answer" : "Response";
    this.writeEntry(
      "LLM",
      `✓ ${label} (${durationMs}ms, ~${tokenEstimate} tokens)`,
      durationMs,
    );

    /*
     * Track for tier compression.
     */
    this.recordLlmCall(durationMs);
  }

  llmError(timerId: string, error: string): void {
    const durationMs = this.endTimer(timerId);
    this.writeEntry(
      "ERROR",
      `✗ LLM failed (${durationMs}ms): ${error}`,
      durationMs,
    );
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Tools
   * ─────────────────────────────────────────
   */

  toolStart(name: string, target?: string): string {
    const targetStr =
      target !== undefined ? ` → ${this.shortenPath(target)}` : "";
    this.writeEntry("TOOL", `${name}${targetStr}`);
    return this.startTimer("TOOL");
  }

  toolEnd(
    timerId: string,
    name: string,
    ok: boolean,
    chars?: number,
    error?: string,
  ): void {
    const durationMs = this.endTimer(timerId);
    let msg: string;

    if (ok) {
      const sizeNote = chars !== undefined ? `, ${chars} chars` : "";
      msg = `✓ ${name} (${durationMs}ms${sizeNote})`;
    } else {
      const errNote = error !== undefined ? `: ${error}` : "";
      msg = `✗ ${name} failed (${durationMs}ms${errNote})`;
    }

    this.writeEntry("TOOL", msg, durationMs);

    /*
     * Track for tier compression.
     */
    this.recordToolCall(ok);
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Permissions
   * ─────────────────────────────────────────
   */

  permissionAuto(permission: string, target?: string): void {
    const targetStr =
      target !== undefined ? ` — ${this.shortenPath(target)}` : "";
    this.writeEntry(
      "PERM",
      `✓ ${permission} auto-approved (workspace trusted)${targetStr}`,
    );
    this.recordPerm("auto");
  }

  permissionApproved(permission: string, target?: string): void {
    const targetStr =
      target !== undefined ? ` — ${this.shortenPath(target)}` : "";
    this.writeEntry("PERM", `✓ ${permission} approved${targetStr}`);
    this.recordPerm("approved");
  }

  permissionDenied(permission: string, target?: string): void {
    const targetStr =
      target !== undefined ? ` — ${this.shortenPath(target)}` : "";
    this.writeEntry("PERM", `✗ ${permission} denied${targetStr}`);
    this.recordPerm("denied");
  }

  permissionWorkspaceRead(approved: boolean): void {
    const msg = approved
      ? "✓ Workspace read approved — all project files readable"
      : "⚠ Workspace read not approved — per-file prompts active";
    this.writePinned("PERM", msg);
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Security
   * ─────────────────────────────────────────
   */

  security(message: string): void {
    /*
     * Security events: always pinned, never compressed.
     * Full message always — no truncation.
     */
    const entry: LogEntry = {
      timestamp: new Date(),
      category: "SECURITY",
      message: `⛔ ${message}`,
      neverCompress: true,
    };

    this.pinnedEntries.push(entry);
    this.channel.appendLine(this.formatEntry(entry, false));

    /*
     * Track for block summary.
     */
    this.recordSecurityBlock();

    void this.writeDebug("SECURITY", message);
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Diff preview
   * ─────────────────────────────────────────
   */

  diffStart(filePath: string, action: string): string {
    this.writeEntry("DIFF", `${action}: ${path.basename(filePath)}`);
    return this.startTimer("DIFF");
  }

  diffEnd(timerId: string, filePath: string, applied: boolean): void {
    const durationMs = this.endTimer(timerId);
    const icon = applied ? "✓" : "✗";
    const label = applied ? "Applied" : "Cancelled";
    this.writeEntry(
      "DIFF",
      `${icon} ${label}: ${path.basename(filePath)} (${durationMs}ms)`,
      durationMs,
    );
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Status bar
   * ─────────────────────────────────────────
   */

  statusChange(from: string, to: string): void {
    if (this.debugMode) {
      this.writeEntry("STATUS", `${from} → ${to}`);
    }
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Context
   * ─────────────────────────────────────────
   */

  contextInjected(summary: string): void {
    if (this.debugMode) {
      this.writeEntry("CONTEXT", summary);
    }
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Debug
   * ─────────────────────────────────────────
   */

  debug(category: string, message: string): void {
    if (this.debugMode) {
      this.writeEntry("DEBUG", `[${category}] ${message}`);
    }

    void this.writeDebug(category, message);
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — General error
   * ─────────────────────────────────────────
   */

  error(message: string, detail?: string): void {
    const full = detail !== undefined ? `${message}: ${detail}` : message;
    const entry: LogEntry = {
      timestamp: new Date(),
      category: "ERROR",
      message: `✗ ${full}`,
      neverCompress: true,
    };

    this.pinnedEntries.push(entry);
    this.channel.appendLine(this.formatEntry(entry, false));
    void this.writeDebug("ERROR", full);
  }

  /*
   * ─────────────────────────────────────────
   * PUBLIC API — Separator
   * ─────────────────────────────────────────
   */

  separator(label?: string): void {
    const line =
      label !== undefined
        ? `── ${label} ${"─".repeat(Math.max(0, 50 - label.length))}`
        : "─".repeat(54);
    this.channel.appendLine(line);
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Core write methods
   * ─────────────────────────────────────────
   */

  /*
   * Write a normal (compressible) entry.
   */
  private writeEntry(
    category: string,
    message: string,
    durationMs?: number,
  ): void {
    const neverCompress = NEVER_COMPRESS.has(category);

    const entry: LogEntry = {
      timestamp: new Date(),
      category,
      message,
      neverCompress,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };

    this.tier1.push(entry);

    /*
     * If tier1 overflowed, compression runs redrawChannel()
     * which reprints EVERYTHING already in tier1 including
     * this new entry. Don't appendLine again in that case.
     *
     * If no overflow, just append the new entry normally.
     */
    if (this.tier1.length > TIER1_MAX) {
      this.compressTier1ToTier2();
      /*
       * redrawChannel already wrote this entry.
       * Do not appendLine again.
       */
    } else {
      const truncate = !neverCompress;
      this.channel.appendLine(this.formatEntry(entry, truncate));
    }

    if (this.debugMode) {
      void this.writeDebug(category, message);
    }
  }

  /*
   * Write a pinned (never compressed) entry.
   * SESSION, HEALTH use this.
   */
  private writePinned(category: string, message: string): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      category,
      message,
      neverCompress: true,
    };

    this.pinnedEntries.push(entry);
    this.channel.appendLine(this.formatEntry(entry, false));
    void this.writeDebug(category, message);
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Timer management
   * ─────────────────────────────────────────
   */

  private startTimer(category: string): string {
    const id = `${category}-${++this.timerCounter}-${Date.now()}`;
    this.timers.set(id, {
      startMs: Date.now(),
      category,
    });
    return id;
  }

  private endTimer(timerId: string): number {
    const timer = this.timers.get(timerId);
    if (timer === undefined) return 0;
    this.timers.delete(timerId);
    return Date.now() - timer.startMs;
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Compression
   * ─────────────────────────────────────────
   */

  /*
   * Compress oldest TIER 1 entry into TIER 2.
   * Called when TIER 1 overflows.
   */
  private compressTier1ToTier2(): void {
    const oldest = this.tier1.shift();
    if (oldest === undefined) return;

    /*
     * Never-compress entries go to pinned, not tier 2.
     */
    if (oldest.neverCompress) {
      this.pinnedEntries.push(oldest);
      return;
    }

    const minuteKey = this.toMinuteKey(oldest.timestamp);
    let bucket = this.tier2.find((b) => b.minuteKey === minuteKey);

    if (bucket === undefined) {
      bucket = {
        minuteKey,
        tools: 0,
        toolsOk: 0,
        toolsFail: 0,
        llmCalls: 0,
        llmTotalMs: 0,
        permsAuto: 0,
        permsApproved: 0,
        permsDenied: 0,
        firstTimestamp: oldest.timestamp,
        lastTimestamp: oldest.timestamp,
      };
      this.tier2.push(bucket);
    }

    /*
     * Tally by category.
     */
    this.tallyIntoBucket(bucket, oldest);
    bucket.lastTimestamp = oldest.timestamp;

    /*
     * If TIER 2 is full, compress oldest bucket
     * into TIER 3.
     */
    if (this.tier2.length > TIER2_MAX) {
      this.compressTier2ToTier3();
    }

    /*
     * Rewrite the Output Channel with compressed view.
     * This is the key operation — old entries replaced
     * with summaries, user sees history not gaps.
     */
    this.redrawChannel();
  }

  private compressTier2ToTier3(): void {
    const oldestBuckets = this.tier2.splice(0, Math.floor(TIER2_MAX / 2));

    if (oldestBuckets.length === 0) return;

    const first = oldestBuckets[0]!;
    const last = oldestBuckets[oldestBuckets.length - 1]!;

    const block: BlockSummary = {
      startMinute: first.minuteKey,
      endMinute: last.minuteKey,
      tools: 0,
      toolsOk: 0,
      toolsFail: 0,
      llmCalls: 0,
      permsAuto: 0,
      permsApproved: 0,
      permsDenied: 0,
      securityBlocks: 0,
    };

    for (const b of oldestBuckets) {
      block.tools += b.tools;
      block.toolsOk += b.toolsOk;
      block.toolsFail += b.toolsFail;
      block.llmCalls += b.llmCalls;
      block.permsAuto += b.permsAuto;
      block.permsApproved += b.permsApproved;
      block.permsDenied += b.permsDenied;
    }

    this.tier3.push(block);
  }

  private tallyIntoBucket(bucket: MinuteBucket, entry: LogEntry): void {
    switch (entry.category) {
      case "TOOL": {
        if (entry.message.startsWith("✓")) {
          bucket.tools++;
          bucket.toolsOk++;
        } else if (entry.message.startsWith("✗")) {
          bucket.tools++;
          bucket.toolsFail++;
        }
        break;
      }
      case "LLM": {
        if (entry.message.includes("✓") && entry.durationMs !== undefined) {
          bucket.llmCalls++;
          bucket.llmTotalMs += entry.durationMs;
        }
        break;
      }
      case "PERM": {
        if (entry.message.includes("auto-approved")) {
          bucket.permsAuto++;
        } else if (entry.message.includes("✓")) {
          bucket.permsApproved++;
        } else if (entry.message.includes("✗")) {
          bucket.permsDenied++;
        }
        break;
      }
    }
  }

  /*
   * Redraw the entire Output Channel.
   * Called when compression changes the view.
   *
   * Order:
   *   1. Tier 3 block summaries (oldest)
   *   2. Tier 2 minute buckets (middle)
   *   3. Pinned entries (session/health/security — spread inline)
   *   4. Tier 1 recent entries (newest, full detail)
   */
  private redrawChannel(): void {
    this.channel.clear();

    /*
     * Tier 3 block summaries.
     */
    for (const block of this.tier3) {
      this.channel.appendLine(this.formatBlockSummary(block));
    }

    /*
     * Tier 2 minute buckets.
     */
    for (const bucket of this.tier2) {
      this.channel.appendLine(this.formatMinuteBucket(bucket));
    }

    /*
     * Pinned entries (always full).
     */
    for (const entry of this.pinnedEntries) {
      this.channel.appendLine(this.formatEntry(entry, false));
    }

    /*
     * Tier 1 recent entries (full detail).
     */
    for (const entry of this.tier1) {
      this.channel.appendLine(this.formatEntry(entry, !entry.neverCompress));
    }
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Compression state tracking
   * ─────────────────────────────────────────
   */

  /*
   * Separate counters for block summary.
   * These track events that happened in tier 1
   * before they are compressed.
   */
  private tier1ToolOk = 0;
  private tier1ToolFail = 0;
  private tier1LlmCalls = 0;
  private tier1PermsAuto = 0;
  private tier1PermsApproved = 0;
  private tier1PermsDenied = 0;
  private tier1SecurityBlocks = 0;

  private recordToolCall(ok: boolean): void {
    if (ok) this.tier1ToolOk++;
    else this.tier1ToolFail++;
  }

  private recordLlmCall(durationMs: number): void {
    this.tier1LlmCalls++;
    void durationMs; // tracked in bucket
  }

  private recordPerm(type: "auto" | "approved" | "denied"): void {
    if (type === "auto") this.tier1PermsAuto++;
    else if (type === "approved") this.tier1PermsApproved++;
    else this.tier1PermsDenied++;
  }

  private recordSecurityBlock(): void {
    this.tier1SecurityBlocks++;
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Formatting
   * ─────────────────────────────────────────
   */

  private formatEntry(entry: LogEntry, truncate: boolean): string {
    const ts = this.formatTimestamp(entry.timestamp);
    const cat = entry.category.padEnd(8);
    let msg = entry.message;

    if (truncate && msg.length > MAX_LINE_CHARS) {
      msg = msg.slice(0, MAX_LINE_CHARS - 1) + "…";
    }

    return `[${ts}] [${cat}] ${msg}`;
  }

  private formatMinuteBucket(bucket: MinuteBucket): string {
    const parts: string[] = [];

    if (bucket.tools > 0) {
      parts.push(`${bucket.toolsOk}✓/${bucket.toolsFail}✗ tools`);
    }

    if (bucket.llmCalls > 0) {
      const avgMs =
        bucket.llmCalls > 0
          ? Math.round(bucket.llmTotalMs / bucket.llmCalls)
          : 0;
      parts.push(`LLM ×${bucket.llmCalls} (avg ${avgMs}ms)`);
    }

    if (bucket.permsAuto > 0) {
      parts.push(`${bucket.permsAuto} auto`);
    }

    if (bucket.permsApproved > 0) {
      parts.push(`${bucket.permsApproved} approved`);
    }

    if (bucket.permsDenied > 0) {
      parts.push(`${bucket.permsDenied} denied ⚠`);
    }

    const summary = parts.length > 0 ? parts.join(" | ") : "idle";

    return `── [${bucket.minuteKey}] ${summary}`;
  }

  private formatBlockSummary(block: BlockSummary): string {
    const parts: string[] = [];

    if (block.tools > 0) {
      parts.push(
        `${block.tools} tools (${block.toolsOk}✓ ${block.toolsFail}✗)`,
      );
    }

    if (block.llmCalls > 0) {
      parts.push(`LLM ×${block.llmCalls}`);
    }

    const totalPerms =
      block.permsAuto + block.permsApproved + block.permsDenied;

    if (totalPerms > 0) {
      parts.push(
        `perms: ${block.permsAuto} auto, ` +
          `${block.permsApproved} approved, ` +
          `${block.permsDenied} denied`,
      );
    }

    if (block.securityBlocks > 0) {
      parts.push(`${block.securityBlocks} security blocks ⛔`);
    }

    const summary = parts.length > 0 ? parts.join(" | ") : "idle";

    return `▓▓ [${block.startMinute}–${block.endMinute}] ${summary}`;
  }

  private formatTimestamp(date: Date): string {
    const YYYY = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, "0");
    const DD = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}.${ms}`;
  }

  private toMinuteKey(date: Date): string {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  private shortenPath(target: string): string {
    /*
     * Show last 2 path segments only.
     * Keeps lines short while identifying the file.
     * Full path in debug file.
     */
    const parts = target.replace(/\\/g, "/").split("/");
    if (parts.length <= 2) return target;
    return `…/${parts.slice(-2).join("/")}`;
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Debug file
   * ─────────────────────────────────────────
   */

  private async writeDebug(category: string, message: string): Promise<void> {
    if (this.debugDir === null) return;

    try {
      const today = new Date().toISOString().slice(0, 10);

      /*
       * Rotate debug file daily.
       */
      if (today !== this.currentDebugDate) {
        this.currentDebugDate = today;
        this.currentDebugPath = path.join(this.debugDir, `${today}.log`);
        await mkdir(this.debugDir, { recursive: true });
      }

      const ts = this.formatTimestamp(new Date());
      const line = `[${ts}] [${category}] ${message}\n`;

      void DEBUG_LINE_NO_LIMIT; // explicit: no limit on debug lines

      await appendFile(this.currentDebugPath, line, "utf8");
    } catch {
      /*
       * Debug file write failure is silent.
       * Never crashes the extension.
       */
    }
  }

  /*
   * ─────────────────────────────────────────
   * PRIVATE — Final summary on session end
   * ─────────────────────────────────────────
   */

  private flushSummary(): void {
    const totalTools = this.tier1ToolOk + this.tier1ToolFail;

    if (totalTools === 0 && this.tier1LlmCalls === 0) {
      return;
    }

    const parts: string[] = [];

    if (totalTools > 0) {
      parts.push(`Tools: ${this.tier1ToolOk}✓ ${this.tier1ToolFail}✗`);
    }

    if (this.tier1LlmCalls > 0) {
      parts.push(`LLM calls: ${this.tier1LlmCalls}`);
    }

    const totalPerms =
      this.tier1PermsAuto + this.tier1PermsApproved + this.tier1PermsDenied;

    if (totalPerms > 0) {
      parts.push(
        `Perms: ${this.tier1PermsAuto} auto, ` +
          `${this.tier1PermsApproved} approved, ` +
          `${this.tier1PermsDenied} denied`,
      );
    }

    if (this.tier1SecurityBlocks > 0) {
      parts.push(`Security blocks: ${this.tier1SecurityBlocks} ⛔`);
    }

    this.writePinned("SESSION", `Summary: ${parts.join(" | ")}`);
  }
}
