import { describe, expect, it } from "vitest";
import { FrameClock } from "../src/frame-clock.js";

describe("FrameClock", () => {
  it("advances frames in manual mode", () => {
    const clock = new FrameClock(20);
    const seen: number[] = [];
    clock.onTick((f) => seen.push(f));
    clock.start();
    expect(clock.isManual()).toBe(true);
    clock.step();
    clock.step();
    expect(seen).toEqual([1, 2]);
    expect(clock.frame).toBe(2);
    clock.stop();
  });

  it("unsubscribes listeners", () => {
    const clock = new FrameClock(20);
    const seen: number[] = [];
    const off = clock.onTick((f) => seen.push(f));
    clock.start();
    clock.step();
    off();
    clock.step();
    expect(seen).toEqual([1]);
    clock.stop();
  });
});
