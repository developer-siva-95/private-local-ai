import { describe, expect, it } from "vitest";

import {
  ToolInputValidator,
} from "../../src/tools/ToolInputValidator.js";

import { Permission } from "../../src/permissions/Permission.js";
import type { Tool } from "../../src/tools/Tool.js";

/*
 * The tool must include all required Tool interface
 * fields, including `permission`.
 */
const tool: Tool = {
  name: "read_file",
  description: "Read the contents of a file.",
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
  async execute() {
    return {
      success: true,
      output: "",
    };
  },
};

describe("ToolInputValidator", () => {
  const validator = new ToolInputValidator();

  it("accepts valid input", () => {
    const result = validator.validate(tool, {
      path: "private_ai/package.json",
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejects missing required fields", () => {
    const result = validator.validate(tool, {});

    expect(result).toEqual({
      valid: false,
      error: "Missing required field: path",
    });
  });

  it("rejects incorrect field types", () => {
    const result = validator.validate(tool, {
      path: 123,
    });

    expect(result).toEqual({
      valid: false,
      error: 'Field "path" must be a string.',
    });
  });

  it("rejects non-object input", () => {
    const result = validator.validate(
      tool,
      null as never,
    );

    expect(result).toEqual({
      valid: false,
      error: "Tool input must be an object.",
    });
  });

  it("allows optional fields to be omitted", () => {
    const optionalTool: Tool = {
      ...tool,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          encoding: { type: "string" },
        },
        required: ["path"],
      },
    };

    const result = validator.validate(optionalTool, {
      path: "package.json",
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejects string argument exceeding 100000 characters", () => {
    const result = validator.validate(tool, {
      path: "x".repeat(100_001),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds maximum length");
  });

});