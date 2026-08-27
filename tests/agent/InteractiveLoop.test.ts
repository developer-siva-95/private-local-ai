import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { InteractiveLoop } from "../../src/agent/InteractiveLoop.js";

import { InputSanitizer } from "../../src/agent/InputSanitizer.js";

import type { Agent } from "../../src/agent/Agent.js";
import type * as readline from "node:readline";

/*
 * Create a mock readline interface that
 * resolves questions immediately with
 * pre-programmed answers.
 *
 * The key is that after all answers are
 * consumed, subsequent question() calls
 * resolve with "exit" to cleanly end the loop.
 */
function createMockRl(answers: string[]): readline.Interface {
  let callIndex = 0;
  const allAnswers = [...answers, "exit"];

  return {
    question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
      const answer = allAnswers[callIndex] ?? "exit";
      callIndex++;
      /*
       * Use setImmediate to simulate async
       * readline behavior without actual I/O.
       */
      setImmediate(() => callback(answer));
    }),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as readline.Interface;
}

function createMockAgent(
  response: {
    success: boolean;
    content: string;
    error?: string;
  } = {
    success: true,
    content: "Hello from agent",
  },
): Agent {
  return {
    run: vi.fn().mockResolvedValue(response),
    clearHistory: vi.fn(),
    getHistoryLength: vi.fn().mockReturnValue(0),
  } as unknown as Agent;
}

const workspaceRoot = "G:\\siva\\projects\\private_ai";

describe("InteractiveLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits cleanly on exit command", async () => {
    const rl = createMockRl([]);
    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await expect(loop.start()).resolves.toBeUndefined();
  });

  it("exits cleanly on quit command", async () => {
    const rl = createMockRl(["quit"]);
    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await expect(loop.start()).resolves.toBeUndefined();
  });

  it("sends valid input to agent", async () => {
    const rl = createMockRl(["Read package.json"]);

    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(agent.run).toHaveBeenCalledWith(
      {
        message: "Read package.json",
        onToken: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
      { workspaceRoot },
    );
  });

  it("sanitizes input before sending to agent", async () => {
    const sanitizeSpy = vi.spyOn(InputSanitizer, "sanitize");

    const rl = createMockRl(["Read package.json"]);

    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(sanitizeSpy).toHaveBeenCalledWith("Read package.json");
  });

  it("does not send empty input to agent", async () => {
    const rl = createMockRl([""]);
    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(agent.run).not.toHaveBeenCalled();
  });

  it("does not send whitespace-only input to agent", async () => {
    const rl = createMockRl(["   "]);
    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(agent.run).not.toHaveBeenCalled();
  });

  it("handles multiple messages in sequence", async () => {
    const rl = createMockRl(["First message", "Second message"]);

    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(agent.run).toHaveBeenCalledTimes(2);
  });

  it("does not retry on permission denied", async () => {
    const rl = createMockRl(["Delete everything"]);

    const agent = createMockAgent({
      success: false,
      content: "",
      error: "Permission denied.",
    });

    const loop = new InteractiveLoop(
      agent,
      {
        workspaceRoot,
        maxRetries: 3,
        retryDelayMs: 10,
      },
      rl,
    );

    await loop.start();

    /*
     * Permission denied must never be retried.
     * Agent called exactly once.
     */
    expect(agent.run).toHaveBeenCalledTimes(1);
  });

  it("retries on network error then succeeds", async () => {
    const rl = createMockRl(["Hello"]);

    const agent = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue({
          success: true,
          content: "Recovered successfully",
        }),
    } as unknown as Agent;

    const loop = new InteractiveLoop(
      agent,
      {
        workspaceRoot,
        maxRetries: 3,
        retryDelayMs: 10,
      },
      rl,
    );

    await loop.start();

    /*
     * First call throws, second succeeds.
     * Total: 2 calls for 1 message.
     */
    expect(agent.run).toHaveBeenCalledTimes(2);
  });

  it("fails after max retries exceeded", async () => {
    const rl = createMockRl(["Hello"]);

    const agent = {
      run: vi.fn().mockRejectedValue(new Error("Persistent network error")),
    } as unknown as Agent;

    const loop = new InteractiveLoop(
      agent,
      {
        workspaceRoot,
        maxRetries: 2,
        retryDelayMs: 10,
      },
      rl,
    );

    await loop.start();

    /*
     * maxRetries=2 means 2 attempts total.
     */
    expect(agent.run).toHaveBeenCalledTimes(2);
  });

  it("shows help without calling agent", async () => {
    const rl = createMockRl(["help"]);
    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(agent.run).not.toHaveBeenCalled();
  });

  it("clears history without calling agent", async () => {
    const rl = createMockRl(["clear"]);
    const agent = createMockAgent();

    const loop = new InteractiveLoop(agent, { workspaceRoot }, rl);

    await loop.start();

    expect(agent.run).not.toHaveBeenCalled();
  });
});
