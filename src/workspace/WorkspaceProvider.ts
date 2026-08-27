import path from "node:path";
import type { WorkspaceConfig } from "./WorkspaceConfig.js";

export class WorkspaceProvider {
  private readonly config: WorkspaceConfig;

  constructor(config: WorkspaceConfig) {
    this.config = {
      root: path.resolve(config.root),
    };
  }

  getRoot(): string {
    return this.config.root;
  }
}