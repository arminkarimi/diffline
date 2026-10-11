// Files Diffline keeps on this computer, under the extension's global storage:
//   state/<slug>.json    the page's review state (drafts, reviewed marks, decisions)
//   agents/<slug>.json   the latest agent review for each pull request
//   cache/<slug>/<head>[-<since>].json   built review data, so reopening a pull request is instant
//   runs/<slug>/<head>-<time>/            agent prompts, raw outputs and logs, for debugging
//   metrics/events.jsonl                  review metrics: decisions on findings, reviews posted, agent runs (metrics-log.ts)

import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentFile, PrKey, ReviewData, ReviewState } from "./types.ts";
import { prSlug } from "./types.ts";

export class Store {
  readonly root: string;
  /** The last write to each file, so writes to one file land in the order they were made. */
  private readonly writes = new Map<string, Promise<void>>();
  private tmpSeq = 0;
  constructor(root: string) {
    this.root = root;
  }

  private file(kind: "state" | "agents", key: PrKey) {
    return path.join(this.root, kind, `${prSlug(key)}.json`);
  }

  async init(): Promise<void> {
    // Run folders hold private diffs and prompts: only the user's account may read the storage folder.
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    for (const d of ["state", "agents", "cache", "runs"]) await mkdir(path.join(this.root, d), { recursive: true });
  }

  /** A JSON file, or null when it's missing. A damaged one is set aside as <file>.damaged so the next save can't lose it. */
  async readJson<T>(file: string): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      await copyFile(file, `${file}.damaged`).catch(() => undefined);
      return null;
    }
  }

  /**
   * Replace a file in one step (a temporary file, then rename). The page saves its state often, and two saves can be
   * in flight at once: they're queued per file, so an older save never lands after a newer one.
   */
  writeJson(file: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value);
    const write = async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${++this.tmpSeq}.tmp`;
      try {
        await writeFile(tmp, text, "utf8");
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    };
    const next = (this.writes.get(file) || Promise.resolve()).then(write, write);
    this.writes.set(file, next);
    const forget = () => {
      if (this.writes.get(file) === next) this.writes.delete(file);
    };
    next.then(forget, forget);
    return next;
  }

  readState(key: PrKey) {
    return this.readJson<ReviewState>(this.file("state", key));
  }
  writeState(key: PrKey, state: ReviewState) {
    return this.writeJson(this.file("state", key), state);
  }
  readAgent(key: PrKey) {
    return this.readJson<AgentFile>(this.file("agents", key));
  }
  writeAgent(key: PrKey, file: AgentFile) {
    return this.writeJson(this.file("agents", key), file);
  }

  private cacheFile(key: PrKey, head: string, since: string | null) {
    return path.join(this.root, "cache", prSlug(key), `${head}${since ? `-${since.slice(0, 12)}` : ""}.json`);
  }
  readReviewData(key: PrKey, head: string, since: string | null) {
    return this.readJson<ReviewData>(this.cacheFile(key, head, since));
  }
  async writeReviewData(key: PrKey, head: string, since: string | null, data: ReviewData) {
    await this.writeJson(this.cacheFile(key, head, since), data);
    await this.prune(path.join(this.root, "cache", prSlug(key)), 4);
  }

  async newRunDir(key: PrKey, head: string): Promise<string> {
    const dir = path.join(this.root, "runs", prSlug(key), `${head.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(dir, { recursive: true });
    await this.prune(path.dirname(dir), 6);
    return dir;
  }

  /** Keep the newest `keep` entries in a folder. */
  private async prune(dir: string, keep: number): Promise<void> {
    try {
      const names = await readdir(dir);
      const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(path.join(dir, n))).mtimeMs })));
      withTime.sort((a, b) => b.t - a.t);
      await Promise.all(withTime.slice(keep).map((x) => rm(path.join(dir, x.n), { recursive: true, force: true })));
    } catch {
      /* nothing to prune */
    }
  }
}
