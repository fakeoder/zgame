/** 信令消息（HTTP 轮询，落 D1 signals 表）。 */
export type SignalMessage =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateLike }
  | { kind: "bye"; reason: string };

export interface RTCIceCandidateLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (typeof value !== "object" || value === null) return false;
  const k = (value as { kind?: unknown }).kind;
  return k === "offer" || k === "answer" || k === "ice" || k === "bye";
}
