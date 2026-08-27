import type { LLMMessage, LLMProvider } from "../llm/LLMProvider.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ToolExecutionGateway } from "../tools/ToolExecutionGateway.js";
import { ToolInputValidator } from "../tools/ToolInputValidator.js";
import { SessionMemory } from "./SessionMemory.js";
import { CrossSessionMemory } from "./CrossSessionMemory.js";
import type {
  AgentContext,
  AgentRequest,
  AgentResponse,
} from "./AgentTypes.js";

const MAX_TOOL_ITERATIONS = 10;
const CONTEXT_WINDOW_TOKENS = 8_192;
const CONTEXT_WARNING_THRESHOLD = 0.7;

export class Agent {
  private readonly toolInputValidator = new ToolInputValidator();
  private readonly memory = new SessionMemory();

  private readonly systemPrompt =
    "You are a private AI coding agent with internet access via the web_access tool and local project access via file tools.\n" +
    "RULES:\n" +
    "1. You CAN access files inside the current project using tools.\n" +
    "2. If the user asks about package.json, tsconfig.json, or any project file, use read_file unless you already have the exact content in memory.\n" +
    "3. If the user asks for the value of a specific field or key in a JSON file, answer using the exact key they named. Do not substitute similar keys. For example, 'name' means the exact key 'name', not 'displayName'.\n" +
    "4. Never say you cannot access local files if a tool can solve the request.\n" +
    "5. New file or full rewrite -> write_file.\n" +
    "6. Partial edit -> patch_file.\n" +
    "7. Delete file -> delete_file.\n" +
    "8. Run command -> run_command.\n" +
    "9. Latest versions, URLs, documentation, or real-time information -> web_access with a specific URL.\n" +
    "10. After a tool succeeds, answer ONLY the user's actual question. Do not dump the full file unless explicitly asked.\n" +
    "11. Never claim a file was read, written, patched, deleted, or fetched unless you received a successful tool result in this turn.\n" +
    "12. If a tool fails, explain the failure clearly.\n" +
    "13. Minimize tool calls. Every tool requires approval.\n" +
    "14. Stay inside the current project directory for file operations.\n" +
    "15. Use conversation history and remembered tool results for follow-up questions.\n" +
    "16. Security is enforced outside you. You cannot bypass it.\n" +
    "17. CRITICAL: To modify ANY file, you MUST call patch_file or write_file. Showing edited content in your response does NOT modify the file. The file on disk only changes when a tool is called and succeeds. If you show code without calling a tool, YOU HAVE FAILED THE TASK. After reading a file, if user wants changes, IMMEDIATELY call patch_file. Do not describe what you would do. Do not show the new code. Just call the tool.\n" +
    "18. If the user asks to change, edit, update, replace, or modify content in a file, ALWAYS call patch_file with the search and replace fields. Never just show the edited content without calling the tool.\n" +
    "19. If the user asks to create a file and gives a filename but no directory, create it in the project root.\n" +
    "20. If the user replies with a short confirmation like 'yes', 'do it', 'go ahead', proceed with the previously discussed action using the appropriate tool.\n" +
    "21. If the user says to change, replace, or update text in a named file, and both the old text and new text are already given, that is a complete instruction. Use patch_file immediately and do not ask for more details.\n" +
    "22. Always respond in plain readable text. Never wrap responses in JSON, XML, or code blocks unless the user explicitly asks for structured output.";

  private readonly crossSessionMemory: CrossSessionMemory;

  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutionGateway: ToolExecutionGateway,
    workspaceRoot: string = "",
  ) {
    this.crossSessionMemory = new CrossSessionMemory(workspaceRoot);
    if (workspaceRoot !== "") {
      this.crossSessionMemory.load();
    }
  }

  clearHistory(): void {
    this.memory.clear();
  }

  getHistoryLength(): number {
    return this.memory.getHistoryLength();
  }

  estimateHistoryTokens(): number {
    return this.memory.estimateTokens();
  }

  getCrossSessionMemory(): CrossSessionMemory {
    return this.crossSessionMemory;
  }

  async run(
    request: AgentRequest,
    context: AgentContext,
  ): Promise<AgentResponse> {
    if (typeof request.message !== "string" || request.message.trim() === "") {
      return {
        success: false,
        content: "",
        error: "A valid message is required.",
      };
    }

    const contextWarning = this.getContextWarning();

    const crossSessionContext = this.crossSessionMemory.buildContext();

    const systemContent =
      crossSessionContext !== ""
        ? crossSessionContext + "\n" + this.systemPrompt
        : this.systemPrompt;

    const messages: LLMMessage[] = [
      { role: "system", content: systemContent },
      ...this.memory.buildMessages(request.message),
    ];

    const tools = this.toolRegistry
      .list()
      .map((tool) => this.toLLMToolDefinition(tool));

    try {
      let actionEnforcerUsed = false;
      let requireToolNextIter = false;
      /*
       * Bug 7 fix: toolOutputSummary removed.
       * It was built every tool call but never used.
       * Pure memory waste — removed entirely.
       */
      let writeToolCalled = false;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        /*
         * Streaming policy — the single biggest UX fix.
         *
         * We only stream tokens to chat when we KNOW this
         * iteration's response is the final answer to the user.
         *
         * If enforcer might fire and cause a retry, we must
         * NOT stream this iteration — otherwise the user sees
         * the intermediate "Sure, I will..." message glued to
         * the actual final answer in the same chat bubble.
         *
         * canStreamThisIter is true when:
         *   - iteration > 0  (enforcer only fires at iter 0)
         *   - OR enforcer already used  (won't fire again)
         *   - OR no intent detected  (enforcer won't fire anyway)
         */
        const intentSource = request.userIntent ?? request.message;
        const canStreamThisIter =
          iteration > 0 ||
          actionEnforcerUsed ||
          this.detectIntendedAction(intentSource) === null;

        const response = await this.llmProvider.generate({
          messages,
          tools,
          ...(request.onToken !== undefined && canStreamThisIter
            ? { onToken: request.onToken }
            : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
          ...(requireToolNextIter ? { requireToolCall: true } : {}),
        });

        /*
         * Reset flag — only forces one iteration.
         */
        requireToolNextIter = false;
        console.log(
          `[AGENT] Iteration ${iteration} response: content=${response.content.length} chars, toolCalls=${response.toolCalls?.length ?? 0}`,
        );

        if (!response.toolCalls || response.toolCalls.length === 0) {
          /*
           * Use userIntent if provided (raw user text without
           * injected context). Otherwise fall back to full message.
           *
           * This prevents context blocks with filenames like
           * "active_file: Agent.ts" from triggering the
           * hasFilename fallback incorrectly.
           */
          const intentSource = request.userIntent ?? request.message;
          const intendedAction = this.detectIntendedAction(intentSource);

          console.log(
            `[AGENT] intendedAction: ${intendedAction === null ? "null" : intendedAction.slice(0, 60)}`,
          );
          console.log(
            `[AGENT] enforcer conditions: used=${actionEnforcerUsed}, iter=${iteration}, hasIntent=${intendedAction !== null}`,
          );
          /*
           * Detect if this iteration matches the user's intent.
           *
           * The enforcer fires when:
           *   1. Enforcer hasn't been used yet
           *   2. User has clear intent (modify/create/delete/etc)
           *   3. Model gave text response with no tool call
           *   4. AND no write tool was called in previous iterations
           *      (a read alone doesn't satisfy a modify intent)
           *
           * This fixes the case where model reads a file then talks
           * about changes without actually calling patch_file.
           */
          const isModifyIntent =
            intendedAction !== null &&
            (intendedAction.includes("MODIFY") ||
              intendedAction.includes("CREATE") ||
              intendedAction.includes("DELETE") ||
              intendedAction.includes("FIX") ||
              intendedAction.includes("GENERATE"));

          const shouldFireEnforcer =
            !actionEnforcerUsed &&
            intendedAction !== null &&
            (iteration === 0 || (isModifyIntent && !writeToolCalled));

          if (shouldFireEnforcer) {
            actionEnforcerUsed = true;
            requireToolNextIter = true;

            /*
             * Auto-read: For modify intents, if the file isn't
             * already in working memory, read it automatically
             * BEFORE retrying. This means the model only needs
             * to call ONE tool (patch_file) instead of two
             * (read_file then patch_file).
             *
             * Small models (7B) reliably call one tool per turn
             * but struggle with multi-tool sequences. Auto-read
             * removes the need for the first tool call.
             */
            if (isModifyIntent) {
              const fileMatch = intentSource.match(/\b([\w./\\-]+\.\w{1,5})\b/);

              if (fileMatch !== null) {
                const fileName = fileMatch[1]!;
                const memoryKey = `read_file:${fileName}`;
                const alreadyInMemory = this.memory
                  .buildMessages("")
                  .some(
                    (m) =>
                      m.content.includes(`FILE: ${fileName}`) ||
                      m.content.includes(`[File: ${fileName}]`),
                  );

                if (!alreadyInMemory) {
                  /*
                   * Read the file through the normal tool pipeline.
                   * This respects all security checks.
                   */
                  const readTool = this.toolRegistry.get("read_file");

                  if (readTool !== undefined) {
                    const readResult = await this.toolExecutionGateway.execute({
                      tool: readTool,
                      input: { path: fileName },
                      context: {
                        workspaceRoot: context.workspaceRoot,
                      } satisfies ToolContext,
                      reason: `Auto-read before modification of "${fileName}".`,
                    });

                    if (readResult.success) {
                      this.memory.storeToolResult(
                        "read_file",
                        fileName,
                        readResult.output,
                      );

                      messages.push({
                        role: "tool",
                        content:
                          `Current content of ${fileName}:\n${readResult.output}\n\n` +
                          `The user wants to modify this file. ` +
                          `Use patch_file with the exact current content as 'search' ` +
                          `and your modified version as 'replace'.`,
                        toolName: "read_file",
                      });
                    }
                  }
                }
              }
            }

            messages.push({
              role: "assistant",
              content: response.content,
            });

            messages.push({
              role: "user",
              content: intendedAction,
            });

            continue;
          }

          /*
           * Bug 8 fix: guard content quality.
           *
           * If enforcer was used and model still returned
           * no tool call, only store the turn in memory
           * if the content is meaningful (>= 10 chars).
           *
           * Empty or near-empty responses after enforcer
           * retry are replaced with a helpful message
           * but NOT stored as garbage in memory.
           */
          const contentTrimmed = response.content.trim();
          const isEmpty = contentTrimmed.length === 0;

          /*
           * Bug 8 fix: only substitute fallback when:
           *   1. Enforcer was used (we retried with instruction)
           *   2. Model still returned completely empty content
           *
           * Never replace content when enforcer was not used.
           * Never replace non-empty content regardless.
           * Short valid responses like "Hello" pass through as-is.
           */
          const needsFallback = actionEnforcerUsed && isEmpty;

          if (!needsFallback) {
            this.memory.addTurn(
              request.message,
              contentTrimmed !== "" ? contentTrimmed : response.content,
            );
          }

          return {
            success: true,
            content: needsFallback
              ? "I was unable to complete that action. Please try rephrasing your request."
              : response.content,
            ...(contextWarning !== undefined ? { contextWarning } : {}),
          };
        }

        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const tool = this.toolRegistry.get(toolCall.name);

          if (!tool) {
            return {
              success: false,
              content: "",
              error: `Unknown tool: ${toolCall.name}`,
            };
          }

          const validation = this.toolInputValidator.validate(
            tool,
            toolCall.arguments,
          );

          if (!validation.valid) {
            return {
              success: false,
              content: "",
              error: validation.error ?? "Invalid tool input.",
            };
          }

          const toolResult = await this.toolExecutionGateway.execute({
            tool,
            input: toolCall.arguments,
            context: {
              workspaceRoot: context.workspaceRoot,
            } satisfies ToolContext,
            reason: `AI requested execution of tool "${tool.name}".`,
          });

          if (
            !toolResult.success &&
            toolResult.error === "Permission denied."
          ) {
            return {
              success: false,
              content: "",
              error: "Permission denied.",
            };
          }

          if (!toolResult.success) {
            messages.push({
              role: "tool",
              content: `Tool failed: ${toolResult.error ?? "Unknown error."}`,
              toolName: tool.name,
            });
            continue;
          }

          /*
           * Track if a write/modify tool was successfully called.
           * This satisfies modify/create/delete intents so we
           * don't need to fire the enforcer again.
           */
          const writeToolNames = new Set([
            "write_file",
            "patch_file",
            "delete_file",
            "run_command",
          ]);

          if (writeToolNames.has(tool.name)) {
            writeToolCalled = true;
          }

          const target =
            typeof toolCall.arguments["path"] === "string"
              ? toolCall.arguments["path"]
              : typeof toolCall.arguments["command"] === "string"
                ? toolCall.arguments["command"]
                : typeof toolCall.arguments["url"] === "string"
                  ? toolCall.arguments["url"]
                  : tool.name;

          this.memory.storeToolResult(tool.name, target, toolResult.output);

          /*
           * When a file is written or patched:
           * 1. Invalidate stale read_file cache
           * 2. If write_file: store NEW content in cache immediately
           *    so follow-up questions use current content, not stale
           */
          if (tool.name === "write_file" || tool.name === "patch_file") {
            const filePath = toolCall.arguments["path"];

            if (typeof filePath === "string") {
              this.memory.invalidateToolResult("read_file", filePath);

              /*
               * For write_file: the new content is known immediately.
               * Store it so model has fresh content for next turn.
               */
              if (
                tool.name === "write_file" &&
                typeof toolCall.arguments["content"] === "string"
              ) {
                this.memory.storeToolResult(
                  "read_file",
                  filePath,
                  toolCall.arguments["content"] as string,
                );
              }

              /*
               * For patch_file: we don't know the new full content
               * from the arguments alone. The tool result contains
               * the outcome. We already invalidate above so model
               * will re-read if needed. This is the safe approach.
               */
            }
          }

          messages.push({
            role: "tool",
            content:
              `Tool result:\n${toolResult.output}\n\n` +
              `Answer the user's exact question using only this data. ` +
              `If the user asked for a specific JSON key or field, return the exact value of that exact key only. ` +
              `Do not substitute similar fields such as displayName for name. ` +
              `Do not dump full content unless explicitly asked.`,
            toolName: tool.name,
          });
        }
      }

      return {
        success: false,
        content: "",
        error: `Maximum tool iterations (${MAX_TOOL_ITERATIONS}) exceeded.`,
      };
    } catch (error) {
      return {
        success: false,
        content: "",
        error:
          error instanceof Error ? error.message : "Agent execution failed.",
      };
    }
  }

  private getContextWarning(): string | undefined {
    const tokens = this.memory.estimateTokens();
    const threshold = Math.floor(
      CONTEXT_WINDOW_TOKENS * CONTEXT_WARNING_THRESHOLD,
    );

    if (tokens >= threshold) {
      const pct = Math.round((tokens / CONTEXT_WINDOW_TOKENS) * 100);
      return (
        `History at ~${pct}% of context window ` +
        `(${tokens}/${CONTEXT_WINDOW_TOKENS} tokens). ` +
        `Type 'clear' to start fresh.`
      );
    }

    return undefined;
  }

  private toLLMToolDefinition(tool: Tool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }

  private detectIntendedAction(message: string): string | null {
    const lower = message.toLowerCase();

    const readPatterns = [
      /(?:read|show|open|display|cat|print)\s+\S+\.\w+/,
      /what(?:'s| is| are) (?:in|inside) \S+\.\w+/,
      /(?:contents?|content) of \S+\.\w+/,
      /(?:name|version|type|main|scripts?) (?:in|of|from) \S+\.\w+/,

      /* Pronoun reference: "show that file", "read it", "open the file" */
      /(?:read|show|open|display|cat|print)\s+(?:that|the|this|it)(?:\s+file)?/,
      /what(?:'s| is| are) (?:in|inside) (?:that|the|this|it)(?:\s+file)?/,
    ];

    for (const pattern of readPatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to READ a file. " +
          "For the path parameter: if the user gave a filename, " +
          "use it directly. If the user said 'that file', 'the file', " +
          "'it', or similar pronoun, look at your conversation history " +
          "and use the filename from the most recently discussed file. " +
          "Use the read_file tool now. " +
          "Do not ask clarifying questions. Act immediately."
        );
      }
    }

    const modifyPatterns = [
      /* With explicit filename: "change X to Y in file.txt" */
      /(?:change|replace|update|modify|edit|swap)\s+.+(?:to|with|in)\s+\S+\.\w+/,

      /* "change X to Y in file file.txt" */
      /(?:change|replace|update|modify|edit|swap)\s+.+(?:to|with)\s+.+(?:in)\s+\S+\.\w+/,

      /* Reverse: "in file.txt change X" */
      /in\s+\S+\.\w+\s+(?:change|replace|update|modify)/,

      /* Pronoun reference: "change X to Y in that file", "in the file", "in it" */
      /(?:change|replace|update|modify|edit|swap)\s+.+(?:to|with)\s+.+(?:in|to)\s+(?:that|the|this|it)(?:\s+file)?/,

      /* Short pronoun: "change X to Y there" or "in there" */
      /(?:change|replace|update|modify|edit|swap)\s+.+(?:to|with)\s+.+\s+(?:in\s+)?there/,

      /* NEW: Add/inject/insert code into file */
      /(?:add|inject|insert|append)\s+.+\s+(?:to|in|into)\s+\S+\.\w+/,
      /(?:add|inject|insert)\s+.+\s+(?:to|in|into)\s+(?:that|the|this|it)(?:\s+file)?/,

      /* NEW: Refactor patterns */
      /(?:refactor|clean up|improve|optimize)\s+\S+\.\w+/,
      /(?:refactor|clean up|improve|optimize)\s+(?:that|the|this|it)(?:\s+file)?/,

      /* NEW: Wrap in try/catch, add types, etc. */
      /(?:wrap|surround|enclose)\s+.+\s+(?:in|with)\s+/,
      /(?:add|include)\s+(?:error\s+handling|types|comments|docstrings|jsdoc|tsdoc)\s+(?:to|in)\s+\S+\.\w+/,
      /(?:add|include)\s+(?:error\s+handling|types|comments|docstrings|jsdoc|tsdoc)\s+(?:to|in)\s+(?:that|the|this|it)(?:\s+file)?/,

      /* NEW: Remove code from file */
      /(?:remove|delete)\s+.+\s+(?:from|in)\s+\S+\.\w+/,
      /(?:remove|delete)\s+.+\s+(?:from|in)\s+(?:that|the|this|it)(?:\s+file)?/,
    ];

    for (const pattern of modifyPatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to MODIFY a file. " +
          "STEP 1: If you don't already have the file's exact current content " +
          "in working memory, first call read_file to see the current content. " +
          "STEP 2: Then call patch_file with operation='replace', " +
          "search=the exact old text you want to replace (must match file exactly), " +
          "replace=the new text (or full new content), " +
          "path=the filename mentioned in the message. " +
          "For the path parameter: if user gave filename, use it. " +
          "If user said 'that file'/'the file'/'it'/'there', use the most " +
          "recently discussed filename from conversation history. " +
          "Do NOT ask for confirmation. Do NOT show the code without calling the tool. " +
          "Act by calling read_file then patch_file immediately."
        );
      }
    }

    /*
     * Fix intent — detects "find and fix bugs", "fix this code",
     * "correct the errors", etc. Forces patch_file tool use.
     */
    const fixPatterns = [
      /(?:fix|repair|correct)\s+(?:the\s+)?(?:bugs?|errors?|issues?|problems?)\s+in/,
      /(?:find and fix|debug and fix)/,
      /(?:use\s+)?patch_file\s+to\s+(?:apply|fix)/,
    ];

    for (const pattern of fixPatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to FIX code in a file. " +
          "You MUST use the patch_file tool now with operation='replace', " +
          "search=the exact original code from the message, " +
          "replace=the corrected code, " +
          "path=the filename mentioned in the message. " +
          "Do NOT respond with text explaining the fix. " +
          "Call patch_file immediately."
        );
      }
    }

    /*
     * Generate intent — "generate tests", "write documentation",
     * "create tests for this". Forces write_file tool use.
     */
    const generatePatterns = [
      /generate\s+(?:unit\s+)?tests?\s+for/,
      /(?:write|create)\s+(?:unit\s+)?tests?\s+for/,
      /generate\s+(?:documentation|docs|comments|jsdoc|tsdoc)/,
      /(?:write|add)\s+(?:documentation|docs|comments|jsdoc|tsdoc)/,
      /(?:use\s+)?write_file\s+to\s+save/,
    ];

    for (const pattern of generatePatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to GENERATE and SAVE code to a new file. " +
          "You MUST use the write_file tool now. " +
          "For tests: create a file named like <original>.test.ts or similar " +
          "in the same directory. " +
          "For documentation: use patch_file to add comments inline. " +
          "Do NOT respond with text showing the code. " +
          "Call the tool immediately."
        );
      }
    }

    const createPatterns = [
      /* Direct: "create notes.txt" */
      /(?:create|make|generate|new file|write)\s+\S+\.\w+/,

      /* With article: "create a notes.txt" "make an example.js" */
      /(?:create|make|generate)\s+(?:a |an )?(?:new )?\S+\.\w+/,

      /* With "file called/named": "create a file called notes.txt" */
      /(?:create|make|generate)\s+(?:a |an )?(?:new )?file\s+(?:called|named)\s+\S+\.\w+/,

      /* Reverse: "notes.txt file with content..." */
      /\S+\.\w+\s+(?:file\s+)?with\s+(?:the\s+)?content/,
    ];

    for (const pattern of createPatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to CREATE a file. " +
          "Use the write_file tool now with the filename from their message. " +
          "If no content was specified, create a minimal sensible template. " +
          "Use the project root if no directory was specified. " +
          "Do not ask clarifying questions. Act immediately."
        );
      }
    }

    const deletePatterns = [
      /(?:delete|remove|rm)\s+\S+\.\w+/,
      /(?:delete|remove)\s+(?:that|the|this|it)(?:\s+file)?/,
    ];

    for (const pattern of deletePatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to DELETE a file. " +
          "For the path parameter: if the user gave a filename, use it. " +
          "If they said 'that file', 'the file', 'it', look at your " +
          "conversation history and use the most recently discussed filename. " +
          "Use the delete_file tool now. " +
          "Do not ask clarifying questions. Act immediately."
        );
      }
    }

    const commandPatterns = [/(?:run|execute|start)\s+(?:npm|node|git|tsc)\s/];

    for (const pattern of commandPatterns) {
      if (pattern.test(lower)) {
        return (
          "The user wants to RUN a command. " +
          "Use the run_command tool now with the command from their message. " +
          "Do not ask clarifying questions. Act immediately."
        );
      }
    }

    if (/https?:\/\/\S+/.test(lower)) {
      return (
        "The user wants to FETCH a URL. " +
        "Use the web_access tool now with the URL from their message. " +
        "Do not ask clarifying questions. Act immediately."
      );
    }

    const implicitFilePatterns = [
      /(?:what|show|tell|get|find).+(?:package\.json|tsconfig\.json|readme|\.env)/,
      /(?:package\.json|tsconfig\.json|readme|\.env).+(?:what|show|tell|name|version)/,
    ];

    for (const pattern of implicitFilePatterns) {
      if (pattern.test(lower)) {
        return (
          "The user is asking about a project file. " +
          "Use read_file to read the file and then answer their question. " +
          "Do not say you cannot access files. Act immediately."
        );
      }
    }

    /*
     * Pattern: Confirmation intent.
     *
     * User replied "yes", "do it", "go ahead", "sure",
     * "ok", "please", "proceed" — all common ways to
     * confirm a previously discussed action.
     *
     * Force the model to look at conversation history
     * and execute the previously proposed action.
     *
     * This solves the case where model asks "should I
     * proceed?" and user says "yes" — small models
     * often forget the pending action and just chat back.
     */
    const confirmationPatterns = [
      /^(?:yes|yep|yeah|yup|sure|ok|okay|okey)[.!]?$/,
      /^(?:do it|go ahead|proceed|confirm|correct|please)[.!]?$/,
      /^(?:yes please|please do|go for it|do that)[.!]?$/,
    ];

    const trimmedLower = lower.trim();

    for (const pattern of confirmationPatterns) {
      if (pattern.test(trimmedLower)) {
        return (
          "The user has confirmed a previously discussed action. " +
          "Look at your recent assistant messages to find:\n" +
          "1. What action was proposed (create/modify/delete/etc)\n" +
          "2. Which file it applies to\n" +
          "3. What the new content should be\n" +
          "\n" +
          "IMPORTANT: If you proposed a modification but don't have the " +
          "old text to pass to patch_file's 'search' parameter:\n" +
          "  - First call read_file to get current content\n" +
          "  - Then call patch_file with the actual old code as 'search' " +
          "and your proposed new code as 'replace'\n" +
          "\n" +
          "If you proposed a full rewrite: call write_file with the new content.\n" +
          "If you proposed a create: call write_file to create the file.\n" +
          "If you proposed a delete: call delete_file.\n" +
          "\n" +
          "Do NOT ask for confirmation again. " +
          "Do NOT ask user to provide old/new text (it was in your previous message). " +
          "Act immediately by calling the appropriate tool."
        );
      }
    }

    return null;
  }
}
