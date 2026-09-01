import type {
  LLMMessage,
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
    if (this.circuitBreaker.isOpen()) {
      throw new Error(this.circuitBreaker.getOpenMessage());
    }

    try {
      const result = await this.generateWithModel(request, this.activeModel);
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      this.circuitBreaker.recordFailure();

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

  private async generateWithModel(
    request: LLMRequest,
    model: string,
  ): Promise<LLMResponse> {
    /*
     * Format messages for Ollama API compatibility.
     * 1. Models like Gemma/Llama drop `role: "tool"` in their templates.
     *    Mapping `tool` -> `user` with explicit prefix ensures all models see tool outputs.
     * 2. Map camelCase `toolCalls` to snake_case `tool_calls` for Ollama Go backend.
     */
    const formattedMessages = request.messages.map((m: LLMMessage) => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: `[Tool Result for ${m.toolName ?? "tool"}]:\n${m.content}`,
        };
      }

      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content:
            m.content && m.content.trim() !== ""
              ? m.content
              : `[Calling tool: ${m.toolCalls.map((t) => t.name).join(", ")}]`,
          tool_calls: m.toolCalls.map((tc) => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }

      return {
        role: m.role,
        content: m.content,
      };
    });

    const requestBody = {
      model,
      messages: formattedMessages,
      ...(request.tools !== undefined
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.requireToolCall === true
        ? { tool_choice: "required" as const }
        : {}),
      stream: false,
      options: {
        num_ctx: this.contextSize,
        num_predict: 8192,
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

    const content = this.deduplicateResponse(rawContent.trim());

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

  private containsRawToolMarkers(content: string): boolean {
    return RAW_TOOL_MARKERS.some((marker) => content.includes(marker));
  }

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
    const words = content.split(" ");

    for (let i = 0; i < words.length; i++) {
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

  private extractEntities(text: string): Set<string> {
    const entities = new Set<string>();

    const numbers = text.match(/\b\d+(?:\.\d+)?\b/g);
    if (numbers) {
      for (const n of numbers) entities.add(n);
    }

    const quoted = text.match(/"([^"]+)"/g);
    if (quoted) {
      for (const q of quoted) entities.add(q.toLowerCase());
    }

    const files = text.match(/\b[\w-]+\.\w{1,5}\b/g);
    if (files) {
      for (const f of files) entities.add(f.toLowerCase());
    }

    return entities;
  }

  private deduplicateResponse(content: string): string {
    if (content.length < 20) return content;

    content = this.removeRestatedParagraphs(content);

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

      if (words.size < 3) {
        kept.push(sentence);
        keptWordSets.push(words);
        continue;
      }

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

    const lastMatch = matches[matches.length - 1];
    const lastIdx = content.lastIndexOf(lastMatch!) + lastMatch!.length;
    const trailing = content.slice(lastIdx).trim();

    if (trailing !== "") {
      kept.push(trailing);
    }

    return kept.join(" ");
  }

  private extractMeaningfulWords(sentence: string): Set<string> {
    const stopWords = new Set([
      "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
      "of", "in", "on", "at", "to", "for", "with", "by", "from", "into",
      "and", "or", "but", "not", "no", "yes", "i", "you", "he", "she",
      "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
      "his", "its", "our", "their", "this", "that", "these", "those", "if",
      "then", "so", "as", "than", "will", "would", "can", "could", "do",
      "does", "did", "have", "has", "had", "am", "just", "how", "what",
      "when", "where", "why",
    ]);

    const words = sentence
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

    return new Set(words);
  }

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

export class OllamaHealthCheck {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fallbackModel = "",
  ) {}

  async check(): Promise<void> {
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

    const primaryExists = this.modelExistsIn(this.model, availableModels);

    if (!primaryExists) {
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

  private modelExistsIn(modelName: string, available: string[]): boolean {
    const prefix = modelName.split(":")[0] ?? modelName;
    return available.some((m) => m === modelName || m.startsWith(prefix));
  }
}