import type { Button, ButtonState, GameManifest, SyncMessage } from "@zgame/protocol";
import type { GameStorage } from "@zgame/storage";

export type GameProfile = "solo" | "host" | "player" | "controller";

export interface FrameApi {
  /** 当前权威帧号。 */
  now(): number;
  onTick(cb: (frame: number) => void): () => void;
}

export interface InputApi {
  /** 指定玩家当前帧按键状态（含远端）。 */
  get(player: 1 | 2): Button[];
  /** 全量状态，便于做「按住」判断。 */
  getState(player: 1 | 2): ButtonState;
}

export interface NetApi {
  send(msg: SyncMessage): void;
  on(cb: (msg: SyncMessage) => void): () => void;
  isMultiplayer(): boolean;
  /**
   * 本局随机种子。Host/solo 在开局时生成；
   * player 在收到 Host 的 frame 基准消息前应暂缓创建游戏实例。
   */
  getSeed(): number;
}

export interface GameContext {
  manifest: GameManifest;
  profile: GameProfile;
  storage: GameStorage;
  input: InputApi;
  frame: FrameApi;
  net: NetApi;
  /** 游戏画布所在容器。 */
  view: HTMLElement;
}

export interface GameInstance {
  /** 每个权威帧调用一次；必须是确定性逻辑。 */
  tick(frame: number, inputs: { 1: ButtonState; 2: ButtonState }): void;
  render(): void;
  /**
   * 全量快照（M3 重同步）。Host 按对账结果下发，Player 应用后继续跑。
   * 不实现则关闭状态对账与自动重同步。
   */
  serialize?(): Uint8Array;
  applySnapshot?(data: Uint8Array): void;
  destroy?(): void;
}

export interface RegisterGameOptions {
  manifest: GameManifest;
  create: (ctx: GameContext) => GameInstance;
}

const registry = new Map<string, RegisterGameOptions>();

/** 新游戏零平台改动：games/* 调用它完成注册。 */
export function registerGame(opts: RegisterGameOptions): void {
  if (registry.has(opts.manifest.id)) {
    console.warn(`[game-sdk] game "${opts.manifest.id}" re-registered, overwriting`);
  }
  registry.set(opts.manifest.id, opts);
}

export function getRegisteredGame(id: string): RegisterGameOptions | undefined {
  return registry.get(id);
}

export function listRegisteredGames(): GameManifest[] {
  return [...registry.values()].map((g) => g.manifest);
}
