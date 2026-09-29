import type { RoomMode, RoomProfile, RoomSnapshot } from "./room.js";

/** 游戏 Manifest（技术方案 §6.1）。未知字段解析时忽略（前向兼容）。 */
export interface GameManifest {
  id: string;
  name: string;
  version: string;
  type: "html" | "emulator";
  players: number;
  controller: { type: string };
  multiplayer: { supported: boolean; sync: "input" | "none" };
  entry?: string;
  /** 权威逻辑帧率（每秒 tick 数）。 */
  tickRate: number;
  /** 输入延迟帧数。 */
  inputDelayFrames: number;
  /** 0 = 不校验状态哈希；>0 = 每 N 帧比对。 */
  stateHashInterval: number;
  engine?: string;
  core?: string;
  description?: string;
  icon?: string;
}

export type RawManifest = Record<string, unknown>;

export function parseManifest(raw: unknown): GameManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as RawManifest;
  const id = o["id"];
  const name = o["name"];
  const players = o["players"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof players !== "number" || !Number.isFinite(players)) return null;

  const type = o["type"] === "emulator" ? "emulator" : "html";
  const multiplayerRaw = o["multiplayer"];
  const multiplayer =
    typeof multiplayerRaw === "object" && multiplayerRaw !== null
      ? (multiplayerRaw as RawManifest)
      : {};
  const sync = multiplayer["sync"] === "none" ? "none" : "input";

  const controllerRaw = o["controller"];
  const controllerType =
    typeof controllerRaw === "object" &&
    controllerRaw !== null &&
    typeof (controllerRaw as RawManifest)["type"] === "string"
      ? ((controllerRaw as RawManifest)["type"] as string)
      : "generic";

  return {
    id,
    name,
    version: typeof o["version"] === "string" ? o["version"] : "0.0.0",
    type,
    players,
    controller: { type: controllerType },
    multiplayer: {
      supported: multiplayerRaw === undefined ? false : multiplayer["supported"] !== false,
      sync,
    },
    entry: typeof o["entry"] === "string" ? o["entry"] : undefined,
    tickRate: typeof o["tickRate"] === "number" ? o["tickRate"] : 20,
    inputDelayFrames: typeof o["inputDelayFrames"] === "number" ? o["inputDelayFrames"] : 2,
    stateHashInterval:
      typeof o["stateHashInterval"] === "number" ? o["stateHashInterval"] : 0,
    engine: typeof o["engine"] === "string" ? o["engine"] : undefined,
    core: typeof o["core"] === "string" ? o["core"] : undefined,
    description: typeof o["description"] === "string" ? o["description"] : undefined,
    icon: typeof o["icon"] === "string" ? o["icon"] : undefined,
  };
}

/** API 请求/响应体。 */
export interface CreateRoomRequest {
  gameId: string;
  mode: RoomMode;
}

export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
  hostToken: string;
  expiresAt: number;
}

export type JoinProfile = RoomProfile;

export interface JoinRoomRequest {
  token: string;
  nickname?: string;
  profile?: JoinProfile;
}

export interface JoinRoomResponse {
  roomId: string;
  gameId: string;
  mode: RoomMode;
  status: RoomSnapshot["status"];
  /** 玩家自身 token，后续所有请求带它。 */
  playerToken: string;
  role: "player";
  profile: JoinProfile;
  /** Host 是否已在线（用于决定谁发起 offer）。 */
  hostOnline: boolean;
}

export interface HostSessionResponse {
  roomId: string;
  gameId: string;
  mode: RoomMode;
  status: RoomSnapshot["status"];
  hostToken: string;
}

export interface HeartbeatResponse {
  status: RoomSnapshot["status"];
  lastHeartbeat: number;
}
