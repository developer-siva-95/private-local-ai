import type { Tool, ToolInput } from "./Tool.js";

/*
 * Maximum characters allowed per string argument.
 * Prevents runaway LLM generation from creating
 * enormous tool call arguments that consume memory.
 */
const MAX_ARG_CHARS = 100_000;

export interface ToolValidationResult {
  valid: boolean;
  error?: string;
}

export class ToolInputValidator {
  validate(
    tool: Tool,
    input: ToolInput,
  ): ToolValidationResult {
    const schema = tool.inputSchema;

    if (!input || typeof input !== "object") {
      return {
        valid: false,
        error: "Tool input must be an object.",
      };
    }

    for (const requiredField of schema.required ?? []) {
      if (!(requiredField in input)) {
        return {
          valid: false,
          error: `Missing required field: ${requiredField}`,
        };
      }
    }

    for (const [propertyName, propertySchema] of Object.entries(
      schema.properties,
    )) {
      if (!(propertyName in input)) {
        continue;
      }

      const value = input[propertyName];

      if (
        propertySchema.type === "string" &&
        typeof value !== "string"
      ) {
        return {
          valid: false,
          error: `Field "${propertyName}" must be a string.`,
        };
      }

      /*
       * Argument size limit.
       * Applies to all string fields.
       * Prevents LLM from generating enormous arguments.
       */
      if (
        typeof value === "string" &&
        value.length > MAX_ARG_CHARS
      ) {
        return {
          valid: false,
          error:
            `Field "${propertyName}" exceeds maximum ` +
            `length of ${MAX_ARG_CHARS} characters ` +
            `(got ${value.length}).`,
        };
      }
    }

    return { valid: true };
  }
}