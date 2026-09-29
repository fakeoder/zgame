import "./style.css";
// 游戏注册：新增游戏时在此导入即可（平台零改动）
import "@zgame/game-snake";

import { Router } from "./router.js";
import { renderHub } from "./pages/hub.js";
import { renderGamePage } from "./pages/game.js";
import { renderJoinPage } from "./pages/join.js";
import { renderRoomPage } from "./pages/room.js";
import { renderControllerPage } from "./pages/controller.js";
import { el } from "./ui.js";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

const topbar = el("header", { class: "topbar" });
const brand = el("a", { class: "brand", href: "/" }, ["Web", el("span", {}, ["Game"]), " Hub"]);
const hint = el("span", { class: "hint" }, ["Cloudflare 管房间 · WebRTC 管联机 · 本机管游戏"]);
topbar.append(brand, hint);

const outlet = el("main", { id: "outlet" });
app.append(topbar, outlet);

const router = new Router({ outlet });

router
  .add({ pattern: "/", handler: () => renderHub(router, outlet) })
  .add({
    pattern: "/game/:gameId",
    handler: (p) => renderGamePage(router, outlet, p["gameId"] ?? ""),
  })
  .add({
    pattern: "/join/:code",
    handler: (p) => renderJoinPage(router, outlet, p["code"] ?? ""),
  })
  .add({
    pattern: "/room/:roomId",
    handler: (p) => renderRoomPage(router, outlet, p["roomId"] ?? ""),
  })
  .add({
    pattern: "/controller/:roomId",
    handler: (p) => renderControllerPage(router, outlet, p["roomId"] ?? ""),
  });

router.start();
