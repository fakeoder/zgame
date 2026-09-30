import { describe, expect, it } from "vitest";
import { RoomService, handleApi, type Env } from "../src/service.js";
import { parseJoinPath } from "../src/tokens.js";
import { createDb } from "./helpers/d1.js";

const ORIGIN = "https://zgame.test";

function setup() {
  const { db, raw } = createDb();
  const env: Env = { DB: db, PUBLIC_ORIGIN: ORIGIN };
  const svc = new RoomService(env, `${ORIGIN}/api/rooms`);
  return { svc, db, raw, env };
}

function joinTokenOf(joinUrl: string): string {
  const parsed = parseJoinPath(new URL(joinUrl).pathname.slice("/join/".length));
  if (!parsed) throw new Error(`bad joinUrl: ${joinUrl}`);
  return parsed.token;
}

async function playerCount(db: D1Database, roomId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM players WHERE room_id = ? AND role = 'player'")
    .bind(roomId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function rows(db: D1Database, sql: string, roomId: string): Promise<unknown[]> {
  const res = await db.prepare(sql).bind(roomId).all<{ id: string }>();
  return res.results ?? [];
}

/** 把匹配的会话直接改成已过期（模拟时间流逝）。 */
function expire(raw: { exec(sql: string): void }, where: string): void {
  raw.exec(`UPDATE sessions SET expires_at = 1 WHERE ${where}`);
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return handleApi(new Request(`${ORIGIN}${path}`, init), env);
}

function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

describe("joinRoom", () => {
  it("邀请链接里的 join token 可以加入房间", async () => {
    const { svc } = setup();
    const created = await svc.createRoom("host-1", "snake", "nearby");
    const joined = await svc.joinRoom(
      created.roomId,
      joinTokenOf(created.joinUrl),
      "小明",
      "player",
    );
    expect(joined.response.roomId).toBe(created.roomId);
    expect(joined.response.role).toBe("player");
    expect(joined.playerToken).toBe(joined.response.playerToken);
  });

  it("token 不对时返回 invalid join token", async () => {
    const { svc } = setup();
    const created = await svc.createRoom("host-1", "snake", "nearby");
    await expect(
      svc.joinRoom(created.roomId, "not-the-invite-token-aaaaaaaa", null, "player"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403, message: "invalid join token" });
  });

  it("并发 join 只有一个成功（容量判定与写入同事务）", async () => {
    const { svc, db } = setup();
    const created = await svc.createRoom("host-1", "snake", "nearby");
    const token = joinTokenOf(created.joinUrl);

    const results = await Promise.allSettled([
      svc.joinRoom(created.roomId, token, "A", "player"),
      svc.joinRoom(created.roomId, token, "B", "controller"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "ROOM_FULL" });
    expect(await playerCount(db, created.roomId)).toBe(1);
  });

  it("过期玩家既不占名额，也会被下一次 join 回收", async () => {
    const { svc, db, raw } = setup();
    const created = await svc.createRoom("host-1", "snake", "nearby");
    const token = joinTokenOf(created.joinUrl);
    await svc.joinRoom(created.roomId, token, "先来的人", "player");

    expire(raw, "role = 'player'");

    const again = await svc.joinRoom(created.roomId, token, "后来的人", "player");
    expect(again.response.role).toBe("player");
    expect(await playerCount(db, created.roomId)).toBe(1);
    // 只剩房主 + 新玩家，过期那行被 GC 掉了
    expect(await rows(db, "SELECT id FROM players WHERE room_id = ?", created.roomId)).toHaveLength(2);
  });

  it("过期玩家不出现在列表里，也不再挡住房间", async () => {
    const { svc, raw } = setup();
    const created = await svc.createRoom("host-1", "snake", "nearby");
    const token = joinTokenOf(created.joinUrl);
    await svc.joinRoom(created.roomId, token, "过期的人", "player");
    expire(raw, "role = 'player'");

    expect((await svc.getRoom(created.roomId)).playerCount).toBe(0);
    const again = await svc.joinRoom(created.roomId, token, "再来一次", "player");
    expect(again.response.role).toBe("player");
  });
});

describe("join token 的权限边界", () => {
  it("不能当作 Bearer（auth 拒绝 join 角色）", async () => {
    const { svc } = setup();
    const created = await svc.createRoom("host-1", "snake", "nearby");
    await expect(svc.auth(created.roomId, joinTokenOf(created.joinUrl))).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "invalid token",
    });
  });

  it("不能用 leave 删掉邀请会话（邀请依然可用）", async () => {
    const { db, env } = setup();
    const createRes = await call(
      env,
      "/api/rooms",
      jsonInit("POST", { gameId: "snake", mode: "nearby" }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { roomId: string; joinUrl: string };
    const token = joinTokenOf(created.joinUrl);

    const leaveRes = await call(
      env,
      `/api/rooms/${created.roomId}/leave`,
      jsonInit("POST", {}, token),
    );
    expect(leaveRes.status).toBe(403);
    expect(
      await rows(db, "SELECT id FROM sessions WHERE room_id = ? AND role = 'join'", created.roomId),
    ).toHaveLength(1);

    const joinRes = await call(
      env,
      `/api/rooms/${created.roomId}/join`,
      jsonInit("POST", { token, nickname: "扫码的人", profile: "player" }),
    );
    expect(joinRes.status).toBe(201);
  });

  it("过期的玩家 token 依然可以 leave 清理自己", async () => {
    const { svc, db, raw, env } = setup();
    const createRes = await call(
      env,
      "/api/rooms",
      jsonInit("POST", { gameId: "snake", mode: "nearby" }),
    );
    const created = (await createRes.json()) as { roomId: string; joinUrl: string };
    const joinRes = await call(
      env,
      `/api/rooms/${created.roomId}/join`,
      jsonInit("POST", { token: joinTokenOf(created.joinUrl), nickname: "p", profile: "player" }),
    );
    expect(joinRes.status).toBe(201);
    const joined = (await joinRes.json()) as { playerToken: string };

    expire(raw, "role = 'player'");
    expect((await svc.getRoom(created.roomId)).playerCount).toBe(0);

    const leaveRes = await call(
      env,
      `/api/rooms/${created.roomId}/leave`,
      jsonInit("POST", {}, joined.playerToken),
    );
    expect(leaveRes.status).toBe(200);
    expect(
      await rows(db, "SELECT id FROM sessions WHERE room_id = ? AND role = 'player'", created.roomId),
    ).toHaveLength(0);
  });
});
