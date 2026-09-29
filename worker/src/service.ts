import {
  ApiError,
  apiErrorBody,
  isSignalMessage,
  parseJson,
  ROOM_STATUSES,
  type ErrorCode,
  type HeartbeatResponse,
  type HostSessionResponse,
  type JoinRoomResponse,
  type PlayerSnapshot,
  type RoomMode,
  type RoomProfile,
  type RoomSnapshot,
  type RoomStatus,
  type SyncResponse,
} from "@zgame/protocol";
import {
  buildJoinPath,
  generateRoomId,
  generateToken,
  hashToken,
} from "./tokens.js";
import { canTransition, resolveLiveness, resumeStatus, type LivenessConfig } from "./state.js";

export interface Env {
  DB: D1Database;
  PUBLIC_ORIGIN?: string;
  ROOM_TTL_MS?: string;
  HOST_LOSS_TIMEOUT_MS?: string;
}

interface RoomRow {
  id: string;
  game_id: string;
  host_id: string;
  status: string;
  mode: string;
  created_at: number;
  updated_at: number;
  last_heartbeat: number | null;
  resume_status: string | null;
}

interface PlayerRow {
  id: string;
  room_id: string;
  nickname: string | null;
  role: string;
  profile: string;
  joined_at: number;
  last_seen: number | null;
}

interface SessionRow {
  id: string;
  room_id: string;
  token_hash: string;
  role: string;
  expires_at: number;
  created_at: number;
}

interface SignalRow {
  id: number;
  from_role: string;
  payload: string;
  created_at: number;
}

export interface AuthContext {
  session: SessionRow;
  role: "host" | "player";
  profile: RoomProfile;
}

const ROOM_ID_RE = /^[A-Z0-9]{4,12}$/;
const SIGNAL_CLEANUP_AGE_MS = 5 * 60 * 1000;
const SYNC_PAGE_LIMIT = 50;

function cfg(env: Env): LivenessConfig {
  return {
    hostLossTimeoutMs: Number(env.HOST_LOSS_TIMEOUT_MS ?? 45_000),
    roomTtlMs: Number(env.ROOM_TTL_MS ?? 1_800_000),
  };
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorJson(code: ErrorCode, status: number, message?: string): Response {
  return json(apiErrorBody(code, message), status);
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  return parseJson(text) ?? {};
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

function isRoomStatus(v: unknown): v is RoomStatus {
  return typeof v === "string" && (ROOM_STATUSES as readonly string[]).includes(v);
}

function toSnapshot(row: RoomRow, playerCount: number): RoomSnapshot {
  return {
    roomId: row.id,
    gameId: row.game_id,
    status: row.status as RoomStatus,
    mode: row.mode as RoomMode,
    hostId: row.host_id,
    playerCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastHeartbeat: row.last_heartbeat,
  };
}

export class RoomService {
  #db: D1Database;
  #cfg: LivenessConfig;
  #origin: string;

  constructor(env: Env, requestUrl: string) {
    this.#db = env.DB;
    this.#cfg = cfg(env);
    this.#origin = (env.PUBLIC_ORIGIN || "").replace(/\/$/, "") || new URL(requestUrl).origin;
  }

  async #getRoomRaw(roomId: string): Promise<RoomRow | null> {
    const row = await this.#db
      .prepare("SELECT * FROM rooms WHERE id = ?")
      .bind(roomId)
      .first<RoomRow>();
    return row ?? null;
  }

  /** 读房间 + 惰性心跳判定，需要时落库。 */
  async #loadRoom(roomId: string): Promise<{ row: RoomRow; changed: boolean } | null> {
    const row = await this.#getRoomRaw(roomId);
    if (!row) return null;
    const now = Date.now();
    const next = resolveLiveness(
      { status: row.status as RoomStatus, lastHeartbeat: row.last_heartbeat, now },
      this.#cfg,
    );
    if (next === row.status) return { row, changed: false };

    const resume =
      next === "HOST_LOST" && row.status !== "HOST_LOST"
        ? row.status
        : next !== "HOST_LOST"
          ? row.resume_status
          : row.resume_status;
    await this.#db
      .prepare("UPDATE rooms SET status = ?, resume_status = ?, updated_at = ? WHERE id = ?")
      .bind(next, resume, now, roomId)
      .run();
    return { row: { ...row, status: next, updated_at: now, resume_status: resume }, changed: true };
  }

  async #countPlayers(roomId: string): Promise<number> {
    const row = await this.#db
      .prepare("SELECT COUNT(*) AS n FROM players WHERE room_id = ? AND role = 'player'")
      .bind(roomId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async #listPlayers(roomId: string): Promise<PlayerSnapshot[]> {
    const res = await this.#db
      .prepare("SELECT * FROM players WHERE room_id = ? ORDER BY joined_at ASC")
      .bind(roomId)
      .all<PlayerRow>();
    return (res.results ?? []).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      role: p.role === "host" ? "host" : "player",
      profile: (p.profile as RoomProfile) ?? "player",
      joinedAt: p.joined_at,
    }));
  }

  async auth(roomId: string, token: string | null): Promise<AuthContext> {
    if (!token) throw new ApiError("FORBIDDEN", 401, "missing token");
    const hash = await hashToken(token);
    const session = await this.#db
      .prepare("SELECT * FROM sessions WHERE room_id = ? AND token_hash = ?")
      .bind(roomId, hash)
      .first<SessionRow>();
    if (!session) throw new ApiError("FORBIDDEN", 403, "invalid token");
    if (session.expires_at <= Date.now()) throw new ApiError("EXPIRED", 403, "token expired");
    const role = session.role === "host" ? "host" : "player";
    const players = await this.#listPlayers(roomId);
    const profile = players.find((p) => p.id === session.id)?.profile ?? "player";
    return { session, role, profile };
  }

  async createRoom(hostId: string, gameId: string, mode: RoomMode): Promise<CreateRoomResult> {
    if (!gameId) throw new ApiError("BAD_REQUEST", 400, "gameId required");

    const now = Date.now();
    const hostToken = generateToken();
    const joinToken = generateToken();
    const hostSessionId = generateToken(16);
    const ttl = this.#cfg.roomTtlMs;

    // Room ID 极小概率冲突，重试一次
    let roomId = generateRoomId();
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.#getRoomRaw(roomId);
      const expired =
        !existing ||
        resolveLiveness(
          { status: existing.status as RoomStatus, lastHeartbeat: existing.last_heartbeat, now },
          this.#cfg,
        ) === "EXPIRED";
      if (expired) break;
      roomId = generateRoomId();
      if (attempt === 1) throw new ApiError("CONFLICT", 503, "room id collision");
    }

    const insert = this.#db.batch([
      this.#db
        .prepare(
          "INSERT INTO rooms (id, game_id, host_id, status, mode, created_at, updated_at, last_heartbeat, resume_status) VALUES (?, ?, ?, 'WAITING', ?, ?, ?, ?, NULL)",
        )
        .bind(roomId, gameId, hostId, mode, now, now, now),
      this.#db
        .prepare(
          "INSERT INTO players (id, room_id, nickname, role, profile, joined_at, last_seen) VALUES (?, ?, ?, 'host', 'host', ?, ?)",
        )
        .bind(hostSessionId, roomId, "房主", now, now),
      this.#db
        .prepare(
          "INSERT INTO sessions (id, room_id, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, 'host', ?, ?)",
        )
        .bind(hostSessionId, roomId, await hashToken(hostToken), now + ttl, now),
      this.#db
        .prepare(
          "INSERT INTO sessions (id, room_id, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, 'join', ?, ?)",
        )
        .bind(generateToken(16), roomId, await hashToken(joinToken), now + ttl, now),
    ]);
    await insert;

    return {
      roomId,
      joinUrl: `${this.#origin}${buildJoinPath(roomId, joinToken)}`,
      hostToken,
      hostSessionId,
      expiresAt: now + ttl,
    };
  }

  async joinRoom(
    roomId: string,
    token: string,
    nickname: string | null,
    profile: RoomProfile,
  ): Promise<{ response: JoinRoomResponse; playerToken: string }> {
    const loaded = await this.#loadRoom(roomId);
    if (!loaded) throw new ApiError("NOT_FOUND", 404, "room not found");
    const { row } = loaded;
    const status = row.status as RoomStatus;
    if (status === "CLOSED" || status === "EXPIRED") {
      throw new ApiError("ROOM_CLOSED", 410, `room ${status}`);
    }

    const hash = await hashToken(token);
    const session = await this.#db
      .prepare("SELECT * FROM sessions WHERE room_id = ? AND token_hash = ? AND role = 'join'")
      .bind(roomId, hash)
      .first<SessionRow>();
    if (!session) throw new ApiError("FORBIDDEN", 403, "invalid join token");
    if (session.expires_at <= Date.now()) throw new ApiError("EXPIRED", 403, "join token expired");

    // D4：MVP 固定 2 人（Host + 1 Client），同步引擎只有 player 1 / player 2
    const count = await this.#countPlayers(roomId);
    if (count >= 1) throw new ApiError("ROOM_FULL", 409, "room full (MVP 固定 2 人)");

    const now = Date.now();
    const playerToken = generateToken();
    const playerId = generateToken(16);
    await this.#db.batch([
      this.#db
        .prepare(
          "INSERT INTO players (id, room_id, nickname, role, profile, joined_at, last_seen) VALUES (?, ?, ?, 'player', ?, ?, ?)",
        )
        .bind(playerId, roomId, nickname, profile, now, now),
      this.#db
        .prepare(
          "INSERT INTO sessions (id, room_id, token_hash, role, expires_at, created_at) VALUES (?, ?, ?, 'player', ?, ?)",
        )
        .bind(playerId, roomId, await hashToken(playerToken), session.expires_at, now),
      this.#db
        .prepare("UPDATE rooms SET updated_at = ? WHERE id = ?")
        .bind(now, roomId),
    ]);

    return {
      playerToken,
      response: {
        roomId,
        gameId: row.game_id,
        mode: row.mode as RoomMode,
        status: status,
        playerToken,
        role: "player",
        profile,
        hostOnline: status !== "HOST_LOST",
      },
    };
  }

  async heartbeat(roomId: string, auth: AuthContext): Promise<HeartbeatResponse> {
    if (auth.role !== "host") throw new ApiError("FORBIDDEN", 403, "host token required");
    const now = Date.now();
    const loaded = await this.#loadRoom(roomId);
    if (!loaded) throw new ApiError("NOT_FOUND", 404, "room not found");
    const { row } = loaded;

    let status = row.status as RoomStatus;
    if (status === "HOST_LOST") {
      status = resumeStatus(row.resume_status);
      await this.#db
        .prepare(
          "UPDATE rooms SET last_heartbeat = ?, updated_at = ?, status = ?, resume_status = NULL WHERE id = ?",
        )
        .bind(now, now, status, roomId)
        .run();
    } else {
      await this.#db
        .prepare("UPDATE rooms SET last_heartbeat = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, roomId)
        .run();
    }

    return { status, lastHeartbeat: now };
  }

  async setStatus(roomId: string, auth: AuthContext, next: unknown): Promise<RoomSnapshot> {
    if (auth.role !== "host") throw new ApiError("FORBIDDEN", 403, "host token required");
    if (!isRoomStatus(next)) throw new ApiError("BAD_REQUEST", 400, "invalid status");
    const loaded = await this.#loadRoom(roomId);
    if (!loaded) throw new ApiError("NOT_FOUND", 404, "room not found");
    const from = loaded.row.status as RoomStatus;
    if (!canTransition(from, next)) {
      throw new ApiError("CONFLICT", 409, `cannot transition ${from} -> ${next}`);
    }
    const now = Date.now();
    await this.#db
      .prepare(
        "UPDATE rooms SET status = ?, resume_status = CASE WHEN ? = 'HOST_LOST' THEN status ELSE resume_status END, updated_at = ? WHERE id = ?",
      )
      .bind(next, next, now, roomId)
      .run();
    const count = await this.#countPlayers(roomId);
    return toSnapshot({ ...loaded.row, status: next, updated_at: now }, count);
  }

  async getRoom(roomId: string): Promise<RoomSnapshot> {
    const loaded = await this.#loadRoom(roomId);
    if (!loaded) throw new ApiError("NOT_FOUND", 404, "room not found");
    const count = await this.#countPlayers(roomId);
    return toSnapshot(loaded.row, count);
  }

  /** 轮询端点：一次性返回房间状态 + 信令消息（技术方案 §2.1）。 */
  async sync(roomId: string, auth: AuthContext, after: number): Promise<SyncResponse> {
    const loaded = await this.#loadRoom(roomId);
    if (!loaded) throw new ApiError("NOT_FOUND", 404, "room not found");

    const cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
    const now = Date.now();

    // 顺带清理本房间 5 分钟前的信令行（控制 D1 读配额）
    await this.#db
      .prepare("DELETE FROM signals WHERE room_id = ? AND created_at < ?")
      .bind(roomId, now - SIGNAL_CLEANUP_AGE_MS)
      .run();

    const res = await this.#db
      .prepare(
        "SELECT id, from_role, payload, created_at FROM signals WHERE room_id = ? AND to_role = ? AND id > ? ORDER BY id ASC LIMIT ?",
      )
      .bind(roomId, auth.role, cursor, SYNC_PAGE_LIMIT)
      .all<SignalRow>();

    const rows = res.results ?? [];
    const players = await this.#listPlayers(roomId);
    const since = rows.length > 0 ? (rows[rows.length - 1]?.id ?? cursor) : cursor;

    return {
      status: loaded.row.status as RoomStatus,
      since,
      players: players.filter((p) => p.role === "player"),
      signals: rows.map((r) => ({
        id: r.id,
        fromRole: r.from_role === "host" ? "host" : "player",
        message: parseJson(r.payload),
      })),
    };
  }

  async signal(roomId: string, auth: AuthContext, body: unknown): Promise<{ id: number }> {
    if (!isSignalMessage(body)) throw new ApiError("BAD_REQUEST", 400, "invalid signal");
    const toRole = auth.role === "host" ? "player" : "host";
    const now = Date.now();
    const result = await this.#db
      .prepare(
        "INSERT INTO signals (room_id, from_role, to_role, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(roomId, auth.role, toRole, JSON.stringify(body), now)
      .first<{ id: number }>();
    return { id: result?.id ?? 0 };
  }

  async leave(roomId: string, auth: AuthContext): Promise<{ ok: true }> {
    const now = Date.now();
    if (auth.role === "host") {
      await this.closeRoom(roomId);
      return { ok: true };
    }
    await this.#db.batch([
      this.#db.prepare("DELETE FROM players WHERE id = ?").bind(auth.session.id),
      this.#db.prepare("DELETE FROM sessions WHERE id = ?").bind(auth.session.id),
      this.#db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(now, roomId),
    ]);
    return { ok: true };
  }

  async closeRoom(roomId: string): Promise<{ ok: true }> {
    const now = Date.now();
    await this.#db.batch([
      this.#db
        .prepare("UPDATE rooms SET status = 'CLOSED', updated_at = ? WHERE id = ?")
        .bind(now, roomId),
      this.#db.prepare("DELETE FROM signals WHERE room_id = ?").bind(roomId),
    ]);
    return { ok: true };
  }
}

export interface CreateRoomResult {
  roomId: string;
  joinUrl: string;
  hostToken: string;
  hostSessionId: string;
  expiresAt: number;
}

/** 解析并分发请求；返回 null 表示不是 API 路由。 */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const service = new RoomService(env, request.url);

  const segs = url.pathname.split("/").filter(Boolean); // ['api','rooms',...]
  const method = request.method.toUpperCase();

  try {
    // POST /api/rooms
    if (segs[1] === "rooms" && segs.length === 2) {
      if (method === "POST") {
        const body = (await readBody(request)) as { gameId?: unknown; mode?: unknown };
        const gameId = typeof body.gameId === "string" ? body.gameId : "";
        const mode: RoomMode = body.mode === "nearby" ? "nearby" : "remote";
        const hostId = request.headers.get("x-host-id") ?? generateToken(16);
        const created = await service.createRoom(hostId, gameId, mode);
        const res: HostSessionResponse & { joinUrl: string; hostToken: string; expiresAt: number } = {
          roomId: created.roomId,
          gameId,
          mode,
          status: "WAITING",
          hostToken: created.hostToken,
          joinUrl: created.joinUrl,
          expiresAt: created.expiresAt,
        };
        return json(res, 201);
      }
      return errorJson("BAD_REQUEST", 405, "method not allowed");
    }

    if (segs[1] !== "rooms" || segs.length < 3) {
      return errorJson("NOT_FOUND", 404, "unknown api route");
    }

    const roomId = decodeURIComponent(segs[2] ?? "");
    if (!ROOM_ID_RE.test(roomId)) return errorJson("BAD_REQUEST", 400, "bad room id");
    const action = segs[3];

    // POST /api/rooms/:id/join
    if (action === "join" && method === "POST") {
      const body = (await readBody(request)) as {
        token?: unknown;
        nickname?: unknown;
        profile?: unknown;
      };
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) return errorJson("FORBIDDEN", 401, "join token required");
      const nickname = typeof body.nickname === "string" ? body.nickname.slice(0, 32) : null;
      const profile: RoomProfile =
        body.profile === "controller" ? "controller" : body.profile === "host" ? "host" : "player";
      const { response } = await service.joinRoom(roomId, token, nickname, profile);
      return json(response, 201);
    }

    const token = bearer(request);
    const auth = await service.auth(roomId, token);

    // POST /api/rooms/:id/heartbeat
    if (action === "heartbeat" && method === "POST") {
      return json(await service.heartbeat(roomId, auth));
    }

    // POST /api/rooms/:id/status
    if (action === "status" && method === "POST") {
      const body = (await readBody(request)) as { status?: unknown };
      return json(await service.setStatus(roomId, auth, body.status));
    }

    // GET /api/rooms/:id/sync?after=N
    if (action === "sync" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      return json(await service.sync(roomId, auth, Number.isFinite(after) ? after : 0));
    }

    // POST /api/rooms/:id/signal
    if (action === "signal" && method === "POST") {
      const body = await readBody(request);
      return json(await service.signal(roomId, auth, body), 201);
    }

    // POST /api/rooms/:id/leave
    if (action === "leave" && method === "POST") {
      return json(await service.leave(roomId, auth));
    }

    // GET / DELETE /api/rooms/:id
    if (action === undefined) {
      if (method === "GET") return json(await service.getRoom(roomId));
      if (method === "DELETE") {
        if (auth.role !== "host") return errorJson("FORBIDDEN", 403, "host token required");
        return json(await service.closeRoom(roomId));
      }
      return errorJson("BAD_REQUEST", 405, "method not allowed");
    }

    return errorJson("NOT_FOUND", 404, "unknown api route");
  } catch (err) {
    if (err instanceof ApiError) return errorJson(err.code, err.status, err.message);
    console.error("[worker] unhandled", err);
    return errorJson("BAD_REQUEST", 500, "internal error");
  }
}
