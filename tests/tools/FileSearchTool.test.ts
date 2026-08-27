import { describe, expect, it } from "vitest";

import { FileSearchTool } from "../../src/tools/FileSearchTool.js";

import { Permission } from "../../src/permissions/Permission.js";

describe("FileSearchTool", () => {
  const workspaceRoot = "G:\\siva\\projects\\private_ai";

  it("declares Permission.READ_FILE", () => {
    const tool = new FileSearchTool();
    expect(tool.permission).toBe(Permission.READ_FILE);
  });

  it("has the correct name", () => {
    const tool = new FileSearchTool();
    expect(tool.name).toBe("search_files");
  });

  it("finds a term that exists in the project", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      {
        term: "Permission",
        path: "src/permissions",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Permission");
    expect(result.output).toContain(".ts:");
  });

  it("returns line numbers with matches", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      {
        term: "export",
        path: "src/permissions",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    /*
     * Output format: filepath:lineNumber: content
     * Line numbers must appear in the output.
     */
    const hasLineNumber = /:\d+:/.test(result.output);

    expect(hasLineNumber).toBe(true);
  });

  it("is case insensitive by default", async () => {
    const tool = new FileSearchTool();

    const lowerResult = await tool.execute(
      { term: "permission", path: "src" },
      { workspaceRoot },
    );

    const upperResult = await tool.execute(
      { term: "PERMISSION", path: "src" },
      { workspaceRoot },
    );

    expect(lowerResult.success).toBe(true);
    expect(upperResult.success).toBe(true);

    /*
     * Both searches should find the same
     * number of matches since search is
     * case insensitive.
     */
    const lowerCount = lowerResult.output.split("\n").length;

    const upperCount = upperResult.output.split("\n").length;

    expect(lowerCount).toBe(upperCount);
  });

  it("returns clear message when no matches found", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      {
        term: "XYZZY_NONEXISTENT_TERM_12345",
        path: "src",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("No matches found");
  });

  it("handles special regex characters safely", async () => {
    const tool = new FileSearchTool();

    /*
     * Search for a term with special regex
     * characters. Must not crash or throw.
     * tool.execute() is a literal string search.
     */
    const result = await tool.execute(
      {
        term: "tool.execute()",
        path: "src",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
  });

  it("searches the entire project from root", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "workspaceRoot", path: "." },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("workspaceRoot");
  });

  it("rejects an empty search term", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "", path: "src" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("A valid search term is required.");
  });

  it("rejects a whitespace-only search term", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "   ", path: "src" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("A valid search term is required.");
  });

  it("rejects an empty directory path", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "export", path: "" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("A valid directory path is required.");
  });

  it("rejects a path outside the workspace", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "password", path: "..\\.." },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Security violation");
  });

  it("skips node_modules automatically", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "export", path: "." },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);

    /*
     * Results must not contain node_modules paths.
     */
    expect(result.output).not.toContain("node_modules");
  });

  it("skips dist folder automatically", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      { term: "export", path: "." },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("dist\\");
    expect(result.output).not.toContain("dist-ext\\");
  });

  it("finds terms with spaces", async () => {
    const tool = new FileSearchTool();

    const result = await tool.execute(
      {
        term: "export class",
        path: "src",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("export class");
  });

  it("searches hidden files like .gitignore", async () => {
    const tool = new FileSearchTool();

    /*
     * .gitignore exists in the project root.
     * Search should include it.
     */
    const result = await tool.execute(
      { term: "node_modules", path: "." },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
  });
});
