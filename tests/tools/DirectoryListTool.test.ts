import { describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  DirectoryListTool,
} from "../../src/tools/DirectoryListTool.js";

import { Permission } from "../../src/permissions/Permission.js";

describe("DirectoryListTool", () => {
  const workspaceRoot =
    "G:\\siva\\projects\\private_ai";

  it("declares Permission.READ_FILE", () => {
    const tool = new DirectoryListTool();
    expect(tool.permission).toBe(
      Permission.READ_FILE,
    );
  });

  it("has the correct name", () => {
    const tool = new DirectoryListTool();
    expect(tool.name).toBe("list_directory");
  });

  it("lists workspace root recursively by default", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "." },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("package.json");
    expect(result.output).toContain("[FILE]");
    expect(result.output).toContain("[DIR]");
    expect(result.output).toContain(".ts");
  });

  it("lists src directory showing all TypeScript files", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "src" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("[FILE]");
    expect(result.output).toContain(".ts");
  });

  it("shows files inside subdirectories recursively", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "src" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    /*
     * Recursive listing must show files
     * inside agent/, tools/, security/ etc.
     * Not just the folder names.
     */
    expect(result.output).toContain("agent");
    expect(result.output).toContain("Agent.ts");
  });

  it("lists shallowly when recursive is false", async () => {
    const tool = new DirectoryListTool();

    const shallowResult = await tool.execute(
      { path: "src", recursive: "false" },
      { workspaceRoot },
    );

    const recursiveResult = await tool.execute(
      { path: "src" },
      { workspaceRoot },
    );

    expect(shallowResult.success).toBe(true);
    expect(recursiveResult.success).toBe(true);

    /*
     * Recursive result must have more lines
     * than shallow result because it shows
     * files inside subdirectories.
     */
    const shallowLines =
      shallowResult.output.split("\n").length;

    const recursiveLines =
      recursiveResult.output.split("\n").length;

    expect(recursiveLines).toBeGreaterThan(
      shallowLines,
    );
  });

  it("shows file sizes", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "." },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(
      result.output.includes("KB") ||
      result.output.includes(" B") ||
      result.output.includes("MB"),
    ).toBe(true);
  });

  it("rejects an empty path", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "A valid directory path is required.",
    );
  });

  it("rejects a path outside the workspace", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "..\\.." },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Security violation",
    );
  });

  it("returns error for non-existent directory", async () => {
    const tool = new DirectoryListTool();

    const result = await tool.execute(
      { path: "non-existent-xyz" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
  });

  it("handles empty directory", async () => {
    const tool = new DirectoryListTool();

    // Ensure logs folder exists before listing
    try {
      await mkdir(path.join(workspaceRoot, "logs"), { recursive: true });
    } catch {
      // Ignore if folder exists or creation fails due to permissions
    }

    /*
     * logs folder exists but may be empty
     * or have only log files.
     * Either way it should not crash.
     */
    const result = await tool.execute(
      { path: "logs" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
  });
});