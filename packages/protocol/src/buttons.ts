export const BUTTONS = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "A",
  "B",
  "X",
  "Y",
  "L",
  "R",
  "START",
  "SELECT",
] as const;

export type Button = (typeof BUTTONS)[number];

export const BUTTON_SET: ReadonlySet<string> = new Set<string>(BUTTONS);

export function isButton(value: unknown): value is Button {
  return typeof value === "string" && BUTTON_SET.has(value);
}

export type ButtonState = Partial<Record<Button, boolean>>;

export function normalizeButtons(state: ButtonState): ButtonState {
  const out: ButtonState = {};
  for (const b of BUTTONS) {
    const v = state[b];
    if (v === true || v === false) out[b] = v;
  }
  return out;
}
