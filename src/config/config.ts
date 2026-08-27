import path from "node:path";
import { ConfigLoader } from "./ConfigLoader.js";
import type { WorkspaceConfig } from "../workspace/WorkspaceConfig.js";

/*
 * Workspace root resolution.
 *
 * Priority:
 * 1. PROJECT_ROOT environment variable
 * 2. process.cwd() — current working directory
 *
 * This is resolved once at startup and used
 * as the security boundary for all operations.
 */
const workspaceRoot = path.resolve(
  process.env["PROJECT_ROOT"] ?? process.cwd(),
);

/*
 * Load full configuration from all sources.
 *
 * Priority order (highest to lowest):
 * 1. .private_ai/config.json (project-specific)
 * 2. .env file (project environment)
 * 3. process.env (system environment)
 * 4. Default values
 */
const loader = new ConfigLoader(workspaceRoot);
export const appConfig = loader.load();

/*
 * Workspace configuration for WorkspaceProvider.
 * Kept separate for backward compatibility.
 */
export const workspaceConfig: WorkspaceConfig = {
  root: workspaceRoot,
};

/*
 * Helper: get list of enabled tool names.
 * Empty array means all tools are enabled.
 *
 * Usage in index.ts:
 *   const enabled = getEnabledTools();
 *   if (enabled.length === 0 || enabled.includes("read_file")) {
 *     toolRegistry.register(fileReadTool);
 *   }
 */
export function getEnabledTools(): string[] {
  const raw = appConfig.enabledTools.trim();

  if (raw === "") {
    return [];
  }

  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");
}