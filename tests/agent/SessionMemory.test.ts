import { describe, it, expect, beforeEach } from "vitest";
import { SessionMemory } from "../../src/agent/SessionMemory.js";

describe("SessionMemory", () => {
  let memory: SessionMemory;

  beforeEach(() => {
    memory = new SessionMemory();
  });

  // ─────────────────────────────────────────
  // Initial state
  // ─────────────────────────────────────────

  it("starts with empty history", () => {
    expect(memory.getHistoryLength()).toBe(0);
  });

  it("starts with zero token estimate", () => {
    expect(memory.estimateTokens()).toBe(0);
  });

  it("builds messages with only current user message when empty", () => {
    const messages = memory.buildMessages("hello");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("hello");
  });

  // ─────────────────────────────────────────
  // Adding turns
  // ─────────────────────────────────────────

  it("adds a turn to recent history", () => {
    memory.addTurn("user question", "assistant answer");
    expect(memory.getHistoryLength()).toBe(2);
  });

  it("includes recent turns in built messages", () => {
    memory.addTurn("first question", "first answer");
    const messages = memory.buildMessages("second question");

    const userMessages = messages.filter(
      (m) => m.role === "user",
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.content).toBe("first question");
    expect(userMessages[1]?.content).toBe("second question");
  });

  it("keeps up to 6 recent turns verbatim", () => {
    for (let i = 0; i < 6; i++) {
      memory.addTurn(`question ${i}`, `answer ${i}`);
    }
    expect(memory.getHistoryLength()).toBe(12);
  });

  it("compresses oldest turn to facts when exceeding 6 turns", () => {
    for (let i = 0; i < 7; i++) {
      memory.addTurn(`question ${i}`, `answer ${i}`);
    }

    /*
     * 7 turns added but only 6 kept verbatim.
     * Oldest turn moved to session facts.
     */
    expect(memory.getHistoryLength()).toBe(12);

    const messages = memory.buildMessages("current");

    /*
     * Session facts should be present as a
     * system message before recent turns.
     */
    const systemMessages = messages.filter(
      (m) => m.role === "system",
    );

    const factsMessage = systemMessages.find((m) =>
      m.content.includes("[Earlier in this session]"),
    );

    expect(factsMessage).toBeDefined();
    expect(factsMessage?.content).toContain("question 0");
  });

  // ─────────────────────────────────────────
  // Working memory
  // ─────────────────────────────────────────

  it("stores tool result in working memory", () => {
    memory.storeToolResult(
      "read_file",
      "package.json",
      '{"name":"private_ai"}',
    );

    const messages = memory.buildMessages("what is the name?");

    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    expect(workingMemoryMsg).toBeDefined();
    expect(workingMemoryMsg?.content).toContain("package.json");
    expect(workingMemoryMsg?.content).toContain(
      '{"name":"private_ai"}',
    );
  });

  it("updates existing working memory entry for same key", () => {
    memory.storeToolResult(
      "read_file",
      "package.json",
      "old content",
    );

    memory.storeToolResult(
      "read_file",
      "package.json",
      "new content",
    );

    const messages = memory.buildMessages("question");
    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    expect(workingMemoryMsg?.content).toContain("new content");
    expect(workingMemoryMsg?.content).not.toContain("old content");
  });

  it("invalidates tool result from working memory", () => {
    memory.storeToolResult(
      "read_file",
      "test.ts",
      "original content",
    );

    memory.invalidateToolResult("read_file", "test.ts");

    const messages = memory.buildMessages("question");
    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    expect(workingMemoryMsg).toBeUndefined();
  });

    it("evicts oldest entry when working memory is full", () => {
    /*
     * Max is now 8 entries.
     * Add 9 to trigger eviction of file0.ts.
     */
    for (let i = 0; i < 9; i++) {
      memory.storeToolResult(
        "read_file",
        `file${i}.ts`,
        `content of file ${i}`,
      );
    }

    const messages = memory.buildMessages("question");
    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    /*
     * file0.ts was evicted (oldest, 9th entry added).
     * file8.ts should be present (newest).
     */
    expect(workingMemoryMsg?.content).not.toContain(
      "file0.ts",
    );
    expect(workingMemoryMsg?.content).toContain("file8.ts");
  });

  // ─────────────────────────────────────────
  // Clear
  // ─────────────────────────────────────────

  it("clears all memory layers", () => {
    memory.addTurn("question", "answer");
    memory.storeToolResult("read_file", "test.ts", "content");

    memory.clear();

    expect(memory.getHistoryLength()).toBe(0);
    expect(memory.estimateTokens()).toBe(0);

    const messages = memory.buildMessages("new question");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("new question");
  });

  // ─────────────────────────────────────────
  // Token estimation
  // ─────────────────────────────────────────

  it("estimates tokens as chars divided by 4", () => {
    memory.addTurn(
      "a".repeat(400),
      "b".repeat(400),
    );

    /*
     * 800 chars / 4 = 200 tokens.
     */
    expect(memory.estimateTokens()).toBe(200);
  });

   // ─────────────────────────────────────────
  // Working memory capacity
  // ─────────────────────────────────────────

  it("allows up to 8 working memory entries", () => {
    for (let i = 0; i < 8; i++) {
      memory.storeToolResult(
        "read_file",
        `file${i}.ts`,
        `content ${i}`,
      );
    }

    const messages = memory.buildMessages("question");
    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    /*
     * All 8 entries should be present.
     * file0.ts was NOT evicted yet — eviction happens at 9.
     */
    expect(workingMemoryMsg?.content).toContain("file0.ts");
    expect(workingMemoryMsg?.content).toContain("file7.ts");
  });

  it("evicts oldest when 9th entry added", () => {
    for (let i = 0; i < 9; i++) {
      memory.storeToolResult(
        "read_file",
        `file${i}.ts`,
        `content ${i}`,
      );
    }

    const messages = memory.buildMessages("question");
    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    /*
     * file0.ts was evicted when file8.ts was added.
     * file8.ts should be present.
     */
    expect(workingMemoryMsg?.content).not.toContain(
      "file0.ts",
    );
    expect(workingMemoryMsg?.content).toContain("file8.ts");
  });

  // ─────────────────────────────────────────
  // Tool reminder in working memory
  // ─────────────────────────────────────────

  it("includes tool reminder note in working memory context", () => {
    memory.storeToolResult(
      "read_file",
      "test.ts",
      "some content",
    );

    const messages = memory.buildMessages("question");
    const workingMemoryMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Working memory"),
    );

    expect(workingMemoryMsg?.content).toContain(
      "read_file",
    );
    expect(workingMemoryMsg?.content).toContain(
      "tools available",
    );
  });

  // ─────────────────────────────────────────
  // Session facts compression
  // ─────────────────────────────────────────

  it("session facts contain snippets of compressed turns", () => {
    for (let i = 0; i < 7; i++) {
      memory.addTurn(
        `question about topic ${i}`,
        `answer about topic ${i}`,
      );
    }

    const messages = memory.buildMessages("current");
    const factsMsg = messages.find(
      (m) =>
        m.role === "system" &&
        m.content.includes("[Earlier in this session]"),
    );

    expect(factsMsg).toBeDefined();
    /*
     * Oldest turn compressed to ~80+120 chars.
     * Should contain recognizable snippet.
     */
    expect(factsMsg?.content).toContain("question about topic 0");
  });

});