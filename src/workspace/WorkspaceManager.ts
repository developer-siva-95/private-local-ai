import fs from "node:fs/promises";
import path from "node:path";

import type { Workspace } from "./Workspace.js";


export class WorkspaceManager
  implements Workspace
{
  readonly root: string;


  constructor(root: string) {
    this.root = path.resolve(root);
  }


  isPathAllowed(
    targetPath: string
  ): boolean {
    const resolvedTarget =
      path.resolve(
        this.root,
        targetPath
      );


    const relativePath =
      path.relative(
        this.root,
        resolvedTarget
      );


    return (
      relativePath === "" ||
      (
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
      )
    );
  }


  async isRealPathAllowed(
    targetPath: string
  ): Promise<boolean> {
    if (
      !this.isPathAllowed(targetPath)
    ) {
      return false;
    }


    const resolvedTarget =
      path.resolve(
        this.root,
        targetPath
      );


    try {
      const realRoot =
        await fs.realpath(
          this.root
        );


      /*
       * If the target exists, resolve it
       * directly.
       */
      try {
        const realTarget =
          await fs.realpath(
            resolvedTarget
          );


        return this.isRealPathInside(
          realRoot,
          realTarget
        );
      } catch {
        /*
         * The target does not exist.
         *
         * We must still verify the nearest
         * existing parent directory.
         *
         * This prevents a new file from
         * being created through a symlink,
         * junction, or other filesystem
         * redirection outside the workspace.
         */
      }


      let currentPath =
        resolvedTarget;


      while (
        currentPath !==
        path.dirname(currentPath)
      ) {
        try {
          const realParent =
            await fs.realpath(
              currentPath
            );


          return this.isRealPathInside(
            realRoot,
            realParent
          );
        } catch {
          currentPath =
            path.dirname(
              currentPath
            );
        }
      }


      return false;
    } catch {
      /*
       * Fail closed.
       */
      return false;
    }
  }


  private isRealPathInside(
    realRoot: string,
    realTarget: string
  ): boolean {
    const relativePath =
      path.relative(
        realRoot,
        realTarget
      );


    return (
      relativePath === "" ||
      (
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath)
      )
    );
  }
}