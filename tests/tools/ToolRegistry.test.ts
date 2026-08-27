import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { Permission } from "../../src/permissions/Permission.js";
import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
} from "../../src/tools/Tool.js";

/*
 * Every test tool must include the required
 * `permission` field from the Tool interface.
 */
function createTestTool(name: string): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    permission: Permission.READ_FILE,
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute(
      _input: ToolInput,
      _context: ToolContext,
    ): Promise<ToolResult> {
      return {
        success: true,
        output: "test",
      };
    },
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const tool = createTestTool("test_tool");

    registry.register(tool);

    expect(registry.has("test_tool")).toBe(true);
    expect(registry.get("test_tool")).toBe(tool);
  });

  it("lists registered tools", () => {
    const registry = new ToolRegistry();

    const firstTool = createTestTool("first_tool");
    const secondTool = createTestTool("second_tool");

    registry.register(firstTool);
    registry.register(secondTool);

    expect(registry.list()).toEqual([
      firstTool,
      secondTool,
    ]);
  });

  it("returns false for an unregistered tool", () => {
    const registry = new ToolRegistry();

    expect(registry.has("missing_tool")).toBe(false);
    expect(registry.get("missing_tool")).toBeUndefined();
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();

    const firstTool = createTestTool("duplicate_tool");
    const secondTool = createTestTool("duplicate_tool");

    registry.register(firstTool);

    expect(() => {
      registry.register(secondTool);
    }).toThrow(
      'A tool with the name "duplicate_tool" is already registered.',
    );
  });
});