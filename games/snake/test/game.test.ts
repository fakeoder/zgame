import { describe, expect, it } from "vitest";
import {
  COLS,
  ROUND_TICKS,
  createInitialState,
  deserializeState,
  nextRandom,
  serializeState,
  step,
} from "../src/game.js";

const noInput = { 1: [], 2: [] } as const;

describe("snake core", () => {
  it("createInitialState 是确定性的", () => {
    const a = createInitialState(42);
    const b = createInitialState(42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(createInitialState(43).rng).not.toBe(a.rng);
  });

  it("同一输入序列产生完全相同的状态", () => {
    const a = createInitialState(7);
    const b = createInitialState(7);
    const seq = [
      { 1: ["RIGHT" as const], 2: ["LEFT" as const] },
      { 1: ["DOWN" as const], 2: ["UP" as const] },
      noInput,
      { 1: ["LEFT" as const], 2: ["RIGHT" as const] },
    ];
    for (let i = 0; i < 6; i++) {
      const input = seq[i % seq.length] ?? noInput;
      step(a, { inputs: input, solo: false });
      step(b, { inputs: input, solo: false });
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("禁止 180° 掉头", () => {
    const s = createInitialState(1);
    const snake = s.snakes[0]!;
    expect(snake.dir).toBe("right");
    step(s, { inputs: { 1: ["LEFT"], 2: [] }, solo: false });
    expect(snake.dir).toBe("right");
    step(s, { inputs: { 1: ["UP"], 2: [] }, solo: false });
    expect(snake.dir).toBe("up");
  });

  it("出界即死亡并结束单机局", () => {
    const s = createInitialState(1);
    // 一路向右直到撞墙
    let guard = 0;
    while (!s.over && guard < COLS + 10) {
      step(s, { inputs: { 1: ["RIGHT"], 2: [] }, solo: true });
      guard++;
    }
    expect(s.over).toBe(true);
    expect(s.snakes[0]?.alive).toBe(false);
    expect(s.winner === 2 || s.winner === null).toBe(true);
  });

  it("吃到苹果分数增加且生成新苹果", () => {
    const s = createInitialState(3);
    s.snakes[0]!.body = [{ x: 5, y: 5 }];
    s.snakes[0]!.dir = "right";
    s.apple = { x: 6, y: 5 };
    step(s, { inputs: { 1: ["RIGHT"], 2: [] }, solo: true });
    expect(s.snakes[0]?.score).toBe(1);
    expect(s.snakes[0]?.grow).toBeGreaterThan(0);
    expect(s.apple).not.toEqual({ x: 6, y: 5 });
  });

  it("回合时长到点自动结算", () => {
    const s = createInitialState(5);
    s.tick = ROUND_TICKS - 1;
    step(s, { inputs: noInput, solo: true });
    expect(s.over).toBe(true);
    expect(s.tick).toBe(ROUND_TICKS);
  });

  it("serialize 往返保持状态", () => {
    const s = createInitialState(9);
    step(s, { inputs: { 1: ["DOWN"], 2: ["UP"] }, solo: false });
    const back = deserializeState(serializeState(s));
    expect(back).toEqual(s);
  });

  it("xorshift32 序列稳定", () => {
    const a = nextRandom(12345);
    const b = nextRandom(12345);
    expect(a.state).toBe(b.state);
    expect(a.value).toBe(b.value);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
  });
});
