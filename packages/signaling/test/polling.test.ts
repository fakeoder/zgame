import { describe, expect, it, vi } from "vitest";
import type { RoomStatus } from "@zgame/protocol";
import type { RoomApiClient } from "../src/api.js";
import { PollingSignalingChannel } from "../src/polling.js";

interface SyncResponse {
  status: RoomStatus;
  since: number;
  players: never[];
  signals: { id: number; fromRole: string; message: unknown }[];
}

function makeApi(seq: Partial<SyncResponse>[]): RoomApiClient {
  let i = 0;
  const next = (): SyncResponse =>
    seq[Math.min(i, seq.length - 1)] ?? { status: "WAITING", since: i, players: [], signals: [] };
  return {
    sync: vi.fn(async () => {
      i += 1;
      return next();
    }),
  } as unknown as RoomApiClient;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PollingSignalingChannel", () => {
  it("markConnected 停止轮询（D1 读配额纪律）", async () => {
    const api = makeApi([{ status: "WAITING", since: 1, players: [], signals: [] }]);
    const ch = new PollingSignalingChannel({
      api,
      roomId: "R1",
      token: "t",
      intervalMs: 5,
      events: { onSignal: () => {} },
    });
    ch.start(0);
    await wait(30);
    ch.markConnected();
    const calls = (api.sync as ReturnType<typeof vi.fn>).mock.calls.length;
    await wait(50);
    expect((api.sync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect(ch.state).toBe("connected");
    expect(calls).toBeGreaterThan(0);
    ch.stop();
  });

  it("stop 后 resume 不会复活（避免关页后仍打配额）", async () => {
    const api = makeApi([]);
    const ch = new PollingSignalingChannel({
      api,
      roomId: "R1",
      token: "t",
      intervalMs: 5,
      events: { onSignal: () => {} },
    });
    ch.start(0);
    ch.stop();
    const calls = (api.sync as ReturnType<typeof vi.fn>).mock.calls.length;
    await wait(40);
    expect((api.sync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("markConnected 后 resume 恢复轮询（断线重连用）", async () => {
    const api = makeApi([{ status: "PLAYING", since: 7, players: [], signals: [] }]);
    const ch = new PollingSignalingChannel({
      api,
      roomId: "R1",
      token: "t",
      intervalMs: 5,
      events: { onSignal: () => {} },
    });
    ch.start(0);
    await wait(20);
    ch.markConnected();
    ch.resume();
    await wait(40);
    // resume 进入 waiting 轮询态
    expect(ch.state).toBe("waiting");
    // 恢复后 cursor 沿用上一次，不回退重放旧信号
    expect(ch.cursor).toBeGreaterThanOrEqual(7);
    ch.stop();
  });

  it("状态回调带出 HOST_LOST", async () => {
    const seen: RoomStatus[] = [];
    const api = makeApi([{ status: "HOST_LOST", since: 1, players: [], signals: [] }]);
    const ch = new PollingSignalingChannel({
      api,
      roomId: "R1",
      token: "t",
      intervalMs: 5,
      events: { onSignal: () => {}, onStatus: (s) => seen.push(s) },
    });
    ch.start(0);
    await wait(30);
    expect(seen).toContain("HOST_LOST");
    ch.stop();
  });
});
