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

export class ChatPanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly extensionUri: vscode.Uri;

  private sessionHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }> = [];
  private currentAbortController: AbortController | undefined;

  constructor(
    private readonly agent: Agent,
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly logger?: OutputChannelLogger,
    private readonly statusBar?: StatusBarManager,
    private readonly auditLog?: AuditLog,
    private readonly contextProvider?: ContextProvider,
  ) {
    this.extensionUri = context.extensionUri;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "privateAiChat",
      "Private AI Chat",
      {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "src", "extension", "media"),
        ],
      },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    /*
     * After chat panel opens, immediately return focus
     * to column One (editor column). This ensures files
     * clicked in Explorer open in column One, not in
     * the chat's column.
     *
     * preserveFocus:true alone isn't enough — VS Code
     * still marks the chat column as "target" on first open.
     * We explicitly refocus column One to override that.
     */
    setTimeout(() => {
      void vscode.commands.executeCommand(
        "workbench.action.focusFirstEditorGroup",
      );
    }, 50);

    /*
     * Redirect files that open in chat's column to column One.
     *
     * Uses onDidChangeActiveTextEditor which fires when
     * VS Code makes an editor active. We check if a text
     * editor became active in column Two (chat's column).
     * If yes, move it to column One immediately.
     *
     * This runs FAST — the flash is < 50ms, usually invisible.
     * Not perfect but no lock = no dispose glitch.
     *
     * Debouncing prevents infinite loops if move triggers
     * another change event.
     */
    let redirectInProgress = false;
    const redirectSubscription = vscode.window.onDidChangeActiveTextEditor(
      async (editor) => {
        if (redirectInProgress) return;
        if (editor === undefined) return;
        if (editor.viewColumn !== vscode.ViewColumn.Two) return;
        if (this.panel === undefined) return;

        /*
         * File landed in chat's column.
         * Move it to column One.
         */
        redirectInProgress = true;
        try {
          await vscode.commands.executeCommand(
            "workbench.action.moveEditorToFirstGroup",
          );
        } catch {
          /* silent */
        } finally {
          /*
           * Small delay before allowing another redirect.
           * Prevents flicker during rapid file switches.
           */
          setTimeout(() => {
            redirectInProgress = false;
          }, 100);
        }
      },
    );

    this.context.subscriptions.push(redirectSubscription);

    this.panel.webview.postMessage({
      type: "system",
      text:
        "Welcome to Private AI. Type a message to get started. " +
        "Use @filename to reference files.",
    });

    this.panel.webview.onDidReceiveMessage(
      async (message: { type: string; text?: string }) => {
        if (message.type === "chat" && typeof message.text === "string") {
          await this.handleChat(message.text);
        }

        if (message.type === "fileComplete") {
          await this.handleFileAutocomplete(message.text ?? "");
        }

        /*
         * User clicked Stop button.
         */
        if (message.type === "stop") {
          this.abortCurrentRequest();
        }
      },
      undefined,
      this.context.subscriptions,
    );

    this.panel.onDidDispose(
      () => {
        redirectSubscription.dispose();
        this.panel = undefined;
      },
      undefined,
      this.context.subscriptions,
    );
  }

  clear(): void {
    this.agent.clearHistory();
    this.sessionHistory = [];
    this.panel?.webview.postMessage({ type: "clear" });
    this.logger?.separator("Conversation cleared");
  }

  private async handleChat(text: string): Promise<void> {
    const trimmed = text.trim();

    /*
     * Handle slash commands first.
     */
    if (trimmed.startsWith("/")) {
      const handled = await this.handleSlashCommand(trimmed);
      if (handled) {
        this.panel?.webview.postMessage({
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
      /*
       * Resolve @file mentions.
       */
      const { cleanMessage, fileContext, fileCount, contextChars } =
        await this.resolveFileMentions(text);

      const effectiveMessage =
        cleanMessage.trim() === ""
          ? "The user referenced these files. Summarize their contents briefly."
          : cleanMessage;

      /*
       * Auto-inject editor context (metadata only).
       */
      const editorContext = (await this.contextProvider?.buildContext()) ?? "";

      const contextParts: string[] = [];
      if (editorContext !== "") contextParts.push(editorContext);
      if (fileContext !== "") contextParts.push(fileContext);

      const fullMessage =
        contextParts.length > 0
          ? `${contextParts.join("\n\n")}\n\nUser message: ${effectiveMessage}`
          : effectiveMessage;

      /*
       * Log user message to Output Channel.
       */
      this.logger?.userMessage(text, fileCount, contextChars);

      /*
       * Debug: log full message only in debug mode.
       * Never log file contents in normal mode.
       */
      this.logger?.debug(
        "CHAT",
        `Full message (${fullMessage.length} chars): ` +
          fullMessage.slice(0, 200),
      );

      /*
       * Start LLM timer.
       */
      const llmTimer = this.logger?.llmStart();

      const response = await this.agent.run(
        {
          message: fullMessage,
          userIntent: text, // ← ADD THIS — original user text before context injection
          onToken: (token: string) => {
            this.panel?.webview.postMessage({
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

        /*
         * Bug 1 fix: postMessage sent ONCE only.
         * Previously sent twice causing double render.
         */
        this.panel?.webview.postMessage({
          type: "done",
          text: response.content,
        });

        /*
         * End LLM timer — final answer.
         */
        if (llmTimer !== undefined) {
          const tokenEstimate = Math.ceil(response.content.length / 4);
          this.logger?.llmEnd(llmTimer, tokenEstimate, true);
        }

        if (response.contextWarning !== undefined) {
          this.panel?.webview.postMessage({
            type: "system",
            text: `⚠️ ${response.contextWarning}`,
          });
        }
      } else {
        /*
         * End LLM timer on error.
         */
        if (llmTimer !== undefined) {
          this.logger?.llmError(llmTimer, response.error ?? "Unknown error");
        }

        this.panel?.webview.postMessage({
          type: "error",
          text: response.error ?? "Unknown error.",
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Agent failed.";

      this.panel?.webview.postMessage({
        type: "error",
        text: msg,
      });

      this.logger?.error("Chat exception", msg);
    } finally {
      this.currentAbortController = undefined;
      this.statusBar?.setStatus("ready");
    }
  }

  /*
   * Parse @filename mentions from user message.
   *
   * Bug 5 fix: pattern updated to handle dot-files
   * like @.env and @.gitignore, and extensionless
   * files like @README and @Makefile.
   *
   * Returns:
   *   cleanMessage  — message with @mentions removed
   *   fileContext   — file contents as context block
   *   fileCount     — number of files loaded
   *   contextChars  — total chars of context
   */
  private async resolveFileMentions(text: string): Promise<{
    cleanMessage: string;
    fileContext: string;
    fileCount: number;
    contextChars: number;
  }> {
    /*
     * Bug 5 fix: updated pattern.
     *
     * Original: /@([\w./\\-]+\.\w+)/g
     *   — missed @.env (leading dot not matched by \w)
     *   — missed @README (no extension)
     *
     * New: /@([.\w][^\s,()'"]*)/g
     *   — matches @.env, @.gitignore (dot-files)
     *   — matches @README, @Makefile (no extension)
     *   — matches @src/agent/Agent.ts (paths)
     *   — stops at whitespace, comma, parens, quotes
     *   — requires at least one char after @
     */
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

      /*
       * Security: verify path is inside workspace.
       */
      const relativePath = path.relative(this.workspaceRoot, resolvedPath);

      const isInside =
        relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

      if (!isInside) {
        this.panel?.webview.postMessage({
          type: "system",
          text: `⚠️ @${filePath} is outside the workspace — skipped.`,
        });
        this.logger?.security(
          `@mention blocked: ${filePath} — outside workspace`,
        );
        continue;
      }

      if (!existsSync(resolvedPath)) {
        this.panel?.webview.postMessage({
          type: "system",
          text: `⚠️ @${filePath} not found — skipped.`,
        });
        continue;
      }

      try {
        const content = await readFile(resolvedPath, "utf8");

        /*
         * Truncate very large files to prevent
         * context window overflow.
         */
        const truncated =
          content.length > 3000
            ? content.slice(0, 3000) + "\n...[truncated]"
            : content;

        contextBlocks.push(
          `[File: ${filePath}]\n${truncated}\n[End: ${filePath}]`,
        );

        totalChars += truncated.length;

        this.panel?.webview.postMessage({
          type: "system",
          text: `📄 Loaded @${filePath}`,
        });

        this.logger?.debug(
          "MENTION",
          `@${filePath} loaded (${content.length} chars)`,
        );
      } catch (error) {
        this.panel?.webview.postMessage({
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

  /*
   * Handle file autocomplete request from chat.js.
   */
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

      this.panel?.webview.postMessage({
        type: "fileSuggestions",
        files: suggestions,
      });
    } catch {
      this.panel?.webview.postMessage({
        type: "fileSuggestions",
        files: [],
      });
    }
  }

  /*
   * Handle slash commands locally.
   * Returns true if command was handled.
   * Returns false to send to agent.
   */
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

    this.panel?.webview.postMessage({
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

    this.panel?.webview.postMessage({
      type: "system",
      text: stats,
    });
  }

  private async showAudit(): Promise<void> {
    if (this.auditLog === undefined) {
      this.panel?.webview.postMessage({
        type: "system",
        text: "Audit log not available.",
      });
      return;
    }

    const events = await this.auditLog.getRecentEvents(10);

    if (events.length === 0) {
      this.panel?.webview.postMessage({
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

    this.panel?.webview.postMessage({
      type: "system",
      text: lines.join("\n"),
    });
  }

  private showMemory(): void {
    const memory = this.agent.getCrossSessionMemory();
    const display = memory.getDisplay();

    this.panel?.webview.postMessage({
      type: "system",
      text: display,
    });
  }

  private async handleRemember(fact: string): Promise<void> {
    if (fact === "") {
      this.panel?.webview.postMessage({
        type: "system",
        text: "✗ Usage: /remember your fact here",
      });
      return;
    }

    const result = await this.agent.getCrossSessionMemory().remember(fact);

    this.panel?.webview.postMessage({
      type: "system",
      text: (result.success ? "✓ " : "✗ ") + result.message,
    });
  }

  private async handleForget(query: string): Promise<void> {
    if (query === "") {
      this.panel?.webview.postMessage({
        type: "system",
        text: "✗ Usage: /forget partial text of fact",
      });
      return;
    }

    const result = await this.agent.getCrossSessionMemory().forget(query);

    this.panel?.webview.postMessage({
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

      this.panel?.webview.postMessage({
        type: "system",
        text: `✓ Session saved to: ${filePath}`,
      });
    } catch (error) {
      this.panel?.webview.postMessage({
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

      this.panel?.webview.postMessage({
        type: "system",
        text: `✓ Session exported to: ${filePath}`,
      });
    } catch (error) {
      this.panel?.webview.postMessage({
        type: "system",
        text: `✗ Failed to export: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = vscode.Uri.joinPath(
      this.extensionUri,
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

  /*
   * Abort the current running agent request.
   * Called when user clicks Stop button in chat.
   */
  private abortCurrentRequest(): void {
    if (this.currentAbortController !== undefined) {
      this.currentAbortController.abort();
      this.logger?.debug("CHAT", "User aborted request");
      this.panel?.webview.postMessage({
        type: "system",
        text: "⚠️ Request cancelled.",
      });
      this.panel?.webview.postMessage({ type: "done", text: "" });
    }
  }
}
