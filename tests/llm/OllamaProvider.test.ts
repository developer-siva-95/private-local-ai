import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "../../src/llm/OllamaProvider.js";
import type { LLMRequest } from "../../src/llm/LLMProvider.js";

describe("OllamaProvider — Streaming", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockJsonResponse(
    content: string,
    toolCalls?: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>,
  ): void {
    const message: Record<string, unknown> = {
      role: "assistant",
      content,
    };
    if (toolCalls && toolCalls.length > 0) {
      message["tool_calls"] = toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ message }),
      text: async () => "",
    });
  }

  // ─────────────────────────────────────────────
  // Normal text response
  // ─────────────────────────────────────────────

  it("returns full content for a normal text response", async () => {
    mockJsonResponse("Hello, world!");

    const provider = new OllamaProvider("test-model");
    const result = await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("Hello, world!");
    expect(result.toolCalls).toBeUndefined();
  });

  it("calls onToken word by word for plain text response", async () => {
    mockJsonResponse("Hello world");

    const provider = new OllamaProvider("test-model");
    const received: string[] = [];

    await provider.generate({
      messages: [{ role: "user", content: "hi" }],
      onToken: (token) => { received.push(token); },
    });

    /*
     * Words are emitted with trailing space except last.
     * "Hello world" → ["Hello ", "world"]
     */
    expect(received.join("")).toBe("Hello world");
    expect(received.length).toBeGreaterThan(0);
  });

  it("does not call onToken when no callback provided", async () => {
    mockJsonResponse("Hello world");

    const provider = new OllamaProvider("test-model");

    const result = await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("Hello world");
  });

  it("does not call onToken when response is empty", async () => {
    mockJsonResponse("");

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    const result = await provider.generate({
      messages: [{ role: "user", content: "hi" }],
      onToken: (t) => { tokens.push(t); },
    });

    expect(result.content).toBe("");
    expect(tokens).toHaveLength(0);
  });

  // ─────────────────────────────────────────────
  // Format 1: Structured tool_calls
  // ─────────────────────────────────────────────

  it("parses Format 1 structured tool_calls", async () => {
    mockJsonResponse("", [
      { name: "read_file", arguments: { path: "src/index.ts" } },
    ]);

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    const result = await provider.generate({
      messages: [{ role: "user", content: "read index" }],
      onToken: (t) => { tokens.push(t); },
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("read_file");
    expect(result.toolCalls?.[0]?.arguments).toEqual({
      path: "src/index.ts",
    });
    expect(result.content).toBe("");
    expect(tokens).toHaveLength(0);
  });

  it("does not call onToken for tool call responses", async () => {
    mockJsonResponse("", [
      { name: "write_file", arguments: { path: "test.ts", content: "x" } },
    ]);

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    await provider.generate({
      messages: [{ role: "user", content: "write it" }],
      onToken: (t) => { tokens.push(t); },
    });

    expect(tokens).toHaveLength(0);
  });

  // ─────────────────────────────────────────────
  // Format 2: JSON tool call in content
  // ─────────────────────────────────────────────

  it("parses Format 2 JSON tool call from content", async () => {
    const toolJson = JSON.stringify({
      name: "write_file",
      arguments: { path: "test.ts", content: "hello" },
    });

    mockJsonResponse(toolJson);

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    const result = await provider.generate({
      messages: [{ role: "user", content: "write it" }],
      onToken: (t) => { tokens.push(t); },
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("write_file");
    expect(tokens).toHaveLength(0);
    expect(result.content).toBe("");
  });

  // ─────────────────────────────────────────────
  // Format 3: DeepSeek tokens
  // ─────────────────────────────────────────────

  it("parses Format 3 DeepSeek token format", async () => {
    const deepseekCall =
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function" +
      "<｜tool▁sep｜>read_file\n```json\n" +
      '{"path": "src/index.ts"}\n```\n' +
      "<｜tool▁call▁end｜><｜tool▁calls▁end｜>";

    mockJsonResponse(deepseekCall);

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    const result = await provider.generate({
      messages: [{ role: "user", content: "read it" }],
      onToken: (t) => { tokens.push(t); },
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("read_file");
    expect(tokens).toHaveLength(0);
  });

  // ─────────────────────────────────────────────
  // HTTP errors
  // ─────────────────────────────────────────────

  it("throws on non-200 HTTP response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "model not found",
    });

    const provider = new OllamaProvider("test-model");

    await expect(
      provider.generate({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Ollama request failed: 500");
  });

  // ─────────────────────────────────────────────
  // Debug mode
  // ─────────────────────────────────────────────

  it("logs accumulated content in debug mode", async () => {
    mockJsonResponse("Debug response");

    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => {});

    const provider = new OllamaProvider(
      "test-model",
      "http://127.0.0.1:11434",
      true,
    );

    await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[OllamaProvider]"),
      expect.any(String),
    );

    consoleSpy.mockRestore();
  });

  // ─────────────────────────────────────────────
  // Request structure
  // ─────────────────────────────────────────────

  it("sends stream: false in request body", async () => {
    mockJsonResponse("ok");

    const provider = new OllamaProvider("my-model");

    await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { stream: boolean };
    expect(body.stream).toBe(false);
  });

  it("includes stop sequences in request options", async () => {
    mockJsonResponse("ok");

    const provider = new OllamaProvider("my-model");

    await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as {
      options: { stop: string[] };
    };
    expect(body.options.stop).toContain("<｜tool▁outputs▁begin｜>");
  });

  it("sends tools in correct Ollama format", async () => {
    mockJsonResponse("ok");

    const provider = new OllamaProvider("my-model");

    const request: LLMRequest = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
          },
        },
      ],
    };

    await provider.generate(request);

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as {
      tools: Array<{ type: string; function: { name: string } }>;
    };
    expect(body.tools?.[0]?.type).toBe("function");
    expect(body.tools?.[0]?.function?.name).toBe("read_file");
  });

  it("simulates streaming by calling onToken multiple times for long response", async () => {
    mockJsonResponse("one two three four five");

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    await provider.generate({
      messages: [{ role: "user", content: "count" }],
      onToken: (t) => { tokens.push(t); },
    });

    /*
     * 5 words → 5 onToken calls.
     * Joined they must equal the original content.
     */
    expect(tokens.length).toBe(5);
    expect(tokens.join("")).toBe("one two three four five");
  });

    it("includes num_ctx and num_predict in request options", async () => {
    mockJsonResponse("ok");

    const provider = new OllamaProvider("my-model");

    await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    const [, options] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(options.body as string) as {
      options: { num_ctx: number; num_predict: number };
    };

    expect(body.options.num_ctx).toBe(8192);
    expect(body.options.num_predict).toBe(8192);
  });

  it("returns empty content when response contains raw tool markers", async () => {
    /*
     * Simulate model emitting DeepSeek markers
     * without proper tool call structure.
     */
    mockJsonResponse(
      "<｜tool▁calls▁begin｜>garbage content",
    );

    const provider = new OllamaProvider("test-model");
    const tokens: string[] = [];

    const result = await provider.generate({
      messages: [{ role: "user", content: "hi" }],
      onToken: (t) => { tokens.push(t); },
    });

    /*
     * Raw markers detected — returns empty content.
     * No tokens emitted to user.
     */
    expect(result.content).toBe("");
    expect(result.toolCalls).toBeUndefined();
    expect(tokens).toHaveLength(0);
  });

  it("tries fallback model when primary model fails with model error", async () => {
    /*
     * First call: primary model fails with model error.
     */
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "model not found",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: "assistant", content: "fallback response" },
        }),
        text: async () => "",
      });

    const provider = new OllamaProvider(
      "primary-model",
      "http://127.0.0.1:11434",
      false,
      "fallback-model",
    );

    const result = await provider.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("fallback response");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not try fallback for network errors", async () => {
    fetchSpy.mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    const provider = new OllamaProvider(
      "primary-model",
      "http://127.0.0.1:11434",
      false,
      "fallback-model",
    );

    await expect(
      provider.generate({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow();

    /*
     * Only one fetch call — no fallback for network errors.
     */
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when both primary and fallback fail", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "model not found",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "fallback model not found",
      });

    const provider = new OllamaProvider(
      "primary-model",
      "http://127.0.0.1:11434",
      false,
      "fallback-model",
    );

    await expect(
      provider.generate({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Both primary model");
  });

    it("throws circuit breaker message when circuit is open", async () => {
    /*
     * Use a provider with very low threshold.
     * Trigger 3 failures to open the circuit.
     */
    const provider = new OllamaProvider("test-model");

    /*
     * Access the private circuit breaker and
     * force it open by recording failures.
     */
    const cb = (provider as unknown as {
      circuitBreaker: { recordFailure: () => void; };
    }).circuitBreaker;

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    /*
     * Now generate should fail immediately
     * without calling fetch.
     */
    await expect(
      provider.generate({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Ollama is not responding");

    /*
     * fetch should NOT have been called —
     * circuit breaker blocked the request.
     */
    expect(fetchSpy).not.toHaveBeenCalled();
  });

});