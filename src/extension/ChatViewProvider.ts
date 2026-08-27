import * as vscode from "vscode";
import * as path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Agent } from "../agent/Agent.js";
import type { StatusBarManager } from "./StatusBarManager.js";
import type { AuditLog } from "../audit/AuditLog.js";
import type { ContextProvider } from "./ContextProvider.js";
import type { OutputChannelLogger } from "./OutputChannelLogger.js";

/*
 * ChatViewProvider
 *
 * Registers the Private AI chat as a sidebar view.
 * Uses vscode.WebviewViewProvider — the correct API
 * for persistent tool panels (Explorer, Search, etc).
 *
 * Advantages over WebviewPanel in editor column:
 *   - Never occupies editor space
 *   - No column glitches on open/close
 *   - Files always open in editor area
 *   - Persists cleanly across sessions
 *   - Matches Copilot/Continue behavior exactly
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "privateAiChat";

  private view: vscode.WebviewView | undefined;
  private currentAbortController: AbortController | undefined;
  private sendInProgress = false;

  private sessionHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }> = [];

  constructor(
    private readonly agent: Agent,
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly logger?: OutputChannelLogger,
    private readonly statusBar?: StatusBarManager,
    private readonly auditLog?: AuditLog,
    private readonly contextProvider?: ContextProvider,
  ) {}

  /*
   * Called by VS Code when the view becomes visible.
   * Sets up the webview HTML and message handlers.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(
          this.context.extensionUri,
          "src",
          "extension",
          "media",
        ),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.postMessage({
      type: "system",
      text:
        "Welcome to Private AI. Type a message to get started. " +
        "Use @filename to reference files.",
    });

    webviewView.webview.onDidReceiveMessage(
      async (message: { type: string; text?: string }) => {
        if (message.type === "chat" && typeof message.text === "string") {
          await this.handleChat(message.text);
        }

        if (message.type === "fileComplete") {
          await this.handleFileAutocomplete(message.text ?? "");
        }

        if (message.type === "stop") {
          this.abortCurrentRequest();
        }
      },
      undefined,
      this.context.subscriptions,
    );

    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.context.subscriptions,
    );
  }

  /*
   * Public: focus the chat view (used by openChat command).
   */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand("privateAiChat.focus");
  }

  /*
   * Public: clear conversation history.
   */
  clear(): void {
    this.agent.clearHistory();
    this.sessionHistory = [];
    this.view?.webview.postMessage({ type: "clear" });
    this.logger?.separator("Conversation cleared");
  }

  /*
   * Send a pre-composed message from external commands.
   * Used by editor context menu actions like Explain/Fix.
   *
   * Focuses chat view, then sends the message as if user typed it.
   */
  async sendMessage(text: string): Promise<void> {
    if (this.sendInProgress) {
      return;
    }
    this.sendInProgress = true;

    try {
      await vscode.commands.executeCommand(
        "workbench.view.extension.privateAiContainer",
      );

      if (this.view === undefined) {
        await new Promise((r) => setTimeout(r, 500));
      }

      if (this.view === undefined) {
        void vscode.window.showWarningMessage(
          "Private AI: Chat view not ready. Please try again.",
        );
        return;
      }

      /*
       * Tell the webview to render this as a user message
       * and start the assistant streaming bubble.
       * Same effect as user typing + Enter, but initiated
       * from an extension command (context menu action).
       */
      this.view.webview.postMessage({
        type: "externalMessage",
        text: text,
      });

      /*
       * Small delay to let webview render the bubbles
       * before streaming tokens arrive.
       */
      await new Promise((r) => setTimeout(r, 100));

      await this.handleChat(text);
    } finally {
      this.sendInProgress = false;
    }
  }

  /*
   * Pre-fill the input textarea without sending.
   * Used when user wants to edit the message before submitting.
   */
  async prefillInput(text: string): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.view.extension.privateAiContainer",
    );

    if (this.view === undefined) {
      await new Promise((r) => setTimeout(r, 300));
    }

    this.view?.webview.postMessage({
      type: "prefill",
      text: text,
    });
  }

  /*
   * Abort current running agent request.
   */
  private abortCurrentRequest(): void {
    if (this.currentAbortController !== undefined) {
      this.currentAbortController.abort();
      this.logger?.debug("CHAT", "User aborted request");
      this.view?.webview.postMessage({
        type: "system",
        text: "⚠️ Request cancelled.",
      });
      this.view?.webview.postMessage({ type: "done", text: "" });
    }
  }

  private async handleChat(text: string): Promise<void> {
    const trimmed = text.trim();

    if (trimmed.startsWith("/")) {
      const handled = await this.handleSlashCommand(trimmed);
      if (handled) {
        this.view?.webview.postMessage({
          type: "done",
          text: "",
        });
        return;
      }
    }

    this.sessionHistory.push({
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    });

    this.statusBar?.setStatus("thinking");

    try {
      this.currentAbortController = new AbortController();

      const { cleanMessage, fileContext, fileCount, contextChars } =
        await this.resolveFileMentions(text);

      const effectiveMessage =
        cleanMessage.trim() === ""
          ? "The user referenced these files. Summarize their contents briefly."
          : cleanMessage;

      const editorContext = (await this.contextProvider?.buildContext()) ?? "";

      const contextParts: string[] = [];
      if (editorContext !== "") contextParts.push(editorContext);
      if (fileContext !== "") contextParts.push(fileContext);

      const fullMessage =
        contextParts.length > 0
          ? `${contextParts.join("\n\n")}\n\nUser message: ${effectiveMessage}`
          : effectiveMessage;

      this.logger?.userMessage(text, fileCount, contextChars);

      this.logger?.debug(
        "CHAT",
        `Full message (${fullMessage.length} chars): ` +
          fullMessage.slice(0, 200),
      );

      const llmTimer = this.logger?.llmStart();

      const response = await this.agent.run(
        {
          message: fullMessage,
          userIntent: text,
          onToken: (token: string) => {
            this.view?.webview.postMessage({
              type: "token",
              text: token,
            });
          },
          signal: this.currentAbortController.signal,
        },
        { workspaceRoot: this.workspaceRoot },
      );

      if (response.success) {
        this.sessionHistory.push({
          role: "assistant",
          content: response.content,
          timestamp: new Date().toISOString(),
        });

        this.view?.webview.postMessage({
          type: "done",
          text: response.content,
        });

        if (llmTimer !== undefined) {
          const tokenEstimate = Math.ceil(response.content.length / 4);
          this.logger?.llmEnd(llmTimer, tokenEstimate, true);
        }

        if (response.contextWarning !== undefined) {
          this.view?.webview.postMessage({
            type: "system",
            text: `⚠️ ${response.contextWarning}`,
          });
        }
      } else {
        if (llmTimer !== undefined) {
          this.logger?.llmError(llmTimer, response.error ?? "Unknown error");
        }

        this.view?.webview.postMessage({
          type: "error",
          text: response.error ?? "Unknown error.",
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Agent failed.";

      this.view?.webview.postMessage({
        type: "error",
        text: msg,
      });

      this.logger?.error("Chat exception", msg);
    } finally {
      this.currentAbortController = undefined;
      this.statusBar?.setStatus("ready");
    }
  }

  private async resolveFileMentions(text: string): Promise<{
    cleanMessage: string;
    fileContext: string;
    fileCount: number;
    contextChars: number;
  }> {
    const mentionPattern = /@([.\w][^\s,()'"]*)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = mentionPattern.exec(text)) !== null) {
      const filePath = match[1];
      if (filePath !== undefined && !mentions.includes(filePath)) {
        mentions.push(filePath);
      }
    }

    if (mentions.length === 0) {
      return {
        cleanMessage: text,
        fileContext: "",
        fileCount: 0,
        contextChars: 0,
      };
    }

    const contextBlocks: string[] = [];
    let totalChars = 0;

    for (const filePath of mentions) {
      const resolvedPath = path.resolve(this.workspaceRoot, filePath);

      const relativePath = path.relative(this.workspaceRoot, resolvedPath);

      const isInside =
        relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

      if (!isInside) {
        this.view?.webview.postMessage({
          type: "system",
          text: `⚠️ @${filePath} is outside the workspace — skipped.`,
        });
        this.logger?.security(
          `@mention blocked: ${filePath} — outside workspace`,
        );
        continue;
      }

      if (!existsSync(resolvedPath)) {
        this.view?.webview.postMessage({
          type: "system",
          text: `⚠️ @${filePath} not found — skipped.`,
        });
        continue;
      }

      try {
        const content = await readFile(resolvedPath, "utf8");

        const truncated =
          content.length > 3000
            ? content.slice(0, 3000) + "\n...[truncated]"
            : content;

        contextBlocks.push(
          `[File: ${filePath}]\n${truncated}\n[End: ${filePath}]`,
        );

        totalChars += truncated.length;

        this.view?.webview.postMessage({
          type: "system",
          text: `📄 Loaded @${filePath}`,
        });

        this.logger?.debug(
          "MENTION",
          `@${filePath} loaded (${content.length} chars)`,
        );
      } catch (error) {
        this.view?.webview.postMessage({
          type: "system",
          text: `⚠️ Could not read @${filePath}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        });
      }
    }

    const cleanMessage = text.replace(mentionPattern, "").trim();

    const fileContext =
      contextBlocks.length > 0 ? contextBlocks.join("\n\n") : "";

    return {
      cleanMessage,
      fileContext,
      fileCount: contextBlocks.length,
      contextChars: totalChars,
    };
  }

  private async handleFileAutocomplete(partial: string): Promise<void> {
    try {
      const pattern = partial === "" ? "**/*" : `**/${partial}*`;

      const files = await vscode.workspace.findFiles(
        pattern,
        "**/node_modules/**",
        20,
      );

      const suggestions = files.map((f) =>
        path.relative(this.workspaceRoot, f.fsPath).replace(/\\/g, "/"),
      );

      this.view?.webview.postMessage({
        type: "fileSuggestions",
        files: suggestions,
      });
    } catch {
      this.view?.webview.postMessage({
        type: "fileSuggestions",
        files: [],
      });
    }
  }

  private async handleSlashCommand(text: string): Promise<boolean> {
    const parts = text.split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase();
    const args = text.slice(command.length).trim();

    switch (command) {
      case "/help":
        this.showHelp();
        return true;
      case "/clear":
        this.clear();
        return true;
      case "/stats":
        this.showStats();
        return true;
      case "/audit":
        await this.showAudit();
        return true;
      case "/memory":
        this.showMemory();
        return true;
      case "/remember":
        await this.handleRemember(args);
        return true;
      case "/forget":
        await this.handleForget(args);
        return true;
      case "/save":
        await this.handleSave();
        return true;
      case "/export":
        await this.handleExport();
        return true;
      default:
        return false;
    }
  }

  private showHelp(): void {
    const helpText =
      "═══ AVAILABLE COMMANDS ═══\n" +
      "/help      — Show this message\n" +
      "/clear     — Clear conversation\n" +
      "/stats     — Session metrics\n" +
      "/audit     — Recent security events\n" +
      "/memory    — Show project memory\n" +
      "/remember  — Save a fact: /remember your fact\n" +
      "/forget    — Remove fact: /forget partial\n" +
      "/save      — Save session as JSON\n" +
      "/export    — Save session as Markdown\n" +
      "\n═══ CHAT FEATURES ═══\n" +
      "@filename  — Reference a file in your message\n" +
      "Shift+Enter — New line in message\n" +
      "Enter      — Send message";

    this.view?.webview.postMessage({
      type: "system",
      text: helpText,
    });
  }

  private showStats(): void {
    const tokens = this.agent.estimateHistoryTokens();
    const history = this.agent.getHistoryLength();
    const pct = Math.round((tokens / 8192) * 100);

    let stats =
      "═══ SESSION METRICS ═══\n" +
      `Messages      : ${history}\n` +
      `Tokens used   : ~${tokens} / 8192\n` +
      `Context usage : ${pct}%\n`;

    if (this.auditLog !== undefined) {
      const m = this.auditLog.getMetrics();
      stats +=
        `Duration      : ${m.durationSeconds}s\n` +
        `Tool calls    : ${m.toolCalls}\n` +
        `Approved      : ${m.approved}\n` +
        `Denied        : ${m.denied}`;
      if (m.blocked > 0) {
        stats += `\nBlocked       : ${m.blocked} ⚠️`;
      }
    }

    const memory = this.agent.getCrossSessionMemory();
    if (memory.hasMemory()) {
      stats += `\nProject facts : ${memory.getCount()} remembered`;
    }

    this.view?.webview.postMessage({
      type: "system",
      text: stats,
    });
  }

  private async showAudit(): Promise<void> {
    if (this.auditLog === undefined) {
      this.view?.webview.postMessage({
        type: "system",
        text: "Audit log not available.",
      });
      return;
    }

    const events = await this.auditLog.getRecentEvents(10);

    if (events.length === 0) {
      this.view?.webview.postMessage({
        type: "system",
        text: "No audit events found.",
      });
      return;
    }

    const lines = ["═══ RECENT AUDIT EVENTS ═══"];

    for (const e of events) {
      const time = e.timestamp.split("T")[1]?.split(".")[0] ?? "??:??:??";
      const status =
        e.event === "tool_denied" || e.success === false ? "✗" : "✓";
      lines.push(
        `[${time}] ${status} ${e.event.replace(/_/g, " ")}: ${e.permission}`,
      );
    }

    this.view?.webview.postMessage({
      type: "system",
      text: lines.join("\n"),
    });
  }

  private showMemory(): void {
    const memory = this.agent.getCrossSessionMemory();
    this.view?.webview.postMessage({
      type: "system",
      text: memory.getDisplay(),
    });
  }

  private async handleRemember(fact: string): Promise<void> {
    if (fact === "") {
      this.view?.webview.postMessage({
        type: "system",
        text: "✗ Usage: /remember your fact here",
      });
      return;
    }

    const result = await this.agent.getCrossSessionMemory().remember(fact);

    this.view?.webview.postMessage({
      type: "system",
      text: (result.success ? "✓ " : "✗ ") + result.message,
    });
  }

  private async handleForget(query: string): Promise<void> {
    if (query === "") {
      this.view?.webview.postMessage({
        type: "system",
        text: "✗ Usage: /forget partial text of fact",
      });
      return;
    }

    const result = await this.agent.getCrossSessionMemory().forget(query);

    this.view?.webview.postMessage({
      type: "system",
      text: (result.success ? "✓ " : "✗ ") + result.message,
    });
  }

  private async handleSave(): Promise<void> {
    try {
      const sessionDir = path.join(
        this.workspaceRoot,
        ".private_ai",
        "sessions",
      );
      await mkdir(sessionDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `session-${timestamp}.json`;
      const filePath = path.join(sessionDir, filename);

      const sessionData = {
        savedAt: new Date().toISOString(),
        workspaceRoot: this.workspaceRoot,
        messageCount: this.sessionHistory.length,
        messages: this.sessionHistory.map((m) => ({
          role: m.role,
          timestamp: m.timestamp,
          content:
            m.content.length > 500
              ? m.content.slice(0, 500) + "..."
              : m.content,
        })),
      };

      await writeFile(filePath, JSON.stringify(sessionData, null, 2), "utf8");

      this.view?.webview.postMessage({
        type: "system",
        text: `✓ Session saved to: ${filePath}`,
      });
    } catch (error) {
      this.view?.webview.postMessage({
        type: "system",
        text: `✗ Failed to save: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }

  private async handleExport(): Promise<void> {
    try {
      const exportDir = path.join(this.workspaceRoot, ".private_ai", "exports");
      await mkdir(exportDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `session-${timestamp}.md`;
      const filePath = path.join(exportDir, filename);

      let md = `# Private AI Session\n\n`;
      md += `**Saved:** ${new Date().toLocaleString()}\n\n`;
      md += `**Workspace:** ${this.workspaceRoot}\n\n`;
      md += `---\n\n`;

      for (const msg of this.sessionHistory) {
        md += `### ${msg.role === "user" ? "You" : "Assistant"}\n`;
        md += `${msg.content}\n\n`;
        md += `---\n\n`;
      }

      await writeFile(filePath, md, "utf8");

      this.view?.webview.postMessage({
        type: "system",
        text: `✓ Session exported to: ${filePath}`,
      });
    } catch (error) {
      this.view?.webview.postMessage({
        type: "system",
        text: `✗ Failed to export: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "src",
      "extension",
      "media",
    );

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaPath, "chat.css"),
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaPath, "chat.js"),
    );

    const nonce = randomUUID().replace(/-/g, "");
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
  <title>Private AI Chat</title>
</head>
<body>
  <div id="chat-container">
    <div id="messages"></div>
    <div id="input-area">
      <div id="autocomplete-container">
        <textarea
          id="user-input"
          placeholder="Type a message... Use @file to reference files. (Shift+Enter for newline)"
          rows="2"
        ></textarea>
        <div id="autocomplete-list" class="autocomplete-hidden"></div>
      </div>
      <button id="send-btn">Send</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
