import type { Tool } from "./Tool.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `A tool with the name "${tool.name}" is already registered.`
      );
    }

    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly Tool[] {
    return Array.from(this.tools.values());
  }
}