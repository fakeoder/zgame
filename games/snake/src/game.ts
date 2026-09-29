import type { Button, ButtonState } from "@zgame/protocol";
import type { GameContext, GameInstance } from "@zgame/game-sdk";

export const COLS = 31;
export const ROWS = 21;
export const ROUND_TICKS = 20 * 60; // 60 秒（tickRate=20）
export const GROW_PER_APPLE = 3;
const START_LEN = 4;

type Dir = "up" | "down" | "left" | "right";

interface Cell {
  x: number;
  y: number;
}

interface Snake {
  body: Cell[];
  dir: Dir;
  alive: boolean;
  score: number;
  grow: number;
}

export interface SnakeState {
  tick: number;
  rng: number;
  snakes: Snake[];
  apple: Cell;
  over: boolean;
  winner: 0 | 1 | 2 | null;
}

const DIR_VEC: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Dir, Dir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

/** 输入优先级固定，保证双端一致。 */
const DIR_BUTTONS: readonly (readonly [Button, Dir])[] = [
  ["UP", "up"],
  ["DOWN", "down"],
  ["LEFT", "left"],
  ["RIGHT", "right"],
];

/** xorshift32，整数状态，可序列化。 */
export function nextRandom(state: number): { value: number; state: number } {
  let s = state >>> 0;
  if (s === 0) s = 0x9e3779b9;
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  return { value: s / 0x100000000, state: s };
}

function dirFromButtons(buttons: Button[]): Dir | null {
  for (const [btn, dir] of DIR_BUTTONS) {
    if (buttons.includes(btn)) return dir;
  }
  return null;
}

function cellKey(c: Cell): number {
  return c.y * COLS + c.x;
}

function occupiedSet(snakes: Snake[]): Set<number> {
  const set = new Set<number>();
  for (const s of snakes) {
    if (!s.alive) continue;
    for (const c of s.body) set.add(cellKey(c));
  }
  return set;
}

export function createInitialState(seed: number): SnakeState {
  const midY = Math.floor(ROWS / 2);
  const mk = (headX: number, dir: Dir): Snake => {
    const vec = DIR_VEC[dir];
    const body: Cell[] = [];
    for (let i = 0; i < START_LEN; i++) {
      body.push({ x: headX - vec.x * i, y: midY - vec.y * i });
    }
    return { body, dir, alive: true, score: 0, grow: 0 };
  };

  const state: SnakeState = {
    tick: 0,
    rng: seed >>> 0,
    snakes: [mk(Math.floor(COLS / 2) - 6, "right"), mk(Math.floor(COLS / 2) + 6, "left")],
    apple: { x: 0, y: 0 },
    over: false,
    winner: null,
  };
  state.apple = spawnApple(state);
  return state;
}

function spawnApple(state: SnakeState): Cell {
  const taken = occupiedSet(state.snakes);
  const free: Cell[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!taken.has(y * COLS + x)) free.push({ x, y });
    }
  }
  if (free.length === 0) return { x: 0, y: 0 };
  const r = nextRandom(state.rng);
  state.rng = r.state;
  const idx = Math.floor(r.value * free.length) % free.length;
  return free[idx] ?? { x: 0, y: 0 };
}

/** 确定性贪心 AI，仅用于单机模式的 2 号蛇。 */
function aiDirection(state: SnakeState, snake: Snake): Dir | null {
  const head = snake.body[0];
  if (!head) return null;
  const apple = state.apple;
  const candidates: Dir[] = [];
  if (apple.x > head.x) candidates.push("right");
  if (apple.x < head.x) candidates.push("left");
  if (apple.y > head.y) candidates.push("down");
  if (apple.y < head.y) candidates.push("up");

  const taken = occupiedSet(state.snakes);
  const safe = (d: Dir): boolean => {
    const v = DIR_VEC[d];
    const nx = head.x + v.x;
    const ny = head.y + v.y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return false;
    const isTail = snake.body[snake.body.length - 1];
    if (isTail && isTail.x === nx && isTail.y === ny && snake.grow === 0) return true;
    return !taken.has(ny * COLS + nx);
  };

  for (const d of candidates) {
    if (d !== OPPOSITE[snake.dir] && safe(d)) return d;
  }
  for (const d of ["up", "down", "left", "right"] as Dir[]) {
    if (d !== OPPOSITE[snake.dir] && safe(d)) return d;
  }
  return null;
}

export interface StepOptions {
  /** 每个玩家当前按下的按键；无输入传空数组。 */
  inputs: Record<1 | 2, Button[]>;
  solo: boolean;
}

/** 单个逻辑帧；纯整数运算，无 Math.random / 浮点时间。 */
export function step(state: SnakeState, opts: StepOptions): SnakeState {
  if (state.over) return state;
  state.tick += 1;

  const desired: (Dir | null)[] = [null, null];
  for (let i = 0; i < 2; i++) {
    const snake = state.snakes[i];
    if (!snake || !snake.alive) continue;
    const key = (i === 0 ? 1 : 2) as 1 | 2;
    if (i === 1 && opts.solo) {
      desired[i] = aiDirection(state, snake);
    } else {
      const dir = dirFromButtons(opts.inputs[key]);
      desired[i] = dir && dir !== OPPOSITE[snake.dir] ? dir : null;
    }
  }

  let appleEaten = false;

  for (let i = 0; i < 2; i++) {
    const snake = state.snakes[i];
    if (!snake || !snake.alive) continue;

    const dir = desired[i];
    if (dir) snake.dir = dir;
    const vec = DIR_VEC[snake.dir];
    const head = snake.body[0];
    if (!head) {
      snake.alive = false;
      continue;
    }
    const newHead: Cell = { x: head.x + vec.x, y: head.y + vec.y };

    // 出界
    if (newHead.x < 0 || newHead.y < 0 || newHead.x >= COLS || newHead.y >= ROWS) {
      snake.alive = false;
      continue;
    }

    // 撞身体：先从占用集合里排除自己将要腾出的尾格
    const taken = occupiedSet(state.snakes);
    if (snake.grow === 0) {
      const tail = snake.body[snake.body.length - 1];
      if (tail) taken.delete(cellKey(tail));
    }
    if (taken.has(cellKey(newHead))) {
      snake.alive = false;
      continue;
    }

    snake.body.unshift(newHead);
    if (snake.grow > 0) {
      snake.grow -= 1;
    } else {
      snake.body.pop();
    }

    if (newHead.x === state.apple.x && newHead.y === state.apple.y) {
      snake.score += 1;
      snake.grow += GROW_PER_APPLE;
      appleEaten = true;
    }
  }

  if (appleEaten) state.apple = spawnApple(state);

  const alive = state.snakes.filter((s) => s.alive).length;
  const soloDead = opts.solo && !state.snakes[0]?.alive;
  if (alive === 0 || soloDead || state.tick >= ROUND_TICKS) {
    state.over = true;
    state.winner = decideWinner(state);
  }
  return state;
}

function decideWinner(state: SnakeState): 0 | 1 | 2 | null {
  const a = state.snakes[0]?.score ?? 0;
  const b = state.snakes[1]?.score ?? 0;
  if (a > b) return 1;
  if (b > a) return 2;
  return null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function serializeState(state: SnakeState): Uint8Array {
  return encoder.encode(JSON.stringify(state));
}

export function deserializeState(data: Uint8Array): SnakeState | null {
  try {
    const parsed = JSON.parse(decoder.decode(data)) as SnakeState;
    if (typeof parsed.tick !== "number" || !Array.isArray(parsed.snakes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface SnakeCanvasOptions {
  cellSize?: number;
}

/** Canvas 渲染；确定性无关，仅读取状态。 */
export class SnakeRenderer {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #cell: number;

  constructor(view: HTMLElement, cell = 16) {
    this.#cell = cell;
    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "snake-canvas";
    this.#canvas.width = COLS * cell;
    this.#canvas.height = ROWS * cell;
    view.appendChild(this.#canvas);
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.#ctx = ctx;
  }

  draw(state: SnakeState, scores?: { p1: number; p2: number }): void {
    const { ctx, cell } = { ctx: this.#ctx, cell: this.#cell };
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);

    // 网格
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, ROWS * cell);
      ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(COLS * cell, y * cell + 0.5);
      ctx.stroke();
    }

    // 苹果
    ctx.fillStyle = "#ff5c7a";
    ctx.beginPath();
    ctx.arc(
      state.apple.x * cell + cell / 2,
      state.apple.y * cell + cell / 2,
      cell * 0.34,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    const colors = ["#4ade80", "#60a5fa"];
    state.snakes.forEach((snake, i) => {
      ctx.fillStyle = snake.alive ? (colors[i] ?? "#fff") : "#334155";
      snake.body.forEach((c, idx) => {
        const pad = idx === 0 ? 1 : 2;
        ctx.fillRect(c.x * cell + pad, c.y * cell + pad, cell - pad * 2, cell - pad * 2);
      });
    });

    if (scores) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "600 13px ui-monospace, monospace";
      ctx.fillText(`P1 ${scores.p1}`, 8, 16);
      const right = `P2 ${scores.p2}`;
      ctx.fillText(right, this.#canvas.width - ctx.measureText(right).width - 8, 16);
    }

    if (state.over) {
      ctx.fillStyle = "rgba(2,6,23,0.72)";
      ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "700 22px system-ui, sans-serif";
      const msg =
        state.winner === null
          ? "平局"
          : `玩家 ${state.winner} 获胜`;
      const sub = `比分 ${state.snakes[0]?.score ?? 0} : ${state.snakes[1]?.score ?? 0}`;
      const w = ctx.measureText(msg).width;
      ctx.fillText(msg, (this.#canvas.width - w) / 2, this.#canvas.height / 2 - 8);
      const w2 = ctx.measureText(sub).width;
      ctx.font = "400 15px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(sub, (this.#canvas.width - w2) / 2, this.#canvas.height / 2 + 18);
    }
  }

  destroy(): void {
    this.#canvas.remove();
  }
}

const HIGH_SCORE_SLOT = "highscore";

export function createSnakeGame(ctx: GameContext): GameInstance {
  const solo = ctx.profile === "solo";
  const localPlayer: 1 | 2 = ctx.profile === "player" ? 2 : 1;

  const state = createInitialState(ctx.net.getSeed() >>> 0);
  let renderer: SnakeRenderer | null = null;
  let lastInputs: Record<1 | 2, Button[]> = { 1: [], 2: [] };

  const ensureRenderer = (): SnakeRenderer => {
    if (!renderer) renderer = new SnakeRenderer(ctx.view);
    return renderer;
  };

  void ctx.storage.load(HIGH_SCORE_SLOT).then(() => {
    // 高分仅在结算时写入，不参与模拟
  });

  const finish = async (): Promise<void> => {
    const best = await ctx.storage.load(HIGH_SCORE_SLOT);
    const mine = state.snakes[localPlayer - 1]?.score ?? 0;
    if (typeof best !== "number" || mine > best) {
      await ctx.storage.save(HIGH_SCORE_SLOT, mine);
    }
  };

  return {
    tick(_frame: number, inputs: { 1: ButtonState; 2: ButtonState }) {
      lastInputs = {
        1: pressedButtons(inputs[1]),
        2: pressedButtons(inputs[2]),
      };
      if (state.over) return;
      step(state, { inputs: lastInputs, solo });
      if (state.over) void finish();
    },

    render() {
      const r = ensureRenderer();
      r.draw(state, {
        p1: state.snakes[0]?.score ?? 0,
        p2: state.snakes[1]?.score ?? 0,
      });
    },

    serialize() {
      return serializeState(state);
    },

    applySnapshot(data: Uint8Array) {
      const next = deserializeState(data);
      if (!next) return;
      state.tick = next.tick;
      state.rng = next.rng;
      state.snakes = next.snakes;
      state.apple = next.apple;
      state.over = next.over;
      state.winner = next.winner;
    },

    destroy() {
      renderer?.destroy();
      renderer = null;
    },
  };
}

function pressedButtons(state: ButtonState): Button[] {
  const out: Button[] = [];
  for (const [k, v] of Object.entries(state)) {
    if (v === true) out.push(k as Button);
  }
  // 固定顺序，保证确定性
  const order: Button[] = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "X", "Y", "L", "R", "START", "SELECT"];
  return order.filter((b) => out.includes(b));
}
