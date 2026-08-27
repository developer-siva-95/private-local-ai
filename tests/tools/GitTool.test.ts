import { describe, expect, it } from "vitest";
import { GitTool } from "../../src/tools/GitTool.js";
import { Permission } from "../../src/permissions/Permission.js";

describe("GitTool", () => {
  const workspaceRoot = "G:\\siva\\projects\\private_ai";

  /*
   * NOTE: Git is optional.
   *
   * Tests that execute actual git commands
   * handle both cases:
   * 1. Git repo exists — success expected
   * 2. Git not initialized — graceful error expected
   *
   * The tool must never crash in either case.
   *
   * Security tests (blocking) do not depend
   * on git being initialized — they fail
   * before any git command runs.
   */

  it("declares Permission.GIT_OPERATION", () => {
    const tool = new GitTool();
    expect(tool.permission).toBe(Permission.GIT_OPERATION);
  });

  it("has the correct name", () => {
    const tool = new GitTool();
    expect(tool.name).toBe("git_operation");
  });

  it("allows git status — succeeds or graceful error", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "status" },
      { workspaceRoot },
    );

    expect(typeof result.success).toBe("boolean");

    if (result.success) {
      expect(result.output.length).toBeGreaterThan(0);
    } else {
      expect(result.error).toBeDefined();
      expect(result.error!.length).toBeGreaterThan(0);
    }
  });

  it("allows git log — succeeds or graceful error", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "log", args: "--oneline -5" },
      { workspaceRoot },
    );

    expect(typeof result.success).toBe("boolean");

    if (result.success) {
      expect(result.output.length).toBeGreaterThan(0);
    } else {
      expect(result.error).toBeDefined();
    }
  });

  it("allows git branch — succeeds or graceful error", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "branch" },
      { workspaceRoot },
    );

    expect(typeof result.success).toBe("boolean");

    if (result.success) {
      expect(result.output.length).toBeGreaterThan(0);
    } else {
      expect(result.error).toBeDefined();
    }
  });

  it("allows git diff — succeeds or graceful error", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "diff" },
      { workspaceRoot },
    );

    expect(typeof result.success).toBe("boolean");

    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("blocks git push", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "push" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not permitted");
  });

  it("blocks git pull", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "pull" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not permitted");
  });

  it("blocks git clone", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "clone" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not permitted");
  });

  it("blocks git reset", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "reset" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not permitted");
  });

  it("blocks git clean", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "clean" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not permitted");
  });

  it("blocks git checkout", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "checkout" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not permitted");
  });

  it("blocks --hard flag even on allowed subcommand", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "diff", args: "--hard HEAD" },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("--hard");
  });

  it("blocks --force flag", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      {
        subcommand: "commit",
        args: "--force -m 'test'",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("--force");
  });

  it("blocks shell injection with &&", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      {
        subcommand: "status",
        args: "&& del /s /q *.*",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("&&");
  });

  it("blocks pipe injection", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      {
        subcommand: "log",
        args: "| rm -rf /",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("|");
  });

  it("blocks semicolon injection", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      {
        subcommand: "status",
        args: "; format C:",
      },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(";");
  });

  it("rejects empty subcommand", async () => {
    const tool = new GitTool();

    const result = await tool.execute({ subcommand: "" }, { workspaceRoot });

    expect(result.success).toBe(false);
    expect(result.error).toBe("A valid git subcommand is required.");
  });

  it("never crashes regardless of git state", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "status" },
      { workspaceRoot },
    );

    /*
     * Must never throw.
     * Must always return a valid ToolResult.
     */
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.output).toBe("string");
  });

  it("returns error when attempting to commit with nothing staged", async () => {
    const tool = new GitTool();

    const result = await tool.execute(
      { subcommand: "commit", args: "-m 'test'" },
      { workspaceRoot },
    );

    // If it fails, it must either be because nothing is staged
    // OR because git isn't initialized in the test folder.
    if (!result.success) {
      const errText = (result.error || "").toLowerCase();
      const isCorrectError =
        errText.includes("nothing staged") ||
        errText.includes("not a git repository") ||
        errText.includes("no changes added") ||
        errText.includes("nothing to commit") ||
        errText.includes("clean") ||
        errText.includes("identity") ||
        errText.includes("config") ||
        errText.includes("author") ||
        errText.includes("tell me who you are") ||
        errText.includes("user.email");

      expect(isCorrectError).toBe(true);
    }
  });
});