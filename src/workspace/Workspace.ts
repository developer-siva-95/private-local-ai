export interface Workspace {
  readonly root: string;

  isPathAllowed(targetPath: string): boolean;
}