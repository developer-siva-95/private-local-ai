import { describe, it, expect, vi, beforeEach } from "vitest";

/*
 * Mock vscode — DiffManager uses window.showWarningMessage
 * and commands.executeCommand. We only test pure logic here.
 */
vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(),
    showTextDocument: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
  Range: class {
    constructor(
      public startLine: number,
      public startCh: number,
      public endLine: number,
      public endCh: number,
    ) {}
  },
  Selection: class {
    constructor(
      public startLine: number,
      public startCh: number,
      public endLine: number,
      public endCh: number,
    ) {}
  },
  ViewColumn: { One: 1, Two: 2 },
  TextEditorRevealType: { InCenter: 2 },
}));

import { DiffManager } from "../../src/extension/DiffManager.js";

/*
 * Access private methods via cast for direct testing.
 * We test the pure logic: applyPatchInMemory + findFirstChangedLine.
 */
interface DiffManagerPrivates {
  applyPatchInMemory(
    content: string,
    operation: string,
    args: Record<string, unknown>,
  ): string | null;
  findFirstChangedLine(oldContent: string, newContent: string): number;
}

function accessPrivates(dm: DiffManager): DiffManagerPrivates {
  return dm as unknown as DiffManagerPrivates;
}

describe("DiffManager", () => {
  let dm: DiffManager;

  beforeEach(() => {
    dm = new DiffManager("C:\\test\\workspace");
  });

  /* ─────────────────────────────────────────
   * applyPatchInMemory — search/replace mode
   * ───────────────────────────────────────── */

  describe("applyPatchInMemory — search/replace", () => {
    it("replaces exact search string with replace string", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "hello world",
        "replace",
        { search: "hello", replace: "goodbye" },
      );
      expect(result).toBe("goodbye world");
    });

    it("returns null when search string not found", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "hello world",
        "replace",
        { search: "xxx", replace: "yyy" },
      );
      expect(result).toBeNull();
    });

    it("replaces first occurrence only", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "aa bb aa cc",
        "replace",
        { search: "aa", replace: "XX" },
      );
      expect(result).toBe("XX bb aa cc");
    });

    it("handles empty replace string as deletion", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "hello world",
        "replace",
        { search: "hello ", replace: "" },
      );
      expect(result).toBe("world");
    });

    it("handles multi-line search", () => {
      const original = "line1\nline2\nline3";
      const result = accessPrivates(dm).applyPatchInMemory(
        original,
        "replace",
        { search: "line1\nline2", replace: "replaced" },
      );
      expect(result).toBe("replaced\nline3");
    });
  });

  /* ─────────────────────────────────────────
   * applyPatchInMemory — line-based mode
   * ───────────────────────────────────────── */

  describe("applyPatchInMemory — replace lines", () => {
    it("replaces lines within range", () => {
      const content = "a\nb\nc\nd\ne";
      const result = accessPrivates(dm).applyPatchInMemory(
        content,
        "replace",
        { start_line: 2, end_line: 3, content: "X\nY" },
      );
      expect(result).toBe("a\nX\nY\nd\ne");
    });

    it("replaces single line", () => {
      const content = "a\nb\nc";
      const result = accessPrivates(dm).applyPatchInMemory(
        content,
        "replace",
        { start_line: 2, end_line: 2, content: "B" },
      );
      expect(result).toBe("a\nB\nc");
    });

    it("returns null when start_line is 0", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb\nc",
        "replace",
        { start_line: 0, end_line: 1, content: "X" },
      );
      expect(result).toBeNull();
    });

    it("returns null when end_line exceeds file length", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb\nc",
        "replace",
        { start_line: 1, end_line: 99, content: "X" },
      );
      expect(result).toBeNull();
    });
  });

  describe("applyPatchInMemory — insert", () => {
    it("inserts at line 0 (top of file)", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb",
        "insert",
        { start_line: 0, content: "NEW" },
      );
      expect(result).toBe("NEW\na\nb");
    });

    it("inserts in middle", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb\nc",
        "insert",
        { start_line: 2, content: "X" },
      );
      expect(result).toBe("a\nb\nX\nc");
    });

    it("inserts at end of file", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb",
        "insert",
        { start_line: 2, content: "NEW" },
      );
      expect(result).toBe("a\nb\nNEW");
    });

    it("returns null for negative start_line", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a",
        "insert",
        { start_line: -1, content: "X" },
      );
      expect(result).toBeNull();
    });
  });

  describe("applyPatchInMemory — delete", () => {
    it("deletes lines within range", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb\nc\nd",
        "delete",
        { start_line: 2, end_line: 3 },
      );
      expect(result).toBe("a\nd");
    });

    it("deletes single line", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb\nc",
        "delete",
        { start_line: 2, end_line: 2 },
      );
      expect(result).toBe("a\nc");
    });

    it("returns null when start_line is 0", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "a\nb\nc",
        "delete",
        { start_line: 0, end_line: 1 },
      );
      expect(result).toBeNull();
    });
  });

  describe("applyPatchInMemory — unknown operation", () => {
    it("returns null for unrecognized operation", () => {
      const result = accessPrivates(dm).applyPatchInMemory(
        "content",
        "invalid_op",
        {},
      );
      expect(result).toBeNull();
    });
  });

  /* ─────────────────────────────────────────
   * findFirstChangedLine
   * ───────────────────────────────────────── */

  describe("findFirstChangedLine", () => {
    it("returns 0 when old content is empty (new file)", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "",
        "new content",
      );
      expect(line).toBe(0);
    });

    it("returns 0 when first line differs", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "old\nb\nc",
        "new\nb\nc",
      );
      expect(line).toBe(0);
    });

    it("returns correct line when middle line differs", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "a\nb\nc",
        "a\nX\nc",
      );
      expect(line).toBe(1);
    });

    it("returns correct line when last line differs", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "a\nb\nc",
        "a\nb\nX",
      );
      expect(line).toBe(2);
    });

    it("returns correct line when content is added at end", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "a\nb",
        "a\nb\nc",
      );
      expect(line).toBe(2);
    });

    it("returns correct line when content is removed", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "a\nb\nc",
        "a\nb",
      );
      expect(line).toBe(2);
    });

    it("returns 0 for identical content", () => {
      const line = accessPrivates(dm).findFirstChangedLine(
        "same\ncontent",
        "same\ncontent",
      );
      expect(line).toBe(0);
    });
  });
});