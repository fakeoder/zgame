import QRCode from "qrcode";
import { getRegisteredGame } from "@zgame/game-sdk";
import type { PlayerSnapshot, RoomStatus } from "@zgame/protocol";
import type { WebRTCTransport } from "@zgame/net";
import type { Router } from "../router.js";
import { clearSession, inviteUrl, loadSession, statusLabel } from "../session.js";
import { button, copyText, el, toast } from "../ui.js";
import { GameRuntime } from "../runtime.js";
import { RoomConnection, type ConnectionPhase } from "../connection.js";

export async function renderRoomPage(
  router: Router,
  outlet: HTMLElement,
  roomId: string,
): Promise<void> {
  const session = loadSession(roomId);
  if (!session) {
    const body = el("div", { class: "panel" }, [
      el("h2", {}, ["没有本机会话"]),
      el("p", { class: "hint" }, [`房间 ${roomId} 的凭据不在本机浏览器中。请通过邀请链接加入。`]),
      button("返回首页", () => router.navigate("/"), { kind: "primary" }),
    ]);
    outlet.append(body);
    return;
  }

  if (session.role === "player" && session.profile === "controller") {
    router.navigate(`/controller/${roomId}`, true);
    return;
  }

  const reg = getRegisteredGame(session.gameId);
  if (!reg) {
    outlet.append(
      el("div", { class: "panel" }, [
        el("h2", {}, ["游戏未安装"]),
        el("p", { class: "hint" }, [`本机没有注册游戏 ${session.gameId}。`]),
      ]),
    );
    return;
  }

  const isHost = session.role === "host";
  const body = el("div", {});

  // ---- 顶部状态 ----
  const header = el("div", { class: "panel" });
  const statusBadge = el("span", { class: "status status-warn" }, ["连接中"]);
  const phaseText = el("span", { class: "hint" }, [""]);
  const headRow = el("div", { style: "display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap" });
  headRow.append(
    el("div", { style: "display:flex;gap:10px;align-items:center" }, [
      el("strong", {}, [`房间 ${roomId}`]),
      statusBadge,
    ]),
    phaseText,
  );
  header.append(headRow);
  body.append(header);

  // ---- 房主：邀请 ----
  let invitePanel: HTMLElement | null = null;
  if (isHost) {
    invitePanel = el("div", { class: "panel" });
    invitePanel.append(el("h2", {}, ["邀请玩家"]));
    // 拿不到合法 join code 就不要展示坏链接（扫出来只会是 invalid join token）
    const url = inviteUrl(session, window.location.origin);
    if (url) {
      const qrWrap = el("div", { class: "qr-wrap" });
      const qrBox = el("div", { class: "qr-box" });
      const qrImg = document.createElement("img");
      qrImg.alt = "邀请二维码";
      qrBox.append(qrImg);
      const side = el("div", { class: "qr-side" });
      const urlBox = el("div", { class: "url-box" }, [url]);
      const copyBtn = button("复制邀请链接", async () => {
        const ok = await copyText(url);
        toast(ok ? "已复制" : "复制失败，请手动选择链接");
      });
      side.append(
        el("p", { class: "hint" }, ["让玩家用手机扫码，或把链接发给对方。玩家加入后这里会显示列表。"]),
        urlBox,
        copyBtn,
      );
      qrWrap.append(qrBox, side);
      invitePanel.append(qrWrap);
      void QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: "#0b1020", light: "#ffffff" } })
        .then((dataUrl) => {
          qrImg.src = dataUrl;
        })
        .catch((err) => {
          console.error(err);
          qrBox.replaceWith(el("p", { class: "hint" }, ["二维码生成失败，可直接复制下方链接。"]));
        });
    } else {
      invitePanel.append(
        el("p", { class: "hint" }, [
          "本机保存的邀请链接不可用（可能来自旧版本会话）。请关闭房间后重新创建，以生成新的二维码。",
        ]),
      );
    }
    body.append(invitePanel);
  }

  // ---- 玩家列表 ----
  const listPanel = el("div", { class: "panel" });
  listPanel.append(el("h2", {}, ["玩家"]));
  const playerList = el("ul", { class: "player-list" });
  playerList.append(el("li", {}, [el("span", {}, [isHost ? "房主（本机）" : "本机"]), el("span", { class: "tag" }, ["你"])]));
  listPanel.append(playerList);
  body.append(listPanel);

  // ---- 舞台 ----
  const stagePanel = el("div", { class: "panel" });
  stagePanel.append(el("h2", {}, ["游戏"]));
  const stage = el("div", { class: "stage" });
  const overlay = el("div", { class: "overlay" });
  const overlayTitle = el("h3", {}, [isHost ? "等待玩家加入" : "等待房主开始"]);
  const overlayText = el("p", {}, [
    isHost ? "玩家扫码加入并建立连接后，即可开始游戏。" : "连接建立后，房主开始游戏时本机自动同步。",
  ]);
  const overlayExtra = el("div", { class: "overlay-extra" });
  overlay.append(overlayTitle, overlayText, overlayExtra);
  stage.append(overlay);
  const touchHost = el("div", {});
  const actionBar = el("div", { class: "btn-row" });
  stagePanel.append(stage, touchHost, actionBar);
  body.append(stagePanel);

  // ---- 操作按钮 ----
  let startBtn: HTMLButtonElement | null = null;
  let resumeBtn: HTMLButtonElement | null = null;
  if (isHost) {
    startBtn = button("开始游戏", () => void startGame(), { kind: "primary", disabled: true });
    resumeBtn = button("暂停", () => {
      runtime?.sendControl("pause");
    }, { kind: "ghost", disabled: true });
    const leaveBtn = button("关闭房间", () => void closeRoom(), { kind: "danger" });
    actionBar.append(startBtn, resumeBtn, leaveBtn);
  } else {
    const leaveBtn = button("离开房间", () => void leaveRoom(), { kind: "danger" });
    actionBar.append(leaveBtn);
  }

  body.append(
    el("div", { class: "note" }, [
      isHost
        ? "游戏运行在本机，进度保存在本机浏览器 IndexedDB；实时数据通过 WebRTC 直连（同网段自动走局域网）传输，Cloudflare 只做房间与信令。"
        : "游戏状态由房主权威帧驱动；本机渲染同一份确定性逻辑。",
    ]),
  );
  outlet.append(body);

  // ---- 连接 ----
  let transport: WebRTCTransport | null = null;
  let runtime: GameRuntime | null = null;
  let players: PlayerSnapshot[] = [];
  let phase: ConnectionPhase = "idle";
  let roomStatus: RoomStatus = "WAITING";
  let started = false;

  const conn = new RoomConnection(session, {
    onPhase: (p) => {
      phase = p;
      renderPhase();
    },
    onStatus: (s) => {
      roomStatus = s;
      renderPhase();
      if (!isHost && s === "PLAYING" && transport?.state === "open") ensurePlayerRuntime();
      if (s === "CLOSED" || s === "EXPIRED") {
        toast("房间已结束");
        clearSession(roomId);
        router.navigate("/", true);
      }
    },
    onPlayers: (list) => {
      players = list;
      renderPlayers();
    },
    onTransport: (t) => {
      transport = t;
      if (isHost && startBtn) startBtn.disabled = false;
      renderPhase();
    },
    onTransportState: () => renderPhase(),
    onError: (err) => console.warn("[room]", err),
  });

  router.onLeave(() => {
    runtime?.stop();
    runtime = null;
    conn.stop();
  });

  conn.start();

  if (!isHost) {
    // 玩家：传输就绪即准备运行时（等 frame 基准到达后自动创建游戏）
    ensurePlayerRuntime();
  }

  function ensurePlayerRuntime(): void {
    if (runtime || !transport) return;
    overlayTitle.textContent = "连接中";
    overlayText.textContent = "等待房主开始游戏…";
    runtime = new GameRuntime({
      manifest: reg!.manifest,
      profile: "player",
      container: stage,
      transport,
      onSeed: () => {
        overlay.style.display = "none";
        toast("已同步到房主帧基准");
      },
      onDesync: (frame) => {
        console.warn("[room] player state hash mismatch at frame", frame);
        toast("检测到状态不同步，正在重同步…");
      },
      onControl: (e) => {
        if (e === "pause") showOverlay("已暂停", "房主暂停了游戏。");
        if (e === "resume") overlay.style.display = "none";
        if (e === "end") showOverlay("本局结束", "房主结束了本局。");
      },
      onTransportState: () => renderPhase(),
    });
    runtime.start();
  }

  async function startGame(): Promise<void> {
    if (!transport || transport.state !== "open") {
      toast("玩家尚未连接，无法开始");
      return;
    }
    if (started) return;
    started = true;
    if (startBtn) startBtn.disabled = true;

    const seed = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0x5eed1234) >>> 0;
    runtime = new GameRuntime({
      manifest: reg!.manifest,
      profile: "host",
      container: stage,
      touchContainer: isTouch() ? touchHost : undefined,
      transport,
      seed,
      onControl: (e) => {
        if (e === "pause") showOverlay("已暂停", "房主暂停了游戏。");
        if (e === "resume") overlay.style.display = "none";
      },
      onTransportState: () => renderPhase(),
      onDesync: (frame) => {
        console.warn("[room] host state hash mismatch at frame", frame);
        toast("检测到状态不同步，已自动纠正");
      },
    });
    runtime.start();
    overlay.style.display = "none";
    if (resumeBtn) resumeBtn.disabled = false;
    try {
      await conn.setStatus("PLAYING");
    } catch (err) {
      console.warn("[room] setStatus failed", err);
    }
    toast("游戏已开始");
  }

  async function closeRoom(): Promise<void> {
    runtime?.stop();
    runtime = null;
    try {
      await conn.setStatus("CLOSED").catch(() => undefined);
      await conn.leave();
    } finally {
      clearSession(roomId);
      toast("房间已关闭");
      router.navigate("/", true);
    }
  }

  async function leaveRoom(): Promise<void> {
    runtime?.stop();
    runtime = null;
    await conn.leave();
    clearSession(roomId);
    router.navigate("/", true);
  }

  function showOverlay(title: string, text: string, extra?: HTMLElement): void {
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    overlayExtra.replaceChildren();
    if (extra) overlayExtra.append(extra);
    overlay.style.display = "";
  }

  /** 热点引导卡（设计文档 §9–§11，浏览器无法代开系统热点，只能引导）。 */
  function hotspotGuide(withRetry: boolean): HTMLElement {
    const card = el("div", { class: "hotspot" });
    card.append(el("div", { class: "hotspot-title" }, ["连不上？三步热点直连"]));
    const steps = el("ol", { class: "hotspot-steps" });
    for (const t of [
      "房主打开「个人热点 / 便携式 WLAN 热点」",
      "玩家连上该热点（同一网段）",
      "重新打开邀请链接扫码",
    ]) {
      steps.append(el("li", {}, [t]));
    }
    card.append(steps);
    card.append(el("p", { class: "hint" }, ["互联网游玩请确认双方网络未封锁 UDP（WebRTC）。"]));
    if (withRetry) card.append(button("重试直连", () => void retry(), { kind: "primary" }));
    return card;
  }

  async function retry(): Promise<void> {
    toast("正在重试…");
    conn.retry();
  }

  function renderPlayers(): void {
    for (const p of players) {
      const id = `p-${p.id.slice(0, 6)}`;
      let li = document.getElementById(id);
      if (!li) {
        li = document.createElement("li");
        li.id = id;
        li.append(
          document.createElement("span"),
          el("span", { class: "tag" }, [p.profile === "controller" ? "手柄" : "玩家"]),
        );
        playerList.append(li);
      }
      (li.firstElementChild as HTMLElement).textContent = p.nickname ?? p.id.slice(0, 6);
    }
  }

  function renderPhase(): void {
    const label = statusLabel(roomStatus);
    statusBadge.className = `status status-${label.tone}`;
    statusBadge.textContent = label.text;

    const open = transport?.state === "open";
    const phaseTexts: Record<ConnectionPhase, string> = {
      idle: "",
      "waiting-player": "等待玩家扫码加入…",
      connecting: "正在建立 WebRTC 连接…",
      connected: open ? "已直连（WebRTC DataChannel 就绪）" : "已连接",
      reconnecting: "连接中断，正在自动重连…",
      failed: "直连失败 — 同一 Wi-Fi 下可让房主开启个人热点后重试",
      closed: "连接已关闭",
      "host-lost": "房主暂时断线，等待恢复…",
    };
    phaseText.textContent = phaseTexts[phase] ?? "";

    if (phase === "reconnecting") {
      showOverlay(
        `连接中断（第 ${conn.reconnectAttempts + 1} 次重试）`,
        "正在自动重连；若反复失败，可按下方步骤改用热点。",
        hotspotGuide(false),
      );
    } else if (phase === "failed" && !runtime) {
      showOverlay("无法建立直连", "已尝试自动重连仍未成功。", hotspotGuide(true));
    } else if (phase === "connected" && !started && isHost) {
      showOverlay("玩家已就绪", "点击「开始游戏」开局。");
      if (startBtn) startBtn.disabled = false;
    } else if (phase === "connected" && !runtime && !isHost) {
      showOverlay("已连接", "等待房主开始游戏…");
    } else if (phase === "host-lost") {
      showOverlay("房主断线", "游戏已暂停，等待房主浏览器恢复。存档保留在房主设备。");
    }
  }
}

function isTouch(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}
