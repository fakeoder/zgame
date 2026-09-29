import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, resolveLiveness, resumeStatus } from "../src/state.js";

const CFG = { hostLossTimeoutMs: 45_000, roomTtlMs: 1_800_000 };

describe("room state machine", () => {
  it("CREATED → WAITING → PLAYING ⇄ PAUSED", () => {
    expect(canTransition("CREATED", "WAITING")).toBe(true);
    expect(canTransition("WAITING", "PLAYING")).toBe(true);
    expect(canTransition("PLAYING", "PAUSED")).toBe(true);
    expect(canTransition("PAUSED", "PLAYING")).toBe(true);
  });

  it("PLAYING → HOST_LOST → PLAYING", () => {
    expect(canTransition("PLAYING", "HOST_LOST")).toBe(true);
    expect(canTransition("HOST_LOST", "PLAYING")).toBe(true);
    expect(canTransition("HOST_LOST", "WAITING")).toBe(true);
  });

  it("终态不可再迁移", () => {
    expect(isTerminal("CLOSED")).toBe(true);
    expect(isTerminal("EXPIRED")).toBe(true);
    expect(canTransition("CLOSED", "PLAYING")).toBe(false);
    expect(canTransition("EXPIRED", "WAITING")).toBe(false);
    expect(canTransition("CLOSED", "CLOSED")).toBe(true);
  });

  it("禁止跳过状态（WAITING 不能直接 HOST_LOST 之后又 PLAYING 之外的非法迁移）", () => {
    expect(canTransition("CREATED", "PLAYING")).toBe(false);
    expect(canTransition("WAITING", "CLOSED")).toBe(true);
  });
});

describe("resolveLiveness", () => {
  const now = 1_000_000;

  it("心跳新鲜则保持原状态", () => {
    expect(
      resolveLiveness({ status: "PLAYING", lastHeartbeat: now - 10_000, now }, CFG),
    ).toBe("PLAYING");
    expect(
      resolveLiveness({ status: "WAITING", lastHeartbeat: now - 10_000, now }, CFG),
    ).toBe("WAITING");
  });

  it("超时 45s → HOST_LOST", () => {
    expect(
      resolveLiveness({ status: "PLAYING", lastHeartbeat: now - 46_000, now }, CFG),
    ).toBe("HOST_LOST");
    expect(
      resolveLiveness({ status: "HOST_LOST", lastHeartbeat: now - 46_000, now }, CFG),
    ).toBe("HOST_LOST");
  });

  it("超时 30min → EXPIRED", () => {
    expect(
      resolveLiveness({ status: "HOST_LOST", lastHeartbeat: now - 1_900_000, now }, CFG),
    ).toBe("EXPIRED");
    expect(
      resolveLiveness({ status: "PLAYING", lastHeartbeat: now - 1_900_000, now }, CFG),
    ).toBe("EXPIRED");
  });

  it("终态与 CREATED 不被心跳判定改写", () => {
    expect(resolveLiveness({ status: "CLOSED", lastHeartbeat: null, now }, CFG)).toBe("CLOSED");
    expect(resolveLiveness({ status: "EXPIRED", lastHeartbeat: null, now }, CFG)).toBe("EXPIRED");
    expect(resolveLiveness({ status: "CREATED", lastHeartbeat: null, now }, CFG)).toBe("CREATED");
    expect(resolveLiveness({ status: "CREATED", lastHeartbeat: now, now }, CFG)).toBe("CREATED");
  });

  it("从未心跳（null）保持原状态", () => {
    expect(resolveLiveness({ status: "WAITING", lastHeartbeat: null, now }, CFG)).toBe("WAITING");
  });
});

describe("resumeStatus", () => {
  it("恢复到丢失前的状态", () => {
    expect(resumeStatus("PLAYING")).toBe("PLAYING");
    expect(resumeStatus("PAUSED")).toBe("PAUSED");
    expect(resumeStatus("WAITING")).toBe("WAITING");
    expect(resumeStatus(null)).toBe("WAITING");
    expect(resumeStatus("CLOSED")).toBe("WAITING");
  });
});
