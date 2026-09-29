export type TransportKind = "loopback" | "webrtc";
export type TransportState = "connecting" | "open" | "closed";
export type ChannelName = "input" | "sync" | "control";

export const CHANNEL_NAMES: readonly ChannelName[] = ["input", "sync", "control"];

export type TransportHandler = (data: Uint8Array) => void;
export type StateHandler = (state: TransportState) => void;

/** 传输无关抽象（技术方案 §8.1）。上层不感知 Loopback 还是 WebRTC。 */
export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  /** 是否经由本地候选连通（UI 标注 LAN 用）。 */
  readonly isLocal?: boolean;
  send(channel: ChannelName, data: Uint8Array): void;
  on(channel: ChannelName | "*", cb: TransportHandler): () => void;
  onStateChange(cb: StateHandler): () => void;
  close(): void;
}

export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  protected _state: TransportState = "connecting";
  #channelHandlers = new Map<string, Set<TransportHandler>>();
  #stateHandlers = new Set<StateHandler>();

  get state(): TransportState {
    return this._state;
  }

  abstract send(channel: ChannelName, data: Uint8Array): void;

  on(channel: ChannelName | "*", cb: TransportHandler): () => void {
    let set = this.#channelHandlers.get(channel);
    if (!set) {
      set = new Set();
      this.#channelHandlers.set(channel, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  onStateChange(cb: StateHandler): () => void {
    this.#stateHandlers.add(cb);
    cb(this._state);
    return () => this.#stateHandlers.delete(cb);
  }

  protected setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const cb of this.#stateHandlers) cb(next);
  }

  protected dispatch(channel: ChannelName, data: Uint8Array): void {
    for (const cb of this.#channelHandlers.get(channel) ?? []) cb(data);
    for (const cb of this.#channelHandlers.get("*") ?? []) cb(data);
  }

  close(): void {
    this.setState("closed");
  }
}
