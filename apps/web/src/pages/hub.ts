import { listRegisteredGames } from "@zgame/game-sdk";
import type { Router } from "../router.js";
import { el } from "../ui.js";

export function renderHub(router: Router, outlet: HTMLElement): void {
  const games = listRegisteredGames();
  const body = el("div", {});

  body.append(
    el("p", { class: "sub" }, [
      "打开网页 → 选游戏 → 建房/进房 → 扫码 → 手机变手柄 → LAN / WebRTC 联机。",
    ]),
  );

  if (games.length === 0) {
    body.append(el("div", { class: "panel" }, [el("p", { class: "hint" }, ["暂无已注册游戏。"])]));
    outlet.append(body);
    return;
  }

  const grid = el("div", { class: "card-grid" });
  for (const g of games) {
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "icon" }, [g.icon ?? "🎮"]));
    card.append(el("h3", {}, [g.name]));
    card.append(el("p", {}, [g.description ?? ""]));

    const meta = el("div", { class: "meta" });
    meta.append(el("span", { class: "tag" }, [`${g.players} 人`]));
    meta.append(el("span", { class: "tag" }, [`v${g.version}`]));
    if (g.multiplayer.supported) meta.append(el("span", { class: "tag" }, ["联机"]));
    card.append(meta);

    const btn = el("button", { class: "btn btn-primary btn-full", type: "button" }, ["进入游戏"]);
    btn.addEventListener("click", () => router.navigate(`/game/${g.id}`));
    card.append(btn);
    grid.append(card);
  }

  body.append(grid);
  outlet.append(body);
}
