import {
  Permission
} from "./Permission.js";

import type {
  PermissionManager,
  PermissionRequest
} from "./PermissionManager.js";

export class DefaultPermissionManager
  implements PermissionManager {

  async check(
    request: PermissionRequest
  ): Promise<boolean> {

    switch (request.permission) {
      case Permission.READ_FILE:
        return true;

      case Permission.WRITE_FILE:
      case Permission.DELETE_FILE:
      case Permission.RUN_COMMAND:
      case Permission.GIT_OPERATION:
      case Permission.WEB_ACCESS:
        return false;

      default:
        return false;
    }
  }
}