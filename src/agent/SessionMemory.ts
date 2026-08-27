import type { LLMMessage } from "../llm/LLMProvider.js";

/*
 * Maximum number of recent conversation turns
 * kept verbatim in Layer 2.
 *
 * Each turn = 1 user message + 1 assistant message.
 * 6 turns = 12 messages.
 */
const MAX_RECENT_TURNS = 6;

/*
 * Maximum characters for working memory
 * (Layer 1 — file contents and command outputs).
 *
 * ~2000 tokens at chars/4 approximation.
 */
const MAX_WORKING_MEMORY_CHARS = 8_000;

/*
 * Maximum entries in working memory.
 * LRU eviction when exceeded.
 */
const MAX_WORKING_MEMORY_ENTRIES = 8;

/*
 * Maximum characters for session facts
 * (Layer 3 — compressed older context).
 *
 * ~500 tokens.
 */
const MAX_FACTS_CHARS = 2_000;

/*
 * Working memory entry.
 * Stores tool results by key.
 */
interface WorkingMemoryEntry {
  key: string;
  content: string;
  toolName: string;
  timestamp: number;
}

/*
 * SessionMemory
 *
 * Manages conversation memory across turns using
 * a 4-layer architecture:
 *
 * Layer 0: System prompt — always pinned (managed by Agent)
 * Layer 1: Working memory — exact tool results (files, commands)
 * Layer 2: Recent turns — last N verbatim conversation turns
 * Layer 3: Session facts — compressed older context
 *
 * This design gives effectively unlimited session memory
 * within the 8192 token context window by keeping
 * exact data where precision matters (Layer 1) and
 * compressing where recency matters less (Layer 3).
 *
 * Zero extra LLM calls — all compression is deterministic.
 * Zero latency — no summarization inference.
 * Perfect accuracy — file contents stored exactly.
 */
export class SessionMemory {
  /*
   * Layer 1: Working memory.
   * Stores exact tool outputs by key.
   * Key format: "toolName:target"
   * Example: "read_file:package.json"
   */
  private readonly workingMemory: WorkingMemoryEntry[] = [];

  /*
   * Layer 2: Recent conversation turns.
   * Stored as pairs: [userMessage, assistantMessage]
   * Most recent at the end.
   */
  private readonly recentTurns: Array<{
    user: LLMMessage;
    assistant: LLMMessage;
  }> = [];

  /*
   * Layer 3: Session facts.
   * Compressed representation of older turns.
   * Built deterministically — no LLM call needed.
   */
  private sessionFacts: string[] = [];

  /*
   * Add a completed conversation turn to memory.
   *
   * Called after each successful agent response.
   * Manages rotation between Layer 2 and Layer 3.
   */
  addTurn(
    userMessage: string,
    assistantMessage: string,
  ): void {
    const userMsg: LLMMessage = {
      role: "user",
      content: userMessage,
    };

    const assistantMsg: LLMMessage = {
      role: "assistant",
      content: assistantMessage,
    };

    /*
     * If recent turns is at capacity, compress
     * the oldest turn into Layer 3 session facts
     * before adding the new turn.
     */
    if (this.recentTurns.length >= MAX_RECENT_TURNS) {
      const oldest = this.recentTurns.shift();
      if (oldest !== undefined) {
        this.compressTurnToFacts(oldest.user, oldest.assistant);
      }
    }

    this.recentTurns.push({
      user: userMsg,
      assistant: assistantMsg,
    });
  }

  /*
   * Store a tool result in working memory (Layer 1).
   *
   * Called after every successful tool execution.
   * Automatically evicts oldest entry when at capacity.
   *
   * Key is deterministic: "toolName:target"
   * Same file read twice = updates existing entry.
   */
  storeToolResult(
    toolName: string,
    target: string,
    content: string,
  ): void {
    const key = `${toolName}:${target}`;

    /*
     * Remove existing entry for same key (update).
     */
    const existingIndex = this.workingMemory.findIndex(
      (e) => e.key === key,
    );

    if (existingIndex !== -1) {
      this.workingMemory.splice(existingIndex, 1);
    }

    /*
     * Evict oldest entry if at capacity (LRU).
     */
    if (
      this.workingMemory.length >= MAX_WORKING_MEMORY_ENTRIES
    ) {
      this.workingMemory.shift();
    }

    this.workingMemory.push({
      key,
      content,
      toolName,
      timestamp: Date.now(),
    });
  }

  /*
   * Invalidate a specific working memory entry.
   *
   * Called when a file is written or patched so
   * the model never reads stale cached content.
   */
  invalidateToolResult(
    toolName: string,
    target: string,
  ): void {
    const key = `${toolName}:${target}`;
    const index = this.workingMemory.findIndex(
      (e) => e.key === key,
    );

    if (index !== -1) {
      this.workingMemory.splice(index, 1);
    }

    /*
     * Also invalidate read_file cache when
     * write_file or patch_file modifies the
     * same path.
     */
    const readKey = `read_file:${target}`;
    const readIndex = this.workingMemory.findIndex(
      (e) => e.key === readKey,
    );

    if (readIndex !== -1) {
      this.workingMemory.splice(readIndex, 1);
    }
  }

  /*
   * Build the complete message array for an LLM call.
   *
   * Returns messages in this order:
   * 1. Working memory context (Layer 1) — if any
   * 2. Session facts (Layer 3) — if any
   * 3. Recent turns verbatim (Layer 2)
   * 4. Current user message (Layer 4)
   *
   * System prompt (Layer 0) is injected by Agent
   * as the first message — never managed here.
   */
  buildMessages(currentUserMessage: string): LLMMessage[] {
    const messages: LLMMessage[] = [];

    /*
     * Layer 1: Working memory.
     * Inject as a system-style context message.
     */
    const workingMemoryContext =
      this.buildWorkingMemoryContext();

    if (workingMemoryContext !== "") {
      messages.push({
        role: "system",
        content: workingMemoryContext,
      });
    }

    /*
     * Layer 3: Session facts.
     * Inject before recent turns so model has
     * background context before reading recent chat.
     */
    if (this.sessionFacts.length > 0) {
      const factsContent =
        "[Earlier in this session]\n" +
        this.sessionFacts.join("\n");

      messages.push({
        role: "system",
        content: factsContent,
      });
    }

    /*
     * Layer 2: Recent turns verbatim.
     */
    for (const turn of this.recentTurns) {
      messages.push(turn.user);
      messages.push(turn.assistant);
    }

    /*
     * Layer 4: Current user message.
     */
    messages.push({
      role: "user",
      content: currentUserMessage,
    });

    return messages;
  }

  /*
   * Get history length for external checks.
   * Returns total message count across all layers.
   */
  getHistoryLength(): number {
    return this.recentTurns.length * 2;
  }

  /*
   * Estimate total tokens across all memory layers.
   * Used for context window warning.
   * Approximation: chars / 4.
   */
  estimateTokens(): number {
    let total = 0;

    /*
     * Layer 1: Working memory.
     */
    for (const entry of this.workingMemory) {
      total += Math.ceil(entry.content.length / 4);
    }

    /*
     * Layer 2: Recent turns.
     */
    for (const turn of this.recentTurns) {
      total += Math.ceil(turn.user.content.length / 4);
      total += Math.ceil(
        turn.assistant.content.length / 4,
      );
    }

    /*
     * Layer 3: Session facts.
     */
    for (const fact of this.sessionFacts) {
      total += Math.ceil(fact.length / 4);
    }

    return total;
  }

  /*
   * Clear all memory layers.
   * Called when user types 'clear'.
   */
  clear(): void {
    this.workingMemory.length = 0;
    this.recentTurns.length = 0;
    this.sessionFacts.length = 0;
  }

  /*
   * Compress an old conversation turn into
   * Layer 3 session facts.
   *
   * Deterministic — no LLM call.
   * Extracts key facts from the turn:
   * - First 80 chars of user message (intent)
   * - First 120 chars of assistant message (outcome)
   *
   * This preserves the gist of the conversation
   * without consuming large amounts of tokens.
   */
  private compressTurnToFacts(
    user: LLMMessage,
    assistant: LLMMessage,
  ): void {
    const userSnippet =
      user.content.length > 80
        ? user.content.slice(0, 80).trim() + "..."
        : user.content.trim();

    const assistantSnippet =
      assistant.content.length > 120
        ? assistant.content.slice(0, 120).trim() + "..."
        : assistant.content.trim();

    const fact =
      `Q: ${userSnippet}\nA: ${assistantSnippet}`;

    this.sessionFacts.push(fact);

    /*
     * Trim session facts if they exceed budget.
     * Remove oldest facts first.
     */
    let factsTotal = this.sessionFacts.join("\n").length;

    while (
      factsTotal > MAX_FACTS_CHARS &&
      this.sessionFacts.length > 0
    ) {
      this.sessionFacts.shift();
      factsTotal = this.sessionFacts.join("\n").length;
    }
  }

  /*
   * Build the working memory context string.
   *
   * Formats stored tool results as a compact
   * context block injected before conversation.
   *
   * Example output:
   * [Working memory from this session]
   * FILE: package.json
   * {"name":"private_ai","version":"1.0.0",...}
   * ---
   * COMMAND: node -v
   * v22.4.0
   */
    private buildWorkingMemoryContext(): string {
    if (this.workingMemory.length === 0) {
      return "";
    }

    const lines: string[] = [
      "[Working memory — data from this session]",
      /*
       * Persistent reminder injected with every working
       * memory block. Prevents model from forgetting it
       * has tool access during long sessions.
       */
      "[Note: You have read_file, write_file, web_access and other tools available. Use them when needed.]",
    ];

    let totalChars = lines.join("\n").length;

    for (const entry of this.workingMemory) {
      const label =
        entry.toolName === "read_file"
          ? `FILE: ${entry.key.replace("read_file:", "")}`
          : entry.toolName === "run_command"
            ? `COMMAND: ${entry.key.replace("run_command:", "")}`
            : `TOOL(${entry.toolName}): ${entry.key}`;

      const content =
        entry.content.length > 1_500
          ? entry.content.slice(0, 1_500) +
            "\n...[truncated]"
          : entry.content;

      const entryText = `${label}\n${content}\n---`;

      totalChars += entryText.length;

      if (totalChars > MAX_WORKING_MEMORY_CHARS) {
        lines.push(
          "[Some working memory entries omitted — token budget]",
        );
        break;
      }

      lines.push(entryText);
    }

    return lines.join("\n");
  }
}