import type { ButtonState } from "./buttons.js";

/** 同步消息（设计文档 §21，第一阶段 InputSync）。 */
export type SyncMessage =
  | { v: 1; type: "input"; frame: number; player: 1 | 2; input: ButtonState }
  | { v: 1; type: "frame"; frame: number; seed: number }
  | { v: 1; type: "state"; frame: number; payload: string }
  | { v: 1; type: "hash"; frame: number; hash: string }
  | { v: 1; type: "control"; event: "pause" | "resume" | "end" | "resync" };

export type SyncMessageType = SyncMessage["type"];

export function isSyncMessage(value: unknown): value is SyncMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { v?: unknown; type?: unknown };
  if (m.v !== 1 || typeof m.type !== "string") return false;
  switch (m.type) {
    case "input":
    case "frame":
    case "state":
    case "hash":
    case "control":
      return true;
    default:
      return false;
  }
}
