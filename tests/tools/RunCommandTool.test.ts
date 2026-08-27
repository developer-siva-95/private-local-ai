import { describe, expect, it } from "vitest";
import { RunCommandTool } from "../../src/tools/RunCommandTool.js";
import { Permission } from "../../src/permissions/Permission.js";

describe("RunCommandTool", () => {
  const workspaceRoot = "G:\\siva\\projects\\private_ai";

  it("declares Permission.RUN_COMMAND", () => {
    const tool = new RunCommandTool();
    expect(tool.permission).toBe(Permission.RUN_COMMAND);
  });

  it("has the correct name", () => {
    const tool = new RunCommandTool();
    expect(tool.name).toBe("run_command");
  });

  it("has command as a required field in schema", () => {
    const tool = new RunCommandTool();
    expect(tool.inputSchema.required).toContain("command");
  });

  it("rejects an empty command", async () => {
    const tool = new RunCommandTool();

    const result = await tool.execute(
      { command: "" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Valid command is required.");
  });

  it("rejects a whitespace-only command", async () => {
    const tool = new RunCommandTool();

    const result = await tool.execute(
      { command: "   " },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Valid command is required.");
  });

  it("executes a safe command successfully", async () => {
    const tool = new RunCommandTool();

    const result = await tool.execute(
      { command: "echo hello" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("returns error for a failing command", async () => {
    const tool = new RunCommandTool();

    const result = await tool.execute(
      { command: "non_existent_command_xyz_123" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});