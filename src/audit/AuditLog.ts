import { appendFile, mkdir, readFile, readdir, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type AuditEventType =
  | "tool_requested"
  | "tool_approved"
  | "tool_denied"
  | "tool_executed"
  | "security_blocked"
  | "session_started"
  | "session_ended";

export interface AuditEvent {
  sessionId: string;
  timestamp: string;
  event: AuditEventType;
  permission: string;
  target?: string;
  reason?: string;
  success?: boolean;
  error?: string;
}

/*
 * How many days of audit logs to keep.
 * Older files are deleted on session start.
 */
const LOG_RETENTION_DAYS = 30;

export class AuditLog {
  private readonly sessionId: string;
  private initialized = false;

  /*
   * Session metrics — tracked in memory.
   * Written to log on session end.
   */
  private metrics = {
    toolCalls: 0,
    approved: 0,
    denied: 0,
    blocked: 0,
    sessionStartTime: Date.now(),
  };

  constructor(private readonly logDir: string) {
    this.sessionId = randomUUID();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private getLogPath(): string {
    const today = new Date().toISOString().split("T")[0];
    return path.join(this.logDir, `${today}.audit.log`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    this.initialized = true;
    this.metrics.sessionStartTime = Date.now();

    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "session_started",
      permission: "system",
      reason: "Session started.",
    });

    /*
     * Rotate old logs non-blocking.
     * Never delays startup.
     */
    void this.rotateOldLogs();
  }

  /*
   * Delete audit log files older than LOG_RETENTION_DAYS.
   * Non-blocking — runs in background after startup.
   * Silent on failure — log rotation must never crash agent.
   */
  private async rotateOldLogs(): Promise<void> {
    try {
      const files = await readdir(this.logDir);
      const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith(".audit.log")) continue;

        const filePath = path.join(this.logDir, file);

        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoff) {
            await unlink(filePath);
            console.log(
              `[AuditLog] Rotated old log: ${file}`,
            );
          }
        } catch {
          /* skip files we cannot stat or delete */
        }
      }
    } catch {
      /* rotation failure is silent */
    }
  }

  async logSessionEnd(): Promise<void> {
    const durationMs = Date.now() - this.metrics.sessionStartTime;
    const durationSec = Math.round(durationMs / 1000);

    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "session_ended",
      permission: "system",
      reason:
        `Session ended. Duration: ${durationSec}s. ` +
        `Tool calls: ${this.metrics.toolCalls}. ` +
        `Approved: ${this.metrics.approved}. ` +
        `Denied: ${this.metrics.denied}. ` +
        `Blocked: ${this.metrics.blocked}.`,
    });
  }

  async getRecentEvents(count = 10): Promise<AuditEvent[]> {
    const logPath = this.getLogPath();
    if (!existsSync(logPath)) return [];

    try {
      const content = await readFile(logPath, "utf8");
      const lines = content.trim().split("\n");
      return lines
        .slice(-count)
        .map((line) => JSON.parse(line) as AuditEvent);
    } catch {
      return [];
    }
  }

  /*
   * Get current session metrics.
   * Used by /stats command.
   */
  getMetrics(): {
    toolCalls: number;
    approved: number;
    denied: number;
    blocked: number;
    durationSeconds: number;
  } {
    return {
      toolCalls: this.metrics.toolCalls,
      approved: this.metrics.approved,
      denied: this.metrics.denied,
      blocked: this.metrics.blocked,
      durationSeconds: Math.round(
        (Date.now() - this.metrics.sessionStartTime) / 1000,
      ),
    };
  }

  logRequest(
    permission: string,
    target: string | undefined,
    reason: string,
  ): void {
    this.metrics.toolCalls++;
    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "tool_requested",
      permission,
      ...(target !== undefined ? { target } : {}),
      reason,
    });
  }

  logApproval(
    permission: string,
    target: string | undefined,
  ): void {
    this.metrics.approved++;
    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "tool_approved",
      permission,
      ...(target !== undefined ? { target } : {}),
    });
  }

  logDenial(
    permission: string,
    target: string | undefined,
  ): void {
    this.metrics.denied++;
    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "tool_denied",
      permission,
      ...(target !== undefined ? { target } : {}),
    });
  }

  logSecurityBlock(
    permission: string,
    target: string | undefined,
    reason: string,
  ): void {
    this.metrics.blocked++;
    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "security_blocked",
      permission,
      ...(target !== undefined ? { target } : {}),
      reason,
    });
  }

  logExecution(
    permission: string,
    target: string | undefined,
    success: boolean,
    error?: string,
  ): void {
    this.writeNonBlocking({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      event: "tool_executed",
      permission,
      ...(target !== undefined ? { target } : {}),
      success,
      ...(error !== undefined ? { error } : {}),
    });
  }

  private writeNonBlocking(event: AuditEvent): void {
    if (!this.initialized) return;

    const line = JSON.stringify(event) + "\n";

    appendFile(this.getLogPath(), line, "utf8").catch(() => {
      /* silent — logging never blocks security */
    });
  }
}