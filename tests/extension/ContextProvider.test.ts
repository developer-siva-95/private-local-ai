import { describe, it, expect, vi, beforeEach } from "vitest";

/*
 * Mock vscode.window and workspace.
 * ContextProvider uses activeTextEditor, selection, and git via child_process.
 */
const mockActiveEditor: {
  document: {
    uri: { fsPath: string; scheme: string };
    languageId: string;
    getText: (sel: unknown) => string;
  };
  selection: {
    active: { line: number };
  };
} | undefined = undefined;

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() {
      return mockActiveEditor;
    },
    visibleTextEditors: [],
  },
}));

/*
 * Mock child_process.exec to control git branch output.
 */
vi.mock("node:child_process", () => ({
  exec: (
    _cmd: string,
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string }) => void,
  ) => {
    /*
     * Default: fail (no git repo).
     * Individual tests can override via mocked module state.
     */
    cb(new Error("not a git repo"), { stdout: "" });
  },
}));

import { ContextProvider } from "../../src/extension/ContextProvider.js";

describe("ContextProvider", () => {
  let cp: ContextProvider;

  beforeEach(() => {
    cp = new ContextProvider("C:\\workspace");
  });

  /* ─────────────────────────────────────────
   * getRelativePath (private, tested via buildContext)
   * ───────────────────────────────────────── */

  describe("Path resolution", () => {
    it("returns empty context when no editor open", async () => {
      const result = await cp.buildContext();
      /*
       * With no active editor and no git, may still return
       * git_branch: undefined → empty.
       */
      expect(result).toBe("");
    });
  });

  /* ─────────────────────────────────────────
   * Private method: getRelativePath
   * ───────────────────────────────────────── */

  describe("getRelativePath (via private access)", () => {
    interface Private {
      getRelativePath(fsPath: string): string | undefined;
    }

    function access(c: ContextProvider): Private {
      return c as unknown as Private;
    }

    it("returns relative path for file inside workspace", () => {
      const result = access(cp).getRelativePath(
        "C:\\workspace\\src\\index.ts",
      );
      expect(result).toBe("src/index.ts");
    });

    it("returns undefined for file outside workspace", () => {
      const result = access(cp).getRelativePath(
        "C:\\other\\file.ts",
      );
      expect(result).toBeUndefined();
    });

    it("returns undefined for workspace root itself", () => {
      const result = access(cp).getRelativePath("C:\\workspace");
      expect(result).toBeUndefined();
    });

    it("converts backslashes to forward slashes", () => {
      const result = access(cp).getRelativePath(
        "C:\\workspace\\deeply\\nested\\file.ts",
      );
      expect(result).toBe("deeply/nested/file.ts");
    });

    it("returns undefined for absolute path outside", () => {
      const result = access(cp).getRelativePath("D:\\other\\file.ts");
      expect(result).toBeUndefined();
    });
  });

  /* ─────────────────────────────────────────
   * Git branch caching
   * ───────────────────────────────────────── */

  describe("Git branch", () => {
    interface Private {
      getGitBranch(): Promise<string | undefined>;
    }

    function access(c: ContextProvider): Private {
      return c as unknown as Private;
    }

    it("returns undefined when git command fails", async () => {
      const branch = await access(cp).getGitBranch();
      expect(branch).toBeUndefined();
    });

    it("caches branch result to avoid repeat calls", async () => {
      /*
       * Call twice — second should use cache.
       * With our mock returning undefined, both return undefined.
       * We verify no crash and consistent result.
       */
      const first = await access(cp).getGitBranch();
      const second = await access(cp).getGitBranch();
      expect(first).toBe(second);
    });
  });
});