import { getRegisteredGame } from "@zgame/game-sdk";
import type { RoomMode } from "@zgame/protocol";
import { RoomApiClient } from "@zgame/signaling";
import type { Router } from "../router.js";
import { deviceId, inviteUrl, saveSession } from "../session.js";
import { button, el, field, select, toast } from "../ui.js";
import { GameRuntime } from "../runtime.js";

export async function renderGamePage(
  router: Router,
  outlet: HTMLElement,
  gameId: string,
): Promise<void> {
  const reg = getRegisteredGame(gameId);
  if (!reg) {
    const body = el("div", { class: "panel" }, [
      el("p", {}, [`未找到游戏：${gameId}`]),
      button("返回首页", () => router.navigate("/"), { kind: "primary" }),
    ]);
    outlet.append(body);
    return;
  }

  const m = reg.manifest;
  const body = el("div", {});
  body.append(el("p", { class: "sub" }, [m.description ?? ""]));

  const info = el("div", { class: "panel" });
  info.append(el("h2", {}, ["游戏信息"]));
  const rows: [string, string][] = [
    ["ID", m.id],
    ["版本", m.version],
    ["类型", m.type],
    ["人数", `${m.players}`],
    ["同步", m.multiplayer.sync],
    ["逻辑帧率", `${m.tickRate} Hz`],
    ["输入延迟", `${m.inputDelayFrames} 帧`],
  ];
  for (const [k, v] of rows) {
    info.append(el("div", { class: "kv" }, [el("span", { class: "k" }, [k]), el("span", { class: "v" }, [v])]));
  }
  body.append(info);

  // ---- 单机 ----
  const soloPanel = el("div", { class: "panel" });
  soloPanel.append(el("h2", {}, ["单机模式"]));
  const stage = el("div", { class: "stage" });
  const touch = el("div", {});
  const overlay = el("div", { class: "overlay" });
  const overlayTitle = el("h3", {}, ["准备就绪"]);
  const overlayText = el("p", {}, [
    "方向键 / WASD 控制方向，Z/J = A，X/K = B，Enter = START。支持蓝牙手柄与触屏虚拟手柄。",
  ]);
  overlay.append(overlayTitle, overlayText);
  stage.append(overlay);

  const controls = el("div", { class: "btn-row" });
  const startBtn = button("开始单机", () => startSolo(), { kind: "primary" });
  controls.append(startBtn);
  soloPanel.append(stage, touch, controls);
  body.append(soloPanel);

  let runtime: GameRuntime | null = null;

  function startSolo(): void {
    if (runtime) return;
    overlay.style.display = "none";
    runtime = new GameRuntime({
      manifest: m,
      profile: "solo",
      container: stage,
      touchContainer: isTouch() ? touch : undefined,
    });
    runtime.start();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    toast("单机已开始");
  }

  const stopBtn = button("结束单机", () => {
    runtime?.stop();
    runtime = null;
    overlay.style.display = "";
    startBtn.disabled = false;
    stopBtn.disabled = true;
    toast("已结束单机");
  }, { kind: "danger", disabled: true });
  controls.append(stopBtn);

  // ---- 创建房间 ----
  const roomPanel = el("div", { class: "panel" });
  roomPanel.append(el("h2", {}, ["联机对战"]));
  roomPanel.append(
    el("p", { class: "hint" }, [
      "创建房间后会生成二维码，其他玩家扫码即可加入。房主设备负责运行游戏与保存进度。",
    ]),
  );

  const modeSelect = select(
    [
      { value: "nearby", label: "Nearby（同一 Wi-Fi / 热点，优先局域网）" },
      { value: "remote", label: "Remote（互联网 WebRTC）" },
    ],
    "nearby",
  );

  const createBtn = button(
    "创建房间",
    () => void createRoom(),
    { kind: "primary", full: true },
  );
  roomPanel.append(field("联机方式", modeSelect), createBtn);
  body.append(roomPanel);

  async function createRoom(): Promise<void> {
    createBtn.disabled = true;
    try {
      const api = new RoomApiClient();
      const mode = (modeSelect.value === "nearby" ? "nearby" : "remote") as RoomMode;
      const res = await api.createRoom({ gameId: m.id, mode }, deviceId());
      // Worker 返回的 joinUrl 以请求源为准；统一改写成当前站点（顺带修复旧版本的重复 roomId）
      const joinUrl = inviteUrl(res, window.location.origin) ?? res.joinUrl;
      saveSession({
        roomId: res.roomId,
        token: res.hostToken,
        role: "host",
        profile: "host",
        gameId: m.id,
        mode,
        joinUrl,
        createdAt: Date.now(),
      });
      router.navigate(`/room/${res.roomId}`);
    } catch (err) {
      console.error(err);
      toast(`创建失败：${err instanceof Error ? err.message : String(err)}`);
      createBtn.disabled = false;
    }
  }

  outlet.append(body);

  const stopOnLeave = () => {
    runtime?.stop();
    runtime = null;
  };
  router.onLeave(stopOnLeave);
}

function isTouch(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}
