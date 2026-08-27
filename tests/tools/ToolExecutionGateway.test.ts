import { describe, expect, it, vi } from "vitest";

import { ToolExecutionGateway } from "../../src/tools/ToolExecutionGateway.js";

import type {
  PermissionGateway,
  PermissionGatewayRequest,
} from "../../src/security/PermissionGateway.js";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
} from "../../src/tools/Tool.js";

import { Permission } from "../../src/permissions/Permission.js";

/*
 * ----------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------
 */

/*
 * Build a ToolExecutionGateway with a mocked PermissionGateway.
 *
 * The constructor takes exactly ONE argument: permissionGateway.
 *
 * ToolRegistry does NOT belong in ToolExecutionGateway.
 * The tool is passed directly in the ToolExecutionRequest.
 */
function createGateway(
  authorize: (request: PermissionGatewayRequest) => Promise<boolean>,
): ToolExecutionGateway {
  const permissionGateway = {
    authorize,
  } as unknown as PermissionGateway;

  return new ToolExecutionGateway(permissionGateway);
}

/*
 * Build a minimal Tool that:
 * - declares Permission.READ_FILE
 * - executes a provided mock function
 */
function createReadFileTool(execute: Tool["execute"]): Tool {
  return {
    name: "read_file",
    description: "Read the contents of a file inside the authorized workspace.",
    permission: Permission.READ_FILE,
    retryable: true,
    inputSchema: {
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

const testContext: ToolContext = {
  workspaceRoot: "G:\\siva\\projects",
};

const testInput: ToolInput = {
  path: "private_ai/package.json",
};

/*
 * ----------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------
 */

describe("ToolExecutionGateway", () => {
  /*
   * Test 1: authorize is called before execute
   */
  it("authorizes before executing the tool", async () => {
    const callOrder: string[] = [];

    const authorize = vi.fn(async (): Promise<boolean> => {
      callOrder.push("authorize");
      return true;
    });

    const execute = vi.fn(async (): Promise<ToolResult> => {
      callOrder.push("execute");
      return { success: true, output: "file contents" };
    });

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "AI requested a file read.",
    });

    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();

    /*
     * Authorization MUST happen first.
     * This is the core security invariant.
     */
    expect(callOrder).toEqual(["authorize", "execute"]);
  });

  /*
   * Test 2: permission is taken from tool.permission, not the caller
   */
  it("uses the permission declared by the tool", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: "file contents",
      }),
    );

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "AI requested a file read.",
    });

    expect(authorize).toHaveBeenCalledOnce();

    /*
     * The permission passed to authorize must be
     * exactly what the tool declared.
     *
     * The caller cannot supply a different permission.
     */
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: Permission.READ_FILE,
      }),
    );
  });

  /*
   * Test 3: filesystem path is extracted as the security target
   */
  it("extracts the filesystem path as the authorization target", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: "file contents",
      }),
    );

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    await gateway.execute({
      tool,
      input: { path: "private_ai/package.json" },
      context: testContext,
      reason: "AI requested a file read.",
    });

    /*
     * The authorization request must include
     * the path from the tool input as the target.
     *
     * This is what PermissionGateway uses to enforce
     * workspace boundary checks.
     */
    expect(authorize).toHaveBeenCalledWith({
      permission: Permission.READ_FILE,
      reason: "AI requested a file read.",
      target: "private_ai/package.json",
    });
  });

  /*
   * Test 4: tool is NOT executed when authorization is denied
   */
  it("does not execute the tool when authorization is denied", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => false);

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: "should never appear",
      }),
    );

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    const result = await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "AI requested a file read.",
    });

    /*
     * Authorization was denied.
     *
     * Tool.execute() MUST NOT have been called.
     * The result must be the standard denied response.
     */
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();

    expect(result).toEqual({
      success: false,
      output: "",
      error: "Permission denied.",
    });
  });

  /*
   * Test 5: original input and context are passed to the tool
   */
  it("passes the original input and context to the tool", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    const execute = vi.fn(
      async (input: ToolInput, context: ToolContext): Promise<ToolResult> => {
        expect(input).toEqual(testInput);
        expect(context).toEqual(testContext);
        return { success: true, output: "ok" };
      },
    );

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "AI requested a file read.",
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      testInput,
      expect.objectContaining({
        workspaceRoot: testContext.workspaceRoot,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  /*
   * Test 6: tool execution result is returned unchanged
   */
  it("propagates tool execution results", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    const expectedResult: ToolResult = {
      success: true,
      output: '{"name":"private_ai","version":"1.0.0"}',
    };

    const execute = vi.fn(async (): Promise<ToolResult> => expectedResult);

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    const result = await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "AI requested a file read.",
    });

    /*
     * The gateway must return the tool result
     * exactly as produced by Tool.execute().
     *
     * Nothing must be stripped or modified.
     */
    expect(result).toEqual(expectedResult);
  });

  /*
   * Test 7: caller cannot override tool.permission
   */
  it("does not allow the caller to choose a different permission", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: "file contents",
      }),
    );

    /*
     * This tool declares READ_FILE.
     *
     * Even if a malicious caller somehow tried to
     * pass WRITE_FILE or DELETE_FILE in the request,
     * the gateway must use tool.permission exclusively.
     *
     * The ToolExecutionRequest does not even contain
     * a permission field — this is intentional.
     */
    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "AI requested a file read.",
    });

    /*
     * The authorize call must use Permission.READ_FILE
     * as declared by the tool.
     *
     * It must NOT use Permission.WRITE_FILE or
     * Permission.DELETE_FILE.
     */
    expect(authorize).toHaveBeenCalledOnce();

    const authorizeCall = authorize.mock.calls[0]?.[0];

    expect(authorizeCall).toBeDefined();
    expect(authorizeCall!.permission).toBe(Permission.READ_FILE);
    expect(authorizeCall!.permission).not.toBe(Permission.WRITE_FILE);
    expect(authorizeCall!.permission).not.toBe(Permission.DELETE_FILE);
  });

  it("truncates large output with middle truncation", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    /*
     * Generate output larger than 8000 chars.
     */
    const largeOutput = "A".repeat(4000) + "B".repeat(4000) + "C".repeat(2000);

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: largeOutput,
      }),
    );

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    const result = await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "test",
    });

    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(largeOutput.length);
    expect(result.output).toContain("characters omitted");
    /*
     * Both start and end preserved.
     */
    expect(result.output.startsWith("AAAA")).toBe(true);
    expect(result.output.endsWith("CCCC")).toBe(true);
  });

  it("does not truncate output under 8000 chars", async () => {
    const authorize = vi.fn(async (): Promise<boolean> => true);

    const smallOutput = "Hello world";

    const execute = vi.fn(
      async (): Promise<ToolResult> => ({
        success: true,
        output: smallOutput,
      }),
    );

    const tool = createReadFileTool(execute);
    const gateway = createGateway(authorize);

    const result = await gateway.execute({
      tool,
      input: testInput,
      context: testContext,
      reason: "test",
    });

    expect(result.output).toBe(smallOutput);
  });
});
