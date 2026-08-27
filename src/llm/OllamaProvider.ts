import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from "./LLMProvider.js";
import { CircuitBreaker } from "./CircuitBreaker.js";

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface OllamaMessage {
  content?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaApiResponse {
  message?: OllamaMessage;
  error?: string;
}

/*
 * Markers that indicate the response contains
 * a raw tool call that was not properly parsed.
 * When detected, we strip and retry.
 */
const RAW_TOOL_MARKERS = [
  "<｜tool▁call▁begin｜>",
  "<｜tool▁calls▁begin｜>",
  "<｜tool▁sep｜>",
];

export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly debug: boolean;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly contextSize: number;

  /*
   * Track which model is currently active.
   * Switches to fallback if primary fails.
   */
  private activeModel: string;

  constructor(
    model: string,
    baseUrl = "http://127.0.0.1:11434",
    debug = false,
    fallbackModel = "",
    contextSize = 8192,
  ) {
    this.model = model;
    this.activeModel = model;
    this.baseUrl = baseUrl;
    this.debug = debug;
    this.fallbackModel = fallbackModel;
    this.contextSize = contextSize;
    this.circuitBreaker = new CircuitBreaker();
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    /*
     * Circuit breaker check — fail fast if Ollama is down.
     * Do not waste 30 seconds on a timeout if we already
     * know Ollama is not responding.
     */
    if (this.circuitBreaker.isOpen()) {
      throw new Error(this.circuitBreaker.getOpenMessage());
    }

    try {
      const result = await this.generateWithModel(request, this.activeModel);

      /*
       * Success — record for circuit breaker.
       */
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      /*
       * Record failure for circuit breaker.
       * This counts toward the threshold
       * regardless of error type.
       */
      this.circuitBreaker.recordFailure();

      /*
       * Check if this is a model-specific error
       * and we have a fallback configured.
       */
      if (this.fallbackModel !== "" && this.isModelError(error)) {
        console.warn(
          `[OllamaProvider] Primary model '${this.activeModel}' failed. ` +
            `Trying fallback: '${this.fallbackModel}'`,
        );

        try {
          const result = await this.generateWithModel(
            request,
            this.fallbackModel,
          );

          /*
           * Fallback succeeded — record success.
           * Switch active model for remainder of session.
           */
          this.circuitBreaker.recordSuccess();
          this.activeModel = this.fallbackModel;

          console.warn(
            `[OllamaProvider] Switched to fallback: '${this.fallbackModel}'`,
          );

          return result;
        } catch (fallbackError) {
          this.circuitBreaker.recordFailure();
          throw new Error(
            `Both primary model '${this.model}' and fallback ` +
              `'${this.fallbackModel}' failed. ` +
              `Last error: ${fallbackError instanceof Error ? fallbackError.message : "Unknown"}`,
          );
        }
      }

      throw error;
    }
  }

  /*
   * Generate a response using a specific model.
   * Contains all the core generation logic.
   */
  private async generateWithModel(
    request: LLMRequest,
    model: string,
  ): Promise<LLMResponse> {
    const requestBody = {
      model,
      messages: request.messages,
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      /*
       * Force tool use when Agent requires it.
       * "required" makes model call a tool instead of text response.
       */
      ...(request.requireToolCall === true
        ? { tool_choice: "required" as const }
        : {}),
      stream: false,
      options: {
        /*
         * Explicit context window size.
         * Ensures model uses full 8192 token window.
         */
        num_ctx: this.contextSize,
        /*
         * Cap response length.
         * Prevents runaway generation.
         * 4096 tokens ≈ 16000 chars — generous for any response.
         */
        num_predict: 8192,
        /*
         * Stop sequences for DeepSeek models.
         * Prevents hallucinated tool outputs.
         */
        stop: [
          "<｜tool▁outputs▁begin｜>",
          "<｜tool▁calls▁end｜>\n<｜tool▁outputs▁begin｜>",
          "<|im_end|>",
          "<|endoftext|>",
        ],
      },
    };

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      /*
       * Network error — connection refused, timeout etc.
       * Re-throw for circuit breaker to handle.
       */
      throw new Error(
        `Network error connecting to Ollama: ` +
          `${error instanceof Error ? error.message : "Unknown"}`,
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama request failed: ${response.status} ` +
          `${response.statusText}: ${errorBody}`,
      );
    }

    const data = (await response.json()) as OllamaApiResponse;

    /*
     * Check for API-level error in response body.
     */
    if (typeof data.error === "string" && data.error !== "") {
      throw new Error(`Ollama error: ${data.error}`);
    }

    if (this.debug) {
      console.log(
        "\n[OllamaProvider] Raw response:",
        JSON.stringify(data.message, null, 2),
      );
    }

    const rawContent = data.message?.content ?? "";
    const rawToolCalls = data.message?.tool_calls;

    /*
     * Response quality check — Step 1:
     * Detect and handle raw tool markers in content.
     *
     * If the model emitted DeepSeek-style tool tokens
     * but our parser failed, the content will contain
     * visible markers. Strip and retry once.
     */

    const content = this.deduplicateResponse(rawContent.trim());

    /*
     * Response quality check — Step 2:
     * Empty or whitespace-only response.
     *
     * This happens when the model fails to generate
     * anything useful. We return empty content and
     * let the agent handle it (it will retry the turn).
     */
    if (
      content === "" &&
      (rawToolCalls === undefined || rawToolCalls.length === 0)
    ) {
      if (this.debug) {
        console.log("[OllamaProvider] Empty response received.");
      }
    }

    let toolCalls: LLMToolCall[] | undefined;

    /*
     * Format 1: Structured tool_calls from Ollama.
     */
    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      const parsed: LLMToolCall[] = [];

      for (const raw of rawToolCalls) {
        const name = raw.function?.name;
        const args = raw.function?.arguments;

        if (
          typeof name === "string" &&
          name.trim() !== "" &&
          args !== null &&
          typeof args === "object" &&
          !Array.isArray(args)
        ) {
          parsed.push({ name, arguments: args });
        }
      }

      if (parsed.length > 0) {
        toolCalls = parsed;
      }
    }

    /*
     * Formats 2, 3, 4: Parse from content text.
     */
    if (toolCalls === undefined && content) {
      const parsed = this.parseToolCallsFromContent(content);
      if (parsed.length > 0) {
        toolCalls = parsed;
      }
    }

    /*
     * Response quality check:
     * If content has raw tool markers but parsing
     * completely failed, return empty content.
     * Better than showing garbage markers to user.
     */
    if (toolCalls === undefined && this.containsRawToolMarkers(content)) {
      if (this.debug) {
        console.log(
          "[OllamaProvider] Raw markers detected but parsing failed. " +
            "Returning empty content.",
        );
      }
      return { content: "" };
    }

    if (
      toolCalls === undefined &&
      request.onToken !== undefined &&
      content !== ""
    ) {
      await this.simulateStream(content, request.onToken, request.signal);
    }

    return {
      content: toolCalls !== undefined ? "" : content,
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    };
  }

  /*
   * Check if an error is model-specific
   * (vs network/infrastructure error).
   *
   * Model errors: model not found, OOM, context too long.
   * Network errors: connection refused, timeout.
   *
   * Only model errors trigger fallback.
   * Network errors go to circuit breaker instead.
   */
  private isModelError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const msg = error.message.toLowerCase();

    return (
      msg.includes("model") ||
      msg.includes("not found") ||
      msg.includes("out of memory") ||
      msg.includes("context length") ||
      msg.includes("invalid model")
    );
  }

  /*
   * Check if content contains raw DeepSeek tool markers
   * that were not successfully parsed.
   */
  private containsRawToolMarkers(content: string): boolean {
    return RAW_TOOL_MARKERS.some((marker) => content.includes(marker));
  }

  /*
   * Stream content to a token callback.
   * Called by Agent AFTER it decides content is final.
   * Not called automatically during generate().
   */
  async streamContent(
    content: string,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.simulateStream(content, onToken, signal);
  }

  private async simulateStream(
    content: string,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    console.log(
      "[STREAM-V2] Streaming",
      content.length,
      "chars:",
      content.slice(0, 60),
    ); // ADD
    const words = content.split(" ");

    for (let i = 0; i < words.length; i++) {
      /*
       * Check abort signal before each word.
       * If aborted, stop immediately.
       */
      if (signal?.aborted === true) {
        return;
      }

      const word = words[i];
      if (word === undefined) continue;
      const token = i < words.length - 1 ? word + " " : word;
      if (token.length > 0) {
        onToken(token);
        await this.delay(15);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseToolCallsFromContent(content: string): LLMToolCall[] {
    const results: LLMToolCall[] = [];

    /*
     * Pattern 1: Standard JSON format
     * {"name": "tool_name", "arguments": {...}}
     */
    const jsonPattern =
      /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;

    let match: RegExpExecArray | null;

    while ((match = jsonPattern.exec(content)) !== null) {
      const name = match[1];
      const argsString = match[2];
      if (typeof name !== "string" || name.trim() === "") continue;
      if (typeof argsString !== "string") continue;
      try {
        const args = JSON.parse(argsString) as unknown;
        if (args !== null && typeof args === "object" && !Array.isArray(args)) {
          results.push({
            name,
            arguments: args as Record<string, unknown>,
          });
        }
      } catch {
        /* skip */
      }
    }

    if (results.length > 0) return results;

    /*
     * Pattern 2: DeepSeek special token format.
     * Handles both singular and plural begin/end tokens.
     */
    const deepseekPattern =
      /<｜tool▁calls?▁begin｜>(?:<｜tool▁call▁begin｜>)?function<｜tool▁sep｜>(\w+)\s*```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*(?:<｜tool▁call▁end｜>)?(?:<｜tool▁calls?▁end｜>)?/g;

    while ((match = deepseekPattern.exec(content)) !== null) {
      const name = match[1];
      const argsString = match[2];
      if (typeof name !== "string" || name.trim() === "") continue;
      if (typeof argsString !== "string") continue;
      try {
        const args = JSON.parse(argsString) as unknown;
        if (args !== null && typeof args === "object" && !Array.isArray(args)) {
          results.push({
            name,
            arguments: args as Record<string, unknown>,
          });
        }
      } catch {
        /* skip */
      }
    }

    if (results.length > 0) return results;

    /*
     * Pattern 3: tool_calls array format in content.
     */
    const toolCallsArrayPattern = /"tool_calls"\s*:\s*\[([\s\S]*?)\]/g;

    while ((match = toolCallsArrayPattern.exec(content)) !== null) {
      const arrayContent = match[1];
      if (typeof arrayContent !== "string") continue;

      const objectPattern = /\{([\s\S]*?)\}/g;
      let objMatch: RegExpExecArray | null;

      while ((objMatch = objectPattern.exec(arrayContent)) !== null) {
        try {
          const obj = JSON.parse(`{${objMatch[1]}}`) as Record<string, unknown>;

          if (typeof obj["function"] === "string" && obj["parameters"]) {
            results.push({
              name: obj["function"] as string,
              arguments: obj["parameters"] as Record<string, unknown>,
            });
          }
        } catch {
          /* skip */
        }
      }
    }

    return results;
  }

  /*
   * Detect and remove paragraph-level restatements.
   *
   * Model sometimes gives answer twice in different formats:
   *   "The answer is 4, and the answer is 6."
   *   "The answer to X is:
   *    - answer: 4
   *    - answer: 6"
   *
   * Strategy:
   *   1. Split by double newlines (paragraphs)
   *   2. Extract key numeric/named entities per paragraph
   *   3. If paragraph 2's entities are subset of paragraph 1,
   *      drop paragraph 2
   */
  private removeRestatedParagraphs(content: string): string {
    const paragraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p !== "");

    if (paragraphs.length < 2) return content;

    const kept: string[] = [paragraphs[0]!];
    const firstEntities = this.extractEntities(paragraphs[0]!);

    for (let i = 1; i < paragraphs.length; i++) {
      const current = paragraphs[i]!;
      const currentEntities = this.extractEntities(current);

      /*
       * If current paragraph's entities are >= 80% subset
       * of first paragraph, skip (it's a restatement).
       */
      if (currentEntities.size > 0) {
        let overlap = 0;
        for (const e of currentEntities) {
          if (firstEntities.has(e)) overlap++;
        }
        const overlapRatio = overlap / currentEntities.size;

        if (overlapRatio >= 0.8) continue;
      }

      kept.push(current);
    }

    return kept.join("\n\n");
  }

  /*
   * Extract entities from text — numbers, quoted strings,
   * and capitalized identifiers. These are the "facts"
   * a paragraph conveys.
   */
  private extractEntities(text: string): Set<string> {
    const entities = new Set<string>();

    /*
     * Numbers (including decimals).
     */
    const numbers = text.match(/\b\d+(?:\.\d+)?\b/g);
    if (numbers) {
      for (const n of numbers) entities.add(n);
    }

    /*
     * Quoted strings.
     */
    const quoted = text.match(/"([^"]+)"/g);
    if (quoted) {
      for (const q of quoted) entities.add(q.toLowerCase());
    }

    /*
     * File-like names (word.ext).
     */
    const files = text.match(/\b[\w-]+\.\w{1,5}\b/g);
    if (files) {
      for (const f of files) entities.add(f.toLowerCase());
    }

    return entities;
  }

  /*
   * Deduplicate near-identical sentences in model output.
   *
   * Small models like deepseek-coder-fix often emit
   * the same information twice with slightly different
   * wording:
   *   "The result of the expression 2+2 is 4."
   *   "The result of 2+2 is 4."
   *
   * Uses Jaccard similarity on meaningful words.
   * Sentences with >= 70% word overlap are duplicates.
   *
   * Strategy:
   *   1. Split by sentence boundaries
   *   2. Extract meaningful words (no stop words)
   *   3. Compare to previously kept sentences
   *   4. Drop if similar to any kept sentence
   *
   * Defense in depth: keep this even when using
   * better models. Copilot and Antigravity both
   * post-process their model outputs.
   */
  private deduplicateResponse(content: string): string {
    console.log("[DEDUP-V2] Called with", content.length, "chars"); // ADD THIS
    if (content.length < 20) return content;

    /*
     * First pass: remove restated paragraphs.
     * Handles model saying same answer in two formats.
     */
    content = this.removeRestatedParagraphs(content);

    /*
     * Split by sentence boundaries.
     * Handles missing whitespace after . ! ?
     */
    const sentenceRegex = /[^.!?]+[.!?]+/g;
    const matches = content.match(sentenceRegex);

    if (matches === null || matches.length < 2) {
      return content;
    }

    const keptWordSets: Set<string>[] = [];
    const kept: string[] = [];

    for (const raw of matches) {
      const sentence = raw.trim();
      if (sentence === "") continue;

      const words = this.extractMeaningfulWords(sentence);

      /*
       * Very short sentences (< 3 meaningful words):
       * always keep — likely legitimate short statements.
       */
      if (words.size < 3) {
        kept.push(sentence);
        keptWordSets.push(words);
        continue;
      }

      /*
       * Check similarity against every kept sentence.
       * If >= 70% word overlap → duplicate.
       */
      let isDuplicate = false;

      for (const keptWords of keptWordSets) {
        const similarity = this.wordSetSimilarity(words, keptWords);
        if (similarity >= 0.7) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) continue;

      kept.push(sentence);
      keptWordSets.push(words);
    }

    /*
     * Preserve any trailing incomplete text after
     * the last sentence terminator.
     */
    const lastMatch = matches[matches.length - 1];
    const lastIdx = content.lastIndexOf(lastMatch!) + lastMatch!.length;
    const trailing = content.slice(lastIdx).trim();

    if (trailing !== "") {
      kept.push(trailing);
    }

    return kept.join(" ");
  }

  /*
   * Extract meaningful words from a sentence.
   * Removes stop words, punctuation, numbers.
   * Returns Set for O(1) intersection checks.
   */
  private extractMeaningfulWords(sentence: string): Set<string> {
    const stopWords = new Set([
      "a",
      "an",
      "the",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "of",
      "in",
      "on",
      "at",
      "to",
      "for",
      "with",
      "by",
      "from",
      "into",
      "and",
      "or",
      "but",
      "not",
      "no",
      "yes",
      "i",
      "you",
      "he",
      "she",
      "it",
      "we",
      "they",
      "me",
      "him",
      "her",
      "us",
      "them",
      "my",
      "your",
      "his",
      "its",
      "our",
      "their",
      "this",
      "that",
      "these",
      "those",
      "if",
      "then",
      "so",
      "as",
      "than",
      "will",
      "would",
      "can",
      "could",
      "do",
      "does",
      "did",
      "have",
      "has",
      "had",
      "am",
      "just",
      "how",
      "what",
      "when",
      "where",
      "why",
    ]);

    const words = sentence
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

    return new Set(words);
  }

  /*
   * Jaccard similarity between two word sets.
   * Returns 0.0 (nothing in common) to 1.0 (identical).
   *
   * Formula: |A ∩ B| / |A ∪ B|
   */
  private wordSetSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}

/*
 * OllamaHealthCheck
 *
 * Verifies Ollama is running and the required
 * model is available before starting the agent.
 *
 * Gives clear error messages instead of cryptic
 * connection refused errors during inference.
 */
export class OllamaHealthCheck {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fallbackModel = "",
  ) {}

  async check(): Promise<void> {
    /*
     * Step 1: Check Ollama is running.
     */
    let availableModels: string[] = [];

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };

      availableModels = (data.models ?? []).map((m) => m.name);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Ollama returned")
      ) {
        throw error;
      }

      throw new Error(
        `Cannot connect to Ollama at ${this.baseUrl}.\n` +
          `Please ensure Ollama is running:\n` +
          `  ollama serve\n` +
          `Or check if it is already running in the background.`,
      );
    }

    /*
     * Step 2: Check primary model exists.
     */
    const primaryExists = this.modelExistsIn(this.model, availableModels);

    if (!primaryExists) {
      /*
       * Check if fallback is available.
       */
      if (this.fallbackModel !== "") {
        const fallbackExists = this.modelExistsIn(
          this.fallbackModel,
          availableModels,
        );

        if (fallbackExists) {
          console.warn(
            `⚠ Primary model '${this.model}' not found. ` +
              `Fallback '${this.fallbackModel}' is available.`,
          );
          return;
        }
      }

      const available = availableModels.join(", ");

      throw new Error(
        `Model '${this.model}' not found in Ollama.\n` +
          `Available models: ${available || "none"}\n` +
          `Pull the model with:\n` +
          `  ollama pull ${this.model}`,
      );
    }

    console.log(`✓ Ollama connected. Model '${this.model}' ready.`);
  }

  /*
   * Check if a model name exists in the available list.
   * Matches exact name or name prefix (ignores :tag).
   */
  private modelExistsIn(modelName: string, available: string[]): boolean {
    const prefix = modelName.split(":")[0] ?? modelName;

    return available.some((m) => m === modelName || m.startsWith(prefix));
  }
}
