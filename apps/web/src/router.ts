export type PathParams = Record<string, string>;

export interface RouteDefinition {
  /** 形如 "/game/:gameId" */
  pattern: string;
  handler: (params: PathParams) => void | Promise<void>;
}

export interface RouterOptions {
  outlet: HTMLElement;
  NotFound?: (path: string) => void;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (!seg) return "";
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export class Router {
  #routes: { regex: RegExp; keys: string[]; handler: RouteDefinition["handler"] }[] = [];
  #outlet: HTMLElement;
  #notFound?: RouterOptions["NotFound"];
  #current: RouteDefinition["handler"] | null = null;
  #cleanups: (() => void)[] = [];

  /** 注册路由离开时的清理（停止轮询、关闭 WebRTC、销毁运行时）。 */
  onLeave(fn: () => void): () => void {
    this.#cleanups.push(fn);
    return () => {
      this.#cleanups = this.#cleanups.filter((f) => f !== fn);
    };
  }

  #runCleanups(): void {
    const fns = this.#cleanups;
    this.#cleanups = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        console.error("[router] cleanup failed", err);
      }
    }
  }

  constructor(opts: RouterOptions) {
    this.#outlet = opts.outlet;
    this.#notFound = opts.NotFound;
  }

  add(def: RouteDefinition): this {
    const { regex, keys } = compile(def.pattern);
    this.#routes.push({ regex, keys, handler: def.handler });
    return this;
  }

  start(): void {
    window.addEventListener("popstate", () => void this.resolve());
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const url = new URL(anchor.href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      if (anchor.target && anchor.target !== "_self") return;
      e.preventDefault();
      this.navigate(url.pathname + url.search);
    });
    void this.resolve();
  }

  navigate(path: string, replace = false): void {
    if (replace) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
    void this.resolve();
  }

  async resolve(): Promise<void> {
    this.#runCleanups();
    const path = window.location.pathname;
    for (const route of this.#routes) {
      const m = path.match(route.regex);
      if (!m) continue;
      const params: PathParams = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      this.#current = route.handler;
      this.#outlet.innerHTML = "";
      await route.handler(params);
      return;
    }
    this.#outlet.innerHTML = "";
    if (this.#notFound) this.#notFound(path);
    else this.#outlet.innerHTML = `<div class="page"><h1>404</h1><p>路径不存在：${path}</p></div>`;
  }

  get currentHandler(): RouteDefinition["handler"] | null {
    return this.#current;
  }
}
