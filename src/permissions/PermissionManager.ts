import { Permission } from "./Permission.js";

export interface PermissionRequest {
  permission: Permission;
  reason: string;
  target?: string;
}

export interface PermissionManager {
  check(request: PermissionRequest): Promise<boolean>;
}