import { describe, expect, it } from "vitest";
import { createRng, rngInt } from "../src/rng.js";

describe("createRng", () => {
  it("is deterministic for the same seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("differs for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a()).not.toBe(b());
  });

  it("never returns 0 seed state (avoids stuck at 0)", () => {
    const r = createRng(0);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("rngInt stays in range", () => {
    const r = createRng(99);
    for (let i = 0; i < 500; i++) {
      const v = rngInt(r, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });
});
