export type FrameCallback = (frame: number) => void;

/**
 * 权威帧时钟。Host 驱动；单机（solo）模式也复用它。
 * 以固定 tickRate 推进，不依赖 requestAnimationFrame 的实际间隔参与逻辑。
 */
export class FrameClock {
  #tickRate: number;
  #frame = 0;
  #accum = 0;
  #lastTime: number | null = null;
  #running = false;
  #raf = 0;
  #listeners = new Set<FrameCallback>();
  #manual = false;

  constructor(tickRate: number) {
    this.#tickRate = tickRate;
  }

  get frame(): number {
    return this.#frame;
  }

  get tickRate(): number {
    return this.#tickRate;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  onTick(cb: FrameCallback): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (typeof requestAnimationFrame === "undefined" || typeof document === "undefined") {
      this.#manual = true;
      return;
    }
    this.#lastTime = null;
    const loop = (t: number) => {
      if (!this.#running) return;
      if (this.#lastTime === null) this.#lastTime = t;
      // 限制单帧推进量，避免后台标签页回来后一次性跑几万帧
      const elapsed = Math.min(t - this.#lastTime, (1000 / this.#tickRate) * 5);
      this.#lastTime = t;
      this.#accum += elapsed;
      const step = 1000 / this.#tickRate;
      while (this.#accum >= step) {
        this.#accum -= step;
        this.#advance();
      }
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.#running = false;
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  /** 无 rAF 环境（测试）手动推进一帧。 */
  step(): void {
    this.#advance();
  }

  #advance(): void {
    this.#frame += 1;
    for (const cb of this.#listeners) cb(this.#frame);
  }

  isManual(): boolean {
    return this.#manual;
  }
}
