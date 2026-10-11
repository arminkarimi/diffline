// Locks shared by every VS Code window on this machine. Each window runs its own extension host, so without them two
// windows would both review the same pull request. A lock is a file holding its owner's process id and a heartbeat;
// it counts as free once the owner process is gone or the heartbeat is older than STALE_MS.

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LockInfo {
  pid: number;
  owner: string;
  since: number;
  heartbeat: number;
  /** The head commit a run lock is reviewing. */
  head?: string;
}

const HEARTBEAT_MS = 30_000;
export const STALE_MS = 3 * HEARTBEAT_MS;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export class Locks {
  readonly dir: string;
  /** This window: its process id plus a random part, in case a process id is reused. */
  readonly owner = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly beats = new Map<string, NodeJS.Timeout>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.json`);
  }

  /** Who holds the lock, or null when it's free. */
  async holder(name: string): Promise<LockInfo | null> {
    const info = await readFile(this.file(name), "utf8").then((t) => JSON.parse(t) as LockInfo, () => null);
    if (!info || !alive(info.pid) || Date.now() - info.heartbeat > STALE_MS) return null;
    return info;
  }

  held(name: string): boolean {
    return this.beats.has(name);
  }

  /** Take the lock, or report who holds it. A taken lock keeps a heartbeat until release(). */
  async acquire(name: string, extra: { head?: string } = {}): Promise<{ ok: true } | { ok: false; holder: LockInfo }> {
    await mkdir(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      const info: LockInfo = { pid: process.pid, owner: this.owner, since: now, heartbeat: now, ...extra };
      // link() creates the lock with its content in one step, and fails if another window got there first.
      const tmp = `${this.file(name)}.${this.owner}.tmp`;
      await writeFile(tmp, JSON.stringify(info), "utf8");
      try {
        await link(tmp, this.file(name));
        this.beat(name, info);
        return { ok: true };
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        const h = await this.holder(name);
        if (h?.owner === this.owner) {
          if (!this.beats.has(name)) this.beat(name, h);
          return { ok: true };
        }
        if (h) return { ok: false, holder: h };
        await rm(this.file(name), { force: true }); // stale: its window is gone
      } finally {
        await rm(tmp, { force: true });
      }
    }
    const h = await this.holder(name);
    return h ? { ok: false, holder: h } : { ok: false, holder: { pid: 0, owner: "", since: Date.now(), heartbeat: Date.now() } };
  }

  private beat(name: string, info: LockInfo): void {
    clearInterval(this.beats.get(name));
    const timer = setInterval(async () => {
      const current = await readFile(this.file(name), "utf8").then((t) => JSON.parse(t) as LockInfo, () => null);
      if (current?.owner !== this.owner) return void this.stopBeat(name);
      const tmp = `${this.file(name)}.${this.owner}.beat`;
      await writeFile(tmp, JSON.stringify({ ...info, heartbeat: Date.now() }), "utf8").catch(() => undefined);
      // Released while writing: don't bring the lock back.
      if (this.beats.get(name) !== timer) return void (await rm(tmp, { force: true }).catch(() => undefined));
      await rename(tmp, this.file(name)).catch(() => undefined);
    }, HEARTBEAT_MS);
    timer.unref?.();
    this.beats.set(name, timer);
  }

  private stopBeat(name: string): void {
    clearInterval(this.beats.get(name));
    this.beats.delete(name);
  }

  async release(name: string): Promise<void> {
    this.stopBeat(name);
    const current = await readFile(this.file(name), "utf8").then((t) => JSON.parse(t) as LockInfo, () => null);
    if (current?.owner === this.owner) await rm(this.file(name), { force: true });
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.beats.keys()].map((n) => this.release(n)));
  }
}
