import {
  describe,
  expect,
  it,
} from "vitest";

import { FileReadTool } from "../../src/tools/FileReadTool.js";

describe("FileReadTool", () => {
  const workspaceRoot =
    "G:\\siva\\projects\\private_ai";

  function createTool(): FileReadTool {
    return new FileReadTool();
  }

  it("reads an authorized file", async () => {
    const tool = createTool();
    const result = await tool.execute(
      { path: "package.json" },
      { workspaceRoot },
    );
    expect(result.success).toBe(true);
    /*
     * Check the file is valid JSON with a name field.
     * Do not check the specific name value — that is
     * fragile and breaks when package.json changes.
     */
    expect(result.output).toContain('"name"');
    expect(result.output).toContain('"version"');
  });

  it("rejects an empty path", async () => {
    const tool = createTool();

    const result = await tool.execute(
      {
        path: "",
      },
      {
        workspaceRoot,
      },
    );

    expect(result).toEqual({
      success: false,
      output: "",
      error: "A valid file path is required.",
    });
  });

  it("rejects a whitespace-only path", async () => {
    const tool = createTool();

    const result = await tool.execute(
      {
        path: "   ",
      },
      {
        workspaceRoot,
      },
    );

    expect(result).toEqual({
      success: false,
      output: "",
      error: "A valid file path is required.",
    });
  });

  it("rejects a non-string path", async () => {
    const tool = createTool();

    const result = await tool.execute(
      {
        path: 123,
      },
      {
        workspaceRoot,
      },
    );

    expect(result).toEqual({
      success: false,
      output: "",
      error: "A valid file path is required.",
    });
  });

  it("returns an error when the file does not exist", async () => {
    const tool = createTool();

    const result = await tool.execute(
      {
        path: "does-not-exist.txt",
      },
      {
        workspaceRoot,
      },
    );

    expect(result.success).toBe(false);
    expect(result.output).toBe("");
    expect(result.error).toBeDefined();
  });
});