import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
} from "vitest";

import { AuditLog } from "../../src/audit/AuditLog.js";
import { readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";

/*
 * Helper to wait for non-blocking writes.
 * Since writes are fire-and-forget, we need
 * a small delay before reading the file.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

describe("AuditLog", () => {
  const testLogDir =
    "G:\\siva\\projects\\private_ai\\logs-test";

  let auditLog: AuditLog;

  const today = new Date()
    .toISOString()
    .split("T")[0];

  const expectedLogFile = `${today}.audit.log`;

  beforeEach(async () => {
    auditLog = new AuditLog(testLogDir);
    await auditLog.initialize();
    await wait(50);
  });

  afterEach(async () => {
    try {
      await rm(testLogDir, {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore
    }
  });

  it("creates a date-based log file", async () => {
    const files = await readdir(testLogDir);
    expect(files).toContain(expectedLogFile);
  });

  it("assigns a unique session ID", () => {
    const id = auditLog.getSessionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("logs a request entry", async () => {
    auditLog.logRequest(
      "read_file",
      "package.json",
      "Test request.",
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) =>
        l.event === "tool_requested" &&
        l.permission === "read_file",
    );

    expect(entry).toBeDefined();
    expect(entry.target).toBe("package.json");
  });

  it("logs an approval entry", async () => {
    auditLog.logApproval(
      "read_file",
      "package.json",
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) => l.event === "tool_approved",
    );

    expect(entry).toBeDefined();
    expect(entry.permission).toBe("read_file");
  });

  it("logs a denial entry", async () => {
    auditLog.logDenial(
      "write_file",
      "output.txt",
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) => l.event === "tool_denied",
    );

    expect(entry).toBeDefined();
    expect(entry.permission).toBe("write_file");
  });

  it("logs a security block entry", async () => {
    auditLog.logSecurityBlock(
      "run_command",
      "del /s /q *.*",
      "Command blocked.",
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) => l.event === "security_blocked",
    );

    expect(entry).toBeDefined();
    expect(entry.target).toBe("del /s /q *.*");
  });

  it("logs a successful execution", async () => {
    auditLog.logExecution(
      "read_file",
      "package.json",
      true,
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) => l.event === "tool_executed",
    );

    expect(entry).toBeDefined();
    expect(entry.success).toBe(true);
  });

  it("logs a failed execution", async () => {
    auditLog.logExecution(
      "write_file",
      "output.txt",
      false,
      "Permission denied.",
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) =>
        l.event === "tool_executed" &&
        l.success === false,
    );

    expect(entry).toBeDefined();
    expect(entry.error).toBe("Permission denied.");
  });

  it("appends entries never overwrites", async () => {
    auditLog.logRequest(
      "read_file",
      "file1.txt",
      "First.",
    );

    auditLog.logRequest(
      "write_file",
      "file2.txt",
      "Second.",
    );

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("logs session end", async () => {
    await auditLog.logSessionEnd();

    await wait(100);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entry = lines.find(
      (l) => l.event === "session_ended",
    );

    expect(entry).toBeDefined();
  });

    it("getRecentEvents returns empty array when no log file", async () => {
    /*
     * Create a fresh AuditLog pointing to a dir
     * that has no log file yet.
     */
    const emptyLog = new AuditLog(testLogDir + "-empty");
    emptyLog["initialized"] = true;

    const events = await emptyLog.getRecentEvents();
    expect(events).toEqual([]);
  });

  it("getRecentEvents returns last N events", async () => {
    auditLog.logRequest("read_file", "a.txt", "test");
    auditLog.logApproval("read_file", "a.txt");
    auditLog.logRequest("write_file", "b.txt", "test");

    await wait(150);

    const events = await auditLog.getRecentEvents(2);
    expect(events.length).toBe(2);
  });

  it("getMetrics tracks tool calls", () => {
    auditLog.logRequest("read_file", "a.txt", "test");
    auditLog.logRequest("write_file", "b.txt", "test");

    const m = auditLog.getMetrics();
    expect(m.toolCalls).toBe(2);
  });

  it("getMetrics tracks approvals and denials", () => {
    auditLog.logApproval("read_file", "a.txt");
    auditLog.logApproval("read_file", "b.txt");
    auditLog.logDenial("write_file", "c.txt");

    const m = auditLog.getMetrics();
    expect(m.approved).toBe(2);
    expect(m.denied).toBe(1);
  });

  it("getMetrics tracks security blocks", () => {
    auditLog.logSecurityBlock(
      "run_command",
      "evil",
      "blocked",
    );

    const m = auditLog.getMetrics();
    expect(m.blocked).toBe(1);
  });

  it("getMetrics returns duration in seconds", async () => {
    await wait(100);
    const m = auditLog.getMetrics();
    expect(m.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("logSessionEnd includes metrics in reason", async () => {
    auditLog.logRequest("read_file", "test", "r");
    auditLog.logApproval("read_file", "test");

    await auditLog.logSessionEnd();
    await wait(150);

    const content = await readFile(
      path.join(testLogDir, expectedLogFile),
      "utf8",
    );

    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    const end = lines.find((l) => l.event === "session_ended");

    expect(end).toBeDefined();
    expect(end.reason).toContain("Tool calls");
    expect(end.reason).toContain("Approved");
  });

});