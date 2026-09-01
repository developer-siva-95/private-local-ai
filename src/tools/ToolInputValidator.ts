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

    if (!input || typeof input !== "object" || Array.isArray(input)) {
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
        /*
         * Allow boolean values for "recursive" parameter in list_directory.
         * LLMs (like Gemma) frequently emit native JSON booleans (e.g. recursive: true)
         * for flags even when the schema declares string.
         */
        if (typeof value === "boolean" && propertyName === "recursive") {
          input[propertyName] = String(value);
        } else {
          return {
            valid: false,
            error: `Field "${propertyName}" must be a string.`,
          };
        }
      }

      const finalValue = input[propertyName];

      /*
       * Argument size limit.
       * Applies to all string fields.
       * Prevents LLM from generating enormous arguments.
       */
      if (
        typeof finalValue === "string" &&
        finalValue.length > MAX_ARG_CHARS
      ) {
        return {
          valid: false,
          error:
            `Field "${propertyName}" exceeds maximum ` +
            `length of ${MAX_ARG_CHARS} characters ` +
            `(got ${finalValue.length}).`,
        };
      }
    }

    return { valid: true };
  }
}