import type { Button } from "@zgame/protocol";
import type { VirtualInputSource } from "./sources.js";

export interface TouchButtonDef {
  button: Button;
  label: string;
  kind: "dpad" | "action" | "meta";
}

export const DEFAULT_TOUCH_BUTTONS: TouchButtonDef[] = [
  { button: "UP", label: "↑", kind: "dpad" },
  { button: "LEFT", label: "←", kind: "dpad" },
  { button: "RIGHT", label: "→", kind: "dpad" },
  { button: "DOWN", label: "↓", kind: "dpad" },
  { button: "A", label: "A", kind: "action" },
  { button: "B", label: "B", kind: "action" },
  { button: "X", label: "X", kind: "action" },
  { button: "Y", label: "Y", kind: "action" },
  { button: "L", label: "L", kind: "meta" },
  { button: "R", label: "R", kind: "meta" },
  { button: "SELECT", label: "SEL", kind: "meta" },
  { button: "START", label: "STA", kind: "meta" },
];

export interface TouchControllerOptions {
  container: HTMLElement;
  source: VirtualInputSource;
  buttons?: TouchButtonDef[];
  /** 按键状态回调（用于广播快照）。 */
  onChange?: (button: Button, pressed: boolean) => void;
}

/**
 * 触屏虚拟手柄：按下即发、抬起即发（成对，防丢键）。
 * 使用 pointer 事件 + setPointerCapture，支持多点触控。
 */
export class TouchController {
  #opts: TouchControllerOptions;
  #els = new Map<Button, HTMLElement>();
  #activePointers = new Map<number, Button>();
  #detach: (() => void)[] = [];

  constructor(opts: TouchControllerOptions) {
    this.#opts = opts;
    this.#render();
  }

  destroy(): void {
    for (const fn of this.#detach) fn();
    this.#detach = [];
    this.#opts.container.innerHTML = "";
    this.#els.clear();
  }

  #render(): void {
    const { container, buttons = DEFAULT_TOUCH_BUTTONS } = this.#opts;
    container.classList.add("touch-controller");
    container.innerHTML = "";

    const dpad = buttons.filter((b) => b.kind === "dpad");
    const actions = buttons.filter((b) => b.kind === "action");
    const meta = buttons.filter((b) => b.kind === "meta");

    const left = document.createElement("div");
    left.className = "tc-cluster tc-dpad";
    for (const def of dpad) left.appendChild(this.#button(def));

    const right = document.createElement("div");
    right.className = "tc-cluster tc-actions";
    for (const def of actions) right.appendChild(this.#button(def));

    const bar = document.createElement("div");
    bar.className = "tc-cluster tc-meta";
    for (const def of meta) bar.appendChild(this.#button(def));

    container.append(left, right, bar);
  }

  #button(def: TouchButtonDef): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `tc-btn tc-${def.kind} tc-${def.button}`;
    el.dataset["button"] = def.button;
    el.textContent = def.label;
    el.setAttribute("aria-label", def.button);
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", this.#onPointerDown);
    el.addEventListener("pointerup", this.#onPointerUp);
    el.addEventListener("pointercancel", this.#onPointerUp);
    el.addEventListener("pointerleave", this.#onPointerUp);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.#els.set(def.button, el);
    return el;
  }

  #onPointerDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const button = el.dataset["button"] as Button | undefined;
    if (!button) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-pressed");
    this.#activePointers.set(e.pointerId, button);
    this.#emit(button, true);
  };

  #onPointerUp = (e: PointerEvent) => {
    const button = this.#activePointers.get(e.pointerId);
    if (!button) return;
    const el = this.#els.get(button);
    el?.classList.remove("is-pressed");
    this.#activePointers.delete(e.pointerId);
    // 同一键位可能被多个手指按住，仍按下则不发抬起
    if ([...this.#activePointers.values()].includes(button)) return;
    this.#emit(button, false);
  };

  #emit(button: Button, pressed: boolean): void {
    this.#opts.source.press(button, pressed);
    this.#opts.onChange?.(button, pressed);
  }
}
