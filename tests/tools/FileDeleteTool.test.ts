import { describe, expect, it } from "vitest";
import { FileDeleteTool } from "../../src/tools/FileDeleteTool.js";
import { FileWriteTool } from "../../src/tools/FileWriteTool.js";
import { Permission } from "../../src/permissions/Permission.js";
import { access } from "node:fs/promises";
import path from "node:path";

describe("FileDeleteTool", () => {
  const workspaceRoot = "G:\\siva\\projects\\private_ai";
  const testFile = "delete_test.txt";

  it("declares Permission.DELETE_FILE", () => {
    const tool = new FileDeleteTool();
    expect(tool.permission).toBe(Permission.DELETE_FILE);
  });

  it("deletes an existing file", async () => {
    const writer = new FileWriteTool();
    const deleter = new FileDeleteTool();
    const fullPath = path.resolve(workspaceRoot, testFile);

    // 1. Create the file
    await writer.execute({ path: testFile, content: "to be deleted" }, { workspaceRoot });

    // 2. Delete the file
    const result = await deleter.execute({ path: testFile }, { workspaceRoot });
    expect(result.success).toBe(true);

    // 3. Verify it is gone
    await expect(access(fullPath)).rejects.toThrow();
  });

  it("returns error for non-existent file", async () => {
    const tool = new FileDeleteTool();
    const result = await tool.execute({ path: "non_existent.txt" }, { workspaceRoot });
    expect(result.success).toBe(false);
  });
});