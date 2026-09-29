import { handleApi, type Env } from "./service.js";

export { type Env } from "./service.js";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
};

function withSecurity(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": request.headers.get("origin") ?? "*",
          "access-control-allow-headers": "content-type, authorization, x-host-id",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      const res = await handleApi(request, env);
      if (res) return withSecurity(res);
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }

    return withSecurity(
      new Response(JSON.stringify({ error: "NOT_FOUND", message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  },
};
