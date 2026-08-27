export type ToolOperation =
  | "read"
  | "write"
  | "delete"
  | "execute"
  | "search";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}