import {
  ApiError,
  type ApiErrorBody,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type HeartbeatResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type RoomSnapshot,
  type SignalMessage,
  type SyncResponse,
} from "@zgame/protocol";

export interface RoomApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Worker HTTP API 客户端（技术方案 §7.2）。 */
export class RoomApiClient {
  #base: string;
  #fetch: typeof fetch;

  constructor(opts: RoomApiClientOptions = {}) {
    this.#base = (opts.baseUrl ?? "").replace(/\/$/, "");
    this.#fetch = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  createRoom(req: CreateRoomRequest, hostId: string): Promise<CreateRoomResponse> {
    return this.#post<CreateRoomResponse>("/api/rooms", req, { "X-Host-Id": hostId });
  }

  joinRoom(roomId: string, req: JoinRoomRequest): Promise<JoinRoomResponse> {
    return this.#post<JoinRoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}/join`, req);
  }

  /** 房间状态迁移（仅 hostToken）。 */
  setStatus(roomId: string, token: string, status: RoomSnapshot["status"]): Promise<RoomSnapshot> {
    return this.#post<RoomSnapshot>(
      `/api/rooms/${encodeURIComponent(roomId)}/status`,
      { status },
      this.#auth(token),
    );
  }

  heartbeat(roomId: string, token: string): Promise<HeartbeatResponse> {
    return this.#post<HeartbeatResponse>(
      `/api/rooms/${encodeURIComponent(roomId)}/heartbeat`,
      {},
      this.#auth(token),
    );
  }

  getRoom(roomId: string, token: string): Promise<RoomSnapshot> {
    return this.#get<RoomSnapshot>(`/api/rooms/${encodeURIComponent(roomId)}`, this.#auth(token));
  }

  /** 轮询：一次性返回房间状态 + 信令消息（D1 增补端点）。 */
  sync(roomId: string, token: string, after: number): Promise<SyncResponse> {
    return this.#get<SyncResponse>(
      `/api/rooms/${encodeURIComponent(roomId)}/sync?after=${after}`,
      this.#auth(token),
    );
  }

  signal(roomId: string, token: string, message: SignalMessage): Promise<{ id: number }> {
    return this.#post<{ id: number }>(
      `/api/rooms/${encodeURIComponent(roomId)}/signal`,
      message,
      this.#auth(token),
    );
  }

  leave(roomId: string, token: string): Promise<{ ok: true }> {
    return this.#post<{ ok: true }>(
      `/api/rooms/${encodeURIComponent(roomId)}/leave`,
      {},
      this.#auth(token),
    );
  }

  closeRoom(roomId: string, token: string): Promise<{ ok: true }> {
    return this.#request<{ ok: true }>(
      `/api/rooms/${encodeURIComponent(roomId)}`,
      { method: "DELETE" },
      this.#auth(token),
    );
  }

  #auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  async #get<T>(path: string, headers: Record<string, string>): Promise<T> {
    return this.#request<T>(path, { method: "GET", headers });
  }

  async #post<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return this.#request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
  }

  async #request<T>(path: string, init: RequestInit, extra?: Record<string, string>): Promise<T> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...(extra ?? {}) },
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = (data ?? {}) as ApiErrorBody;
      throw new ApiError(err.error ?? "BAD_REQUEST", res.status, err.message ?? res.statusText);
    }
    return data as T;
  }
}
