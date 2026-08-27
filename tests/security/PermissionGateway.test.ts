import { describe, expect, it, vi } from "vitest";

import { Permission } from "../../src/permissions/Permission.js";
import { PermissionGateway } from "../../src/security/PermissionGateway.js";
import type {
  PermissionManager,
  PermissionRequest,
} from "../../src/permissions/PermissionManager.js";
import { SecurityPolicy } from "../../src/security/SecurityPolicy.js";
import { WorkspaceManager } from "../../src/workspace/WorkspaceManager.js";

describe("PermissionGateway", () => {
  const workspaceRoot = "G:\\siva\\projects\\private_ai";

  function createGateway(permissionResult = true) {
    const permissionManager: PermissionManager = {
      check: vi.fn(async (_request: PermissionRequest) => permissionResult),
    };

    const workspaceManager = new WorkspaceManager(workspaceRoot);

    const securityPolicy = new SecurityPolicy(workspaceRoot);

    const gateway = new PermissionGateway(
      securityPolicy,
      permissionManager,
      workspaceManager,
    );

    return {
      gateway,
      permissionManager,
      workspaceManager,
    };
  }

  it("allows an approved read inside the workspace", async () => {
    const { gateway, permissionManager } = createGateway(true);

    const result = await gateway.authorize({
      permission: Permission.READ_FILE,
      target: "package.json",
      reason: "Read project metadata.",
    });

    expect(result).toBe(true);

    expect(permissionManager.check).toHaveBeenCalledOnce();

    expect(permissionManager.check).toHaveBeenCalledWith({
      permission: Permission.READ_FILE,
      target: "package.json",
      reason: "Read project metadata.",
    });
  });

  it("denies a filesystem permission without a target", async () => {
    const { gateway, permissionManager } = createGateway(true);

    const result = await gateway.authorize({
      permission: Permission.READ_FILE,
      reason: "Read a file.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).not.toHaveBeenCalled();
  });

  it("denies parent traversal before permission approval", async () => {
    const { gateway, permissionManager } = createGateway(true);

    const result = await gateway.authorize({
      permission: Permission.READ_FILE,
      target: "..\\outside.txt",
      reason: "Read outside workspace.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).not.toHaveBeenCalled();
  });

  it("denies an absolute path outside the workspace before permission approval", async () => {
    const { gateway, permissionManager } = createGateway(true);

    const result = await gateway.authorize({
      permission: Permission.READ_FILE,
      target: "C:\\Windows\\System32\\config\\SAM",
      reason: "Read system file.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).not.toHaveBeenCalled();
  });

  it("denies a read when the real path escapes the workspace", async () => {
    const { gateway, permissionManager, workspaceManager } =
      createGateway(true);

    vi.spyOn(workspaceManager, "isRealPathAllowed").mockResolvedValue(false);

    const result = await gateway.authorize({
      permission: Permission.READ_FILE,
      target: "linked\\secret.txt",
      reason: "Read linked file.",
    });

    expect(result).toBe(false);

    expect(workspaceManager.isRealPathAllowed).toHaveBeenCalledWith(
      "linked\\secret.txt",
    );

    expect(permissionManager.check).not.toHaveBeenCalled();
  });

  it("denies a delete when the real path escapes the workspace", async () => {
    const { gateway, permissionManager, workspaceManager } =
      createGateway(true);

    vi.spyOn(workspaceManager, "isRealPathAllowed").mockResolvedValue(false);

    const result = await gateway.authorize({
      permission: Permission.DELETE_FILE,
      target: "linked\\secret.txt",
      reason: "Delete linked file.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).not.toHaveBeenCalled();
  });

  it("does not bypass the permission manager for a valid read", async () => {
    const { gateway, permissionManager } = createGateway(false);

    const result = await gateway.authorize({
      permission: Permission.READ_FILE,
      target: "package.json",
      reason: "Read project metadata.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).toHaveBeenCalledOnce();
  });

  it("requires permission approval for write operations", async () => {
    const { gateway, permissionManager } = createGateway(false);

    const result = await gateway.authorize({
      permission: Permission.WRITE_FILE,
      target: "output.txt",
      reason: "Create output.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).toHaveBeenCalledOnce();
  });

  it("requires permission approval for command execution", async () => {
    const { gateway, permissionManager } = createGateway(false);

    const result = await gateway.authorize({
      permission: Permission.RUN_COMMAND,
      reason: "Run a build command.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).toHaveBeenCalledOnce();
  });

  it("requires permission approval for git operations", async () => {
    const { gateway, permissionManager } = createGateway(false);

    const result = await gateway.authorize({
      permission: Permission.GIT_OPERATION,
      reason: "Perform git operation.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).toHaveBeenCalledOnce();
  });

  it("requires permission approval for web access", async () => {
    const { gateway, permissionManager } = createGateway(false);

    const result = await gateway.authorize({
      permission: Permission.WEB_ACCESS,
      reason: "Access the web.",
    });

    expect(result).toBe(false);

    expect(permissionManager.check).toHaveBeenCalledOnce();
  });

  it("denies a write when the real parent path escapes the workspace", async () => {
    const { gateway, permissionManager, workspaceManager } =
      createGateway(true);

    vi.spyOn(workspaceManager, "isRealPathAllowed").mockResolvedValue(false);

    const result = await gateway.authorize({
      permission: Permission.WRITE_FILE,
      target: "linked\\new-file.txt",
      reason: "Write through linked directory.",
    });

    expect(result).toBe(false);

    expect(workspaceManager.isRealPathAllowed).toHaveBeenCalledWith(
      "linked\\new-file.txt",
    );

    expect(permissionManager.check).not.toHaveBeenCalled();
  });
});
