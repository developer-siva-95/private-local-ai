import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

import {
  ApprovalController,
} from "../../src/permissions/ApprovalController.js";

import {
  ConsoleApprovalHandler,
} from "../../src/approval/ConsoleApprovalHandler.js";

import { Permission } from "../../src/permissions/Permission.js";

describe("ConsoleApprovalHandler", () => {
  let controller: ApprovalController;
  let handler: ConsoleApprovalHandler;

  beforeEach(() => {
    controller = new ApprovalController(60_000);
    handler = new ConsoleApprovalHandler(
    controller,
    "G:\\siva\\projects\\private_ai",
  );;
  });

  afterEach(() => {
    handler.stop();
  });

  it("approves a pending request when user types yes", async () => {
    const questionMock = vi.fn(
      (
        _prompt: string,
        callback: (answer: string) => void,
      ) => {
        callback("yes");
      },
    );

    const rl = (handler as unknown as {
      rl: {
        question: typeof questionMock;
        close: () => void;
      };
    }).rl;

    rl.question = questionMock;

    const promise = controller.request({
      permission: Permission.READ_FILE,
      reason: "Test approval.",
      target: "package.json",
    });

    handler.start();

    const result = await promise;

    expect(result).toBe(true);
    expect(questionMock).toHaveBeenCalledOnce();
  });

  it("denies a pending request when user types no", async () => {
    const questionMock = vi.fn(
      (
        _prompt: string,
        callback: (answer: string) => void,
      ) => {
        callback("no");
      },
    );

    const rl = (handler as unknown as {
      rl: {
        question: typeof questionMock;
        close: () => void;
      };
    }).rl;

    rl.question = questionMock;

    const promise = controller.request({
      permission: Permission.READ_FILE,
      reason: "Test denial.",
      target: "package.json",
    });

    handler.start();

    const result = await promise;

    expect(result).toBe(false);
    expect(questionMock).toHaveBeenCalledOnce();
  });

  it("denies when user types anything other than yes", async () => {
    const questionMock = vi.fn(
      (
        _prompt: string,
        callback: (answer: string) => void,
      ) => {
        callback("maybe");
      },
    );

    const rl = (handler as unknown as {
      rl: {
        question: typeof questionMock;
        close: () => void;
      };
    }).rl;

    rl.question = questionMock;

    const promise = controller.request({
      permission: Permission.WRITE_FILE,
      reason: "Test invalid input.",
      target: "output.txt",
    });

    handler.start();

    const result = await promise;

    /*
     * Fail closed.
     * Anything other than "yes" must deny.
     */
    expect(result).toBe(false);
  });

  it("denies when user types empty string", async () => {
    const questionMock = vi.fn(
      (
        _prompt: string,
        callback: (answer: string) => void,
      ) => {
        callback("");
      },
    );

    const rl = (handler as unknown as {
      rl: {
        question: typeof questionMock;
        close: () => void;
      };
    }).rl;

    rl.question = questionMock;

    const promise = controller.request({
      permission: Permission.DELETE_FILE,
      reason: "Test empty input.",
      target: "file.txt",
    });

    handler.start();

    const result = await promise;

    expect(result).toBe(false);
  });

  it("does not start twice if start is called multiple times", () => {
    handler.start();
    handler.start();

    expect(() => handler.stop()).not.toThrow();
  });
});