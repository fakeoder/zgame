import type { Button, ButtonState, GameManifest, SyncMessage } from "@zgame/protocol";
import { decodeMessage, encodeMessage, fromBase64, hashBytes, toBase64 } from "@zgame/protocol";
import {
  FrameClock,
  SyncEngine,
  type PlayerInputs,
  type SyncRole,
  type TransportStateLike,
} from "@zgame/core";
import type { Transport } from "@zgame/net";
import {
  GamepadInputSource,
  InputAggregator,
  KeyboardInputSource,
  TouchController,
  VirtualInputSource,
  type InputSource,
} from "@zgame/input";
import { createGameStorage, type GameStorage } from "@zgame/storage";
import { getRegisteredGame, type GameContext, type GameInstance } from "@zgame/game-sdk";

export type RuntimeProfile = "solo" | "host" | "player" | "controller";

export interface GameRuntimeOptions {
  manifest: GameManifest;
  profile: RuntimeProfile;
  /** 游戏渲染容器。 */
  container: HTMLElement;
  /** 触屏虚拟手柄挂载容器；不传则不显示触屏手柄。 */
  touchContainer?: HTMLElement;
  transport?: Transport | null;
  seed?: number;
  /** 是否叠加触屏虚拟手柄。 */
  showTouch?: boolean;
  onSeed?: (seed: number) => void;
  onFrame?: (frame: number, inputs: PlayerInputs) => void;
  onTransportState?: (state: TransportStateLike) => void;
  onControl?: (event: "pause" | "resume" | "end") => void;
  onStatus?: (text: string, tone?: "ok" | "warn" | "bad" | "idle") => void;
  /** 状态哈希对账发现双端不一致（M3）。 */
  onDesync?: (frame: number) => void;
  /** 状态对账间隔（帧）；0 关闭。默认 600（10s @60fps）。 */
  hashIntervalFrames?: number;
}

const DEFAULT_SEED = 0x5eed1234;

/**
 * 把「输入源 → 同步引擎 → 游戏实例 → 渲染」串起来的运行时。
 * - solo / host：FrameClock 驱动权威 tick
 * - player / controller：由 Host 广播的帧驱动
 */
export class GameRuntime {
  readonly profile: RuntimeProfile;
  readonly manifest: GameManifest;

  #container: HTMLElement;
  #transport: Transport | null;
  #opts: GameRuntimeOptions;

  #engine: SyncEngine;
  #clock: FrameClock;
  #aggregator: InputAggregator;
  #touch: TouchController | null = null;
  #virtual: VirtualInputSource;
  #storage: GameStorage;
  #game: GameInstance | null = null;
  #raf = 0;
  #running = false;
  #lastInputs: PlayerInputs = { 1: {}, 2: {} };
  #tickListeners = new Set<(frame: number) => void>();
  #seed = DEFAULT_SEED;
  #hashInterval = 600;

  constructor(opts: GameRuntimeOptions) {
    this.#opts = opts;
    this.manifest = opts.manifest;
    this.profile = opts.profile;
    this.#container = opts.container;
    this.#transport = opts.transport ?? null;
    this.#storage = createGameStorage(opts.manifest.id);
    this.#virtual = new VirtualInputSource();

    const sources: InputSource[] = [new KeyboardInputSource(), new GamepadInputSource()];
    const touchHost = opts.touchContainer;
    if (touchHost) sources.push(this.#virtual);
    this.#aggregator = new InputAggregator(sources);

    if (touchHost) {
      this.#touch = new TouchController({
        container: touchHost,
        source: this.#virtual,
      });
    }

    const role: SyncRole = opts.profile;
    const hashInterval = opts.hashIntervalFrames ?? 600;
    this.#hashInterval = hashInterval;
    this.#engine = new SyncEngine({
      role,
      inputDelayFrames: opts.manifest.inputDelayFrames,
      transport: this.#transport,
      hashIntervalFrames: hashInterval,
      onResyncRequest: () => this.#snapshot(),
      handlers: {
        onFrame: (frame, inputs) => this.#handleFrame(frame, inputs),
        onSeed: (frame, seed) => {
          this.#seed = seed >>> 0;
          opts.onSeed?.(this.#seed);
          this.#ensureGame();
        },
        onControl: (e) => {
          if (e === "resync") return;
          opts.onControl?.(e);
        },
        onTransportState: (s) => opts.onTransportState?.(s),
        onState: (frame, payload) => this.#applySnapshot(frame, payload),
        onHashMismatch: (frame) => opts.onDesync?.(frame),
      },
    });

    this.#clock = new FrameClock(opts.manifest.tickRate);
    this.#clock.onTick((f) => this.#engine.tick(f));
  }

  get engine(): SyncEngine {
    return this.#engine;
  }

  get frame(): number {
    return this.#engine.frame;
  }

  get game(): GameInstance | null {
    return this.#game;
  }

  get touch(): TouchController | null {
    return this.#touch;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#aggregator.start();
    this.#aggregator.onChange((state) => this.#engine.setLocalInput(state));

    if (this.profile === "solo" || this.profile === "host") {
      this.#seed = (this.#opts.seed ?? DEFAULT_SEED) >>> 0;
      this.#ensureGame();
      this.#engine.start(this.#seed, 0);
      this.#engine.setLocalInput(this.#aggregator.snapshot());
      this.#clock.start();
    } else {
      // player / controller：等待 Host 的 frame 基准消息
      this.#engine.start(0, 0);
      this.#engine.setLocalInput(this.#aggregator.snapshot());
    }

    const renderLoop = () => {
      if (!this.#running) return;
      this.#game?.render();
      this.#raf = requestAnimationFrame(renderLoop);
    };
    this.#raf = requestAnimationFrame(renderLoop);
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    cancelAnimationFrame(this.#raf);
    this.#clock.stop();
    this.#aggregator.stop();
    this.#engine.destroy();
    this.#game?.destroy?.();
    this.#game = null;
    this.#touch?.destroy();
    this.#touch = null;
  }

  /** 主动暂停/恢复（仅 host 侧广播）。 */
  sendControl(event: "pause" | "resume" | "end"): void {
    this.#engine.sendControl(event);
  }

  sendGameMessage(msg: SyncMessage): void {
    if (!this.#transport || this.#transport.state === "closed") return;
    this.#transport.send("control", encodeMessage(msg));
  }

  onGameMessage(cb: (msg: SyncMessage) => void): () => void {
    if (!this.#transport) return () => {};
    return this.#transport.on("control", (data) => {
      const msg = decodeMessage(data);
      if (msg && typeof msg === "object" && "type" in msg) cb(msg as SyncMessage);
    });
  }

  #handleFrame(frame: number, inputs: PlayerInputs): void {
    this.#lastInputs = inputs;
    this.#game?.tick(frame, inputs);
    if (this.#hashInterval > 0 && frame % this.#hashInterval === 0) this.#reportHash(frame);
    for (const cb of this.#tickListeners) cb(frame);
    this.#opts.onFrame?.(frame, inputs);
  }

  #reportHash(frame: number): void {
    const snapshot = this.#game?.serialize?.();
    if (!snapshot) return;
    this.#engine.reportLocalHash(frame, hashBytes(snapshot));
  }

  #snapshot(): string | null {
    const bytes = this.#game?.serialize?.();
    return bytes ? toBase64(bytes) : null;
  }

  #applySnapshot(frame: number, payload: string): void {
    if (!this.#game?.applySnapshot) return;
    try {
      this.#game.applySnapshot(fromBase64(payload));
      this.#opts.onStatus?.(`已按房主快照重新同步（帧 ${frame}）`, "ok");
    } catch (err) {
      console.warn("[runtime] applySnapshot failed", err);
      this.#opts.onStatus?.("重同步失败", "bad");
    }
  }

  #ensureGame(): void {
    if (this.#game) return;
    if (this.profile === "controller") return;
    const registration = getRegisteredGame(this.manifest.id);
    if (!registration) {
      this.#opts.onStatus?.(`游戏未注册：${this.manifest.id}`, "bad");
      return;
    }
    this.#game = registration.create(this.#buildContext());
  }

  #buildContext(): GameContext {
    return {
      manifest: this.manifest,
      profile: this.profile,
      storage: this.#storage,
      view: this.#container,
      input: {
        get: (player: 1 | 2): Button[] =>
          Object.entries(this.#lastInputs[player])
            .filter(([, v]) => v === true)
            .map(([k]) => k as Button),
        getState: (player: 1 | 2): ButtonState => ({ ...this.#lastInputs[player] }),
      },
      frame: {
        now: () => this.#engine.frame,
        onTick: (cb) => {
          this.#tickListeners.add(cb);
          return () => this.#tickListeners.delete(cb);
        },
      },
      net: {
        send: (msg) => this.sendGameMessage(msg),
        on: (cb) => this.onGameMessage(cb),
        isMultiplayer: () => this.profile !== "solo",
        getSeed: () => this.#seed,
      },
    };
  }
}
