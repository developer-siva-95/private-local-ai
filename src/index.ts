import * as readline from "node:readline";
import { OllamaProvider } from "./llm/OllamaProvider.js";
import { OllamaHealthCheck } from "./llm/OllamaHealthCheck.js";
import { workspaceConfig } from "./config/config.js";
import { WorkspaceManager } from "./workspace/WorkspaceManager.js";
import { WorkspaceProvider } from "./workspace/WorkspaceProvider.js";
import { SecurityPolicy } from "./security/SecurityPolicy.js";
import { PermissionGateway } from "./security/PermissionGateway.js";
import { ApprovalController } from "./permissions/ApprovalController.js";
import { ApprovalService } from "./permissions/ApprovalService.js";
import { ConsoleApprovalHandler } from "./approval/ConsoleApprovalHandler.js";
import { AuditLog } from "./audit/AuditLog.js";
import {
  RateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
} from "./security/RateLimiter.js";
import { FileReadTool } from "./tools/FileReadTool.js";
import { FileWriteTool } from "./tools/FileWriteTool.js";
import { FileDeleteTool } from "./tools/FileDeleteTool.js";
import { RunCommandTool } from "./tools/RunCommandTool.js";
import { DirectoryListTool } from "./tools/DirectoryListTool.js";
import { FileSearchTool } from "./tools/FileSearchTool.js";
import { GitTool } from "./tools/GitTool.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { ToolExecutionGateway } from "./tools/ToolExecutionGateway.js";
import { FilePatchTool } from "./tools/FilePatchTool.js";
import { WebAccessTool } from "./tools/WebAccessTool.js";

import { Agent } from "./agent/Agent.js";
import { InteractiveLoop } from "./agent/InteractiveLoop.js";
import path from "node:path";

import { appConfig, getEnabledTools } from "./config/config.js";

const MODEL_NAME = appConfig.modelName;
const OLLAMA_URL = appConfig.ollamaUrl;
const APPROVAL_TIMEOUT_MS = appConfig.approvalTimeoutSeconds * 1_000;
const DEBUG_MODE = appConfig.debugMode;

/*
 * --------------------------------
 * Workspace
 * --------------------------------
 */
const workspaceProvider = new WorkspaceProvider(workspaceConfig);

const workspace = new WorkspaceManager(workspaceProvider.getRoot());

const workspaceRoot = workspaceProvider.getRoot();

console.log("-------------------------------------------");
console.log("PRIVATE AI AGENT");
console.log("PROJECT ROOT :", workspaceRoot);
console.log("SECURITY     : Workspace Boundary Enforced");
console.log("-------------------------------------------");

/*
 * --------------------------------
 * Health Check
 * --------------------------------
 */
const healthCheck = new OllamaHealthCheck(
  OLLAMA_URL,
  MODEL_NAME,
  appConfig.fallbackModel,
);

try {
  await healthCheck.check();
} catch (error) {
  console.error(
    "\n[ERROR]",
    error instanceof Error ? error.message : "Health check failed.",
  );
  process.exit(1);
}

/*
 * --------------------------------
 * Audit Log
 * --------------------------------
 */
const auditLog = new AuditLog(path.join(workspaceRoot, ".private_ai", "logs"));

await auditLog.initialize();

const today = new Date().toISOString().split("T")[0];

console.log(
  "AUDIT LOG    :",
  path.join(workspaceRoot, "logs", `${today}.audit.log`),
);

/*
 * --------------------------------
 * Rate Limiter
 * --------------------------------
 */
const rateLimiter = new RateLimiter(DEFAULT_RATE_LIMITER_CONFIG, auditLog);

console.log(
  "RATE LIMITS  : No hard limits.",
  `Large file warning at ${
    DEFAULT_RATE_LIMITER_CONFIG.largeFileWarnBytes / 1_048_576
  }MB.`,
);

/*
 * --------------------------------
 * Security
 * --------------------------------
 */
const securityPolicy = new SecurityPolicy(workspaceRoot);

const approvalController = new ApprovalController(APPROVAL_TIMEOUT_MS);

const approvalService = new ApprovalService(approvalController, auditLog);

const permissionGateway = new PermissionGateway(
  securityPolicy,
  approvalService,
  workspace,
  auditLog,
);

/*
 * --------------------------------
 * Shared Readline Interface
 *
 * ONE readline interface shared between
 * ConsoleApprovalHandler and InteractiveLoop.
 * This prevents stdin ownership conflict.
 * --------------------------------
 */
const sharedRl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  historySize: 50,
  completer: (line: string) => {
    const completions = [
      "/remember",
      "/forget",
      "/memory",
      "/stats",
      "/audit",
      "/export",
      "help",
      "clear",
      "exit",
      "save",
    ];
    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  },
});

/*
 * --------------------------------
 * Console Approval Handler
 * --------------------------------
 */
const approvalHandler = new ConsoleApprovalHandler(
  approvalController,
  workspaceRoot,
  sharedRl,
);

approvalHandler.start();

/*
 * --------------------------------
 * Tools
 * --------------------------------
 */
const fileReadTool = new FileReadTool(rateLimiter);
const fileWriteTool = new FileWriteTool();
const fileDeleteTool = new FileDeleteTool();
const runCommandTool = new RunCommandTool();
const directoryListTool = new DirectoryListTool();
const fileSearchTool = new FileSearchTool();
const gitTool = new GitTool();
const filePatchTool = new FilePatchTool();
const webAccessTool = new WebAccessTool();

const toolRegistry = new ToolRegistry();
const enabledTools = getEnabledTools();
const isEnabled = (name: string): boolean =>
  enabledTools.length === 0 || enabledTools.includes(name);

if (isEnabled("read_file")) toolRegistry.register(fileReadTool);
if (isEnabled("write_file")) toolRegistry.register(fileWriteTool);
if (isEnabled("delete_file")) toolRegistry.register(fileDeleteTool);
if (isEnabled("run_command")) toolRegistry.register(runCommandTool);
if (isEnabled("list_directory")) toolRegistry.register(directoryListTool);
if (isEnabled("search_files")) toolRegistry.register(fileSearchTool);
if (isEnabled("git_operation")) toolRegistry.register(gitTool);
if (isEnabled("patch_file")) toolRegistry.register(filePatchTool);
if (isEnabled("web_access")) toolRegistry.register(webAccessTool);

const toolExecutionGateway = new ToolExecutionGateway(
  permissionGateway,
  auditLog,
);

console.log(
  "TOOLS        :",
  toolRegistry.list().map((t) => t.name),
);

/*
 * --------------------------------
 * LLM
 * --------------------------------
 */
const llm = new OllamaProvider(
  MODEL_NAME,
  OLLAMA_URL,
  DEBUG_MODE,
  appConfig.fallbackModel,
  appConfig.contextSize,
);

/*
 * --------------------------------
 * Agent
 * --------------------------------
 */
const agent = new Agent(llm, toolRegistry, toolExecutionGateway, workspaceRoot);

/*
 * --------------------------------
 * Interactive Loop
 * --------------------------------
 */
const interactiveLoop = new InteractiveLoop(
  agent,
  {
    workspaceRoot,
    auditLog,
    maxRetries: 3,
    retryDelayMs: 2_000,
  },
  sharedRl,
);

/*
 * --------------------------------
 * Graceful Shutdown
 * --------------------------------
 */
async function shutdown(): Promise<void> {
  console.log("\n\n[Shutdown] Cleaning up...");

  /*
   * Stop the loop first — sets isRunning = false.
   * The loop will exit naturally on next iteration.
   * Do NOT call process.exit() — let the loop
   * finish cleanly to avoid unsettled await warning.
   */
  interactiveLoop.stop();

  const pending = approvalController.getPending();
  for (const request of pending) {
    approvalController.deny(request.id);
    console.log(`[Shutdown] Denied pending: ${request.id}`);
  }

  auditLog.logSessionEnd();
  approvalHandler.stop();
  sharedRl.close();

  console.log("[Shutdown] Complete. Goodbye.");
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

/*
 * --------------------------------
 * Start
 * --------------------------------
 */
await interactiveLoop.start();

/*
 * --------------------------------
 * Clean exit after loop ends
 * --------------------------------
 */
auditLog.logSessionEnd();
approvalHandler.stop();
sharedRl.close();
