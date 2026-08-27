import { readFileSync, existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentScanner } from "../security/ContentScanner.js";

/*
 * Maximum characters per stored fact.
 * Allows full sentences while preventing bloat.
 */
const MAX_FACT_CHARS = 150;

/*
 * Maximum total tokens for all facts combined.
 * Approximate: chars / 4.
 * 500 tokens = 2000 chars.
 */
const MAX_TOTAL_CHARS = 2_000;

/*
 * CrossSessionMemory
 *
 * Persists project-specific facts across sessions.
 * Stored in .private_ai/memory.json per project.
 *
 * Only user-initiated via /remember command.
 * LLM CANNOT auto-store — that would allow
 * persistent side effects without user consent.
 *
 * Security:
 *   - ContentScanner validates before storing
 *   - Max 150 chars per fact
 *   - Max 500 tokens total
 *   - Atomic write (temp file + rename)
 *   - File must be inside workspace
 */
export class CrossSessionMemory {
  private facts: string[] = [];
  private readonly memoryPath: string;
  private readonly memoryDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.memoryDir = path.join(workspaceRoot, ".private_ai");
    this.memoryPath = path.join(this.memoryDir, "memory.json");
  }

  /*
   * Load facts from disk on session start.
   * Silent if file does not exist — starts empty.
   * Warns if file is corrupt — starts empty.
   */
  load(): void {
    if (!existsSync(this.memoryPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.memoryPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        "facts" in parsed &&
        Array.isArray((parsed as Record<string, unknown>)["facts"])
      ) {
        const facts = (parsed as { facts: unknown[] }).facts;

        this.facts = facts
          .filter((f): f is string => typeof f === "string")
          .slice(0, 50);

        this.trimToTokenBudget();
      }
    } catch {
      console.warn(
        "[CrossSessionMemory] Memory file corrupt — starting fresh.",
      );
      this.facts = [];
    }
  }

  /*
   * Add a fact to cross-session memory.
   *
   * Returns result object with success/error.
   * Never throws — caller handles the message.
   *
   * Security:
   *   - ContentScanner must pass
   *   - Max 150 chars enforced
   *   - Total budget enforced
   *   - Saved atomically to disk
   */
  async remember(fact: string): Promise<{
    success: boolean;
    message: string;
  }> {
    const trimmed = fact.trim();

    if (trimmed === "") {
      return {
        success: false,
        message: "Fact cannot be empty.",
      };
    }

    /*
     * Enforce max fact length.
     */
    if (trimmed.length > MAX_FACT_CHARS) {
      return {
        success: false,
        message:
          `Fact too long (${trimmed.length} chars). ` +
          `Maximum is ${MAX_FACT_CHARS} characters.`,
      };
    }

    /*
     * Content scan before storing.
     * Block injection patterns.
     */
    const scan = contentScanner.scan(trimmed, "memory fact");

    if (scan.hasWarnings) {
      return {
        success: false,
        message:
          `Fact blocked by security scanner:\n` +
          scan.warnings.join("\n") +
          `\nPlease rephrase without suspicious patterns.`,
      };
    }

    /*
     * Check for duplicate.
     */
    if (this.facts.includes(trimmed)) {
      return {
        success: false,
        message: "This fact is already remembered.",
      };
    }

    this.facts.push(trimmed);
    this.trimToTokenBudget();

    await this.save();

    return {
      success: true,
      message: `✓ Remembered: "${trimmed}"`,
    };
  }

  /*
   * Remove a fact from cross-session memory.
   * Matches by exact string or substring.
   */
  async forget(query: string): Promise<{
    success: boolean;
    message: string;
  }> {
    const trimmed = query.trim().toLowerCase();

    const index = this.facts.findIndex((f) =>
      f.toLowerCase().includes(trimmed),
    );

    if (index === -1) {
      return {
        success: false,
        message: `No fact found matching: "${query}"`,
      };
    }

    const removed = this.facts[index];
    this.facts.splice(index, 1);

    await this.save();

    return {
      success: true,
      message: `✓ Forgotten: "${removed}"`,
    };
  }

  /*
   * Get all stored facts as display string.
   */
  getDisplay(): string {
    if (this.facts.length === 0) {
      return "No project memory stored yet.\nUse /remember \"fact\" to save something.";
    }

    const tokenEstimate = Math.ceil(
      this.facts.join(" ").length / 4,
    );

    return (
      `Project memory (${this.facts.length} facts, ~${tokenEstimate} tokens):\n` +
      this.facts.map((f, i) => `  ${i + 1}. ${f}`).join("\n")
    );
  }

  /*
   * Get facts as injection string for system prompt.
   * Returns empty string if no facts stored.
   */
  buildContext(): string {
    if (this.facts.length === 0) {
      return "";
    }

    return (
      "[Project memory — remembered across sessions]\n" +
      this.facts.map((f) => `- ${f}`).join("\n") +
      "\n"
    );
  }

  /*
   * Check if any facts are stored.
   */
  hasMemory(): boolean {
    return this.facts.length > 0;
  }

  /*
   * Get count of stored facts.
   */
  getCount(): number {
    return this.facts.length;
  }

  /*
   * Trim facts to stay within token budget.
   * Removes oldest facts first.
   */
  private trimToTokenBudget(): void {
    while (
      this.facts.join("\n").length > MAX_TOTAL_CHARS &&
      this.facts.length > 0
    ) {
      this.facts.shift();
    }
  }

  /*
   * Save facts to disk atomically.
   * Write to temp file then rename.
   * This prevents corruption if process dies mid-write.
   */
  private async save(): Promise<void> {
    try {
      await mkdir(this.memoryDir, { recursive: true });

      const data = JSON.stringify(
        {
          version: 1,
          savedAt: new Date().toISOString(),
          facts: this.facts,
        },
        null,
        2,
      );

      const tempPath = `${this.memoryPath}.${randomUUID()}.tmp`;

      /*
       * Write to temp then rename — atomic on most
       * filesystems including Windows NTFS.
       */
      await writeFile(tempPath, data, "utf8");

      const { rename } = await import("node:fs/promises");
      await rename(tempPath, this.memoryPath);
    } catch (error) {
      console.warn(
        `[CrossSessionMemory] Failed to save: ` +
        `${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}