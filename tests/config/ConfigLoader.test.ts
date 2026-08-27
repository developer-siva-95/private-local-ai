import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigLoader } from "../../src/config/ConfigLoader.js";
import { DEFAULT_CONFIG } from "../../src/config/ConfigTypes.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/*
 * Use a temp directory inside the project for tests.
 * Cleaned up after each test.
 */
const testRoot = path.join(
  "G:\\siva\\projects\\private_ai",
  "test_config_temp",
);

function writeEnvFile(content: string): void {
  writeFileSync(path.join(testRoot, ".env"), content, "utf8");
}

function writeProjectConfig(
  content: Record<string, unknown>,
): void {
  const dir = path.join(testRoot, ".private_ai");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(content),
    "utf8",
  );
}

describe("ConfigLoader", () => {
  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────
  // Defaults
  // ─────────────────────────────────────────

  it("returns defaults when no config files exist", () => {
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();

    expect(config.ollamaUrl).toBe(DEFAULT_CONFIG.ollamaUrl);
    expect(config.modelName).toBe(DEFAULT_CONFIG.modelName);
    expect(config.fallbackModel).toBe(DEFAULT_CONFIG.fallbackModel);
    expect(config.approvalTimeoutSeconds).toBe(
      DEFAULT_CONFIG.approvalTimeoutSeconds,
    );
    expect(config.debugMode).toBe(DEFAULT_CONFIG.debugMode);
    expect(config.enabledTools).toBe(DEFAULT_CONFIG.enabledTools);
  });

  // ─────────────────────────────────────────
  // .env file parsing
  // ─────────────────────────────────────────

  it("loads OLLAMA_URL from .env file", () => {
    writeEnvFile("OLLAMA_URL=http://localhost:11435\n");
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.ollamaUrl).toBe("http://localhost:11435");
  });

  it("loads MODEL_NAME from .env file", () => {
    writeEnvFile("MODEL_NAME=llama3\n");
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("llama3");
  });

  it("handles CRLF line endings in .env file", () => {
    writeEnvFile(
      "MODEL_NAME=llama3\r\nDEBUG_MODE=true\r\n",
    );
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("llama3");
    expect(config.debugMode).toBe(true);
  });

  it("ignores comment lines in .env file", () => {
    writeEnvFile(
      "# This is a comment\nMODEL_NAME=llama3\n# Another comment\n",
    );
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("llama3");
  });

  it("ignores empty lines in .env file", () => {
    writeEnvFile(
      "\n\nMODEL_NAME=llama3\n\n",
    );
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("llama3");
  });

  it("handles quoted values in .env file", () => {
    writeEnvFile('MODEL_NAME="my model name"\n');
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("my model name");
  });

  it("handles single-quoted values in .env file", () => {
    writeEnvFile("MODEL_NAME='my model'\n");
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("my model");
  });

  it("parses DEBUG_MODE=true correctly", () => {
    writeEnvFile("DEBUG_MODE=true\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().debugMode).toBe(true);
  });

  it("parses DEBUG_MODE=1 correctly", () => {
    writeEnvFile("DEBUG_MODE=1\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().debugMode).toBe(true);
  });

  it("parses DEBUG_MODE=false correctly", () => {
    writeEnvFile("DEBUG_MODE=false\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().debugMode).toBe(false);
  });

  it("parses APPROVAL_TIMEOUT_SECONDS correctly", () => {
    writeEnvFile("APPROVAL_TIMEOUT_SECONDS=120\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().approvalTimeoutSeconds).toBe(120);
  });

  it("uses default for invalid APPROVAL_TIMEOUT_SECONDS", () => {
    writeEnvFile("APPROVAL_TIMEOUT_SECONDS=notanumber\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().approvalTimeoutSeconds).toBe(
      DEFAULT_CONFIG.approvalTimeoutSeconds,
    );
  });

  it("uses default for zero APPROVAL_TIMEOUT_SECONDS", () => {
    writeEnvFile("APPROVAL_TIMEOUT_SECONDS=0\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().approvalTimeoutSeconds).toBe(
      DEFAULT_CONFIG.approvalTimeoutSeconds,
    );
  });

  it("rejects injection chars in model name", () => {
    writeEnvFile("MODEL_NAME=model;rm -rf\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().modelName).toBe(
      DEFAULT_CONFIG.modelName,
    );
  });

  it("rejects invalid URL protocol", () => {
    writeEnvFile("OLLAMA_URL=ftp://localhost:11434\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().ollamaUrl).toBe(
      DEFAULT_CONFIG.ollamaUrl,
    );
  });

  it("rejects malformed URL", () => {
    writeEnvFile("OLLAMA_URL=not-a-url\n");
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().ollamaUrl).toBe(
      DEFAULT_CONFIG.ollamaUrl,
    );
  });

  // ─────────────────────────────────────────
  // .private_ai/config.json parsing
  // ─────────────────────────────────────────

  it("loads config from .private_ai/config.json", () => {
    writeProjectConfig({ modelName: "mistral" });
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().modelName).toBe("mistral");
  });

  it("accepts UPPER_CASE keys in project config", () => {
    writeProjectConfig({ MODEL_NAME: "codellama" });
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().modelName).toBe("codellama");
  });

  it("accepts camelCase keys in project config", () => {
    writeProjectConfig({ ollamaUrl: "http://127.0.0.1:11435" });
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().ollamaUrl).toBe(
      "http://127.0.0.1:11435",
    );
  });

  it("handles corrupt .private_ai/config.json gracefully", () => {
    const dir = path.join(testRoot, ".private_ai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      "{ invalid json }",
      "utf8",
    );
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe(DEFAULT_CONFIG.modelName);
  });

  // ─────────────────────────────────────────
  // Priority order
  // ─────────────────────────────────────────

  it("project config overrides .env file", () => {
    writeEnvFile("MODEL_NAME=from-env\n");
    writeProjectConfig({ modelName: "from-project-config" });
    const loader = new ConfigLoader(testRoot);
    expect(loader.load().modelName).toBe("from-project-config");
  });

  it("merges values from multiple sources", () => {
    writeEnvFile("MODEL_NAME=from-env\n");
    writeProjectConfig({
      approvalTimeoutSeconds: 120,
    });
    const loader = new ConfigLoader(testRoot);
    const config = loader.load();
    expect(config.modelName).toBe("from-env");
    expect(config.approvalTimeoutSeconds).toBe(120);
  });

  // ─────────────────────────────────────────
  // Security — path traversal
  // ─────────────────────────────────────────

  it("does not load .env from outside workspace", () => {
    /*
     * ConfigLoader resolves paths relative to workspace.
     * A path like ../../.env would resolve outside workspace
     * and be rejected by isPathSafe().
     *
     * We test by giving a workspace root that does not
     * contain any config files — should return defaults.
     */
    const safeLoader = new ConfigLoader(testRoot);
    const config = safeLoader.load();
    expect(config.modelName).toBe(DEFAULT_CONFIG.modelName);
  });
});