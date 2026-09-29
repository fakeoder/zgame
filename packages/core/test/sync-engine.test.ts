import { describe, expect, it } from "vitest";
import { encodeMessage, isSyncMessage, type SyncMessage } from "@zgame/protocol";
import type { ChannelName, Transport } from "@zgame/net";
import { SyncEngine, type PlayerInputs } from "../src/sync-engine.js";

/** 双向连线的测试传输：A.send → B.on，B.send → A.on。 */
class PairTransport implements Transport {
  readonly kind = "loopback" as const;
  state: "connecting" | "open" | "closed" = "open";
  peer: PairTransport | null = null;
  #handlers = new Map<string, Set<(d: Uint8Array) => void>>();
  #stateHandlers = new Set<(s: "connecting" | "open" | "closed") => void>();

  send(channel: ChannelName, data: Uint8Array): void {
    const target = this.peer;
    if (!target || target.state === "closed") return;
    queueMicrotask(() => target.#dispatch(channel, data));
  }

  on(channel: ChannelName | "*", cb: (d: Uint8Array) => void): () => void {
    let set = this.#handlers.get(channel);
    if (!set) {
      set = new Set();
      this.#handlers.set(channel, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  onStateChange(cb: (s: "connecting" | "open" | "closed") => void): () => void {
    this.#stateHandlers.add(cb);
    cb(this.state);
    return () => this.#stateHandlers.delete(cb);
  }

  close(): void {
    this.state = "closed";
    for (const cb of this.#stateHandlers) cb("closed");
  }

  #dispatch(channel: ChannelName, data: Uint8Array): void {
    for (const cb of this.#handlers.get(channel) ?? []) cb(data);
    for (const cb of this.#handlers.get("*") ?? []) cb(data);
  }
}

function connect(): [PairTransport, PairTransport] {
  const a = new PairTransport();
  const b = new PairTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SyncEngine", () => {
  it("solo: tick 走本地输入，不依赖网络", () => {
    const frames: { frame: number; inputs: PlayerInputs }[] = [];
    const engine = new SyncEngine({
      role: "solo",
      inputDelayFrames: 2,
      handlers: { onFrame: (frame, inputs) => frames.push({ frame, inputs }) },
    });
    engine.start(42, 0);
    engine.setLocalInput({ UP: true });
    engine.tick(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.inputs[1]).toEqual({ UP: true });
    expect(frames[0]?.inputs[2]).toEqual({});
  });

  it("host/player: 输入按 inputDelayFrames 生效并广播一致状态", async () => {
    const [tHost, tClient] = connect();
    const hostFrames: PlayerInputs[] = [];
    const clientFrames: { frame: number; inputs: PlayerInputs }[] = [];
    let seedSeen = -1;

    const host = new SyncEngine({
      role: "host",
      inputDelayFrames: 2,
      transport: tHost,
      handlers: { onFrame: (_f, inputs) => hostFrames.push(inputs) },
    });
    const client = new SyncEngine({
      role: "player",
      inputDelayFrames: 2,
      transport: tClient,
      handlers: {
        onFrame: (frame, inputs) => clientFrames.push({ frame, inputs }),
        onSeed: (_f, seed) => {
          seedSeen = seed;
        },
      },
    });

    host.start(1234, 0);
    client.start(0, 0);
    await flush();

    // Host 本地按键 → 2 帧后生效
    host.setLocalInput({ A: true });
    for (let f = 1; f <= 4; f++) host.tick(f);
    await flush();

    expect(hostFrames).toHaveLength(4);
    // 输入在 adopted(0) + delay(2) = 第 2 帧生效
    expect(hostFrames[0]?.[1]).toEqual({});
    expect(hostFrames[1]?.[1]).toEqual({ A: true });
    expect(hostFrames[2]?.[1]).toEqual({ A: true });
    expect(seedSeen).toBe(1234);

    // Client 收到广播后逐帧推进，状态与 Host 一致
    expect(clientFrames.map((c) => c.frame)).toEqual([1, 2, 3, 4]);
    expect(clientFrames[1]?.inputs[1]).toEqual({ A: true });
    expect(clientFrames[2]?.inputs).toEqual(hostFrames[2]);
    expect(clientFrames[3]?.inputs).toEqual(hostFrames[3]);

    host.destroy();
    client.destroy();
  });

  it("host 收到晚到输入时改写到下一帧，不丢按键", () => {
    const frames: PlayerInputs[] = [];
    const host = new SyncEngine({
      role: "host",
      inputDelayFrames: 2,
      handlers: { onFrame: (_f, inputs) => frames.push(inputs) },
    });
    host.start(7, 0);
    for (let f = 1; f <= 3; f++) host.tick(f);
    // 伪造一条 frame=1 的晚到输入
    host.handleMessage({ v: 1, type: "input", frame: 1, player: 2, input: { B: true } });
    host.tick(4);
    expect(frames[3]?.[2]).toEqual({ B: true });
    host.destroy();
  });

  it("control 消息透传", () => {
    const events: string[] = [];
    const host = new SyncEngine({
      role: "host",
      inputDelayFrames: 2,
      handlers: { onFrame: () => {}, onControl: (e) => events.push(e) },
    });
    host.start(1, 0);
    host.handleMessage({ v: 1, type: "control", event: "pause" });
    expect(events).toEqual(["pause"]);
    host.destroy();
  });

  it("状态哈希一致时不触发对账（M3）", async () => {
    const [tHost, tClient] = connect();
    const mismatches: number[] = [];
    const host = new SyncEngine({
      role: "host",
      inputDelayFrames: 2,
      transport: tHost,
      hashIntervalFrames: 4,
      handlers: { onFrame: () => {}, onHashMismatch: (f) => mismatches.push(f) },
    });
    const client = new SyncEngine({
      role: "player",
      inputDelayFrames: 2,
      transport: tClient,
      hashIntervalFrames: 4,
      handlers: { onFrame: () => {}, onHashMismatch: (f) => mismatches.push(f) },
    });
    host.start(1, 0);
    client.start(0, 0);
    await flush();

    for (const frame of [4, 8]) {
      host.reportLocalHash(frame, "abcd1234");
      client.reportLocalHash(frame, "abcd1234");
      await flush();
    }
    expect(mismatches).toEqual([]);
    host.destroy();
    client.destroy();
  });

  it("哈希不一致：host 推送全量快照，player 发起 resync", async () => {
    const [tHost, tClient] = connect();
    let hostPayload: string | null = null;
    const states: { frame: number; payload: string }[] = [];
    const resyncs: string[] = [];
    const mismatchFrames: number[] = [];

    const host = new SyncEngine({
      role: "host",
      inputDelayFrames: 2,
      transport: tHost,
      hashIntervalFrames: 4,
      onResyncRequest: (frame) => {
        hostPayload = `snapshot@${frame}`;
        return hostPayload;
      },
      handlers: {
        onFrame: () => {},
        onHashMismatch: (f) => mismatchFrames.push(f),
        onControl: (e) => resyncs.push(e),
      },
    });
    const client = new SyncEngine({
      role: "player",
      inputDelayFrames: 2,
      transport: tClient,
      hashIntervalFrames: 4,
      handlers: {
        onFrame: () => {},
        onHashMismatch: (f) => mismatchFrames.push(f),
        onState: (frame, payload) => states.push({ frame, payload }),
        onControl: (e) => resyncs.push(e),
      },
    });
    host.start(1, 0);
    client.start(0, 0);
    await flush();
    for (let f = 1; f <= 4; f++) host.tick(f);
    await flush();

    // 双端在第 4 帧算出不同哈希
    host.reportLocalHash(4, "aaaa1111");
    client.reportLocalHash(4, "bbbb2222");
    await flush();

    expect(mismatchFrames).toContain(4);
    // player 发起 resync → host 回应权威快照（帧 = host 当前帧）
    expect(states).toEqual([{ frame: 4, payload: "snapshot@4" }]);
    expect(hostPayload).toBe("snapshot@4");
    host.destroy();
    client.destroy();
  });

  it("player 发 resync 请求时 host 用当前帧快照回应", async () => {
    const [tHost, tClient] = connect();
    const states: { frame: number; payload: string }[] = [];
    const host = new SyncEngine({
      role: "host",
      inputDelayFrames: 2,
      transport: tHost,
      hashIntervalFrames: 4,
      onResyncRequest: (frame) => `snapshot@${frame}`,
      handlers: { onFrame: () => {} },
    });
    const client = new SyncEngine({
      role: "player",
      inputDelayFrames: 2,
      transport: tClient,
      handlers: {
        onFrame: () => {},
        onState: (frame, payload) => states.push({ frame, payload }),
      },
    });
    host.start(1, 0);
    client.start(0, 0);
    await flush();

    for (let f = 1; f <= 7; f++) host.tick(f);
    await flush();

    host.handleMessage({ v: 1, type: "control", event: "resync" });
    await flush();

    expect(states).toEqual([{ frame: 7, payload: "snapshot@7" }]);

    // 快照应用后 player 跳到 host 的帧
    expect(client.frame).toBe(7);
    host.destroy();
    client.destroy();
  });

  it("encode/isSyncMessage 往返", () => {
    const msg: SyncMessage = { v: 1, type: "input", frame: 5, player: 1, input: { UP: true } };
    const decoded = JSON.parse(new TextDecoder().decode(encodeMessage(msg))) as unknown;
    expect(isSyncMessage(decoded)).toBe(true);
  });
});
