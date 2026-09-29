/** 房间状态（设计文档 §6/§7）。 */
export const ROOM_STATUSES = [
  "CREATED",
  "WAITING",
  "PLAYING",
  "PAUSED",
  "HOST_LOST",
  "CLOSED",
  "EXPIRED",
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_MODES = ["nearby", "remote"] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

export const ROOM_PROFILES = ["host", "player", "controller"] as const;
export type RoomProfile = (typeof ROOM_PROFILES)[number];

export type Role = "host" | "player";

export interface RoomSnapshot {
  roomId: string;
  gameId: string;
  status: RoomStatus;
  mode: RoomMode;
  hostId: string;
  playerCount: number;
  createdAt: number;
  updatedAt: number;
  lastHeartbeat: number | null;
}

export interface PlayerSnapshot {
  id: string;
  nickname: string | null;
  role: Role;
  profile: RoomProfile;
  joinedAt: number;
}

/** GET /api/rooms/:id/sync 返回体。 */
export interface SyncResponse {
  status: RoomStatus;
  /** 本次返回的 signals 起游标（下轮 after）。 */
  since: number;
  players: PlayerSnapshot[];
  signals: SyncedSignal[];
}

export interface SyncedSignal {
  id: number;
  fromRole: Role;
  message: unknown;
}
