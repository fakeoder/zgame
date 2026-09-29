import type { RTCIceCandidateLike, SignalMessage } from "@zgame/protocol";
import { BaseTransport, CHANNEL_NAMES, type ChannelName } from "./transport.js";

export interface WebRTCTransportOptions {
  /** 把信令消息交给上层（HTTP 轮询 POST /signal）。 */
  signal: (msg: SignalMessage) => void;
  /** ICE 服务器配置；MVP 仅 STUN（开放问题 O1：是否内置 TURN）。 */
  iceServers?: RTCIceServer[];
  /** 谁发起 offer。Host 在检测到玩家加入后主动发起。 */
  initiator: boolean;
  /** 本地候选优先（D2：LAN = 本地候选连通）。 */
  preferLocalCandidates?: boolean;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const CHANNEL_OPTIONS: RTCDataChannelInit = {
  ordered: true,
};

/**
 * WebRTC 传输（MVP 唯一联网实现）。
 * 三条 DataChannel：input / sync / control，第一版全部可靠有序。
 */
export class WebRTCTransport extends BaseTransport {
  override readonly kind = "webrtc" as const;

  #pc: RTCPeerConnection;
  #opts: WebRTCTransportOptions;
  #channels = new Map<ChannelName, RTCDataChannel>();
  #pendingRemote: RTCSessionDescriptionInit[] = [];
  #iceQueue: RTCIceCandidateLike[] = [];
  #setRemoteDone = false;
  #draining = false;
  #isLocal = false;
  #closed = false;

  constructor(opts: WebRTCTransportOptions) {
    super();
    this.#opts = opts;
    this.#pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? DEFAULT_ICE,
    });
    this.#wire();
    if (opts.initiator) this.#createChannels();
  }

  get isLocal(): boolean {
    return this.#isLocal;
  }

  get localDescription(): RTCSessionDescription | null {
    return this.#pc.localDescription;
  }

  #wire(): void {
    const pc = this.#pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.#opts.signal({
          kind: "ice",
          candidate: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            usernameFragment: e.candidate.usernameFragment,
          },
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.#closed) return;
      switch (pc.connectionState) {
        case "connected":
          this.setState("open");
          break;
        case "failed":
        case "closed":
          this.setState("closed");
          break;
        default:
          break;
      }
    };
    pc.ondatachannel = (e) => {
      this.#bindChannel(e.channel);
    };
    // 本地候选优先：只要有本地候选，就认为可能是 LAN（D2）
    pc.onicecandidateerror = () => {
      /* STUN 失败不致命，继续等其他候选 */
    };
  }

  #createChannels(): void {
    for (const name of CHANNEL_NAMES) {
      const ch = this.#pc.createDataChannel(name, CHANNEL_OPTIONS);
      this.#bindChannel(ch);
    }
    void this.#createOffer();
  }

  async #createOffer(): Promise<void> {
    try {
      const offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription(offer);
      if (this.#pc.localDescription) {
        this.#opts.signal({ kind: "offer", sdp: this.#pc.localDescription.sdp ?? "" });
      }
    } catch (err) {
      console.error("[net] createOffer failed", err);
      this.setState("closed");
    }
  }

  #bindChannel(ch: RTCDataChannel): void {
    const name = ch.label as ChannelName;
    this.#channels.set(name, ch);
    ch.binaryType = "arraybuffer";
    ch.onmessage = (e) => {
      const data = e.data;
      if (data instanceof ArrayBuffer) {
        this.dispatch(name, new Uint8Array(data));
      }
    };
    ch.onopen = () => this.#maybeOpen();
    ch.onclose = () => {
      if (this.#closed) return;
      if (this.#channels.size > 0 && [...this.#channels.values()].every((c) => c.readyState === "closed")) {
        this.setState("closed");
      }
    };
    if (ch.readyState === "open") this.#maybeOpen();
  }

  #maybeOpen(): void {
    if (this.#closed) return;
    if (CHANNEL_NAMES.every((n) => this.#channels.get(n)?.readyState === "open")) {
      this.setState("open");
    }
  }

  /**
   * 断线重连（M3）：保留 Transport 对象身份，换一个新的 RTCPeerConnection 重新握手。
   * 这样上层 SyncEngine / GameRuntime 挂的 handler 无需重新订阅。
   */
  restart(): void {
    if (this.#closed) return;
    this.#teardownPc();
    this.#pc = new RTCPeerConnection({ iceServers: this.#opts.iceServers ?? DEFAULT_ICE });
    this.#wire();
    this.setState("connecting");
    if (this.#opts.initiator) this.#createChannels();
  }

  #teardownPc(): void {
    this.#channels.clear();
    this.#pendingRemote = [];
    this.#iceQueue = [];
    this.#setRemoteDone = false;
    this.#draining = false;
    this.#isLocal = false;
    try {
      this.#pc.onicecandidate = null;
      this.#pc.onconnectionstatechange = null;
      this.#pc.ondatachannel = null;
      this.#pc.close();
    } catch {
      /* ignore */
    }
  }

  /** 处理对端信令（来自轮询 sync 响应）。 */
  async handleSignal(msg: SignalMessage): Promise<void> {
    if (this.#closed) return;
    try {
      switch (msg.kind) {
        case "offer":
          await this.#applyRemote({ type: "offer", sdp: msg.sdp });
          break;
        case "answer":
          await this.#applyRemote({ type: "answer", sdp: msg.sdp });
          break;
        case "ice":
          await this.#applyIce(msg.candidate);
          break;
        case "bye":
          this.close();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error("[net] handleSignal failed", err);
    }
  }

  async #applyRemote(desc: RTCSessionDescriptionInit): Promise<void> {
    this.#pendingRemote.push(desc);
    await this.#drainRemote();
  }

  async #drainRemote(): Promise<void> {
    // 串行处理，避免 setRemoteDescription 并发冲突
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#pendingRemote.length > 0) {
        const desc = this.#pendingRemote.shift();
        if (!desc) break;
        const state = this.#pc.signalingState;
        if (desc.type === "offer") {
          // 重复 offer（重连场景）：忽略
          if (state !== "stable") continue;
        } else if (desc.type === "answer") {
          // 只有发出 offer 后才接受 answer
          if (state !== "have-local-offer") continue;
        } else {
          continue;
        }

        await this.#pc.setRemoteDescription(desc);
        this.#setRemoteDone = true;
        await this.#flushIce();

        if (desc.type === "offer") {
          const answer = await this.#pc.createAnswer();
          await this.#pc.setLocalDescription(answer);
          if (this.#pc.localDescription) {
            this.#opts.signal({ kind: "answer", sdp: this.#pc.localDescription.sdp ?? "" });
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #applyIce(candidate: RTCIceCandidateLike): Promise<void> {
    if (!this.#setRemoteDone) {
      this.#iceQueue.push(candidate);
      return;
    }
    try {
      await this.#pc.addIceCandidate(candidate as RTCIceCandidateInit);
      this.#isLocal = this.#isLocal || isLocalCandidate(candidate);
    } catch (err) {
      console.warn("[net] addIceCandidate failed", err);
    }
  }

  async #flushIce(): Promise<void> {
    while (this.#iceQueue.length > 0) {
      const c = this.#iceQueue.shift();
      if (!c) break;
      try {
        await this.#pc.addIceCandidate(c as RTCIceCandidateInit);
        this.#isLocal = this.#isLocal || isLocalCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }

  override send(channel: ChannelName, data: Uint8Array): void {
    if (this.state !== "open") return;
    const ch = this.#channels.get(channel);
    if (!ch || ch.readyState !== "open") return;
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    ch.send(buf);
  }

  override close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#opts.signal({ kind: "bye", reason: "closed" });
    } catch {
      /* ignore */
    }
    for (const ch of this.#channels.values()) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
    this.#teardownPc();
    super.close();
  }
}

function isLocalCandidate(c: RTCIceCandidateLike): boolean {
  const s = c.candidate ?? "";
  if (s.includes(" typ host")) return true;
  // mDNS 主机名（.local）也视为本地候选
  if (s.includes(".local")) return true;
  return false;
}
