import type { ButtonState, SyncMessage } from "@zgame/protocol";
import { decodeMessage, encodeMessage, isSyncMessage, normalizeButtons } from "@zgame/protocol";

/**
 * 传输抽象的最小结构（与 @zgame/net 的 Transport 结构兼容）。
 * core 不反向依赖 net，保持技术方案 §4.2 的依赖方向。
 */
export interface SyncTransport {
  readonly state: "connecting" | "open" | "closed";
  send(channel: "input" | "sync" | "control", data: Uint8Array): void;
  on(channel: "input" | "sync" | "control" | "*", cb: (data: Uint8Array) => void): () => void;
  onStateChange(cb: (state: "connecting" | "open" | "closed") => void): () => void;
}

export type SyncRole = "solo" | "host" | "player" | "controller";

export interface PlayerInputs {
  1: ButtonState;
  2: ButtonState;
}

export type TransportStateLike = "connecting" | "open" | "closed";

export interface SyncEngineHandlers {
  /** 每个权威帧被采纳后回调；双端收到的 inputs 完全一致。 */
  onFrame: (frame: number, inputs: PlayerInputs) => void;
  onControl?: (event: "pause" | "resume" | "end" | "resync") => void;
  onSeed?: (frame: number, seed: number) => void;
  onTransportState?: (state: TransportStateLike) => void;
  /** 两端状态哈希不一致（M3 对账）。 */
  onHashMismatch?: (frame: number, local: string, remote: string) => void;
  /** 收到权威全量快照，由上层写回游戏。 */
  onState?: (frame: number, payload: string) => void;
}

export interface SyncEngineOptions {
  role: SyncRole;
  inputDelayFrames: number;
  transport?: SyncTransport | null;
  handlers: SyncEngineHandlers;
  /** 状态哈希对账间隔（帧）。0 = 关闭。 */
  hashIntervalFrames?: number;
  /** host 收到 resync 请求时回填全量快照（返回 null 表示不支持）。 */
  onResyncRequest?: (frame: number) => string | null;
}

interface Tagged {
  frame: number;
  state: ButtonState;
}

/**
 * 按帧折叠输入：只有 frame <= N 的更新在第 N 帧生效。
 * 晚到的更新由调用方改写到 adopted+1，保证不丢按键。
 */
class InputResolver {
  #resolved: ButtonState = {};
  #pending: Tagged[] = [];

  push(frame: number, state: ButtonState): void {
    this.#pending.push({ frame, state: normalizeButtons(state) });
    if (this.#pending.length > 1) this.#pending.sort((a, b) => a.frame - b.frame);
  }

  resolve(frame: number): ButtonState {
    while (this.#pending.length > 0) {
      const first = this.#pending[0];
      if (!first || first.frame > frame) break;
      this.#pending.shift();
      this.#resolved = { ...this.#resolved, ...first.state };
    }
    return { ...this.#resolved };
  }
}

const SNAPSHOT_INTERVAL_MS = 500;
/** 默认 10s @60fps 一次状态对账。 */
const DEFAULT_HASH_INTERVAL_FRAMES = 600;

/**
 * 输入同步引擎（技术方案 §8.3 InputSyncStrategy）。
 *
 * host / solo  ：本地权威帧时钟，每帧 resolve 双方输入并广播「已采纳输入集合」。
 * player       ：本地输入打 frame 标签发给 Host，按 Host 广播的帧推进本地游戏。
 * controller   ：同 player，但上层不跑游戏，仅用 frame 标签给输入计时。
 */
export class SyncEngine {
  readonly role: SyncRole;

  #delay: number;
  #transport: SyncTransport | null;
  #handlers: SyncEngineHandlers;

  #adoptedFrame = 0;
  #local = new InputResolver();
  #remote = new InputResolver();
  #localState: ButtonState = {};

  #started = false;
  #baselineSent = false;
  /** 等待开局帧基准期间暂存的消息。 */
  #queued: SyncMessage[] | null = null;
  /** client 侧按帧收集双端已采纳输入（players 位掩码：1=player1, 2=player2）。 */
  #incoming = new Map<number, { players: number; inputs: PlayerInputs }>();

  #snapshotTimer: ReturnType<typeof setInterval> | null = null;
  #detach: (() => void)[] = [];

  #hashInterval: number;
  #localHashes = new Map<number, string>();
  #remoteHashes = new Map<number, string>();
  #lastHash = 0;

  constructor(opts: SyncEngineOptions) {
    this.role = opts.role;
    this.#delay = Math.max(0, opts.inputDelayFrames | 0);
    this.#transport = opts.transport ?? null;
    this.#handlers = opts.handlers;
    this.#hashInterval = Math.max(0, opts.hashIntervalFrames ?? DEFAULT_HASH_INTERVAL_FRAMES);
    this.#onResyncRequest = opts.onResyncRequest;

    if (this.#transport) {
      this.#detach.push(
        this.#transport.on("sync", (data) => {
          const msg = decodeMessage(data);
          if (isSyncMessage(msg)) this.handleMessage(msg);
        }),
      );
      this.#detach.push(
        this.#transport.onStateChange((s) => {
              this.#handlers.onTransportState?.(s);
          // 仅在 start() 之后才允许下发基准，避免用默认 seed 抢跑
          if (s === "open" && this.role === "host" && this.#started) this.#sendBaseline();
        }),
      );
    }
  }

  get frame(): number {
    return this.#adoptedFrame;
  }

  get isMultiplayer(): boolean {
    return this.role === "host" || this.role === "player" || this.role === "controller";
  }

  /** 开局：Host 下发帧基准与随机种子。 */
  start(seed: number, startFrame = 0): void {
    if (this.#started) return;
    this.#started = true;
    this.#adoptedFrame = startFrame;
    if (this.role === "host") {
      this.#pendingBaseline = { seed, startFrame };
      this.#sendBaseline();
      this.#beginSnapshot();
    } else if (this.role === "player" || this.role === "controller") {
      this.#queued = [];
      this.#beginSnapshot();
    }
  }

  /** 本地输入全量快照（含 pressed=false）。 */
  setLocalInput(state: ButtonState): void {
    const normalized = normalizeButtons(state);
    this.#localState = normalized;
    if (this.role === "controller") {
      // 纯手柄页：只上报，不参与本地模拟
      this.#send({ v: 1, type: "input", frame: this.#adoptedFrame + this.#delay, player: 2, input: normalized });
      return;
    }
    // solo 无对端，输入立即生效；联机时延迟 delay 帧给远端输入留出到达窗口
    const tag = this.#adoptedFrame + (this.role === "solo" ? 0 : this.#delay);
    if (this.role === "host" || this.role === "solo") {
      this.#local.push(tag, normalized);
      return;
    }
    this.#send({ v: 1, type: "input", frame: tag, player: 2, input: normalized });
  }

  handleMessage(msg: SyncMessage): void {
    // 帧基准必须立即处理，否则队列里的基准永远不会被取出
    if (this.#queued && msg.type !== "frame") {
      this.#queued.push(msg);
      return;
    }
    this.#route(msg);
  }

  #route(msg: SyncMessage): void {
    switch (msg.type) {
      case "frame":
        this.#onBaseline(msg);
        break;
      case "input":
        if (this.role === "host") {
          const late = Math.max(msg.frame, this.#adoptedFrame + 1);
          this.#remote.push(late, msg.input);
        } else {
          this.#onAdopted(msg);
        }
        break;
      case "control":
        if (msg.event === "resync") {
          if (this.role === "host") {
            const frame = this.#adoptedFrame;
            const payload = this.#onResyncRequest?.(frame);
            if (payload) this.#send({ v: 1, type: "state", frame, payload });
          }
          break;
        }
        this.#handlers.onControl?.(msg.event);
        break;
      case "hash":
        this.#onRemoteHash(msg);
        break;
      case "state":
        // 权威快照：跳到 host 的帧，丢弃快照帧之前的待采纳输入
        if (msg.frame > this.#adoptedFrame) {
          this.#adoptedFrame = msg.frame;
          for (const key of [...this.#incoming.keys()]) if (key <= msg.frame) this.#incoming.delete(key);
        }
        this.#handlers.onState?.(msg.frame, msg.payload);
        break;
      default:
        break;
    }
  }

  /** 权威帧推进（Host / solo，由 FrameClock 驱动）。 */
  tick(frame: number): void {
    if (this.role !== "host" && this.role !== "solo") return;
    this.#adoptedFrame = frame;
    const inputs: PlayerInputs = {
      1: this.#local.resolve(frame),
      2: this.role === "host" ? this.#remote.resolve(frame) : {},
    };
    if (this.role === "host") {
      this.#send({ v: 1, type: "input", frame, player: 1, input: inputs[1] });
      this.#send({ v: 1, type: "input", frame, player: 2, input: inputs[2] });
    }
    this.#handlers.onFrame(frame, inputs);
  }

  sendControl(event: "pause" | "resume" | "end"): void {
    if (this.role === "host") this.#send({ v: 1, type: "control", event });
  }

  /**
   * 上报本机在指定帧的状态哈希（M3 对账）。
   * 两端在同一个 `frame % hashInterval === 0` 的帧上各自算一次，互发比对。
   * 任一端发现不一致：host 主动推全量快照，player 发起 resync 请求。
   */
  reportLocalHash(frame: number, hash: string): void {
    if (this.#hashInterval <= 0) return;
    if (frame <= 0 || frame % this.#hashInterval !== 0) return;
    if (this.role !== "host" && this.role !== "player") return;
    if (frame - this.#lastHash < this.#hashInterval) return;
    this.#lastHash = frame;
    this.#localHashes.set(frame, hash);
    this.#trim(this.#localHashes, frame);

    this.#send({ v: 1, type: "hash", frame, hash });
    const remote = this.#remoteHashes.get(frame);
    if (remote !== undefined) this.#compare(frame, hash, remote);
  }

  destroy(): void {
    for (const fn of this.#detach) fn();
    this.#detach = [];
    if (this.#snapshotTimer) clearInterval(this.#snapshotTimer);
    this.#snapshotTimer = null;
    this.#incoming.clear();
    this.#localHashes.clear();
    this.#remoteHashes.clear();
    this.#queued = null;
  }

  #onRemoteHash(msg: Extract<SyncMessage, { type: "hash" }>): void {
    if (this.#hashInterval <= 0) return;
    if (msg.frame <= 0 || msg.frame % this.#hashInterval !== 0) return;
    this.#remoteHashes.set(msg.frame, msg.hash);
    this.#trim(this.#remoteHashes, msg.frame);
    const local = this.#localHashes.get(msg.frame);
    if (local !== undefined) this.#compare(msg.frame, local, msg.hash);
  }

  /**
   * 双端都会收到对端哈希，都会比对并触发 onHashMismatch（供 UI 提示）。
   * 但只有 player 发起 resync，host 只被动响应快照 —— 单一发起方避免重复下发。
   */
  #compare(frame: number, local: string, remote: string): void {
    if (local === remote) return;
    this.#handlers.onHashMismatch?.(frame, local, remote);
    if (this.role === "player") this.#send({ v: 1, type: "control", event: "resync" });
  }

  #trim(map: Map<number, string>, latest: number): void {
    const floor = latest - this.#hashInterval * 2;
    if (floor <= 0) return;
    for (const key of map.keys()) if (key < floor) map.delete(key);
  }

  #onBaseline(msg: Extract<SyncMessage, { type: "frame" }>): void {
    this.#started = true;
    this.#adoptedFrame = msg.frame;
    this.#handlers.onSeed?.(msg.frame, msg.seed);
    const queued = this.#queued;
    this.#queued = null;
    if (queued) for (const m of queued) this.#route(m);
  }

  #onAdopted(msg: Extract<SyncMessage, { type: "input" }>): void {
    if (msg.frame <= this.#adoptedFrame) return;
    const got = this.#incoming.get(msg.frame) ?? { players: 0, inputs: { 1: {}, 2: {} } };
    got.inputs[msg.player] = normalizeButtons(msg.input);
    got.players |= msg.player === 1 ? 1 : 2;
    this.#incoming.set(msg.frame, got);

    // 两个玩家的已采纳输入都到齐才推进该帧
    if (got.players !== 3) return;
    this.#incoming.delete(msg.frame);
    this.#adoptedFrame = msg.frame;
    this.#handlers.onFrame(msg.frame, got.inputs);
  }

  #onResyncRequest?: (frame: number) => string | null;
  #pendingBaseline: { seed: number; startFrame: number } | null = null;

  #sendBaseline(): void {
    if (this.role !== "host" || this.#baselineSent || !this.#started) return;
    const pending = this.#pendingBaseline;
    if (!pending) return;
    // 传输尚未 open 时不置位，留给 onStateChange 补发
    if (this.#transport && this.#transport.state !== "open") return;
    this.#baselineSent = true;
    this.#pendingBaseline = null;
    this.#send({ v: 1, type: "frame", frame: pending.startFrame, seed: pending.seed });
  }

  /** 按键状态全量快照自愈（技术方案 §8.4，500ms 一次）。 */
  #beginSnapshot(): void {
    if (this.#snapshotTimer) return;
    this.#snapshotTimer = setInterval(() => {
      if (this.role === "host") {
        this.#local.push(this.#adoptedFrame + this.#delay, this.#localState);
      } else if (this.role === "player" || this.role === "controller") {
        this.setLocalInput(this.#localState);
      }
    }, SNAPSHOT_INTERVAL_MS);
  }

  #send(msg: SyncMessage): void {
    if (!this.#transport || this.#transport.state === "closed") return;
    this.#transport.send("sync", encodeMessage(msg));
  }
}
