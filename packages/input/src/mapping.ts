import type { Button, ButtonState } from "@zgame/protocol";
import { normalizeButtons } from "@zgame/protocol";
import type { InputSource } from "./sources.js";

export type ControllerMapping = Record<string, Button>;

export const DEFAULT_MAPPING: ControllerMapping = {
  UP: "UP",
  DOWN: "DOWN",
  LEFT: "LEFT",
  RIGHT: "RIGHT",
  A: "A",
  B: "B",
  X: "X",
  Y: "Y",
  L: "L",
  R: "R",
  START: "START",
  SELECT: "SELECT",
};

/** 按游戏 manifest 覆盖的按键映射。 */
export function applyMapping(
  state: ButtonState,
  mapping: ControllerMapping = DEFAULT_MAPPING,
): ButtonState {
  const out: ButtonState = {};
  for (const [from, to] of Object.entries(mapping)) {
    const value = state[from as Button];
    if (value !== undefined) out[to] = value;
  }
  return normalizeButtons(out);
}

/** 聚合多个输入源（键盘 + 手柄 + 触屏）为一个状态。 */
export class InputAggregator {
  #sources: InputSource[];
  #unsubs: (() => void)[] = [];
  #listeners = new Set<(all: ButtonState) => void>();

  constructor(sources: InputSource[]) {
    this.#sources = sources;
  }

  start(): void {
    for (const s of this.#sources) s.start?.();
    for (const s of this.#sources) {
      const unsub = s.onChange((_c, _a) => this.#notify());
      this.#unsubs.push(unsub);
    }
  }

  stop(): void {
    for (const fn of this.#unsubs) fn();
    this.#unsubs = [];
    for (const s of this.#sources) s.stop?.();
  }

  onChange(cb: (all: ButtonState) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  snapshot(): ButtonState {
    const merged: ButtonState = {};
    for (const s of this.#sources) {
      Object.assign(merged, s.snapshot());
    }
    return normalizeButtons(merged);
  }

  #notify(): void {
    const all = this.snapshot();
    for (const cb of this.#listeners) cb(all);
  }
}
