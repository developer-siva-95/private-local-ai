import { Permission } from "./Permission.js";

export interface ApprovalRequest {
  id: string;
  permission: Permission;
  reason: string;
  target?: string;
  createdAt: string;
}