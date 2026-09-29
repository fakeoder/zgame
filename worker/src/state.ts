import type { RoomStatus } from "@zgame/protocol";

/** 房间状态机（设计文档 §6/§7）。状态迁移只由 Worker 执行。 */
const ALLOWED: Record<RoomStatus, readonly RoomStatus[]> = {
  CREATED: ["WAITING", "CLOSED"],
  WAITING: ["PLAYING", "PAUSED", "CLOSED", "HOST_LOST", "EXPIRED"],
  PLAYING: ["PAUSED", "HOST_LOST", "CLOSED"],
  PAUSED: ["PLAYING", "HOST_LOST", "CLOSED"],
  HOST_LOST: ["WAITING", "PLAYING", "PAUSED", "EXPIRED", "CLOSED"],
  CLOSED: [],
  EXPIRED: [],
};

export function canTransition(from: RoomStatus, to: RoomStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

export const TERMINAL_STATUSES: readonly RoomStatus[] = ["CLOSED", "EXPIRED"];

export function isTerminal(status: RoomStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface LivenessConfig {
  /** 心跳超时 → HOST_LOST（技术方案 §5.3：3 × 15s = 45s）。 */
  hostLossTimeoutMs: number;
  /** 房间过期时长（开放问题 O4 暂定 30min）。 */
  roomTtlMs: number;
}

export interface LivenessInput {
  status: RoomStatus;
  lastHeartbeat: number | null;
  now: number;
}

/**
 * 由「最后心跳」推导应处于的状态。Worker 每次读写房间时惰性判定，
 * 不依赖定时器（D1 免费版无 Triggers 也成立）。
 */
export function resolveLiveness(input: LivenessInput, cfg: LivenessConfig): RoomStatus {
  const { status, lastHeartbeat, now } = input;
  if (isTerminal(status)) return status;
  if (status === "CREATED") return status;
  if (lastHeartbeat === null) return status;

  const elapsed = now - lastHeartbeat;
  if (elapsed > cfg.roomTtlMs) return "EXPIRED";
  if (elapsed > cfg.hostLossTimeoutMs) return "HOST_LOST";
  return status;
}

/** 从 HOST_LOST 恢复到的心跳正常状态。 */
export function resumeStatus(resume: string | null | undefined): RoomStatus {
  if (resume === "PLAYING" || resume === "PAUSED" || resume === "WAITING" || resume === "CREATED") {
    return resume;
  }
  return "WAITING";
}
