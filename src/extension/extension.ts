import * as vscode from "vscode";
import * as path from "node:path";

import { WorkspaceDetector } from "./WorkspaceDetector.js";
import { VsCodeApprovalHandler } from "./VsCodeApprovalHandler.js";
import { OllamaProvider, OllamaHealthCheck } from "../llm/OllamaProvider.js";
import { Agent } from "../agent/Agent.js";
import { AuditLog } from "../audit/AuditLog.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ToolExecutionGateway } from "../tools/ToolExecutionGateway.js";
import { SecurityPolicy } from "../security/SecurityPolicy.js";
import { PermissionGateway } from "../security/PermissionGateway.js";
import { ApprovalController } from "../permissions/ApprovalController.js";
import { ApprovalService } from "../permissions/ApprovalService.js";
import { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import {
  RateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
} from "../security/RateLimiter.js";
import { FileReadTool } from "../tools/FileReadTool.js";
import { FileWriteTool } from "../tools/FileWriteTool.js";
import { FileDeleteTool } from "../tools/FileDeleteTool.js";
import { RunCommandTool } from "../tools/RunCommandTool.js";
import { DirectoryListTool } from "../tools/DirectoryListTool.js";
import { FileSearchTool } from "../tools/FileSearchTool.js";
import { GitTool } from "../tools/GitTool.js";
import { FilePatchTool } from "../tools/FilePatchTool.js";
import { WebAccessTool } from "../tools/WebAccessTool.js";
import { StatusBarManager } from "./StatusBarManager.js";
import { ChatViewProvider } from "./ChatViewProvider.js";
import { DiffManager } from "./DiffManager.js";
import { OutputChannelLogger } from "./OutputChannelLogger.js";
import { ContextProvider } from "./ContextProvider.js";
import type { ToolInput } from "../tools/Tool.js";

/*
 * Extension state at module level.
 * Shared between activate() and deactivate().
 */
let agent: Agent | undefined;
let approvalHandler: VsCodeApprovalHandler | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let logger: OutputChannelLogger | undefined;
let statusBar: StatusBarManager | undefined;
let chatViewProvider: ChatViewProvider | undefined;
let diffManager: DiffManager | undefined;
let contextProvider: ContextProvider | undefined;

/*
 * activate()
 *
 * Entry point for the VS Code extension.
 * Everything wrapped in try/catch — never crashes VS Code.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  /*
   * Output channel created first.
   * Logger wraps it immediately.
   * Everything else uses logger — never raw outputChannel.
   */
  outputChannel = vscode.window.createOutputChannel("Private AI");

  const config = vscode.workspace.getConfiguration("privateAi");
  const debugMode = config.get<boolean>("debugMode", false);
  const workspaceRoot = WorkspaceDetector.getWorkspaceRoot();

  logger = new OutputChannelLogger(outputChannel, debugMode, workspaceRoot);

  try {
    await activateCore(context);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown activation error.";

    logger.error("Activation failed", message);

    void vscode.window.showErrorMessage(
      `Private AI failed to start: ${message}`,
    );
  }
}

async function activateCore(context: vscode.ExtensionContext): Promise<void> {
  /*
   * Guard: logger must exist before anything runs.
   */
  if (logger === undefined) return;

  const config = vscode.workspace.getConfiguration("privateAi");

  const ollamaUrl = config.get<string>("ollamaUrl", "http://127.0.0.1:11434");
  const modelName = config.get<string>("model", "deepseek-coder-fix");
  const approvalTimeoutMs =
    config.get<number>("approvalTimeoutSeconds", 60) * 1_000;
  const debugMode = config.get<boolean>("debugMode", false);
  const contextSize = config.get<number>("contextSize", 8192);
  const fallbackModel = config.get<string>("fallbackModel", "");

  const workspaceRoot = WorkspaceDetector.getWorkspaceRoot();

  /*
   * Session start banner — first thing logged.
   */
  logger.sessionStart(workspaceRoot, modelName, ollamaUrl);

  /*
   * Health check with timing.
   */
  const healthTimer = logger.healthStart();
  const healthCheck = new OllamaHealthCheck(
    ollamaUrl,
    modelName,
    fallbackModel,
  );

  try {
    await healthCheck.check();
    logger.healthEnd(healthTimer, true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Health check failed.";
    logger.healthEnd(healthTimer, false, msg);
    void vscode.window.showWarningMessage(
      `Private AI: ${msg}. Start Ollama and reload the window.`,
    );
  }

  /*
   * Status bar — logger injected so status transitions
   * are logged to Output Channel.
   */
  statusBar = new StatusBarManager(logger);
  context.subscriptions.push({
    dispose: () => statusBar?.dispose(),
  });

  /*
   * Audit log.
   */
  const auditLog = new AuditLog(
    path.join(workspaceRoot, ".private_ai", "logs"),
  );
  await auditLog.initialize();

  /*
   * Security stack.
   */
  const securityPolicy = new SecurityPolicy(workspaceRoot);
  const approvalController = new ApprovalController(approvalTimeoutMs);
  const approvalService = new ApprovalService(approvalController, auditLog);
  const workspaceManager = new WorkspaceManager(workspaceRoot);
  const permissionGateway = new PermissionGateway(
    securityPolicy,
    approvalService,
    workspaceManager,
    auditLog,
  );

  /*
   * VsCodeApprovalHandler — logger injected.
   * Logs all approval/denial events.
   */
  approvalHandler = new VsCodeApprovalHandler(
    approvalController,
    approvalService,
    workspaceRoot,
    logger, // ← logger not outputChannel
  );

  await approvalHandler.requestWorkspaceReadApproval();
  approvalHandler.start();

  /*
   * Rate limiter.
   */
  const rateLimiter = new RateLimiter(DEFAULT_RATE_LIMITER_CONFIG, auditLog);

  /*
   * Tools.
   */
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new FileReadTool(rateLimiter));
  toolRegistry.register(new FileWriteTool());
  toolRegistry.register(new FileDeleteTool());
  toolRegistry.register(new RunCommandTool());
  toolRegistry.register(new DirectoryListTool());
  toolRegistry.register(new FileSearchTool());
  toolRegistry.register(new GitTool());
  toolRegistry.register(new FilePatchTool());
  toolRegistry.register(new WebAccessTool());

  logger.debug(
    "INIT",
    `Tools registered: ${toolRegistry
      .list()
      .map((t) => t.name)
      .join(", ")}`,
  );

  /*
   * Diff manager — logger injected.
   */
  diffManager = new DiffManager(workspaceRoot, logger); // ← logger not outputChannel

  const toolExecutionGateway = new ToolExecutionGateway(
    permissionGateway,
    auditLog,
  );

  /*
   * Diff preview hook — wires write_file and patch_file
   * through VS Code diff viewer before execution.
   *
   * Security: securityCheckOnly() still runs all path
   * validation before diff is shown.
   */
  toolExecutionGateway.setBeforeExecuteHook(
    async (toolName: string, input: ToolInput) => {
      if (toolName === "write_file" && diffManager !== undefined) {
        const filePath =
          typeof input["path"] === "string" ? input["path"] : undefined;
        const content =
          typeof input["content"] === "string" ? input["content"] : "";
        if (filePath !== undefined) {
          return diffManager.previewWriteDiff(filePath, content);
        }
      }

      if (toolName === "patch_file" && diffManager !== undefined) {
        const filePath =
          typeof input["path"] === "string" ? input["path"] : undefined;
        const operation =
          typeof input["operation"] === "string"
            ? input["operation"]
            : "replace";
        if (filePath !== undefined) {
          return diffManager.previewPatchDiff(
            filePath,
            operation,
            input as Record<string, unknown>,
          );
        }
      }

      return true;
    },
  );

  /*
   * After-execute UI cleanup.
   * When a file is deleted successfully, close any
   * editor tab showing that file. Prevents stale
   * "file not found" tab appearing.
   */
  toolExecutionGateway.setAfterExecuteHook(async (toolName, input, success) => {
    if (!success) return;

    if (toolName === "delete_file") {
      const filePath =
        typeof input["path"] === "string" ? input["path"] : undefined;

      if (filePath === undefined) return;

      const absPath = path.resolve(workspaceRoot, filePath);
      const uri = vscode.Uri.file(absPath);

      /*
       * Search all editor tabs and close any showing this file.
       */
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          if (
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === uri.fsPath
          ) {
            await vscode.window.tabGroups.close(tab);
            logger?.debug(
              "CLEANUP",
              `Closed editor tab for deleted file: ${filePath}`,
            );
          }
        }
      }
    }
  });

  /*
   * LLM provider.
   */
  const llmProvider = new OllamaProvider(
    modelName,
    ollamaUrl,
    debugMode,
    fallbackModel,
    contextSize,
  );

  /*
   * Agent.
   */
  agent = new Agent(
    llmProvider,
    toolRegistry,
    toolExecutionGateway,
    workspaceRoot,
  );

  logger.debug("INIT", "Agent initialized.");

  /*
   * Context provider — logger injected.
   * Logs editor context injection in debug mode.
   */
  contextProvider = new ContextProvider(
    workspaceRoot,
    logger, // ← logger not outputChannel
  );

  /*
   * Chat panel — logger injected.
   * Logs all user messages, LLM timing, tool calls.
   */
  /*
   * Register chat view as sidebar view.
   * This replaces the old WebviewPanel-in-editor approach.
   */
  chatViewProvider = new ChatViewProvider(
    agent,
    context,
    workspaceRoot,
    logger,
    statusBar,
    auditLog,
    contextProvider,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  /*
   * Register commands.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.openChat", async () => {
      /*
       * Focus the sidebar view.
       * VS Code expands the container and focuses the view.
       */
      await vscode.commands.executeCommand(
        "workbench.view.extension.privateAiContainer",
      );

      /*
       * First-time helper: guide user to move chat to right sidebar.
       * Only shows ONCE per install.
       * No auto-move — user does it once, VS Code remembers.
       * This avoids any glitches from programmatic moves.
       */
      const SHOWN_KEY = "privateAi.hasShownLayoutHint";
      const alreadyShown = context.globalState.get<boolean>(SHOWN_KEY, false);

      if (!alreadyShown) {
        await context.globalState.update(SHOWN_KEY, true);

        void vscode.window
          .showInformationMessage(
            "Private AI Chat is open. Tip: drag the chat panel to the right side for a Copilot-style layout.",
            "Move to Right",
            "Keep on Left",
          )
          .then(async (choice) => {
            if (choice === "Move to Right") {
              try {
                await vscode.commands.executeCommand(
                  "workbench.action.moveViewToAuxiliaryBar",
                );
              } catch {
                /* silent */
              }
            }
          });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.clearHistory", () => {
      chatViewProvider?.clear();
      void vscode.window.showInformationMessage(
        "Private AI: Conversation history cleared.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.showStatus", () => {
      outputChannel?.show();
      logger?.separator("Live Status");
      logger?.debug("STATUS", `Workspace : ${workspaceRoot}`);
      logger?.debug("STATUS", `Model     : ${modelName}`);
      logger?.debug("STATUS", `Ollama    : ${ollamaUrl}`);
      logger?.debug(
        "STATUS",
        `History   : ${agent?.getHistoryLength() ?? 0} messages`,
      );
      logger?.debug(
        "STATUS",
        `Tokens    : ~${agent?.estimateHistoryTokens() ?? 0}`,
      );
    }),
  );

  /*
   * ─────────────────────────────────────────
   * Phase 8j — Editor context commands
   * ─────────────────────────────────────────
   */

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "private-ai.askAboutSelection",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
          void vscode.window.showInformationMessage(
            "Private AI: No active editor.",
          );
          return;
        }

        const selection = editor.document.getText(editor.selection);
        if (selection.trim() === "") {
          void vscode.window.showInformationMessage(
            "Private AI: No text selected.",
          );
          return;
        }

        const fileName = path.basename(editor.document.fileName);
        const line = editor.selection.start.line + 1;

        const prefill =
          `Regarding ${fileName} line ${line}:\n\n` +
          `\`\`\`\n${selection}\n\`\`\`\n\n`;

        await chatViewProvider?.prefillInput(prefill);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "private-ai.askAboutFile",
      async (uri?: vscode.Uri) => {
        let filePath: string | undefined;

        /*
         * Explorer right-click passes URI as argument.
         * Otherwise fall back to active editor.
         */
        if (uri !== undefined && uri.fsPath !== undefined) {
          filePath = uri.fsPath;
        } else {
          const editor = vscode.window.activeTextEditor;
          if (editor !== undefined) {
            filePath = editor.document.fileName;
          }
        }

        if (filePath === undefined) {
          void vscode.window.showInformationMessage(
            "Private AI: No file to reference.",
          );
          return;
        }

        const relative = path
          .relative(workspaceRoot, filePath)
          .replace(/\\/g, "/");

        await chatViewProvider?.prefillInput(`@${relative} `);
      },
    ),
  );

  /*
   * Helper: build message from selection + template, auto-send.
   * Used by all four action commands below.
   */
  const runSelectionAction = async (template: string): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      void vscode.window.showInformationMessage(
        "Private AI: No active editor.",
      );
      return;
    }

    const selection = editor.document.getText(editor.selection);
    if (selection.trim() === "") {
      void vscode.window.showInformationMessage(
        "Private AI: No text selected.",
      );
      return;
    }

    const fileName = path.basename(editor.document.fileName);
    const line = editor.selection.start.line + 1;

    const message =
      `${template}\n\n` +
      `File: ${fileName} (line ${line})\n\n` +
      `\`\`\`\n${selection}\n\`\`\``;

    await chatViewProvider?.sendMessage(message);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.explainSelection", () =>
      runSelectionAction("Explain what this code does in simple terms:"),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.fixSelection", () =>
      runSelectionAction(
        "Find and fix bugs in this code. Use patch_file to apply the fix:",
      ),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.generateTests", () =>
      runSelectionAction(
        "Generate unit tests for this code. Use write_file to save them:",
      ),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("private-ai.generateDocs", () =>
      runSelectionAction(
        "Generate JSDoc/TSDoc documentation for this code. Use patch_file to add it:",
      ),
    ),
  );

  context.subscriptions.push(
    WorkspaceDetector.onWorkspaceChange((newRoot) => {
      logger?.debug("WORKSPACE", `Changed to ${newRoot}`);
    }),
  );

  logger.debug("INIT", "Commands registered. Extension ready.");
}

/*
 * deactivate()
 *
 * Called when extension is deactivated.
 * Logs session summary then cleans up all resources.
 */
export function deactivate(): void {
  logger?.sessionEnd();

  approvalHandler?.stop();
  approvalHandler = undefined;
  statusBar?.dispose();
  statusBar = undefined;
  agent = undefined;
  diffManager = undefined;
  contextProvider = undefined;
  chatViewProvider = undefined;

  /*
   * Dispose outputChannel last — logger writes to it
   * during sessionEnd() above.
   */
  outputChannel?.dispose();
  outputChannel = undefined;
  logger = undefined;
}
