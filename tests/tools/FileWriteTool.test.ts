import { describe, expect, it, afterEach } from "vitest";
import { FileWriteTool } from "../../src/tools/FileWriteTool.js";
import { Permission } from "../../src/permissions/Permission.js";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";

describe("FileWriteTool", () => {
  const workspaceRoot = "G:\\siva\\projects\\private_ai";
  const testFile = "test_output/hello.txt";

  afterEach(async () => {
    // Cleanup test files
    try {
      await rm(path.resolve(workspaceRoot, "test_output"), { recursive: true, force: true });
    } catch {}
  });

  it("declares Permission.WRITE_FILE", () => {
    const tool = new FileWriteTool();
    expect(tool.permission).toBe(Permission.WRITE_FILE);
  });

  it("writes content to a new file and creates directories", async () => {
    const tool = new FileWriteTool();
    const content = "Console Agent Test";
    
    const result = await tool.execute(
      { path: testFile, content },
      { workspaceRoot }
    );

    expect(result.success).toBe(true);
    
    // Verify file exists
    const savedContent = await readFile(path.resolve(workspaceRoot, testFile), "utf8");
    expect(savedContent).toBe(content);
  });

  it("blocks writing outside the workspace (defense-in-depth)", async () => {
    const tool = new FileWriteTool();
    const result = await tool.execute(
      { path: "../outside.txt", content: "hack" },
      { workspaceRoot }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Security violation");
  });
});