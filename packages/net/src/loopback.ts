import { BaseTransport, type ChannelName } from "./transport.js";

/**
 * 单机回环传输：本地输入直接送回本地游戏，M1 完全不依赖网络。
 * send() 的数据会以微任务异步回投到 on() 处理器，模拟真实传输时序。
 */
export class LoopbackTransport extends BaseTransport {
  override readonly kind = "loopback" as const;

  constructor(open = true) {
    super();
    if (open) {
      queueMicrotask(() => this.setState("open"));
    }
  }

  override send(channel: ChannelName, data: Uint8Array): void {
    if (this.state === "closed") return;
    queueMicrotask(() => {
      if (this.state === "closed") return;
      this.dispatch(channel, data);
    });
  }

  override close(): void {
    super.close();
  }
}
