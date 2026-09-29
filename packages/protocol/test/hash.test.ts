import { describe, expect, it } from "vitest";
import { fromBase64, hashBytes, hashText, toBase64 } from "../src/index.js";

describe("hash", () => {
  it("FNV-1a 跨端稳定且 8 位十六进制", () => {
    expect(hashText("")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });

  it("字节与文本同源", () => {
    const bytes = new TextEncoder().encode("snake-state");
    expect(hashBytes(bytes)).toBe(hashText("snake-state"));
  });

  it("不同长度内容不冲突", () => {
    expect(hashText("a")).not.toBe(hashText("aa"));
  });
});

describe("base64", () => {
  it("往返还原字节", () => {
    const src = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...fromBase64(toBase64(src))]).toEqual([...src]);
  });

  it("空与长数组均可还原", () => {
    const empty = new Uint8Array(0);
    expect(fromBase64(toBase64(empty)).length).toBe(0);

    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    expect([...fromBase64(toBase64(big))]).toEqual([...big]);
  });
});
