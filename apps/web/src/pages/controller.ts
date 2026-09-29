import { getRegisteredGame } from "@zgame/game-sdk";
import type { WebRTCTransport } from "@zgame/net";
import type { Router } from "../router.js";
import { clearSession, loadSession, statusLabel } from "../session.js";
import { button, el, toast } from "../ui.js";
import { RoomConnection, type ConnectionPhase } from "../connection.js";
import { GameRuntime } from "../runtime.js";

/** 纯手柄页（D3 controller profile）：只发输入，不跑游戏。 */
export async function renderControllerPage(
  router: Router,
  outlet: HTMLElement,
  roomId: string,
): Promise<void> {
  const session = loadSession(roomId);
  if (!session) {
    outlet.append(
      el("div", { class: "panel" }, [
        el("h2", {}, ["没有本机会话"]),
        button("返回首页", () => router.navigate("/"), { kind: "primary" }),
      ]),
    );
    return;
  }

  const reg = getRegisteredGame(session.gameId);
  const body = el("div", {});

  const header = el("div", { class: "panel" });
  const badge = el("span", { class: "status status-warn" }, ["连接中"]);
  const phaseText = el("span", { class: "hint" }, [""]);
  header.append(
    el("div", {
      style: "display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap",
    }, [
      el("div", { style: "display:flex;gap:10px;align-items:center" }, [
        el("strong", {}, [`手柄 · ${roomId}`]),
        badge,
      ]),
      phaseText,
    ]),
  );
  body.append(header);

  const info = el("div", { class: "panel" });
  info.append(
    el("p", { class: "hint" }, [
      "本机只发送按键，不运行游戏。画面请看房主设备。方向键与 A/B 手感与实体手柄一致，按下即发、抬起即发。",
    ]),
  );
  body.append(info);

  const padHost = el("div", {});
  const stagePanel = el("div", { class: "panel" });
  stagePanel.append(el("h2", {}, ["虚拟手柄"]), padHost);
  const actionBar = el("div", { class: "btn-row" });
  const leaveBtn = button("断开并离开", () => void leave(), { kind: "danger", full: true });
  actionBar.append(leaveBtn);
  stagePanel.append(actionBar);
  body.append(stagePanel);

  const help = el("div", { class: "note" }, [
    "若提示直连失败：请让房主开启个人热点，你连接同一热点后重新扫码加入。",
  ]);
  body.append(help);

  outlet.append(body);

  let transport: WebRTCTransport | null = null;
  let runtime: GameRuntime | null = null;
  let phase: ConnectionPhase = "idle";
  let roomStatus: Parameters<RoomConnection["setStatus"]>[0] = "WAITING";

  const conn = new RoomConnection(session, {
    onPhase: (p) => {
      phase = p;
      render();
    },
    onStatus: (s) => {
      roomStatus = s;
      render();
      if (s === "CLOSED" || s === "EXPIRED") {
        toast("房间已结束");
        clearSession(roomId);
        router.navigate("/", true);
      }
    },
    onPlayers: () => {},
    onTransport: (t) => {
      transport = t;
      attachRuntime();
      render();
    },
    onTransportState: () => render(),
    onError: (err) => console.warn("[controller]", err),
  });

  router.onLeave(() => {
    runtime?.stop();
    runtime = null;
    conn.stop();
  });

  conn.start();
  attachRuntime();

  function attachRuntime(): void {
    if (runtime || !transport || !reg) return;
    runtime = new GameRuntime({
      manifest: reg.manifest,
      profile: "controller",
      container: padHost,
      touchContainer: padHost,
      transport,
      onSeed: () => render(),
    });
    runtime.start();
    toast("手柄已就绪");
  }

  async function leave(): Promise<void> {
    runtime?.stop();
    runtime = null;
    await conn.leave();
    clearSession(roomId);
    router.navigate("/", true);
  }

  function render(): void {
    const label = statusLabel(roomStatus);
    badge.className = `status status-${label.tone}`;
    badge.textContent = label.text;
    const map: Record<ConnectionPhase, string> = {
      idle: "",
      "waiting-player": "等待房主…",
      connecting: "正在建立 WebRTC 连接…",
      connected: "已连接，输入已生效",
      reconnecting: "连接中断，正在自动重连…",
      failed: "直连失败 — 请连接房主热点后重新扫码",
      closed: "已断开",
      "host-lost": "房主断线，按键暂不可用",
    };
    phaseText.textContent = map[phase] ?? "";
  }
}
