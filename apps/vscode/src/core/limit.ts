/** A counting semaphore: at most `size` holders at once, served in arrival order. */
export class Semaphore {
  private size: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.size = Math.max(1, size);
  }

  resize(size: number): void {
    this.size = Math.max(1, size);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.size && this.waiting.length) {
      this.active++;
      this.waiting.shift()!();
    }
  }

  async use<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("cancelled"));
      const go = () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error("cancelled"));
      };
      signal?.addEventListener("abort", stop, { once: true });
      this.waiting.push(go);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }
}
