import type { Button, ButtonState } from "@zgame/protocol";
import { isButton } from "@zgame/protocol";

export type InputSourceKind = "keyboard" | "touch" | "gamepad" | "remote";

export interface InputSnapshot {
  buttons: ButtonState;
}

/** 输入源：把设备事件归一化为平台 Button 集合。 */
export interface InputSource {
  readonly kind: InputSourceKind;
  /** 当前帧的按键状态全量快照。 */
  snapshot(): ButtonState;
  /** 订阅状态变化（按下/抬起）。返回取消函数。 */
  onChange(cb: (changed: ButtonState, all: ButtonState) => void): () => void;
  start?(): void;
  stop?(): void;
}

export abstract class BaseInputSource implements InputSource {
  abstract readonly kind: InputSourceKind;
  protected state: ButtonState = {};
  #listeners = new Set<(changed: ButtonState, all: ButtonState) => void>();

  start(): void {
    /* 默认无副作用 */
  }

  stop(): void {
    /* 默认无副作用 */
  }

  snapshot(): ButtonState {
    return { ...this.state };
  }

  onChange(cb: (changed: ButtonState, all: ButtonState) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  protected setButton(button: Button, pressed: boolean): boolean {
    if (this.state[button] === pressed) return false;
    this.state = { ...this.state, [button]: pressed };
    const changed: ButtonState = { [button]: pressed };
    for (const cb of this.#listeners) cb(changed, this.snapshot());
    return true;
  }

  protected setState(next: ButtonState): void {
    const changed: ButtonState = {};
    let dirty = false;
    for (const key of Object.keys(next) as Button[]) {
      if (this.state[key] !== next[key]) {
        changed[key] = next[key];
        dirty = true;
      }
    }
    if (!dirty) return;
    this.state = { ...next };
    for (const cb of this.#listeners) cb(changed, this.snapshot());
  }
}

/** 键盘输入源。默认方向键 + Z/X + Enter/Shift。 */
export class KeyboardInputSource extends BaseInputSource {
  readonly kind = "keyboard" as const;
  #map: Record<string, Button>;
  #down = (e: KeyboardEvent) => {
    const b = this.#map[e.code];
    if (!b) return;
    e.preventDefault();
    this.setButton(b, true);
  };
  #up = (e: KeyboardEvent) => {
    const b = this.#map[e.code];
    if (!b) return;
    e.preventDefault();
    this.setButton(b, false);
  };
  #blur = () => this.setState({});
  #attached = false;

  constructor(map?: Partial<Record<string, Button>>) {
    super();
    this.#map = {
      ArrowUp: "UP",
      ArrowDown: "DOWN",
      ArrowLeft: "LEFT",
      ArrowRight: "RIGHT",
      KeyW: "UP",
      KeyS: "DOWN",
      KeyA: "LEFT",
      KeyD: "RIGHT",
      KeyJ: "A",
      KeyK: "B",
      KeyZ: "A",
      KeyX: "B",
      Enter: "START",
      ShiftRight: "SELECT",
      ShiftLeft: "SELECT",
      ...map,
    };
  }

  override start(): void {
    if (this.#attached || typeof window === "undefined") return;
    window.addEventListener("keydown", this.#down);
    window.addEventListener("keyup", this.#up);
    window.addEventListener("blur", this.#blur);
    this.#attached = true;
  }

  override stop(): void {
    if (!this.#attached || typeof window === "undefined") return;
    window.removeEventListener("keydown", this.#down);
    window.removeEventListener("keyup", this.#up);
    window.removeEventListener("blur", this.#blur);
    this.#attached = false;
  }
}

const STANDARD_MAPPING: readonly (readonly [number, Button])[] = [
  [12, "UP"],
  [13, "DOWN"],
  [14, "LEFT"],
  [15, "RIGHT"],
  [0, "A"],
  [1, "B"],
  [2, "X"],
  [3, "Y"],
  [4, "L"],
  [5, "R"],
  [9, "START"],
  [8, "SELECT"],
];

const AXES_MAPPING: readonly (readonly [number, number, Button])[] = [
  [0, -1, "UP"],
  [0, 1, "DOWN"],
  [1, -1, "LEFT"],
  [1, 1, "RIGHT"],
];

const AXIS_DEADZONE = 0.5;

/** Gamepad API 输入源：rAF 轮询。 */
export class GamepadInputSource extends BaseInputSource {
  readonly kind = "gamepad" as const;
  #index: number | null = null;
  #raf = 0;
  #running = false;

  override start(): void {
    if (this.#running || typeof window === "undefined") return;
    this.#running = true;
    window.addEventListener("gamepadconnected", this.#onConnect);
    window.addEventListener("gamepaddisconnected", this.#onDisconnect);
    if (navigator.getGamepads) {
      const pads = navigator.getGamepads();
      for (const p of pads) {
        if (p) {
          this.#index = p.index;
          break;
        }
      }
    }
    const loop = () => {
      if (!this.#running) return;
      this.#poll();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  override stop(): void {
    if (!this.#running || typeof window === "undefined") return;
    this.#running = false;
    cancelAnimationFrame(this.#raf);
    window.removeEventListener("gamepadconnected", this.#onConnect);
    window.removeEventListener("gamepaddisconnected", this.#onDisconnect);
  }

  #onConnect = (e: GamepadEvent) => {
    this.#index = e.gamepad.index;
  };

  #onDisconnect = (e: GamepadEvent) => {
    if (this.#index === e.gamepad.index) {
      this.#index = null;
      this.setState({});
    }
  };

  #poll(): void {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (this.#index !== null) pad = pads[this.#index] ?? null;
    if (!pad) {
      for (const p of pads) {
        if (p) {
          pad = p;
          this.#index = p.index;
          break;
        }
      }
    }
    if (!pad) return;

    const next: ButtonState = {};
    for (const [index, button] of STANDARD_MAPPING) {
      const b = pad.buttons[index];
      if (b) next[button] = b.pressed || b.value > 0.5;
    }
    for (const [axisIndex, dir, button] of AXES_MAPPING) {
      const axis = pad.axes[axisIndex];
      if (typeof axis === "number" && (dir < 0 ? axis < -AXIS_DEADZONE : axis > AXIS_DEADZONE)) {
        next[button] = true;
      }
    }
    this.setState(next);
  }
}

/** 手动注入输入源（远程手柄 / 测试）。 */
export class VirtualInputSource extends BaseInputSource {
  readonly kind = "remote" as const;

  press(button: Button, pressed: boolean): void {
    this.setButton(button, pressed);
  }

  applyState(state: ButtonState): void {
    const next: ButtonState = {};
    for (const key of Object.keys(state) as Button[]) {
      if (isButton(key)) next[key] = state[key] === true;
    }
    this.setState(next);
  }
}
