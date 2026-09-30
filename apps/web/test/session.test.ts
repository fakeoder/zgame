import { describe, expect, it } from "vitest";
import { inviteUrl, joinPath, parseJoinCode } from "../src/session.js";

const TOKEN = "v1Zx_9QaBcDeFgHiJkLmNoPqRsTuVwXyZ012345678-abc";

describe("parseJoinCode", () => {
  it("解析 ROOM-<token>", () => {
    expect(parseJoinCode(`A8F3K9-${TOKEN}`)).toEqual({ roomId: "A8F3K9", token: TOKEN });
  });

  it("拒绝畸形片段", () => {
    for (const bad of ["", "-token", "A8F3K9-", "A8F3K9-short", "lowercase-abcdefgh"]) {
      expect(parseJoinCode(bad)).toBeNull();
    }
  });

  it("修复旧版本把 roomId 拼两次的邀请链接", () => {
    expect(parseJoinCode(`A8F3K9-A8F3K9-${TOKEN}`)).toEqual({
      roomId: "A8F3K9",
      token: TOKEN,
    });
  });

  it("与 joinPath 往返", () => {
    const path = joinPath("A8F3K9", TOKEN);
    expect(parseJoinCode(path.slice("/join/".length))).toEqual({
      roomId: "A8F3K9",
      token: TOKEN,
    });
  });
});

describe("inviteUrl", () => {
  const source = { roomId: "A8F3K9", joinUrl: `https://old.example/join/A8F3K9-${TOKEN}` };

  it("改写成当前站点", () => {
    expect(inviteUrl(source, "https://zgame.example")).toBe(
      `https://zgame.example/join/A8F3K9-${TOKEN}`,
    );
  });

  it("修复 roomId 拼两次的旧链接（不再生成 invalid join token）", () => {
    expect(
      inviteUrl({ roomId: "A8F3K9", joinUrl: `https://old.example/join/A8F3K9-A8F3K9-${TOKEN}` }, "https://zgame.example"),
    ).toBe(`https://zgame.example/join/A8F3K9-${TOKEN}`);
  });

  it("没有 joinUrl 时不给出坏链接", () => {
    expect(inviteUrl({ roomId: "A8F3K9" }, "https://zgame.example")).toBeNull();
    expect(inviteUrl({ roomId: "A8F3K9", joinUrl: "https://zgame.example/join/A8F3K9" }, "https://zgame.example")).toBeNull();
    expect(
      inviteUrl({ roomId: "A8F3K9", joinUrl: `https://zgame.example/join/OTHER99-${TOKEN}` }, "https://zgame.example"),
    ).toBeNull();
  });
});
