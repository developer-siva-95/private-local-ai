import * as readline from "node:readline";
import path from "node:path";
import type { ApprovalController } from "../permissions/ApprovalController.js";
import type { ApprovalRequest } from "../permissions/ApprovalRequest.js";

export class ConsoleApprovalHandler {
  private readonly rl: readline.Interface;
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(
    private readonly controller: ApprovalController,
    private readonly workspaceRoot: string,
    /*
     * Accept an external readline interface.
     * This allows sharing stdin with InteractiveLoop.
     * If not provided, creates its own.
     */
    rl?: readline.Interface,
  ) {
    this.rl =
      rl ??
      readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

    this.rl.on("close", () => {
      this.stop();
    });
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.pollInterval = setInterval(() => {
      void this.processPending();
    }, 100);
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollInterval !== undefined) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  private async processPending(): Promise<void> {
    const pending = this.controller.getPending();
    for (const request of pending) {
      if (this.pollInterval !== undefined) {
        clearInterval(this.pollInterval);
        this.pollInterval = undefined;
      }
      await this.promptUser(request);
      if (this.isRunning) {
        this.pollInterval = setInterval(() => {
          void this.processPending();
        }, 100);
      }
    }
  }

  private formatPermission(
    permission: string,
  ): string {
    switch (permission) {
      case "read_file":
        return "READ FILE";
      case "write_file":
        return "WRITE FILE";
      case "delete_file":
        return "DELETE FILE ⚠️";
      case "run_command":
        return "RUN COMMAND ⚠️";
      case "git_operation":
        return "GIT OPERATION";
      case "web_access":
        return "WEB ACCESS";
      default:
        return permission.toUpperCase();
    }
  }

  private formatTarget(
    target: string | undefined,
    permission: string,
  ): { label: string; value: string } {
    if (!target) {
      return { label: "Target  ", value: "N/A" };
    }

    if (
      permission === "run_command" ||
      permission === "git_operation" ||
      permission === "web_access"
    ) {
      return { label: "Command ", value: target };
    }

    const fullPath = path.resolve(
      this.workspaceRoot,
      target,
    );

    return { label: "Full Path", value: fullPath };
  }

  private promptUser(
    request: ApprovalRequest,
  ): Promise<void> {
    return new Promise((resolve) => {
      const permission = this.formatPermission(
        request.permission,
      );

      const { label, value } = this.formatTarget(
        request.target,
        request.permission,
      );

      console.log("\n");
      console.log(
        "╔══════════════════════════════════════════════════╗",
      );
      console.log(
        "║        ⚠️  AGENT PERMISSION REQUEST  ⚠️           ║",
      );
      console.log(
        "╠══════════════════════════════════════════════════╣",
      );
      console.log(
        `║  Operation  : ${permission.padEnd(36)}║`,
      );
      console.log(
        `║  Workspace  : ${this.workspaceRoot.slice(0, 36).padEnd(36)}║`,
      );
      console.log(
        "╠══════════════════════════════════════════════════╣",
      );
      console.log(
        `║  ${label}  :                                    ║`,
      );

      const chunkSize = 50;
      for (
        let i = 0;
        i < value.length;
        i += chunkSize
      ) {
        console.log(
          `║  ${value
            .slice(i, i + chunkSize)
            .padEnd(chunkSize)}║`,
        );
      }

      console.log(
        "╠══════════════════════════════════════════════════╣",
      );
      console.log(
        `║  Reason     :                                    ║`,
      );

      const reason = request.reason;
      for (
        let i = 0;
        i < reason.length;
        i += chunkSize
      ) {
        console.log(
          `║  ${reason
            .slice(i, i + chunkSize)
            .padEnd(chunkSize)}║`,
        );
      }

      console.log(
        "╠══════════════════════════════════════════════════╣",
      );
      console.log(
        "║  Type 'yes' to ALLOW or anything else to DENY   ║",
      );
      console.log(
        "╚══════════════════════════════════════════════════╝",
      );

      this.rl.question(
        "\n  Decision (yes/no): ",
        (answer) => {
          const normalised = answer
            .trim()
            .toLowerCase();

          if (normalised === "yes") {
            const approved =
              this.controller.approve(request.id);
            if (approved) {
              console.log(
                "\n  ✓ APPROVED — Operation will proceed.\n",
              );
            }
          } else {
            const denied =
              this.controller.deny(request.id);
            if (denied) {
              console.log(
                "\n  ✗ DENIED — Operation blocked.\n",
              );
            }
          }

          resolve();
        },
      );
    });
  }
}