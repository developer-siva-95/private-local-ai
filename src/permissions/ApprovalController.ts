import { randomUUID } from "node:crypto";

import type { PermissionRequest } from "./PermissionManager.js";
import type { ApprovalRequest } from "./ApprovalRequest.js";


interface PendingApproval {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}


export class ApprovalController {
  private readonly pending =
    new Map<string, PendingApproval>();


  constructor(
    private readonly timeoutMs = 5 * 60 * 1000
  ) {
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error(
        "Approval timeout must be a positive integer."
      );
    }
  }


  request(
    request: PermissionRequest
  ): Promise<boolean> {
    const id = randomUUID();


    const approvalRequest: ApprovalRequest = {
      id,
      permission: request.permission,
      reason: request.reason,
      createdAt: new Date().toISOString(),
    };


    if (request.target !== undefined) {
      approvalRequest.target =
        request.target;
    }


    return new Promise<boolean>((resolve) => {
      const timeout =
        setTimeout(() => {
          this.resolve(id, false);
        }, this.timeoutMs);


      this.pending.set(id, {
        request: approvalRequest,
        resolve,
        timeout,
      });


      console.log(
        "\nNew approval request:"
      );

      console.log(
        JSON.stringify(
          approvalRequest,
          null,
          2
        )
      );
    });
  }


  approve(id: string): boolean {
    return this.resolve(
      id,
      true
    );
  }


  deny(id: string): boolean {
    return this.resolve(
      id,
      false
    );
  }


  getPending(): ApprovalRequest[] {
    return Array.from(
      this.pending.values()
    ).map(
      (entry) => entry.request
    );
  }


  private resolve(
    id: string,
    approved: boolean
  ): boolean {
    const pending =
      this.pending.get(id);


    if (!pending) {
      return false;
    }


    this.pending.delete(id);


    clearTimeout(
      pending.timeout
    );


    pending.resolve(
      approved
    );


    return true;
  }
}