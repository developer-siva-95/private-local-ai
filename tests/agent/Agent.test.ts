import { describe, expect, it, vi } from "vitest";

import { Agent } from "../../src/agent/Agent.js";
import { Permission } from "../../src/permissions/Permission.js";

import type { LLMProvider, LLMResponse } from "../../src/llm/LLMProvider.js";

import type { Tool, ToolResult } from "../../src/tools/Tool.js";

import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

import type { ToolExecutionGateway } from "../../src/tools/ToolExecutionGateway.js";

const workspaceRoot = "G:\\siva\\projects";

/*
 * Every test tool must declare its permission
 * using the Permission enum — never a raw string.
 *
 * This is a hard architectural requirement:
 * the tool declares its own permission.
 */
function createTool(execute: Tool["execute"]): Tool {
  return {
    name: "read_file",
    description: "Read the contents of a file.",
    permission: Permission.READ_FILE,
    retryable: true,
    inputSchema:  {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file to read.",
        },
      },
      required: ["path"],
    },
    execute,
  };
}

function createAgent(
  provider: LLMProvider,
  tool: Tool,
  executeGateway: ToolExecutionGateway,
): Agent {
  const registry = new ToolRegistry();

  registry.register(tool);

  return new Agent(provider, registry, executeGateway);
}

describe("Agent", () => {
  it("returns a final response when no tool call is requested", async () => {
    const provider: LLMProvider = {
      generate: vi.fn(
        async (): Promise<LLMResponse> => ({
          content: "Hello",
        }),
      ),
    };

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run({ message: "Hello" }, { workspaceRoot });

    expect(result).toEqual({
      success: true,
      content: "Hello",
    });

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(executeGateway.execute).not.toHaveBeenCalled();
  });

  it("executes a tool through the execution gateway and then returns the final LLM response", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            name: "read_file",
            arguments: {
              path: "private_ai/package.json",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "The package is private-ai version 1.0.0.",
      });

    const provider: LLMProvider = { generate };

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: '{"name":"private-ai","version":"1.0.0"}',
      }),
    );

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(async (): Promise<ToolResult> => execute()),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Read package.json" },
      { workspaceRoot },
    );

    expect(result).toEqual({
      success: true,
      content: "The package is private-ai version 1.0.0.",
    });

    expect(executeGateway.execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("supports multiple tool iterations", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            name: "read_file",
            arguments: { path: "first.txt" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            name: "read_file",
            arguments: { path: "second.txt" },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "Both files were read.",
      });

    const provider: LLMProvider = { generate };

    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        output: "first file",
      })
      .mockResolvedValueOnce({
        success: true,
        output: "second file",
      });

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(async (): Promise<ToolResult> => execute()),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Read both files." },
      { workspaceRoot },
    );

    expect(result).toEqual({
      success: true,
      content: "Both files were read.",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(executeGateway.execute).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("returns an error when the tool is unknown", async () => {
    const provider: LLMProvider = {
      generate: vi.fn(
        async (): Promise<LLMResponse> => ({
          content: "",
          toolCalls: [
            {
              name: "unknown_tool",
              arguments: {},
            },
          ],
        }),
      ),
    };

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Use the unknown tool." },
      { workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown tool: unknown_tool");
    expect(executeGateway.execute).not.toHaveBeenCalled();
  });

  it("propagates tool execution failure to LLM for explanation", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            name: "read_file",
            arguments: {
              path: "private_ai/package.json",
            },
          },
        ],
      })
      /*
       * After receiving the tool failure message,
       * the LLM produces a final plain text answer
       * explaining the failure to the user.
       */
      .mockResolvedValueOnce({
        content: "The file could not be read. Please check if it exists.",
      });

    const provider: LLMProvider = { generate };

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(
        async (): Promise<ToolResult> => ({
          success: false,
          output: "",
          error: "Tool execution failed.",
        }),
      ),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Read the file." },
      { workspaceRoot },
    );

    /*
     * Agent passes failure to LLM.
     * LLM explains it to user.
     * Agent returns success: true with explanation.
     */
    expect(result.success).toBe(true);
    expect(result.content).toContain("could not be read");

    expect(executeGateway.execute).toHaveBeenCalledTimes(1);

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects execution when permission is denied", async () => {
    const provider: LLMProvider = {
      generate: vi.fn(
        async (): Promise<LLMResponse> => ({
          content: "",
          toolCalls: [
            {
              name: "read_file",
              arguments: {
                path: "private_ai/package.json",
              },
            },
          ],
        }),
      ),
    };

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: "should not execute",
      }),
    );

    const tool = createTool(execute);

    const executeGateway = {
      execute: vi.fn(
        async (): Promise<ToolResult> => ({
          success: false,
          output: "",
          error: "Permission denied.",
        }),
      ),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Read the file." },
      { workspaceRoot },
    );

    expect(result).toEqual({
      success: false,
      content: "",
      error: "Permission denied.",
    });

    expect(executeGateway.execute).toHaveBeenCalledTimes(1);

    /*
     * Tool.execute() must not have been called.
     * Only the gateway mock was called — which
     * returned denied without calling the real tool.
     */
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects invalid tool arguments before execution", async () => {
    const generate = vi.fn().mockResolvedValueOnce({
      content: "",
      toolCalls: [
        {
          name: "read_file",
          arguments: { path: 123 },
        },
      ],
    });

    const provider: LLMProvider = { generate };

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: "should not execute",
      }),
    );

    const tool = createTool(execute);

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Read the file." },
      { workspaceRoot },
    );

    expect(result).toEqual({
      success: false,
      content: "",
      error: 'Field "path" must be a string.',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(executeGateway.execute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("maintains conversation history across turns", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: "The answer is 42.",
      })
      .mockResolvedValueOnce({
        content: "Yes I said the answer is 42.",
      });

    const provider: LLMProvider = { generate };

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    /*
     * First turn.
     */
    await agent.run({ message: "What is the answer?" }, { workspaceRoot });

    /*
     * Second turn — refers to previous context.
     */
    const result = await agent.run(
      { message: "Are you sure about that?" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);

    /*
     * Second call must include conversation history.
     * messages = system + user1 + assistant1 + user2
     *          = 4 messages minimum
     */
    const secondCallMessages =
      vi.mocked(generate).mock.calls[1]?.[0].messages ?? [];

    expect(secondCallMessages.length).toBeGreaterThanOrEqual(4);
  });

  it("clears history when clearHistory is called", async () => {
    const generate = vi.fn().mockResolvedValue({
      content: "Fresh response.",
    });

    const provider: LLMProvider = { generate };

    const tool = createTool(
      vi.fn(
        async (): Promise<ToolResult> => ({
          success: true,
          output: "unused",
        }),
      ),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    /*
     * First turn adds to history.
     */
    await agent.run({ message: "First message." }, { workspaceRoot });

    expect(agent.getHistoryLength()).toBe(2);

    /*
     * Clear history.
     */
    agent.clearHistory();

    expect(agent.getHistoryLength()).toBe(0);

    /*
     * Second turn after clear.
     * Second generate call gets only system + user.
     */
    await agent.run(
      { message: "Second message after clear." },
      { workspaceRoot },
    );

    const secondCallMessages =
      vi.mocked(generate).mock.calls[1]?.[0].messages ?? [];

    /*
     * After clear: system + user2 = 2 messages only.
     * No history from first turn present.
     */
    expect(secondCallMessages.length).toBe(2);
  });

    it("returns no contextWarning when history is empty", async () => {
    const provider: LLMProvider = {
      generate: vi.fn(async (): Promise<LLMResponse> => ({
        content: "Hello",
      })),
    };

    const tool = createTool(
      vi.fn(async (): Promise<ToolResult> => ({
        success: true,
        output: "unused",
      })),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    const result = await agent.run(
      { message: "Hello" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.contextWarning).toBeUndefined();
  });

  it("returns contextWarning when history exceeds 70% of context window", async () => {
    const provider: LLMProvider = {
      generate: vi.fn(async (): Promise<LLMResponse> => ({
        content: "Response",
      })),
    };

    const tool = createTool(
      vi.fn(async (): Promise<ToolResult> => ({
        success: true,
        output: "unused",
      })),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    /*
     * Manually inject large history to simulate
     * approaching context window limit.
     *
     * 70% of 8192 = 5734 tokens = ~22936 chars
     * We inject 3 pairs of messages totalling
     * more than 22936 chars to trigger warning.
     *
     * Each message is ~4000 chars = ~1000 tokens.
     * 6 messages * 1000 tokens = 6000 tokens > 5734.
     */
    const largeContent = "x".repeat(8000);

    for (let i = 0; i < 3; i++) {
      agent["memory"].addTurn(largeContent, largeContent);
    }

    const result = await agent.run(
      { message: "Hello" },
      { workspaceRoot },
    );

    expect(result.success).toBe(true);
    expect(result.contextWarning).toBeDefined();
    expect(result.contextWarning).toContain("context window");
    expect(result.contextWarning).toContain("clear");
  });

  it("estimateHistoryTokens returns 0 for empty history", () => {
    const provider: LLMProvider = {
      generate: vi.fn(async (): Promise<LLMResponse> => ({
        content: "",
      })),
    };

    const tool = createTool(
      vi.fn(async (): Promise<ToolResult> => ({
        success: true,
        output: "unused",
      })),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    expect(agent.estimateHistoryTokens()).toBe(0);
  });

  it("estimateHistoryTokens counts chars divided by 4", () => {
    const provider: LLMProvider = {
      generate: vi.fn(async (): Promise<LLMResponse> => ({
        content: "",
      })),
    };

    const tool = createTool(
      vi.fn(async (): Promise<ToolResult> => ({
        success: true,
        output: "unused",
      })),
    );

    const executeGateway = {
      execute: vi.fn(),
    } as unknown as ToolExecutionGateway;

    const agent = createAgent(provider, tool, executeGateway);

    /*
     * Inject known content into history.
     * 400 chars / 4 = 100 tokens.
     */
    agent["memory"].addTurn(
      "a".repeat(200),
      "b".repeat(200),
    );

    expect(agent.estimateHistoryTokens()).toBe(100);
  });

});
