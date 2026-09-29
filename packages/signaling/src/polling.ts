import type { PlayerSnapshot, RoomStatus, SignalMessage } from "@zgame/protocol";
import type { RoomApiClient } from "./api.js";

export type SignalingState =
  | "idle"
  | "waiting"
  | "handshaking"
  | "connected"
  | "closed"
  | "error";

export interface SignalingEvents {
  /** 收到对端信令（offer/answer/ice/bye）。 */
  onSignal: (msg: SignalMessage) => void;
  /** 房间状态变化（HOST_LOST 等）。 */
  onStatus?: (status: RoomStatus) => void;
  /** 有新玩家加入（Host 侧）。 */
  onPlayerJoined?: () => void;
  /** 每次轮询返回的玩家列表（Host 侧用于 UI）。 */
  onPlayers?: (players: PlayerSnapshot[]) => void;
  /** 连接状态。 */
  onState?: (state: SignalingState) => void;
  onError?: (err: unknown) => void;
}

/**
 * 信令通道接口（D8：按可替换设计，MVP 为 HTTP 轮询）。
 * 后续可无损切换到 DO + WebSocket。
 */
export interface SignalingChannel {
  start(after?: number): void;
  stop(): void;
  send(msg: SignalMessage): void;
  readonly state: SignalingState;
}

export interface PollingSignalingOptions {
  api: RoomApiClient;
  roomId: string;
  token: string;
  /** 握手期轮询间隔（含 jitter）。 */
  intervalMs?: number;
  events: SignalingEvents;
  /** WebRTC 建连成功后调用，轮询随即停止。 */
  onConnected?: () => void;
}

const DEFAULT_INTERVAL = 1000;
const JITTER = 250;
/** 每次轮询顺带清理的旧信号阈值（毫秒），由 Worker 侧处理。 */
const CLEANUP_AGE_MS = 5 * 60 * 1000;

export class PollingSignalingChannel implements SignalingChannel {
  #opts: PollingSignalingOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #cursor = 0;
  #running = false;
  #inFlight = false;
  #state: SignalingState = "idle";
  #consecutiveErrors = 0;
  #playerSeen = false;

  constructor(opts: PollingSignalingOptions) {
    this.#opts = opts;
  }

  get state(): SignalingState {
    return this.#state;
  }

  get cursor(): number {
    return this.#cursor;
  }

  start(after = 0): void {
    if (this.#running) return;
    this.#running = true;
    this.#cursor = after;
    this.#setState("waiting");
    void this.#loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#setState("closed");
  }

  /**
   * 握手完成，停止轮询（控制 D1 读配额，技术方案 §5.2 轮询纪律）。
   * 之后改由 `GET /api/rooms/:id` 低频感知 HOST_LOST。
   */
  markConnected(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#setState("connected");
    this.#opts.onConnected?.();
  }

  /**
   * 重连场景：从当前 cursor 恢复轮询（不重置游标，不重放旧信号）。
   * 若已 stop() 过则保持停止。
   */
  resume(): void {
    if (this.#running || this.#state === "closed") return;
    this.#setState("waiting");
    void this.#loop();
  }

  send(msg: SignalMessage): void {
    void this.#opts.api.signal(this.#opts.roomId, this.#opts.token, msg).catch((err) => {
      this.#opts.events.onError?.(err);
    });
  }

  #setState(s: SignalingState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.#opts.events.onState?.(s);
  }

  async #loop(): Promise<void> {
    if (!this.#running || this.#inFlight) return;
    this.#inFlight = true;
    try {
      const res = await this.#opts.api.sync(this.#opts.roomId, this.#opts.token, this.#cursor);
      this.#consecutiveErrors = 0;
      this.#cursor = res.since;

      this.#opts.events.onStatus?.(res.status);

      const players = res.players.filter((p) => p.role === "player");
      this.#opts.events.onPlayers?.(players);
      if (players.length === 0) this.#playerSeen = false;
      if (players.length > 0 && !this.#playerSeen) {
        this.#playerSeen = true;
        this.#opts.events.onPlayerJoined?.();
        this.#setState("handshaking");
      }

      for (const s of res.signals) {
        const msg = s.message as SignalMessage;
        this.#opts.events.onSignal(msg);
      }
    } catch (err) {
      this.#consecutiveErrors += 1;
      this.#setState("error");
      this.#opts.events.onError?.(err);
      if (this.#consecutiveErrors >= 5) {
        this.#running = false;
        return;
      }
    } finally {
      this.#inFlight = false;
    }
    if (!this.#running) return;
    const interval = this.#opts.intervalMs ?? DEFAULT_INTERVAL;
    const delay = interval + Math.floor(Math.random() * JITTER);
    this.#timer = setTimeout(() => void this.#loop(), delay);
  }

  get cleanupAgeMs(): number {
    return CLEANUP_AGE_MS;
  }
}
