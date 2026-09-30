import type { RoomMode, RoomProfile, RoomStatus } from "@zgame/protocol";

export type SessionRole = "host" | "player";

export interface RoomSession {
  roomId: string;
  /** hostToken 或 playerToken。 */
  token: string;
  role: SessionRole;
  profile: RoomProfile;
  gameId: string;
  mode: RoomMode;
  nickname?: string;
  joinUrl?: string;
  createdAt: number;
}

const DEVICE_ID_KEY = "zgame.deviceId";
const SESSION_PREFIX = "zgame.session.";

export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function sessionKey(roomId: string): string {
  return `${SESSION_PREFIX}${roomId}`;
}

export function saveSession(s: RoomSession): void {
  localStorage.setItem(sessionKey(s.roomId), JSON.stringify(s));
}

export function loadSession(roomId: string): RoomSession | null {
  const raw = localStorage.getItem(sessionKey(roomId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RoomSession;
    if (parsed.roomId !== roomId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(roomId: string): void {
  localStorage.removeItem(sessionKey(roomId));
}

/** 扫码落地：`A8F3K9-<joinToken>` → roomId + token。 */
export function parseJoinCode(code: string): { roomId: string; token: string } | null {
  let parsed = splitJoinCode(code);
  // 兼容旧版本把 roomId 拼两次的链接：`A8F3K9-A8F3K9-<token>` → 剥掉重复前缀
  for (let i = 0; i < 2 && parsed && parsed.token.startsWith(`${parsed.roomId}-`); i++) {
    parsed = splitJoinCode(parsed.token);
  }
  return parsed;
}

function splitJoinCode(code: string): { roomId: string; token: string } | null {
  const idx = code.indexOf("-");
  if (idx <= 0 || idx === code.length - 1) return null;
  const roomId = code.slice(0, idx);
  const token = code.slice(idx + 1);
  if (!/^[A-Z0-9]{4,12}$/.test(roomId) || token.length < 8) return null;
  return { roomId, token };
}

export function joinPath(roomId: string, joinToken: string): string {
  return `/join/${roomId}-${joinToken}`;
}

/**
 * 会话里存的 joinUrl → 当前站点的规范邀请链接。
 * 旧版本存过 roomId 拼两次或跨源的 URL，这里统一修复；无法还原合法 join code 时返回 null。
 */
export function inviteUrl(
  source: { roomId: string; joinUrl?: string },
  origin: string,
): string | null {
  const raw = source.joinUrl ?? "";
  const idx = raw.indexOf("/join/");
  if (idx < 0) return null;
  const parsed = parseJoinCode(raw.slice(idx + "/join/".length));
  if (!parsed || parsed.roomId !== source.roomId) return null;
  return `${origin}${joinPath(parsed.roomId, parsed.token)}`;
}

export interface RoomUiState {
  status: RoomStatus;
  text: string;
  tone: "ok" | "warn" | "bad" | "idle";
}

export function statusLabel(status: RoomStatus): RoomUiState {
  switch (status) {
    case "CREATED":
      return { status, text: "已创建", tone: "idle" };
    case "WAITING":
      return { status, text: "等待玩家", tone: "warn" };
    case "PLAYING":
      return { status, text: "游戏中", tone: "ok" };
    case "PAUSED":
      return { status, text: "已暂停", tone: "warn" };
    case "HOST_LOST":
      return { status, text: "房主断线", tone: "bad" };
    case "CLOSED":
      return { status, text: "已关闭", tone: "bad" };
    case "EXPIRED":
      return { status, text: "已过期", tone: "bad" };
    default:
      return { status, text: status, tone: "idle" };
  }
}
