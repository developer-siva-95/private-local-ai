import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  afterEach,
} from "vitest";

/*
 * Mock the vscode module.
 * OutputChannelLogger uses OutputChannel — we provide
 * a fake with the methods it calls.
 */
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(),
  },
}));

import { OutputChannelLogger } from "../../src/extension/OutputChannelLogger.js";

/*
 * Fake OutputChannel captures all appendLine calls
 * so we can assert what was written.
 */
interface FakeChannel {
  appendLine: (line: string) => void;
  clear: () => void;
  show: () => void;
  dispose: () => void;
  lines: string[];
}

function createFakeChannel(): FakeChannel {
  const lines: string[] = [];
  return {
    lines,
    appendLine: (line: string) => {
      lines.push(line);
    },
    clear: () => {
      lines.length = 0;
    },
    show: () => {
      /* noop */
    },
    dispose: () => {
      /* noop */
    },
  };
}

describe("OutputChannelLogger", () => {
  let channel: FakeChannel;
  let logger: OutputChannelLogger;

  beforeEach(() => {
    channel = createFakeChannel();
    logger = new OutputChannelLogger(
      channel as unknown as import("vscode").OutputChannel,
      false,
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  /* ─────────────────────────────────────────
   * Session lifecycle
   * ───────────────────────────────────────── */

  describe("Session lifecycle", () => {
    it("writes session start banner with workspace and model", () => {
      logger.sessionStart(
        "C:\\projects\\test",
        "test-model",
        "http://localhost:11434",
      );

      const joined = channel.lines.join("\n");
      expect(joined).toContain("Private AI — Session Started");
      expect(joined).toContain("C:\\projects\\test");
      expect(joined).toContain("test-model");
      expect(joined).toContain("http://localhost:11434");
    });

    it("writes session end marker", () => {
      logger.sessionStart("root", "model", "url");
      const beforeCount = channel.lines.length;
      logger.sessionEnd();
      const joined = channel.lines.slice(beforeCount).join("\n");
      expect(joined).toContain("Private AI session ended");
    });
  });

  /* ─────────────────────────────────────────
   * Timing
   * ───────────────────────────────────────── */

  describe("Timing", () => {
    it("health timer records duration", async () => {
      const timer = logger.healthStart();
      await new Promise((r) => setTimeout(r, 20));
      logger.healthEnd(timer, true);

      const joined = channel.lines.join("\n");
      expect(joined).toMatch(/\[HEALTH\s*\].*✓.*Ollama connected/);
      expect(joined).toMatch(/\(\d+ms\)/);
    });

    it("health timer reports failure when ok=false", () => {
      const timer = logger.healthStart();
      logger.healthEnd(timer, false, "connection refused");

      const joined = channel.lines.join("\n");
      expect(joined).toContain("✗");
      expect(joined).toContain("failed");
      expect(joined).toContain("connection refused");
    });

    it("llm timer records tokens and duration", async () => {
      const timer = logger.llmStart();
      await new Promise((r) => setTimeout(r, 10));
      logger.llmEnd(timer, 42, true);

      const joined = channel.lines.join("\n");
      expect(joined).toContain("Thinking");
      expect(joined).toContain("~42 tokens");
      expect(joined).toContain("Final answer");
    });

    it("llm end without isFinal shows Response label", () => {
      const timer = logger.llmStart();
      logger.llmEnd(timer, 10, false);

      const joined = channel.lines.join("\n");
      expect(joined).toContain("Response");
      expect(joined).not.toContain("Final answer");
    });

    it("tool timer records success", () => {
      const timer = logger.toolStart("read_file", "src/index.ts");
      logger.toolEnd(timer, "read_file", true, 1234);

      const joined = channel.lines.join("\n");
      expect(joined).toContain("read_file");
      expect(joined).toContain("1234 chars");
      expect(joined).toContain("✓");
    });

    it("tool timer records failure with error", () => {
      const timer = logger.toolStart("read_file", "missing.ts");
      logger.toolEnd(
        timer,
        "read_file",
        false,
        undefined,
        "file not found",
      );

      const joined = channel.lines.join("\n");
      expect(joined).toContain("✗");
      expect(joined).toContain("failed");
      expect(joined).toContain("file not found");
    });

    it("diff timer records apply/cancel", () => {
      const timer = logger.diffStart("test.ts", "Patch");
      logger.diffEnd(timer, "test.ts", true);

      const joined = channel.lines.join("\n");
      expect(joined).toContain("Patch");
      expect(joined).toContain("Applied");
    });
  });

  /* ─────────────────────────────────────────
   * Security events
   * ───────────────────────────────────────── */

  describe("Security", () => {
    it("security entries always shown with block icon", () => {
      logger.security("blocked path traversal: ../../etc/passwd");

      const joined = channel.lines.join("\n");
      expect(joined).toContain("[SECURITY");
      expect(joined).toContain("⛔");
      expect(joined).toContain("blocked path traversal");
    });

    it("security entries are not truncated", () => {
      const longMessage =
        "very long security message that exceeds the normal max line length ".repeat(
          5,
        );
      logger.security(longMessage);

      const joined = channel.lines.join("\n");
      /*
       * Security messages must appear in full — verify the
       * full message length is preserved.
       */
      expect(joined).toContain(longMessage);
    });
  });

  /* ─────────────────────────────────────────
   * Permission logging
   * ───────────────────────────────────────── */

  describe("Permissions", () => {
    it("logs auto-approved permission", () => {
      logger.permissionAuto("read_file", "src/index.ts");

      const joined = channel.lines.join("\n");
      expect(joined).toContain("[PERM");
      expect(joined).toContain("read_file");
      expect(joined).toContain("auto-approved");
    });

    it("logs user-approved permission", () => {
      logger.permissionApproved("write_file", "test.ts");

      const joined = channel.lines.join("\n");
      expect(joined).toContain("[PERM");
      expect(joined).toContain("✓");
      expect(joined).toContain("write_file");
      expect(joined).toContain("approved");
    });

    it("logs denied permission", () => {
      logger.permissionDenied("delete_file", "important.ts");

      const joined = channel.lines.join("\n");
      expect(joined).toContain("[PERM");
      expect(joined).toContain("✗");
      expect(joined).toContain("denied");
    });

    it("logs workspace read approval", () => {
      logger.permissionWorkspaceRead(true);
      const joined = channel.lines.join("\n");
      expect(joined).toContain("Workspace read approved");
    });

    it("logs workspace read denial", () => {
      logger.permissionWorkspaceRead(false);
      const joined = channel.lines.join("\n");
      expect(joined).toContain("not approved");
    });
  });

  /* ─────────────────────────────────────────
   * Debug mode
   * ───────────────────────────────────────── */

  describe("Debug mode", () => {
    it("suppresses debug logs when debugMode=false", () => {
      logger.debug("TOOL", "input arguments");

      const joined = channel.lines.join("\n");
      expect(joined).not.toContain("input arguments");
    });

    it("shows debug logs when debugMode=true", () => {
      const debugChannel = createFakeChannel();
      const debugLogger = new OutputChannelLogger(
        debugChannel as unknown as import("vscode").OutputChannel,
        true,
      );

      debugLogger.debug("TOOL", "input arguments");

      const joined = debugChannel.lines.join("\n");
      expect(joined).toContain("DEBUG");
      expect(joined).toContain("input arguments");
    });

    it("shows context injection only in debug mode", () => {
      logger.contextInjected(
        "active_file: src/index.ts | cursor: 10",
      );

      /*
       * Not in debug mode → no output.
       */
      const joined = channel.lines.join("\n");
      expect(joined).not.toContain("active_file");
    });

    it("status change logged only in debug mode", () => {
      logger.statusChange("ready", "thinking");
      const joined = channel.lines.join("\n");
      expect(joined).not.toContain("ready → thinking");
    });
  });

  /* ─────────────────────────────────────────
   * Message truncation
   * ───────────────────────────────────────── */

  describe("Line truncation", () => {
    it("truncates long non-security messages", () => {
      const veryLongText = "x".repeat(200);
      logger.debug("TEST", veryLongText);

      /*
       * Debug mode required for this to appear.
       */
      const debugChannel = createFakeChannel();
      const debugLogger = new OutputChannelLogger(
        debugChannel as unknown as import("vscode").OutputChannel,
        true,
      );
      debugLogger.debug("TEST", veryLongText);

      /*
       * Check line ends with truncation marker.
       */
      const lines = debugChannel.lines.filter((l) =>
        l.includes("[DEBUG"),
      );
      const hasLongLine = lines.some((l) => l.length > 200);
      expect(hasLongLine).toBe(false);
    });
  });

  /* ─────────────────────────────────────────
   * User message summarization
   * ───────────────────────────────────────── */

  describe("User messages", () => {
    it("logs short user messages in quotes", () => {
      logger.userMessage("hello", 0, 0);
      const joined = channel.lines.join("\n");
      expect(joined).toContain('"hello"');
    });

    it("truncates long user messages", () => {
      logger.userMessage("x".repeat(200), 0, 0);
      const joined = channel.lines.join("\n");
      expect(joined).toContain("…");
    });

    it("shows file count when files referenced", () => {
      logger.userMessage("explain @a.ts @b.ts", 2, 500);
      const joined = channel.lines.join("\n");
      expect(joined).toContain("+2 files");
      expect(joined).toContain("500 chars context");
    });
  });

  /* ─────────────────────────────────────────
   * Timestamp format
   * ───────────────────────────────────────── */

  describe("Timestamp format", () => {
    it("includes YYYY-MM-DD HH:MM:SS.mmm timestamp", () => {
      logger.security("test");
      const line = channel.lines.find((l) => l.includes("SECURITY"));
      expect(line).toBeDefined();
      expect(line!).toMatch(
        /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/,
      );
    });
  });

  /* ─────────────────────────────────────────
   * Category formatting
   * ───────────────────────────────────────── */

  describe("Category formatting", () => {
    it("category is padded to 8 characters", () => {
      logger.security("x");
      const line = channel.lines.find((l) => l.includes("SECURITY"));
      expect(line).toMatch(/\[SECURITY\]/);
    });

    it("shorter categories padded with spaces", () => {
      const timer = logger.llmStart();
      logger.llmEnd(timer, 5, true);
      const line = channel.lines.find(
        (l) => l.includes("LLM") && l.includes("Final"),
      );
      expect(line).toMatch(/\[LLM\s+\]/);
    });
  });

  /* ─────────────────────────────────────────
   * Tier compression
   * ───────────────────────────────────────── */

  describe("Tier compression", () => {
    it("keeps recent entries visible after many logs", () => {
      /*
       * Write more than TIER1_MAX (20) entries.
       * Recent entries should still be visible.
       */
      for (let i = 0; i < 30; i++) {
        const timer = logger.toolStart(`tool_${i}`, `file_${i}`);
        logger.toolEnd(timer, `tool_${i}`, true, 100);
      }

      const joined = channel.lines.join("\n");
      /*
       * Latest tool_29 must be visible in tier 1.
       */
      expect(joined).toContain("tool_29");
    });

    it("compresses old entries into minute buckets", () => {
      /*
       * Write more than TIER1_MAX entries to trigger compression.
       */
      for (let i = 0; i < 25; i++) {
        const timer = logger.toolStart("read_file", `f${i}.ts`);
        logger.toolEnd(timer, "read_file", true);
      }

      const joined = channel.lines.join("\n");
      /*
       * Compressed bucket line should exist (── [HH:MM]).
       */
      expect(joined).toMatch(/──\s+\[\d{2}:\d{2}\]/);
    });
  });
});