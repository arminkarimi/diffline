// Finds a local clone for each GitHub repository and makes sure a pull request's commits are in it.
// Order: clones set in the "diffline.clones" setting, then workspace folders, then a partial clone Diffline keeps
// in its own storage. Fetches only happen when a needed commit is missing, and never touch the checked-out branch.

import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GIT_ENV, run, runOrThrow } from "./exec.ts";
import { alive } from "./locks.ts";

export interface Clone {
  path: string;
  /** The git remote that points at the GitHub repository. */
  remote: string;
  managed: boolean;
}

const GH_CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

function remoteRepo(url: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export class Repos {
  private readonly storage: string;
  private readonly configured: () => Record<string, string>;
  private readonly workspaceDirs: () => string[];
  private readonly log: (line: string) => void;
  private readonly remotesByDir = new Map<string, Promise<Array<{ remote: string; repo: string }>>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly credentialed = new Set<string>();

  constructor(opts: { storage: string; configured: () => Record<string, string>; workspaceDirs: () => string[]; log: (line: string) => void }) {
    this.storage = opts.storage;
    this.configured = opts.configured;
    this.workspaceDirs = opts.workspaceDirs;
    this.log = opts.log;
  }

  /** Forget cached remotes, after workspace folders or settings change. */
  reset(): void {
    this.remotesByDir.clear();
  }

  private remotes(dir: string) {
    let p = this.remotesByDir.get(dir);
    if (!p) {
      p = run("git", ["-C", dir, "remote", "-v"], { env: GIT_ENV, timeoutMs: 10_000 }).then((r) =>
        r.code !== 0
          ? []
          : r.stdout
              .split("\n")
              .map((line) => line.split(/\s+/))
              .filter((parts) => parts.length >= 2)
              .map(([remote, url]) => ({ remote, repo: remoteRepo(url) || "" }))
              .filter((x) => x.repo),
      );
      this.remotesByDir.set(dir, p);
    }
    return p;
  }

  private async findRemote(dir: string, repo: string): Promise<string | null> {
    const remotes = await this.remotes(dir);
    const hits = remotes.filter((r) => r.repo === repo.toLowerCase());
    return hits.find((h) => h.remote === "origin")?.remote || hits[0]?.remote || null;
  }

  /** The clone to use for owner/name, creating a managed partial clone when there's none. */
  async resolve(owner: string, name: string): Promise<Clone> {
    const repo = `${owner}/${name}`;
    const conf = Object.entries(this.configured()).find(([k]) => k.toLowerCase() === repo.toLowerCase());
    const candidates = [...(conf ? [conf[1].replace(/^~(?=\/)/, process.env.HOME || "~")] : []), ...this.workspaceDirs()];
    for (const dir of candidates) {
      const remote = await this.findRemote(dir, repo).catch(() => null);
      if (remote) return { path: dir, remote, managed: false };
    }
    return this.managed(owner, name);
  }

  private managedPath(owner: string, name: string) {
    return path.join(this.storage, "clones", `${owner}__${name}`.toLowerCase());
  }

  private async managed(owner: string, name: string): Promise<Clone> {
    const dir = this.managedPath(owner, name);
    return this.locked(dir, async () => {
      const exists = await access(path.join(dir, "HEAD")).then(() => true, () => false);
      if (!exists) {
        await mkdir(path.dirname(dir), { recursive: true });
        this.log(`Cloning ${owner}/${name} (partial, no file contents until needed)…`);
        await runOrThrow(
          "git",
          [...GH_CREDENTIALS, "clone", "--bare", "--filter=blob:none", "--no-tags", `https://github.com/${owner}/${name}.git`, dir],
          { env: GIT_ENV, timeoutMs: 15 * 60_000 },
        );
      }
      if (!this.credentialed.has(dir)) {
        await this.storeCredentials(dir);
        this.credentialed.add(dir);
      }
      return { path: dir, remote: "origin", managed: true };
    });
  }

  /**
   * A partial clone downloads file contents when a command first needs them (git diff, blame, a checkout for the agents),
   * so the clone keeps the gh credential helper in its own config rather than only on the fetch command line. The helper
   * answers for github.com only; the empty generic helper keeps the user's own helpers out.
   */
  private async storeCredentials(dir: string): Promise<void> {
    const git = (...args: string[]) => runOrThrow("git", ["-C", dir, ...args], { env: GIT_ENV, timeoutMs: 10_000 });
    await git("config", "--replace-all", "credential.helper", "");
    await git("config", "--replace-all", "credential.https://github.com.helper", "!gh auth git-credential");
  }

  private treesDir() {
    return path.join(this.storage, "trees");
  }

  /**
   * A checkout of a pull request's head for the agents to read: plain files in a folder of its own, from Diffline's own
   * clone (never the user's, which stays untouched), so agents need no git or shell at all. Remove it after the run.
   * Folder names start with this window's process id, so cleanTrees() knows which ones are abandoned.
   */
  async reviewTree(owner: string, name: string, pr: { number: number; head: string; base: string | null; baseRefName: string | null }): Promise<{ path: string; remove: () => Promise<void> }> {
    const clone = await this.managed(owner, name);
    await this.ensureCommits(clone, pr);
    const dir = path.join(this.treesDir(), `${process.pid}-${`${owner}__${name}`.toLowerCase()}-${pr.number}-${Date.now().toString(36)}`);
    await mkdir(this.treesDir(), { recursive: true });
    await this.locked(clone.path, () =>
      runOrThrow("git", ["-C", clone.path, "worktree", "add", "--detach", "--quiet", dir, pr.head], { env: GIT_ENV, timeoutMs: 15 * 60_000 }),
    );
    const remove = () =>
      this.locked(clone.path, async () => {
        await run("git", ["-C", clone.path, "worktree", "remove", "--force", dir], { env: GIT_ENV, timeoutMs: 60_000 });
        await rm(dir, { recursive: true, force: true });
        await run("git", ["-C", clone.path, "worktree", "prune"], { env: GIT_ENV, timeoutMs: 60_000 });
      });
    return { path: dir, remove };
  }

  /** Remove review checkouts left behind by windows that closed mid-run. Ones belonging to open windows stay. */
  async cleanTrees(): Promise<void> {
    const names = await readdir(this.treesDir()).catch(() => [] as string[]);
    const stale = names.filter((n) => {
      const pid = Number(n.split("-")[0]);
      return !Number.isInteger(pid) || (pid !== process.pid && !alive(pid));
    });
    await Promise.all(stale.map((n) => rm(path.join(this.treesDir(), n), { recursive: true, force: true })));
    if (!stale.length) return;
    const clones = await readdir(path.join(this.storage, "clones")).catch(() => [] as string[]);
    await Promise.all(clones.map((c) => run("git", ["-C", path.join(this.storage, "clones", c), "worktree", "prune"], { env: GIT_ENV, timeoutMs: 60_000 })));
  }

  /**
   * Write files as they are at a commit into a folder, keeping their paths (the agents read the changed files as they
   * were before the pull request this way). Paths that would leave the folder, and files over 1 MB, are skipped.
   */
  async exportFiles(clonePath: string, commit: string, paths: string[], outDir: string): Promise<number> {
    const root = path.resolve(outDir);
    const wanted = [...new Set(paths)].filter((p) => {
      const target = path.resolve(root, p);
      return target.startsWith(root + path.sep) && !p.includes("\0");
    });
    if (!wanted.length) return 0;
    const input = wanted.map((p) => `${commit}:${p}`).join("\n") + "\n";
    const res = await run("git", ["-C", clonePath, "cat-file", "--batch"], { env: GIT_ENV, input, timeoutMs: 5 * 60_000 });
    const out = res.stdoutBytes ?? Buffer.from(res.stdout, "utf8");
    let at = 0;
    let written = 0;
    for (const p of wanted) {
      const nl = out.indexOf(10, at);
      if (nl < 0) break;
      const header = out.subarray(at, nl).toString("utf8");
      at = nl + 1;
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) continue; // "<spec> missing": the file didn't exist before
      const size = Number(m[2]);
      const body = out.subarray(at, at + size);
      at += size + 1;
      if (m[1] !== "blob" || size > 1_000_000) continue;
      const target = path.resolve(root, p);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      written++;
    }
    return written;
  }

  async hasCommit(dir: string, sha: string): Promise<boolean> {
    const r = await run("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { env: GIT_ENV, timeoutMs: 10_000 });
    return r.code === 0;
  }

  /**
   * Make sure the pull request's head and base commits are in the clone. Fetches only what's missing:
   * GitHub's refs/pull/<n>/head, and the base commit by id (or the base branch if that fails).
   */
  async ensureCommits(clone: Clone, pr: { number: number; head: string; base: string | null; baseRefName: string | null }): Promise<{ fetched: boolean }> {
    const [hasHead, hasBase] = await Promise.all([this.hasCommit(clone.path, pr.head), pr.base ? this.hasCommit(clone.path, pr.base) : Promise.resolve(true)]);
    if (hasHead && hasBase) return { fetched: false };
    return this.locked(clone.path, async () => {
      const head = clone.managed ? `+refs/pull/${pr.number}/head:refs/pull/${pr.number}/head` : `refs/pull/${pr.number}/head`;
      const wants = [...(hasHead ? [] : [head]), ...(hasBase || !pr.base ? [] : [pr.base])];
      const creds = clone.managed ? GH_CREDENTIALS : [];
      this.log(`Fetching ${wants.join(", ")} into ${clone.path}`);
      const res = await run("git", [...creds, "-C", clone.path, "fetch", "--quiet", "--no-tags", clone.remote, ...wants], { env: GIT_ENV, timeoutMs: 10 * 60_000 });
      if (res.code !== 0 && pr.base && pr.baseRefName && !(await this.hasCommit(clone.path, pr.base))) {
        // Some servers refuse fetching a commit by id; the base branch carries it.
        await run("git", [...creds, "-C", clone.path, "fetch", "--quiet", "--no-tags", clone.remote, `refs/heads/${pr.baseRefName}`], { env: GIT_ENV, timeoutMs: 10 * 60_000 });
      }
      if (!(await this.hasCommit(clone.path, pr.head))) {
        throw new Error(`Couldn't fetch pull request #${pr.number} into ${clone.path}: ${res.stderr.trim().split("\n").pop() || "git fetch failed"}`);
      }
      return { fetched: true };
    });
  }

  /** One git operation at a time per clone. */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }
}
