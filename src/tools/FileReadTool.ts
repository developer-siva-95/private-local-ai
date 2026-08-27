import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
  ToolInputSchema,
} from "./Tool.js";
import { withTimeout } from "./ToolTimeout.js";
import { Permission } from "../permissions/Permission.js";
import type { RateLimiter } from "../security/RateLimiter.js";
import { contentScanner } from "../security/ContentScanner.js";

export class FileReadTool implements Tool {
  readonly name = "read_file";

  readonly description =
    "Read the contents of a file inside the " +
    "authorized workspace.";

  readonly permission = Permission.READ_FILE;

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path of the file to read.",
      },
    },
    required: ["path"],
  };

  readonly retryable = true;

  constructor(
    private readonly rateLimiter?: RateLimiter,
  ) {}

  async execute(
    input: ToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const filePath = input.path;

    if (
      typeof filePath !== "string" ||
      filePath.trim() === ""
    ) {
      return {
        success: false,
        output: "",
        error: "A valid file path is required.",
      };
    }

    const resolvedPath = path.resolve(
      context.workspaceRoot,
      filePath,
    );

    const relativePath = path.relative(
      context.workspaceRoot,
      resolvedPath,
    );

    const isInside =
      relativePath === "" ||
      (
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
      );

    if (!isInside) {
      return {
        success: false,
        output: "",
        error:
          "Security violation: " +
          "Path is outside the workspace.",
      };
    }

    try {
      if (this.rateLimiter !== undefined) {
        try {
          const fileStat = await stat(resolvedPath);
          this.rateLimiter.warnIfLarge(
            fileStat.size,
            filePath,
          );
        } catch {
          /* stat failed — readFile will catch it */
        }
      }

      const content = await withTimeout(
        readFile(resolvedPath, "utf8"),
        10_000,
        this.name,
      );

      /*
       * Scan file content for dangerous patterns.
       *
       * This runs AFTER the file is read (cannot
       * scan before reading). Warnings are prepended
       * to the output so the LLM and user see them.
       *
       * Only scan text files — binary content
       * would produce false positives.
       */
      const scanResult = contentScanner.scan(
        content,
        `file "${filePath}"`,
      );

      const warningPrefix = contentScanner.formatWarnings(
        scanResult.warnings,
      );

      return {
        success: true,
        output: warningPrefix + content,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error:
          error instanceof Error
            ? error.message
            : "Failed to read file.",
      };
    }
  }
}