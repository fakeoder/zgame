export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.innerHTML = "";
}

export function setPage(outlet: HTMLElement, title: string, body: HTMLElement): void {
  clear(outlet);
  const page = el("div", { class: "page" });
  const h = el("h1", {}, [title]);
  page.append(h, body);
  outlet.append(page);
}

export function button(
  label: string,
  onClick: () => void,
  opts: { kind?: string; disabled?: boolean; full?: boolean } = {},
): HTMLButtonElement {
  const cls = ["btn", opts.kind ? `btn-${opts.kind}` : "", opts.full ? "btn-full" : ""]
    .filter(Boolean)
    .join(" ");
  const b = el("button", { class: cls, type: "button" }, [label]);
  b.disabled = opts.disabled ?? false;
  b.addEventListener("click", onClick);
  return b;
}

export function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  const wrap = el("label", { class: "field" });
  wrap.append(el("span", { class: "field-label" }, [labelText]), input);
  if (hint) wrap.append(el("span", { class: "field-hint" }, [hint]));
  return wrap;
}

export function textInput(attrs: Record<string, string | undefined> = {}): HTMLInputElement {
  const input = el("input", { class: "input", type: "text", ...attrs });
  return input;
}

export function select(options: { value: string; label: string }[], value?: string): HTMLSelectElement {
  const s = el("select", { class: "input" });
  for (const o of options) {
    const opt = el("option", { value: o.value }, [o.label]);
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}

export function toast(message: string, ms = 2600): void {
  const t = el("div", { class: "toast" }, [message]);
  document.body.append(t);
  window.setTimeout(() => {
    t.classList.add("toast-out");
    window.setTimeout(() => t.remove(), 300);
  }, ms);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
