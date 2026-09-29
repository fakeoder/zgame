import type { PlayerSnapshot, RoomStatus, SignalMessage } from "@zgame/protocol";
import { WebRTCTransport, type TransportState } from "@zgame/net";
import { PollingSignalingChannel, RoomApiClient } from "@zgame/signaling";
import type { RoomSession } from "./session.js";

export type ConnectionPhase =
  | "idle"
  | "waiting-player"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed"
  | "host-lost";

export interface RoomConnectionHandlers {
  onPhase: (phase: ConnectionPhase) => void;
  onStatus: (status: RoomStatus) => void;
  onPlayers: (players: PlayerSnapshot[]) => void;
  onTransport: (transport: WebRTCTransport) => void;
  onTransportState?: (state: TransportState) => void;
  onError?: (err: unknown) => void;
}

const HEARTBEAT_MS = 15_000;
const ROOM_POLL_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 12_000;
/** 断线重连退避（M3）。 */
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_MAX_ATTEMPTS = 6;

/**
 * 房间连接编排：轮询信令 → WebRTC 建链 → 停轮询 → 低频房间状态轮询。
 * 对应技术方案 §5.2 时序与轮询纪律。
 */
export class RoomConnection {
  readonly api: RoomApiClient;
  readonly session: RoomSession;

  #handlers: RoomConnectionHandlers;
  #signaling: PollingSignalingChannel | null = null;
  #transport: WebRTCTransport | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #roomPollTimer: ReturnType<typeof setInterval> | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  #stopped = false;
  #phase: ConnectionPhase = "idle";

  constructor(session: RoomSession, handlers: RoomConnectionHandlers, api?: RoomApiClient) {
    this.session = session;
    this.#handlers = handlers;
    this.api = api ?? new RoomApiClient();
  }

  get transport(): WebRTCTransport | null {
    return this.#transport;
  }

  get phase(): ConnectionPhase {
    return this.#phase;
  }

  get reconnectAttempts(): number {
    return this.#reconnectAttempts;
  }

  start(): void {
    if (this.#stopped) return;
    const isHost = this.session.role === "host";
    this.#setPhase(isHost ? "waiting-player" : "connecting");

    this.#signaling = new PollingSignalingChannel({
      api: this.api,
      roomId: this.session.roomId,
      token: this.session.token,
      events: {
        onSignal: (msg) => void this.#handleSignal(msg),
        onStatus: (s) => this.#onRoomStatus(s),
        onPlayers: (players) => this.#handlers.onPlayers(players),
        onPlayerJoined: () => {
          if (this.#stopped || this.#transport) return;
          this.#createTransport(true);
        },
        onState: (s) => {
          if (s === "error") this.#setPhase("failed");
        },
        onError: (err) => this.#handlers.onError?.(err),
      },
    });

    this.#signaling.start(0);

    if (isHost) {
      this.#startHeartbeat();
      // 非房主不建链；房主等玩家出现后再 createTransport
    } else {
      this.#createTransport(false);
    }

    this.#handshakeTimer = setTimeout(() => {
      if (this.#phase === "connecting" || this.#phase === "waiting-player") {
        this.#setPhase("failed");
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#roomPollTimer) clearInterval(this.#roomPollTimer);
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#heartbeatTimer = null;
    this.#roomPollTimer = null;
    this.#handshakeTimer = null;
    this.#reconnectTimer = null;
    this.#signaling?.stop();
    this.#signaling = null;
    this.#transport?.close();
    this.#transport = null;
    this.#setPhase("closed");
  }

  /** WebRTC 建连成功后由外部调用（停止握手期轮询）。 */
  markConnected(): void {
    if (this.#stopped) return;
    this.#signaling?.markConnected();
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
    this.#setPhase("connected");
    this.#startRoomPoll();
  }

  sendSignal(msg: SignalMessage): void {
    this.#signaling?.send(msg);
  }

  async setStatus(status: RoomStatus): Promise<void> {
    if (this.session.role !== "host") return;
    const res = await this.api.setStatus(this.session.roomId, this.session.token, status);
    this.#handlers.onStatus(res.status);
  }

  async leave(): Promise<void> {
    try {
      await this.api.leave(this.session.roomId, this.session.token);
    } catch {
      /* 离开失败不阻塞 UI */
    }
  }

  /** 统一的房间状态 → 连接阶段映射（含 HOST_LOST 恢复，M3）。 */
  #onRoomStatus(s: RoomStatus): void {
    this.#handlers.onStatus(s);
    if (s === "CLOSED" || s === "EXPIRED") {
      this.#setPhase("closed");
      return;
    }
    if (s === "HOST_LOST") {
      this.#setPhase("host-lost");
      return;
    }
    // 房主心跳恢复：HOST_LOST → 原状态，尝试把链路拉回 connected
    if (this.#phase === "host-lost") {
      this.#reconnectAttempts = 0;
      if (this.#transport?.state === "open") this.#setPhase("connected");
      else this.#setPhase(this.session.role === "host" ? "waiting-player" : "reconnecting");
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    if (this.#reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.#setPhase("failed");
      return;
    }
    const attempt = this.#reconnectAttempts++;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    this.#setPhase("reconnecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#reconnect();
    }, backoff);
  }

  #reconnect(): void {
    if (this.#stopped || !this.#transport) return;
    // 保留 Transport 对象身份：换 RTCPeerConnection 重新握手，
    // 上层 SyncEngine/GameRuntime 的订阅无需重建。
    this.#transport.restart();
    // 恢复信令轮询以交换新的 offer/answer/ICE
    this.#signaling?.resume();
    if (this.session.role === "host") this.#startHeartbeat();
    this.#startRoomPoll();
    this.#handlers.onTransportState?.("connecting");
  }

  /** 手动重试（热点引导卡按钮）。 */
  retry(): void {
    if (this.#stopped || !this.#transport) return;
    if (this.#transport.state === "open") return;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#reconnectAttempts = 0;
    this.#reconnect();
  }

  #setPhase(phase: ConnectionPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#handlers.onPhase(phase);
  }

  #createTransport(initiator: boolean): void {
    if (this.#transport || this.#stopped) return;
    const transport = new WebRTCTransport({
      initiator,
      signal: (msg) => this.sendSignal(msg),
    });
    this.#transport = transport;
    transport.onStateChange((s) => {
      this.#handlers.onTransportState?.(s);
      if (s === "open") {
        this.#reconnectAttempts = 0;
        this.markConnected();
        return;
      }
      if (this.#stopped) return;
      // 非主动关闭 → 走重连；超过上限才判定彻底失败
      if (s === "closed") this.#scheduleReconnect();
    });
    this.#handlers.onTransport(transport);
  }

  async #handleSignal(msg: SignalMessage): Promise<void> {
    if (this.#stopped) return;
    // 房主在收到首个信令前可能还没建 transport（理论上不会，但兜底）
    if (!this.#transport) this.#createTransport(this.session.role === "host");
    await this.#transport?.handleSignal(msg);
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer) return;
    const tick = () => {
      void this.api
        .heartbeat(this.session.roomId, this.session.token)
        .then((res) => this.#onRoomStatus(res.status))
        .catch((err) => this.#handlers.onError?.(err));
    };
    tick();
    this.#heartbeatTimer = setInterval(tick, HEARTBEAT_MS);
  }

  #startRoomPoll(): void {
    if (this.#roomPollTimer) return;
    const tick = () => {
      void this.api
        .getRoom(this.session.roomId, this.session.token)
        .then((room) => this.#onRoomStatus(room.status))
        .catch((err) => this.#handlers.onError?.(err));
    };
    this.#roomPollTimer = setInterval(tick, ROOM_POLL_MS);
  }
}
