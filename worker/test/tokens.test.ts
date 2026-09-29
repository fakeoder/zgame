import { describe, expect, it } from "vitest";
import { buildJoinPath, generateRoomId, generateToken, hashToken, parseJoinPath } from "../src/tokens.js";

describe("tokens", () => {
  it("生成无歧义 Room ID", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateRoomId();
      expect(id).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      expect(id).not.toMatch(/[01OI]/);
    }
  });

  it("Room ID 不重复（500 次碰撞检查）", () => {
    const set = new Set<string>();
    for (let i = 0; i < 500; i++) set.add(generateRoomId());
    expect(set.size).toBe(500);
  });

  it("Token 足够随机且 URL 安全", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(43);
  });

  it("hashToken 稳定且不可逆", async () => {
    const t = "abc123";
    const h1 = await hashToken(t);
    const h2 = await hashToken(t);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(await hashToken("abc124")).not.toBe(h1);
  });

  it("Join URL 编解码往返", () => {
    const token = generateToken();
    const path = buildJoinPath("A8F3K9", token);
    expect(path).toBe(`/join/A8F3K9-${token}`);
    const parsed = parseJoinPath(path.replace("/join/", ""));
    expect(parsed).toEqual({ roomId: "A8F3K9", token });
  });

  it("拒绝畸形 join 片段", () => {
    expect(parseJoinPath("")).toBeNull();
    expect(parseJoinPath("-token")).toBeNull();
    expect(parseJoinPath("A8F3K9-")).toBeNull();
    expect(parseJoinPath("A8F3K9-short")).toBeNull();
    expect(parseJoinPath("lowercase-A8F3K9-token-value")).toBeNull();
  });
});
