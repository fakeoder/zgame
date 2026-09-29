import { RoomApiClient } from "@zgame/signaling";
import type { RoomProfile } from "@zgame/protocol";
import type { Router } from "../router.js";
import { loadSession, parseJoinCode, saveSession } from "../session.js";
import { button, el, field, textInput, toast } from "../ui.js";

export async function renderJoinPage(
  router: Router,
  outlet: HTMLElement,
  code: string,
): Promise<void> {
  const parsed = parseJoinCode(code);
  const body = el("div", {});

  if (!parsed) {
    body.append(
      el("div", { class: "panel" }, [
        el("h2", {}, ["链接无效"]),
        el("p", { class: "hint" }, ["邀请链接格式不正确，请让房主重新生成二维码。"]),
        button("返回首页", () => router.navigate("/"), { kind: "primary" }),
      ]),
    );
    outlet.append(body);
    return;
  }

  const { roomId, token } = parsed;
  const existing = loadSession(roomId);
  if (existing && existing.role === "host") {
    router.navigate(`/room/${roomId}`, true);
    return;
  }

  const panel = el("div", { class: "panel" });
  panel.append(el("h2", {}, [`加入房间 ${roomId}`]));
  panel.append(
    el("p", { class: "hint" }, [
      "选择你的角色：玩家会在自己设备上运行游戏画面；手柄模式只发送按键，画面由房主设备显示。",
    ]),
  );

  const nick = textInput({ placeholder: "昵称", maxlength: "16", value: defaultNick() });
  const roleSelect = document.createElement("select");
  roleSelect.className = "input";
  for (const [value, label] of [
    ["player", "玩家（本机也运行游戏画面）"],
    ["controller", "手柄（本机只当虚拟手柄）"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    roleSelect.append(opt);
  }

  const submit = button("加入房间", () => void join(), { kind: "primary", full: true });

  panel.append(field("昵称", nick), field("角色", roleSelect), submit);
  panel.append(el("div", { class: "note", style: "margin-top:14px" }, [
    "加入后会立即尝试建立 WebRTC 直连；同一 Wi-Fi 下将自动走局域网。",
  ]));
  body.append(panel);
  outlet.append(body);

  async function join(): Promise<void> {
    submit.disabled = true;
    try {
      const api = new RoomApiClient();
      const profile = (roleSelect.value === "controller" ? "controller" : "player") as RoomProfile;
      const res = await api.joinRoom(roomId, {
        token,
        nickname: nick.value.trim() || "玩家",
        profile,
      });
      saveSession({
        roomId: res.roomId,
        token: res.playerToken,
        role: "player",
        profile: res.profile,
        gameId: res.gameId,
        mode: res.mode,
        nickname: nick.value.trim() || "玩家",
        createdAt: Date.now(),
      });
      router.navigate(profile === "controller" ? `/controller/${roomId}` : `/room/${roomId}`);
    } catch (err) {
      console.error(err);
      toast(`加入失败：${err instanceof Error ? err.message : String(err)}`);
      submit.disabled = false;
    }
  }
}

function defaultNick(): string {
  return localStorage.getItem("zgame.nickname") ?? "";
}
