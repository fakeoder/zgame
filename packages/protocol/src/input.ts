import type { Button } from "./buttons.js";

/** 统一输入事件（设计文档 §14）。 */
export interface InputEvent {
  v: 1;
  type: "input";
  /** 目标应用帧（Host 权威时钟）。 */
  frame: number;
  player: 1 | 2;
  button: Button;
  pressed: boolean;
}

export function makeInputEvent(
  frame: number,
  player: 1 | 2,
  button: Button,
  pressed: boolean,
): InputEvent {
  return { v: 1, type: "input", frame, player, button, pressed };
}
