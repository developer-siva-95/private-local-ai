import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilePatchTool } from "../../src/tools/FilePatchTool.js";
import { Permission } from "../../src/permissions/Permission.js";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const workspaceRoot = "G:\\siva\\projects\\private_ai";
const testDir = path.join(workspaceRoot, "test_patch_output");
const testFile = path.join(testDir, "test.txt");

const TEST_CONTENT = [
  "line 1: hello",
  "line 2: world",
  "line 3: foo",
  "line 4: bar",
  "line 5: baz",
].join("\n");

describe("FilePatchTool", () => {
  let tool: FilePatchTool;

  beforeEach(async () => {
    tool = new FilePatchTool();
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, TEST_CONTENT, "utf8");
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  });

  // ─────────────────────────────────────────
  // Basic properties
  // ─────────────────────────────────────────

  it("declares Permission.WRITE_FILE", () => {
    expect(tool.permission).toBe(Permission.WRITE_FILE);
  });

  it("has name patch_file", () => {
    expect(tool.name).toBe("patch_file");
  });

  // ─────────────────────────────────────────
  // Replace operation
  // ─────────────────────────────────────────

  it("replaces a single line", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        start_line: 2,
        end_line: 2,
        content: "line 2: replaced",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[1]).toBe("line 2: replaced");
    expect(lines.length).toBe(5);
  });

  it("replaces multiple lines", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        start_line: 2,
        end_line: 4,
        content: "new line A\nnew line B",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("line 1: hello");
    expect(lines[1]).toBe("new line A");
    expect(lines[2]).toBe("new line B");
    expect(lines[3]).toBe("line 5: baz");
    expect(lines.length).toBe(4);
  });

  // ─────────────────────────────────────────
  // Insert operation
  // ─────────────────────────────────────────

  it("inserts after a specific line", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "insert",
        start_line: 2,
        content: "inserted line",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("line 1: hello");
    expect(lines[1]).toBe("line 2: world");
    expect(lines[2]).toBe("inserted line");
    expect(lines[3]).toBe("line 3: foo");
    expect(lines.length).toBe(6);
  });

  it("inserts at beginning of file (line 0)", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "insert",
        start_line: 0,
        content: "first line",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("first line");
    expect(lines[1]).toBe("line 1: hello");
    expect(lines.length).toBe(6);
  });

  it("inserts after last line (append)", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "insert",
        start_line: 5,
        content: "appended line",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[lines.length - 1]).toBe("appended line");
    expect(lines.length).toBe(6);
  });

  // ─────────────────────────────────────────
  // Delete operation
  // ─────────────────────────────────────────

  it("deletes a single line", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "delete",
        start_line: 3,
        end_line: 3,
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("line 1: hello");
    expect(lines[1]).toBe("line 2: world");
    expect(lines[2]).toBe("line 4: bar");
    expect(lines.length).toBe(4);
  });

  it("deletes multiple lines", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "delete",
        start_line: 2,
        end_line: 4,
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("line 1: hello");
    expect(lines[1]).toBe("line 5: baz");
    expect(lines.length).toBe(2);
  });

  // ─────────────────────────────────────────
  // Search and replace
  // ─────────────────────────────────────────

  it("performs search and replace", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        search: "line 3: foo",
        replace: "line 3: replaced_foo",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toContain("line 3: replaced_foo");
    expect(content).not.toContain("line 3: foo");
  });

  it("returns error when search text not found", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        search: "nonexistent text",
        replace: "something",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // ─────────────────────────────────────────
  // Validation errors
  // ─────────────────────────────────────────

  it("rejects invalid operation", async () => {
    const result = await tool.execute(
      { path: "test_patch_output/test.txt", operation: "unknown" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown operation");
  });

  it("rejects negative start_line", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        start_line: -1,
        end_line: 1,
        content: "x",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("positive integer");
  });

  it("rejects start_line greater than end_line", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        start_line: 3,
        end_line: 1,
        content: "x",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be greater");
  });

  it("rejects end_line beyond file length", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "delete",
        start_line: 1,
        end_line: 100,
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("beyond file length");
  });

  it("rejects missing content for replace", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        start_line: 1,
        end_line: 1,
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Content is required");
  });

  it("rejects missing path", async () => {
    const result = await tool.execute(
      { path: "", operation: "replace" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Valid path");
  });

  // ─────────────────────────────────────────
  // Security
  // ─────────────────────────────────────────

  it("blocks patching outside workspace (defence-in-depth)", async () => {
    const result = await tool.execute(
      {
        path: "../outside.txt",
        operation: "replace",
        start_line: 1,
        end_line: 1,
        content: "hack",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Security violation");
  });

  it("returns error for nonexistent file", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/nonexistent.txt",
        operation: "replace",
        start_line: 1,
        end_line: 1,
        content: "x",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // ─────────────────────────────────────────
  // Diff output
  // ─────────────────────────────────────────

  it("includes diff in output on success", async () => {
    const result = await tool.execute(
      {
        path: "test_patch_output/test.txt",
        operation: "replace",
        start_line: 1,
        end_line: 1,
        content: "line 1: changed",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Diff:");
    expect(result.output).toContain("- line 1: hello");
    expect(result.output).toContain("+ line 1: changed");
  });
});