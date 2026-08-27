import * as readline from "node:readline";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "./Agent.js";
import type { AgentContext, AgentResponse } from "./AgentTypes.js";
import type { AuditLog } from "../audit/AuditLog.js";
import { InputSanitizer } from "./InputSanitizer.js";

export interface InteractiveLoopOptions {
  workspaceRoot: string;
  auditLog?: AuditLog;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class InteractiveLoop {
  private readonly rl: readline.Interface;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private isRunning = false;
  private isReadlineClosed = false;
  private streamAbortController: AbortController | null = null;

  // Spinner state
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinFrame = 0;
  private turnStartTime = 0;

  private readonly sessionHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }> = [];

  constructor(
    private readonly agent: Agent,
    private readonly options: InteractiveLoopOptions,
    rl: readline.Interface,
  ) {
    this.rl = rl;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;

    if (typeof this.rl.on === "function") {
      this.rl.on("close", () => {
        this.isReadlineClosed = true;
        this.isRunning = false;
      });
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;

    console.log("\n");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║          PRIVATE AI AGENT — READY                ║");
    console.log("║  Type your message and press Enter.              ║");
    console.log("║  Use Up/Down arrows for command history.         ║");
    console.log("║  Type 'help' to see all commands.                ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("");

    while (this.isRunning) {
      const userInput = await this.prompt();
      if (!this.isRunning) break;

      const command = userInput.trim().toLowerCase();

      // Command Handlers
      if (command === "exit" || command === "quit" || command === "q") {
        await this.handleExit();
        break;
      }
      if (command === "help") {
        this.showHelp();
        continue;
      }
      if (command === "clear") {
        this.handleClear();
        continue;
      }
      if (command === "save") {
        await this.handleSave();
        continue;
      }
      if (command === "/memory") {
        this.handleMemory();
        continue;
      }
      if (command === "/stats") {
        this.handleStats();
        continue;
      }
      if (command === "/audit") {
        await this.handleAudit();
        continue;
      }
      if (command === "/export") {
        await this.handleExport();
        continue;
      }
      if (command === "/remember" || command.startsWith("/remember ")) {
        await this.handleRemember(userInput.trim().slice(10).trim());
        continue;
      }
      if (command === "/forget" || command.startsWith("/forget ")) {
        await this.handleForget(userInput.trim().slice(8).trim());
        continue;
      }

      const sanitized = InputSanitizer.sanitize(userInput);
      if (!sanitized.valid) {
        console.log(`\n  ✗ ${sanitized.error ?? "Invalid input."}\n`);
        continue;
      }

      this.sessionHistory.push({
        role: "user",
        content: sanitized.value,
        timestamp: new Date().toISOString(),
      });

      let streamStarted = false;
      this.turnStartTime = Date.now();

      const onToken = (token: string): void => {
        if (!this.isRunning) return;
        if (!streamStarted) {
          this.stopSpinner(); // Stop spinner when text arrives
          const trimmed = token.trimStart();
          if (trimmed === "") return;

          console.log("\n  Assistant:\n");
          process.stdout.write("  ");
          streamStarted = true;
          process.stdout.write(trimmed);
        } else {
          process.stdout.write(token);
        }
      };

      this.startSpinner("Thinking");

      const response = await this.runWithRetry(
        sanitized.value,
        { workspaceRoot: this.options.workspaceRoot },
        onToken,
      );

      this.stopSpinner();
      if (!this.isRunning) continue;

      if (response.success) {
        if (!streamStarted && response.content.trim() !== "") {
          console.log("\n  Assistant:\n");
          // Format response: trim and collapse excess newlines
          const formatted = response.content.trim().replace(/\n{3,}/g, "\n\n");
          console.log(`  ${formatted.split("\n").join("\n  ")}\n`);
        } else if (streamStarted) {
          console.log("\n");
        }

        if (response.contextWarning) {
          console.log(
            `\n  \x1b[33m⚠️  Context: ${response.contextWarning}\x1b[0m\n`,
          );
        }

        this.sessionHistory.push({
          role: "assistant",
          content: response.content,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.log(`\n  ✗ ${response.error ?? "Unknown error."}\n`);
      }
    }
  }

  private startSpinner(text: string): void {
    this.stopSpinner();
    this.spinFrame = 0;
    process.stdout.write("\n");
    this.spinnerTimer = setInterval(() => {
      const frame =
        this.spinnerFrames[this.spinFrame % this.spinnerFrames.length];
      const elapsed = ((Date.now() - this.turnStartTime) / 1000).toFixed(1);
      process.stdout.write(`\r  ${frame} ${text} (${elapsed}s)... `);
      this.spinFrame++;
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      // Clear the line
      process.stdout.write("\r" + " ".repeat(50) + "\r");
    }
  }

  private async handleAudit(): Promise<void> {
    if (!this.options.auditLog) return;
    const events = await this.options.auditLog.getRecentEvents(10);
    console.log("\n  ═══ RECENT AUDIT EVENTS ═══");
    if (events.length === 0) console.log("  No events found.");
    for (const e of events) {
      const time = e.timestamp.split("T")[1]?.split(".")[0];
      const status =
        e.event === "tool_denied" || e.success === false ? "✗" : "✓";
      console.log(
        `  [${time}] ${status} ${e.event.replace("_", " ")}: ${e.permission}`,
      );
    }
    console.log("");
  }

   private handleStats(): void {
    const tokens = this.agent.estimateHistoryTokens();
    const history = this.agent.getHistoryLength();
    const pct = Math.round((tokens / 8192) * 100);

    console.log("\n  ═══ SESSION METRICS ═══");
    console.log(`  Messages      : ${history}`);
    console.log(`  Tokens used   : ~${tokens} / 8192`);
    console.log(`  Context usage : ${pct}%`);

    /*
     * Show audit metrics if available.
     */
    if (this.options.auditLog !== undefined) {
      const m = this.options.auditLog.getMetrics();
      console.log(`  Duration      : ${m.durationSeconds}s`);
      console.log(`  Tool calls    : ${m.toolCalls}`);
      console.log(`  Approved      : ${m.approved}`);
      console.log(`  Denied        : ${m.denied}`);
      if (m.blocked > 0) {
        console.log(`  Blocked       : ${m.blocked} ⚠️`);
      }
    }

    const memory = this.agent.getCrossSessionMemory();
    if (memory.hasMemory()) {
      console.log(`  Project facts : ${memory.getCount()} remembered`);
    }

    console.log("");
  }

  private async handleExport(): Promise<void> {
    try {
      const exportDir = path.join(
        this.options.workspaceRoot,
        "logs",
        "exports",
      );
      await mkdir(exportDir, { recursive: true });
      const filename = `session-${new Date().getTime()}.md`;
      const filePath = path.join(exportDir, filename);

      let md = `# Private AI Session - ${new Date().toLocaleString()}\n\n`;
      for (const msg of this.sessionHistory) {
        md += `### ${msg.role.toUpperCase()}\n${msg.content}\n\n---\n\n`;
      }

      await writeFile(filePath, md, "utf8");
      console.log(`\n  ✓ Session exported to: ${filePath}\n`);
    } catch (err) {
      console.log(
        `\n  ✗ Export failed: ${err instanceof Error ? err.message : "Unknown error"}\n`,
      );
    }
  }

  private showHelp(): void {
    console.log("\n  ┌─────────────────────────────────────┐");
    console.log("  │  COMMANDS                           │");
    console.log("  ├─────────────────────────────────────┤");
    console.log("  │  exit / quit   End the session      │");
    console.log("  │  /remember     Save a project fact  │");
    console.log("  │  /forget       Remove a saved fact  │");
    console.log("  │  /memory       Show saved facts     │");
    console.log("  │  /stats        Show session metrics │");
    console.log("  │  /audit        Show recent security │");
    console.log("  │  /export       Save as Markdown     │");
    console.log("  │  save          Save as JSON         │");
    console.log("  │  clear         Clear conversation   │");
    console.log("  │  help          Show this message    │");
    console.log("  └─────────────────────────────────────┘\n");
  }

  stop(): void {
    this.isRunning = false;
    this.stopSpinner();
    this.streamAbortController?.abort();
    this.streamAbortController = null;
  }

  private prompt(): Promise<string> {
    return new Promise((resolve) => {
      if (!this.isRunning || this.isReadlineClosed) {
        resolve("exit");
        return;
      }
      this.rl.question("\n  You: ", (answer) => resolve(answer));
    });
  }

  private async runWithRetry(
    message: string,
    context: AgentContext,
    onToken?: (token: string) => void,
  ): Promise<AgentResponse> {
    this.streamAbortController = new AbortController();
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
         const response = await this.agent.run(
          {
            message,
            ...(onToken !== undefined ? { onToken } : {}),
            ...(this.streamAbortController !== null
              ? { signal: this.streamAbortController.signal }
              : {}),
          },
          context,
        );

        if (
          !response.success &&
          (response.error === "Permission denied." ||
            response.error?.includes("Unknown tool"))
        ) {
          return response;
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Unknown error";
        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelayMs);
        }
      }
    }
    return {
      success: false,
      content: "",
      error: `Failed after ${this.maxRetries} attempts. ${lastError}`,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ... keep handleRemember, handleForget, handleMemory as is
  private async handleRemember(fact: string): Promise<void> {
    if (fact === "") {
      console.log('\n  ✗ Usage: /remember "your fact here"\n');
      return;
    }
    const result = await this.agent.getCrossSessionMemory().remember(fact);
    console.log(`\n  ${result.success ? "✓" : "✗"} ${result.message}\n`);
  }

  private async handleSave(): Promise<void> {
    try {
      const sessionDir = path.join(
        this.options.workspaceRoot,
        "logs",
        "sessions",
      );
      await mkdir(sessionDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `session-${timestamp}.json`;
      const filePath = path.join(sessionDir, filename);

      const sessionData = {
        savedAt: new Date().toISOString(),
        workspaceRoot: this.options.workspaceRoot,
        messageCount: this.sessionHistory.length,
        messages: this.sessionHistory.map((m) => ({
          role: m.role,
          timestamp: m.timestamp,
          content:
            m.content.length > 500
              ? m.content.slice(0, 500) + "..."
              : m.content,
        })),
      };

      await writeFile(filePath, JSON.stringify(sessionData, null, 2), "utf8");
      console.log(`\n  ✓ Session saved to:\n  ${filePath}\n`);
    } catch (error) {
      console.log(
        `\n  ✗ Failed to save session: ${
          error instanceof Error ? error.message : "Unknown error"
        }\n`,
      );
    }
  }

  private async handleForget(query: string): Promise<void> {
    if (query === "") {
      console.log('\n  ✗ Usage: /forget "fact to remove"\n');
      return;
    }
    const result = await this.agent.getCrossSessionMemory().forget(query);
    console.log(`\n  ${result.success ? "✓" : "✗"} ${result.message}\n`);
  }

  private handleMemory(): void {
    const display = this.agent.getCrossSessionMemory().getDisplay();
    console.log(`\n  ${display.split("\n").join("\n  ")}\n`);
  }

  private async handleClear(): Promise<void> {
    this.sessionHistory.length = 0;
    this.agent.clearHistory();
    console.clear();
    console.log("\n  ✓ Conversation cleared. Starting fresh.\n");
  }

  private async handleExit(): Promise<void> {
    console.log("\n  Goodbye. Session ended.\n");
    await this.options.auditLog?.logSessionEnd();
    this.isRunning = false;
  }
}
