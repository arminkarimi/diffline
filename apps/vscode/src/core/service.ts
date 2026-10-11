// The heart of the extension, independent of VS Code: the pull request list, loading a review for the page,
// answering the page's calls, and running agents when GitHub activity calls for it.

import { EventEmitter } from "node:events";
import path from "node:path";

import { runReview, type Harnesses, type ReviewProgress } from "../agents/review.ts";
import { formatTokens, HarnessError, type TokenUsage } from "../agents/harness.ts";
import { loadSettings } from "../agents/settings.ts";
import type { AgentId, AgentFile, ListItem, LiveData, PrKey, PullRequestDetail, PullRequestSummary, PushPayload, ReviewData, Risk, RiskInput } from "./types.ts";
import { prKeyString, prSlug } from "./types.ts";
import { buildReviewData } from "./diff.ts";
import { ownsAny, parseCodeowners, type OwnerRule } from "./codeowners.ts";
import { findSecrets } from "./secrets.ts";
import { buildGroups, type RowGroup, type SidebarConfig } from "./grouping.ts";
import { countChecks, fetchCodeowners, fetchPullRequest, fetchPullRequestFiles, fetchViewerTeams, GhError, pushReview, searchPullRequests, searchReviewable } from "./github.ts";
import { Semaphore } from "./limit.ts";
import { Locks } from "./locks.ts";
import type { Repos } from "./repos.ts";
import { computeRisk } from "./risk.ts";
import type { Store } from "./store.ts";

export interface ServiceConfig {
  watch: {
    direct: boolean;
    team: boolean;
    assigned: boolean;
    /** Open pull requests you've reviewed, which leave your review requests once you do. */
    reviewed: boolean;
    authored: boolean;
    /** Mark pull requests that change files you or your teams own (CODEOWNERS). */
    codeOwners: boolean;
    /** List open pull requests in your repositories that nobody asked you to review. */
    others: boolean;
    repositories: string[];
    pollSeconds: number;
  };
  agents: { autoRun: boolean; enabled: AgentId[]; maxParallel: number; quietPeriodSeconds: number; maxAutomaticRuns: number; skipDrafts: boolean; timeoutMinutes: number; autoRunMaxFiles: number; autoRunMaxLines: number };
  harnesses: Harnesses;
  /** How the sidebar and the page's list group and sort pull requests. */
  sidebar: SidebarConfig;
}

/** A small key-value store that survives restarts (VS Code's globalState). */
export interface Memory {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

// "elsewhere": another VS Code window is running this pull request's agents. "held": too large to run automatically.
export type RunState = "idle" | "waiting" | "queued" | "running" | "elsewhere" | "held" | "done" | "failed" | "cancelled";

export interface RunStatus {
  state: RunState;
  head?: string;
  /** When a waiting automatic run starts (the quiet period after a push). */
  dueAt?: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: ReviewProgress;
  error?: string;
  costUsd?: number | null;
  tokens?: TokenUsage | null;
  automatic?: boolean;
  /** Why a run is held back. */
  note?: string;
}

export interface PrRecord {
  key: PrKey;
  summary: PullRequestSummary | null;
  pinned: boolean;
  /** Files with test hints from the last built diff, for an exact risk score. */
  builtFiles?: RiskInput["files"];
  builtHead?: string;
  totals?: { files: number; hunks: number; additions: number; deletions: number; weight: number };
  agent: { commit: string; ranAt: string; findings: Array<{ id: string; severity: string }>; description: AgentFile["description"] | null } | null;
  run: RunStatus;
  /** When this head was first seen, for the quiet period. */
  headSeenAt?: number;
}

const GENERATED = [/(^|\/)package-lock\.json$/, /(^|\/)npm-shrinkwrap\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)Cargo\.lock$/, /(^|\/)go\.sum$/, /(^|\/)poetry\.lock$/, /(^|\/)Gemfile\.lock$/, /\.min\.(js|css)$/, /\.snap$/, /(^|\/)dist\//];
const isGenerated = (p: string) => GENERATED.some((r) => r.test(p));
const sameKey = (a: PrKey, b: PrKey) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase() && a.number === b.number;
/**
 * How the last agent review relates to the pull request now. "current": it reviewed the head commit. "behind": commits
 * landed since. `activity`: the pull request changed on GitHub after the review (description, comments, reviews,
 * labels), which can change what the agents would say even on the same commit.
 */
export interface Freshness {
  state: "none" | "current" | "behind";
  commit?: string;
  ranAt?: string;
  activity: boolean;
}

/** GitHub's updatedAt can trail the run by a few seconds without anything new; ignore that much. */
const ACTIVITY_SLACK_MS = 60_000;

export function reviewFreshness(agent: PrRecord["agent"], summary: Pick<PullRequestSummary, "headRefOid" | "updatedAt"> | null): Freshness {
  if (!agent) return { state: "none", activity: false };
  const base = { commit: agent.commit, ranAt: agent.ranAt };
  if (!summary) return { state: "current", ...base, activity: false };
  if (summary.headRefOid !== agent.commit) return { state: "behind", ...base, activity: true };
  const ran = Date.parse(agent.ranAt);
  const updated = Date.parse(summary.updatedAt);
  return { state: "current", ...base, activity: Number.isFinite(ran) && Number.isFinite(updated) && updated > ran + ACTIVITY_SLACK_MS };
}

/** Why a pull request is too large for an automatic run, or null when it isn't. */
export function tooLargeToAutoRun(
  s: Pick<PullRequestSummary, "changedFiles" | "additions" | "deletions">,
  cfg: Pick<ServiceConfig["agents"], "autoRunMaxFiles" | "autoRunMaxLines">,
): string | null {
  const lines = s.additions + s.deletions;
  if (s.changedFiles <= cfg.autoRunMaxFiles && lines <= cfg.autoRunMaxLines) return null;
  return `Large pull request (${s.changedFiles} files, ${lines.toLocaleString("en-US")} lines changed): agents wait for you to press Run.`;
}

const runLock = (key: PrKey) => `run-${prSlug(key)}`;
/** What the list keeps of an agent review. */
const agentSummary = (a: AgentFile | null): PrRecord["agent"] =>
  a ? { commit: a.commit, ranAt: a.ranAt, findings: a.findings.map((f) => ({ id: f.id, severity: f.severity })), description: a.description || null } : null;
const keyOf = (s: PullRequestSummary): PrKey => {
  const [owner, name] = s.repo.split("/");
  return { owner, name, number: s.number };
};

export class DifflineService extends EventEmitter {
  readonly store: Store;
  readonly repos: Repos;
  private readonly memory: Memory;
  private readonly config: () => ServiceConfig;
  private readonly log: (line: string) => void;
  private readonly records = new Map<string, PrRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly limiter: Semaphore;
  /** Shared with other VS Code windows, so a pull request's agents run in one window only. */
  private readonly locks: Locks;
  /** Whether this window starts automatic runs. One window does, so they share one limit on parallel agents. */
  private leader = false;
  private readonly details = new Map<string, { at: number; detail: PullRequestDetail }>();
  viewer: { login: string | null; name: string | null } | null = null;
  lastError: string | null = null;
  lastRefresh: number | null = null;
  totals: Record<string, { shown: number; total: number }> = {};
  private refreshing: Promise<void> | null = null;
  private extrasRunning = false;
  private treesCleaned = false;
  /**
   * Results of the background searches (team requests, pull requests you could review), kept between searches so
   * rows don't flicker while the main search refreshes.
   */
  private extras = new Map<string, PullRequestSummary>();
  private extraTotals: Partial<Record<"team", { shown: number; total: number }>> = {};
  /** Pull requests whose changed files you or your teams own, as lowercase keys. */
  private codeOwned = new Set<string>();
  /** Changed files by pull request and head, so a refresh doesn't fetch them again. */
  private files = new Map<string, { head: string; files: PullRequestSummary["files"] }>();
  private teams: { at: number; list: string[] } | null = null;
  private owners = new Map<string, { at: number; rules: OwnerRule[] }>();
  private timer: NodeJS.Timeout | null = null;
  private dueTimer: NodeJS.Timeout | null = null;
  /** The poll interval the timer runs at, so a settings change restarts it only when that changed. */
  private pollMs = 0;
  private warming = false;
  /** Diffs being built, by pull request, head and since, so opening one that's being prepared waits for that build. */
  private readonly building = new Map<string, Promise<ReviewData>>();

  constructor(opts: { store: Store; repos: Repos; memory: Memory; config: () => ServiceConfig; log: (line: string) => void }) {
    super();
    this.store = opts.store;
    this.repos = opts.repos;
    this.memory = opts.memory;
    this.config = opts.config;
    this.log = opts.log;
    this.limiter = new Semaphore(this.config().agents.maxParallel);
    this.locks = new Locks(path.join(this.store.root, "locks"));
    // Show the last known list right away; the first refresh replaces it.
    for (const s of this.memory.get<PullRequestSummary[]>("lastList", [])) {
      const key = keyOf(s);
      this.records.set(prKeyString(key).toLowerCase(), { ...this.blank(key), summary: s });
    }
    for (const k of this.memory.get<string[]>("pinned", [])) {
      const key = parseKey(k);
      if (key) this.record(key).pinned = true;
    }
    void Promise.all(this.all().map((r) => this.loadAgentSummary(r))).then(() => this.changed());
  }

  private blank(key: PrKey, pinned = false): PrRecord {
    return { key, summary: null, pinned, agent: null, run: { state: "idle" } };
  }

  private record(key: PrKey): PrRecord {
    const id = prKeyString(key).toLowerCase();
    let r = this.records.get(id);
    if (!r) {
      r = this.blank(key);
      this.records.set(id, r);
    }
    return r;
  }

  get(key: PrKey): PrRecord | undefined {
    return this.records.get(prKeyString(key).toLowerCase());
  }

  all(): PrRecord[] {
    return [...this.records.values()];
  }

  private changed(): void {
    this.emit("change");
  }

  /* ---------- Polling GitHub ---------- */

  start(): void {
    this.stop();
    // Checkouts left by windows that closed mid-run take hundreds of megabytes; clear them once.
    if (!this.treesCleaned) {
      this.treesCleaned = true;
      void this.repos.cleanTrees().catch(() => undefined);
    }
    void this.refresh().catch(() => undefined);
    this.schedule();
  }

  private schedule(): void {
    this.pollMs = Math.max(15, this.config().watch.pollSeconds) * 1000;
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.pollMs);
    this.dueTimer = setInterval(() => this.startDueRuns(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.dueTimer) clearInterval(this.dueTimer);
    this.timer = this.dueTimer = null;
  }

  /** Settings changed. Nothing here asks GitHub: changing how the list is sorted shouldn't search again. */
  configChanged(): void {
    this.limiter.resize(this.config().agents.maxParallel);
    this.repos.reset();
    if (this.timer && this.pollMs !== Math.max(15, this.config().watch.pollSeconds) * 1000) {
      this.stop();
      this.schedule();
    }
  }

  /** Check GitHub for pull requests and pushes. Concurrent calls share one request. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const cfg = this.config();
    const pinned = this.all().filter((r) => r.pinned).map((r) => r.key);
    try {
      const res = await searchPullRequests({
        direct: cfg.watch.direct,
        // Team requests can run to a hundred pull requests, which makes GitHub's search slow; they load in the
        // background (refreshExtras) so the list shows at once.
        team: false,
        assigned: cfg.watch.assigned,
        reviewed: cfg.watch.reviewed,
        authored: cfg.watch.authored,
        repositories: cfg.watch.repositories,
        pinned,
      });
      this.viewer = res.viewer;
      this.totals = { ...res.totals, ...this.extraTotals };
      this.lastError = res.errors && res.errors.length ? res.errors.join("; ") : null;
      const seen = new Set<string>();
      const found = new Set(res.items.map((s) => prKeyString(keyOf(s)).toLowerCase()));
      // Reviewable pull requests from the follow-up search stay until it runs again.
      const extras = [...this.extras.values()].filter((s) => !found.has(prKeyString(keyOf(s)).toLowerCase()));
      for (const s of [...res.items, ...extras]) {
        const key = keyOf(s);
        const id = prKeyString(key).toLowerCase();
        const r = this.record(key);
        if (r.summary?.headRefOid !== s.headRefOid) r.headSeenAt = Date.now();
        // A pull request in both searches keeps the background search's reasons too.
        const extra = this.extras.get(id);
        const merged = extra && extra !== s ? { ...s, reasons: [...new Set([...s.reasons, ...extra.reasons])] } : s;
        r.summary = this.withKnown(id, merged);
        seen.add(id);
      }
      // Drop pull requests that left every search, unless pinned or busy.
      for (const [id, r] of this.records) {
        if (!seen.has(id) && !r.pinned && !["queued", "running"].includes(r.run.state)) this.records.delete(id);
      }
      await Promise.all(this.all().map((r) => this.loadAgentSummary(r)));
      await this.syncOtherWindows();
      this.lastRefresh = Date.now();
      void this.memory.update("lastList", this.all().map((r) => r.summary).filter(Boolean));
      this.changed();
      void this.refreshExtras();
      this.scheduleAutomaticRuns();
      void this.warmUp();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`GitHub: ${this.lastError}`);
      this.changed();
      throw err;
    }
  }

  /** Show runs that other VS Code windows hold, and take the automatic-run role when no window has it. */
  private async syncOtherWindows(): Promise<void> {
    this.leader = (await this.locks.acquire("leader")).ok;
    await Promise.all(
      this.all().map(async (r) => {
        if (["queued", "running"].includes(r.run.state)) return;
        const h = await this.locks.holder(runLock(r.key));
        if (h && h.owner !== this.locks.owner) r.run = { state: "elsewhere", head: h.head, startedAt: h.since };
        else if (r.run.state === "elsewhere") r.run = { state: "idle" };
      }),
    );
  }

  private async loadAgentSummary(r: PrRecord): Promise<void> {
    r.agent = agentSummary(await this.store.readAgent(r.key));
  }

  /** A fresh summary with what's already known about it: its changed files (same head) and code ownership. */
  private withKnown(id: string, s: PullRequestSummary): PullRequestSummary {
    const known = this.files.get(id);
    const files = !s.files.length && known?.head === s.headRefOid ? known.files : s.files;
    const reasons = this.codeOwned.has(id) && !s.own && !s.reasons.includes("code-owner") ? [...s.reasons, "code-owner" as const] : s.reasons;
    return { ...s, files, reasons };
  }

  /** Your repositories: where pull requests ask for your review, are assigned to you or are yours, plus watched ones. */
  private yourRepos(): string[] {
    const mine = this.all().filter((r) => r.pinned || r.summary?.reasons.some((x) => x !== "other" && x !== "code-owner"));
    return [...new Set([...mine.map((r) => `${r.key.owner}/${r.key.name}`.toLowerCase()), ...this.config().watch.repositories.map((x) => x.toLowerCase())])];
  }

  /**
   * After the list shows: find pull requests you could review in your repositories, fill in changed files for risk
   * scores, and mark the ones that change files you or your teams own. Every step is optional and best effort.
   */
  private async refreshExtras(): Promise<void> {
    if (this.extrasRunning) return;
    this.extrasRunning = true;
    const cfg = this.config().watch;
    try {
      const found = new Map<string, PullRequestSummary>();
      let searched = false;
      if (cfg.team) {
        try {
          const res = await searchPullRequests({ direct: false, team: true, authored: false, repositories: [], pinned: [] });
          for (const e of res.errors || []) this.log(`Team requests: ${e}`);
          for (const item of res.items) found.set(prKeyString(keyOf(item)).toLowerCase(), item);
          this.extraTotals = { team: res.totals.team };
          this.totals = { ...this.totals, ...this.extraTotals };
          searched = true;
        } catch (err) {
          this.log(`Couldn't load team requests: ${err instanceof Error ? err.message : err}`);
          for (const [id, item] of this.extras) if (item.reasons.includes("team-requested")) found.set(id, item);
        }
      } else this.extraTotals = {};
      if (cfg.others) {
        try {
          // Your repositories include the ones team requests just brought in.
          const repos = [...new Set([...this.yourRepos(), ...[...found.values()].map((x) => x.repo.toLowerCase())])];
          const { items, errors } = await searchReviewable(repos);
          for (const e of errors || []) this.log(`Pull requests you could review: ${e}`);
          for (const item of items) {
            const id = prKeyString(keyOf(item)).toLowerCase();
            if (!found.has(id)) found.set(id, item);
          }
          searched = true;
        } catch (err) {
          this.log(`Couldn't search for pull requests you could review: ${err instanceof Error ? err.message : err}`);
          for (const [id, item] of this.extras) if (item.reasons.includes("other")) found.set(id, item);
        }
      }
      if (searched || this.extras.size) this.applyExtras(found);
      await this.fillFiles();
      if (cfg.codeOwners) await this.markCodeOwned();
    } finally {
      this.extrasRunning = false;
    }
  }

  /** Put the background searches' results in the list, and take out the ones they no longer return. */
  private applyExtras(found: Map<string, PullRequestSummary>): void {
    const backgroundOnly = (r: PrRecord) => !r.pinned && !!r.summary && r.summary.reasons.every((x) => x === "team-requested" || x === "other" || x === "code-owner");
    const before = this.extras;
    this.extras = found;
    for (const [id, item] of found) {
      const r = this.record(keyOf(item));
      if (!r.summary || backgroundOnly(r)) {
        if (r.summary?.headRefOid !== item.headRefOid) r.headSeenAt = Date.now();
        r.summary = this.withKnown(id, item);
      } else {
        const reasons = [...new Set([...r.summary.reasons, ...item.reasons])];
        if (reasons.length !== r.summary.reasons.length) r.summary = { ...r.summary, reasons };
      }
    }
    for (const id of before.keys()) {
      const r = this.records.get(id);
      if (found.has(id) || !r) continue;
      if (backgroundOnly(r) && !["queued", "running"].includes(r.run.state)) this.records.delete(id);
      else if (r.summary) {
        const gone = new Set(before.get(id)!.reasons);
        r.summary = { ...r.summary, reasons: r.summary.reasons.filter((x) => !gone.has(x) || x === "code-owner") };
      }
    }
    this.changed();
  }

  private static readonly OWNERS_TTL = 60 * 60_000;

  /** Mark pull requests whose changed files you or your teams own, from each repository's CODEOWNERS. */
  private async markCodeOwned(): Promise<void> {
    const login = this.viewer?.login;
    if (!login) return;
    try {
      if (!this.teams || Date.now() - this.teams.at > DifflineService.OWNERS_TTL) {
        this.teams = { at: Date.now(), list: await fetchViewerTeams(login).catch((err) => (this.log(`Couldn't read your teams: ${err.message}`), [])) };
      }
      const candidates = this.all().filter((r) => r.summary && !r.summary.own && r.summary.state === "OPEN");
      const repos = [...new Set(candidates.map((r) => `${r.key.owner}/${r.key.name}`.toLowerCase()))];
      const stale = repos.filter((repo) => Date.now() - (this.owners.get(repo)?.at ?? 0) > DifflineService.OWNERS_TTL);
      if (stale.length) {
        const texts = await fetchCodeowners(stale);
        for (const repo of stale) this.owners.set(repo, { at: Date.now(), rules: parseCodeowners(texts.get(repo) || "") });
      }
      const me = { login, teams: this.teams.list };
      const owned = new Set<string>();
      for (const r of candidates) {
        const rules = this.owners.get(`${r.key.owner}/${r.key.name}`.toLowerCase())?.rules || [];
        const paths = r.builtFiles?.map((f) => f.path) || r.summary!.files.map((f) => f.path);
        if (ownsAny(paths, rules, me)) owned.add(prKeyString(r.key).toLowerCase());
      }
      this.codeOwned = owned;
      for (const r of this.all()) {
        if (!r.summary) continue;
        const id = prKeyString(r.key).toLowerCase();
        const has = r.summary.reasons.includes("code-owner");
        if (owned.has(id) && !has) r.summary = { ...r.summary, reasons: [...r.summary.reasons, "code-owner"] };
        else if (!owned.has(id) && has) r.summary = { ...r.summary, reasons: r.summary.reasons.filter((x) => x !== "code-owner") };
      }
      this.changed();
    } catch (err) {
      this.log(`Couldn't check code owners: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Changed-file lists for rows the search returned without them, so every row gets a risk score. */
  private async fillFiles(): Promise<void> {
    const need = this.all().filter((r) => r.summary && !r.summary.files.length && !r.builtFiles && r.summary.changedFiles > 0);
    for (let i = 0; i < need.length; i += 20) {
      const batch = need.slice(i, i + 20);
      try {
        const files = await fetchPullRequestFiles(batch.map((r) => r.key));
        for (const r of batch) {
          const list = files.get(prKeyString(r.key)) || files.get(prKeyString(r.key).toLowerCase());
          if (list && r.summary) {
            r.summary.files = list;
            this.files.set(prKeyString(r.key).toLowerCase(), { head: r.summary.headRefOid, files: list });
          }
        }
        this.changed();
      } catch (err) {
        this.log(`Couldn't load changed files: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
  }

  /** Build the diffs of pull requests you're asked to review ahead of time, so opening them is instant. */
  private async warmUp(): Promise<void> {
    // A first clone can outlast several refreshes; one warm-up at a time.
    if (this.warming) return;
    this.warming = true;
    try {
      const targets = this.all().filter((r) => r.summary && (r.summary.reasons.includes("review-requested") || r.summary.reasons.includes("pinned")) && r.builtHead !== r.summary.headRefOid);
      for (const r of targets.slice(0, 10)) {
        try {
          await this.loadData(r.key);
        } catch (err) {
          this.log(`Couldn't prepare ${prKeyString(r.key)}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      this.warming = false;
    }
  }

  /* ---------- Pinned pull requests (opened by hand) ---------- */

  async pin(key: PrKey): Promise<void> {
    const r = this.record(key);
    r.pinned = true;
    await this.savePinned();
    this.changed();
  }

  async unpin(key: PrKey): Promise<void> {
    const r = this.get(key);
    if (!r) return;
    r.pinned = false;
    await this.savePinned();
    // A row whose agents are running stays until they finish, as in a refresh.
    const busy = r.run.state === "queued" || r.run.state === "running";
    if (!busy && (!r.summary || r.summary.reasons.every((x) => x === "pinned"))) this.records.delete(prKeyString(key).toLowerCase());
    this.changed();
  }

  private savePinned() {
    return this.memory.update("pinned", this.all().filter((r) => r.pinned).map((r) => prKeyString(r.key)));
  }

  /* ---------- Loading a review ---------- */

  async detail(key: PrKey, maxAgeMs = 0): Promise<PullRequestDetail> {
    const id = prKeyString(key).toLowerCase();
    const cached = this.details.get(id);
    if (cached && Date.now() - cached.at <= maxAgeMs) return cached.detail;
    const detail = await fetchPullRequest(key);
    this.details.set(id, { at: Date.now(), detail });
    if (detail.viewer?.login) this.viewer = detail.viewer;
    return detail;
  }

  /** The diff for a pull request at its current head, from the cache or built from the local clone. */
  async loadData(key: PrKey, detailIn?: PullRequestDetail): Promise<{ data: ReviewData; detail: PullRequestDetail; clonePath: string }> {
    const [detail, clone] = await Promise.all([detailIn ? Promise.resolve(detailIn) : this.detail(key, 30_000), this.repos.resolve(key.owner, key.name)]);
    const pr = detail.pr;
    await this.repos.ensureCommits(clone, { number: key.number, head: pr.headRefOid, base: pr.baseRefOid, baseRefName: pr.baseRefName });
    const lastCommit = pr.lastReview?.commit || null;
    const since = lastCommit && lastCommit !== pr.headRefOid && (await this.repos.hasCommit(clone.path, lastCommit)) ? lastCommit : null;
    const buildId = `${prKeyString(key).toLowerCase()}@${pr.headRefOid}-${since || ""}`;
    let building = this.building.get(buildId);
    if (!building) {
      building = (async () => {
        const cached = await this.store.readReviewData(key, pr.headRefOid, since);
        if (cached) return cached;
        const started = Date.now();
        const built = await buildReviewData(clone.path, pr.baseRefOid, pr.headRefOid, since, { base: pr.baseRefName, head: pr.headRefName, since: "your last review" });
        built.repo = `${key.owner}/${key.name}`;
        await this.store.writeReviewData(key, pr.headRefOid, since, built);
        this.log(`Built ${prKeyString(key)} @ ${pr.headRefOid.slice(0, 7)}: ${built.files.length} files in ${Date.now() - started} ms`);
        return built;
      })().finally(() => this.building.delete(buildId));
      this.building.set(buildId, building);
    }
    const data = await building;
    const r = this.record(key);
    r.builtHead = pr.headRefOid;
    r.builtFiles = data.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, generated: f.generated, tests: f.tests }));
    const files = data.files;
    r.totals = {
      files: files.length,
      hunks: files.reduce((n, f) => n + f.hunks.length, 0),
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      weight: files.filter((f) => !f.generated).reduce((n, f) => n + f.additions + f.deletions, 0),
    };
    this.changed();
    return { data, detail, clonePath: clone.path };
  }

  /** Whether a detail fetched earlier is on hand, so a review can open from it before GitHub answers. */
  hasCachedDetail(key: PrKey): boolean {
    return this.details.has(prKeyString(key).toLowerCase());
  }

  /** Everything the page needs for one pull request. */
  async loadReview(key: PrKey, opts: { cached?: boolean; home?: boolean } = {}): Promise<{ data: ReviewData; live: LiveData }> {
    const detail = await this.detail(key, opts.cached ? Number.POSITIVE_INFINITY : 0);
    const { data } = await this.loadData(key, detail);
    const [agent, state] = await Promise.all([this.store.readAgent(key), this.store.readState(key)]);
    this.record(key).agent = agentSummary(agent);
    const live: LiveData = {
      repo: `${key.owner}/${key.name}`,
      number: key.number,
      url: detail.pr.url,
      github: true,
      githubError: null,
      viewer: detail.viewer,
      pr: detail.pr,
      threads: detail.threads,
      loadedAt: new Date().toISOString(),
      token: "",
      api: "",
      agent,
      state,
      list: [],
    };
    const groups = await this.pageGroups();
    live.groups = groups;
    live.grouping = this.grouping();
    live.list = await this.listItems(key, detail, groups);
    if (opts.home) live.startView = "inbox";
    return { data, live };
  }

  /* ---------- The list, as the page and the sidebar show it ---------- */

  riskInput(r: PrRecord, state: { findings?: Record<string, { state?: string }> } | null): RiskInput {
    const decided = state?.findings || {};
    const files = r.builtHead && r.builtHead === r.summary?.headRefOid ? r.builtFiles! : r.builtFiles && !r.summary ? r.builtFiles : (r.summary?.files || []).map((f) => ({ ...f, generated: isGenerated(f.path), tests: null }));
    return {
      files,
      findings: (r.agent?.findings || []).map((f) => ({ severity: f.severity, state: decided[f.id]?.state || "open" })),
      checks: r.summary?.checks || { total: 0, failed: 0, running: 0 },
    };
  }

  async risk(r: PrRecord) {
    const state = await this.store.readState(r.key);
    return computeRisk(this.riskInput(r, state));
  }

  /** The sidebar's groups, which the page's list mirrors. */
  async groups(): Promise<RowGroup<{ record: PrRecord; risk: Risk | null; tag?: string; inRepoGroup?: boolean }>[]> {
    const rows = await Promise.all(this.all().map(async (record) => ({ record, risk: await this.risk(record).catch(() => null) })));
    return buildGroups(rows, this.config().sidebar, this.totals);
  }

  grouping(): NonNullable<LiveData["grouping"]> {
    const c = this.config().sidebar;
    return { by: c.groupBy, sort: c.sortBy };
  }

  /** The groups as the page gets them: keys only, in order. */
  async pageGroups(): Promise<NonNullable<LiveData["groups"]>> {
    return (await this.groups()).map((g) => ({ id: g.id, label: g.label, description: g.description, collapsed: !!g.collapsed, keys: g.rows.map((r) => prKeyString(r.record.key)) }));
  }

  async listItems(current?: PrKey, currentDetail?: PullRequestDetail, groups?: NonNullable<LiveData["groups"]>): Promise<ListItem[]> {
    // The page's list has what the sidebar shows: everything grouped, which leaves out all but the top others.
    const shown = groups ? new Set(groups.flatMap((g) => g.keys.map((k) => k.toLowerCase()))) : null;
    const rows = this.all().filter((r) => (shown ? shown.has(prKeyString(r.key).toLowerCase()) : r.pinned || !r.summary || r.summary.reasons.some((x) => x !== "other")));
    if (current && !rows.some((r) => sameKey(r.key, current))) rows.push(this.record(current));
    const items = await Promise.all(
      rows.map(async (r): Promise<ListItem> => {
        const s = r.summary;
        const state = await this.store.readState(r.key);
        const decided = state?.findings || {};
        const isCurrent = current && sameKey(r.key, current);
        const pr = isCurrent && currentDetail ? currentDetail.pr : null;
        const desc = r.agent?.description;
        const checks = pr ? countChecks(pr.checks) : s?.checks || { total: 0, failed: 0, running: 0 };
        return {
          number: r.key.number,
          repo: `${r.key.owner}/${r.key.name}`,
          key: `${r.key.owner}/${r.key.name}#${r.key.number}`,
          href: "",
          loaded: !!r.builtHead,
          error: null,
          title: pr?.title ?? s?.title ?? null,
          author: pr?.author ?? s?.author ?? null,
          createdAt: pr?.createdAt ?? s?.createdAt ?? null,
          state: pr?.state ?? s?.state ?? null,
          isDraft: pr?.isDraft ?? s?.isDraft ?? null,
          baseRefName: pr?.baseRefName ?? s?.baseRefName ?? null,
          headRefName: pr?.headRefName ?? s?.headRefName ?? null,
          defaultBranch: pr?.defaultBranch ?? null,
          reviewDecision: pr?.reviewDecision ?? s?.reviewDecision ?? null,
          mergeStateStatus: pr?.mergeStateStatus ?? s?.mergeStateStatus ?? null,
          ...(r.totals || { additions: s?.additions, deletions: s?.deletions, files: s?.changedFiles }),
          reviewed: (state?.reviewedIds || []).length,
          drafts: (state?.drafts || []).length,
          checks,
          agent: r.agent
            ? {
                findings: r.agent.findings.length,
                openHigh: r.agent.findings.filter((f) => f.severity === "high" && !decided[f.id]).length,
                open: r.agent.findings.filter((f) => !decided[f.id]).length,
              }
            : null,
          description: desc ? { kind: desc.kind, gaps: desc.items.filter((it) => it.status === "partly" || it.status === "missing").length, rules: desc.items.length } : null,
          requested: s?.requested ?? false,
          viewerReview: s?.viewerReview ?? null,
          own: s?.own ?? false,
          riskInput: this.riskInput(r, state),
        };
      }),
    );
    // Note pull requests stacked on another one in the list.
    const heads = new Map(items.filter((it) => it.headRefName).map((it) => [`${it.repo}\0${it.headRefName}`, it.number]));
    for (const it of items) {
      const base = heads.get(`${it.repo}\0${it.baseRefName}`);
      if (base && base !== it.number) it.stackedOnPr = base;
    }
    return items;
  }

  /* ---------- The page's calls ---------- */

  async api(key: PrKey, method: string, apiPath: string, body: unknown): Promise<unknown> {
    if (method === "PUT" && apiPath === "/state") {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
      await this.store.writeState(key, body as Record<string, unknown>);
      return { ok: true };
    }
    if (method === "POST" && (apiPath === "/push" || apiPath === "/push?dry=1")) {
      const dry = apiPath.endsWith("?dry=1");
      const detail = await this.detail(key, 60_000);
      const payload = checkPush(body, detail);
      // Comments sit on lines of the diff the page was built from, so the review is posted on that commit.
      const head = typeof payload.head === "string" && /^[0-9a-f]{40}$/.test(payload.head) ? payload.head : detail.pr.headRefOid;
      const result = await pushReview(key, head, detail.viewer?.login || null, payload, dry);
      if (!dry) this.details.delete(prKeyString(key).toLowerCase());
      return result;
    }
    if (method === "POST" && apiPath === "/refresh") {
      this.details.delete(prKeyString(key).toLowerCase());
      const { data } = await this.loadData(key);
      void this.refresh().catch(() => undefined);
      return { ok: true, head: data.head.sha };
    }
    throw new Error(`Not found: ${method} ${apiPath}`);
  }

  /* ---------- Agents ---------- */

  /** Queue automatic runs for pull requests that request your review and have new commits. */
  private scheduleAutomaticRuns(): void {
    const cfg = this.config().agents;
    if (!cfg.autoRun || !this.leader) return;
    const counts = this.memory.get<Record<string, number>>("autoRuns", {});
    for (const r of this.all()) {
      const s = r.summary;
      if (!s || !s.reasons.includes("review-requested") || s.state !== "OPEN") continue;
      if (cfg.skipDrafts && s.isDraft) continue;
      if (r.agent?.commit === s.headRefOid) continue;
      if (["waiting", "queued", "running", "elsewhere"].includes(r.run.state)) continue;
      if (r.run.head === s.headRefOid && (r.run.state === "failed" || r.run.state === "cancelled")) continue;
      if ((counts[prKeyString(r.key).toLowerCase()] || 0) >= cfg.maxAutomaticRuns) continue;
      const note = tooLargeToAutoRun(s, cfg);
      if (note) {
        r.run = { state: "held", head: s.headRefOid, note };
        continue;
      }
      r.run = { state: "waiting", head: s.headRefOid, automatic: true, dueAt: (r.headSeenAt || Date.now()) + cfg.quietPeriodSeconds * 1000 };
    }
    this.startDueRuns();
    this.changed();
  }

  private startDueRuns(): void {
    for (const r of this.all()) {
      if (r.run.state === "waiting" && (r.run.dueAt || 0) <= Date.now()) void this.runAgents(r.key, { automatic: true });
    }
  }

  freshness(key: PrKey): Freshness {
    const r = this.get(key);
    return r ? reviewFreshness(r.agent, r.summary) : { state: "none", activity: false };
  }

  isBusy(key: PrKey): boolean {
    const s = this.get(key)?.run.state;
    return s === "queued" || s === "running" || s === "elsewhere";
  }

  async runAgents(key: PrKey, opts: { automatic?: boolean } = {}): Promise<void> {
    const r = this.record(key);
    const s = r.run.state;
    if (s === "queued" || s === "running") return;
    r.run = { state: "queued", automatic: !!opts.automatic, startedAt: Date.now() };
    this.changed();
    // Set before the first wait, so Stop works on a run that's still queued.
    const ctrl = new AbortController();
    this.controllers.set(prKeyString(key).toLowerCase(), ctrl);
    const cfg = this.config();
    let locked = false;
    let tree: { path: string; remove: () => Promise<void> } | null = null;
    try {
      // Another window may be running this pull request already.
      const lock = await this.locks.acquire(runLock(key), { head: r.summary?.headRefOid }).catch((err) => {
        throw new Error(`Couldn't check whether another VS Code window is running these agents: ${err instanceof Error ? err.message : err}`);
      });
      if (!lock.ok) {
        r.run = { state: "elsewhere", head: lock.holder.head, startedAt: lock.holder.since };
        if (!opts.automatic) this.emit("runElsewhere", key);
        return;
      }
      locked = true;
      const { data, detail, clonePath } = await this.loadData(key, await this.detail(key));
      if (ctrl.signal.aborted) throw new HarnessError("cancelled", "Stopped.");
      r.run.head = data.head.sha;
      if (opts.automatic) {
        // Another window may have finished this head while this run waited.
        await this.loadAgentSummary(r);
        if (r.agent?.commit === data.head.sha) {
          r.run = { state: "idle" };
          return;
        }
        const counts = { ...this.memory.get<Record<string, number>>("autoRuns", {}) };
        const id = prKeyString(key).toLowerCase();
        counts[id] = (counts[id] || 0) + 1;
        await this.memory.update("autoRuns", counts);
      }
      const { settings, problems } = await loadSettings();
      for (const p of problems) this.log(`Agent settings: ${p}`);
      r.run.state = "running";
      this.changed();
      // The agents read a checkout of the pull request's head made for this run, and the changed files as they were
      // before, never the user's clone: they get files to read, not git commands to run.
      const runDir = await this.store.newRunDir(key, data.head.sha);
      tree = await this.repos.reviewTree(key.owner, key.name, { number: key.number, head: data.head.sha, base: detail.pr.baseRefOid, baseRefName: detail.pr.baseRefName });
      if (ctrl.signal.aborted) throw new HarnessError("cancelled", "Stopped.");
      const baseDir = path.join(runDir, "base");
      const before = data.files.filter((f) => f.status !== "added" && !f.binary).map((f) => f.oldPath || f.path);
      const exported = await this.repos.exportFiles(clonePath, data.mergeBase, before, baseDir).catch((err) => {
        this.log(`Couldn't write the changed files as they were for the agents: ${err instanceof Error ? err.message : err}`);
        return 0;
      });
      const result = await runReview({
        key: prKeyString(key),
        repoPath: tree.path,
        baseDir: exported ? baseDir : null,
        data,
        detail,
        harnesses: cfg.harnesses,
        settings,
        enabled: cfg.agents.enabled,
        runDir,
        timeoutMs: cfg.agents.timeoutMinutes * 60_000,
        limiter: this.limiter,
        signal: ctrl.signal,
        onProgress: (p) => {
          r.run.progress = p;
          this.changed();
        },
      });
      await this.store.writeAgent(key, result.file);
      await this.loadAgentSummary(r);
      r.run = { ...r.run, state: "done", finishedAt: Date.now(), costUsd: result.costUsd, tokens: result.tokens, error: result.failed.length ? result.failed.map((f) => `${f.agent}: ${f.error}`).join("; ") : undefined };
      this.log(
        `Agents finished on ${prKeyString(key)} in ${Math.round(result.ms / 1000)}s: ${result.file.findings.length} findings` +
          `${result.costUsd !== null ? `, $${result.costUsd.toFixed(2)}` : ""}${result.tokens ? `, ${formatTokens(result.tokens)}` : ""}${result.problems.dropped.length ? `; ${result.problems.dropped.length} anchors dropped` : ""}`,
      );
      this.emit("runFinished", key, result.file, result.failed);
    } catch (err) {
      const cancelled = ctrl.signal.aborted || (err instanceof HarnessError && err.kind === "cancelled");
      const message = err instanceof GhError || err instanceof HarnessError || err instanceof Error ? err.message : String(err);
      r.run = { ...r.run, state: cancelled ? "cancelled" : "failed", finishedAt: Date.now(), error: cancelled ? undefined : message };
      this.log(`Agents ${cancelled ? "stopped" : "failed"} on ${prKeyString(key)}${cancelled ? "" : `: ${message}`}`);
      if (!cancelled) this.emit("runFailed", key, message, err instanceof HarnessError ? err.kind : "failed");
    } finally {
      this.controllers.delete(prKeyString(key).toLowerCase());
      if (tree) await tree.remove().catch((err) => this.log(`Couldn't remove the agents' checkout ${tree?.path}: ${err instanceof Error ? err.message : err}`));
      if (locked) await this.locks.release(runLock(key)).catch(() => undefined);
      this.changed();
    }
  }

  cancel(key: PrKey): void {
    const r = this.get(key);
    if (r?.run.state === "waiting") {
      r.run = { state: "cancelled", head: r.run.head };
      this.changed();
    }
    this.controllers.get(prKeyString(key).toLowerCase())?.abort();
  }

  dispose(): void {
    this.stop();
    for (const c of this.controllers.values()) c.abort();
    void this.locks.releaseAll();
  }
}

/**
 * The page's review before it's posted: replies and thread changes must be about this pull request's own threads, and
 * nothing that looks like a secret goes out. Throws with a message the page shows.
 */
export function checkPush(body: unknown, detail: PullRequestDetail): PushPayload & { head?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a review to post.");
  const p = body as PushPayload & { head?: string };
  const threads = new Set(detail.threads.map((t) => t.id));
  const comments = new Set(detail.threads.flatMap((t) => t.comments.map((c) => c.dbId)).filter((n): n is number => typeof n === "number"));
  for (const t of [...(p.resolve || []), ...(p.unresolve || [])]) {
    if (!threads.has(String(t))) throw new Error("A thread to resolve isn't on this pull request. Refresh and try again.");
  }
  for (const r of p.replies || []) {
    if (!comments.has(Number(r?.comment_id))) throw new Error("A reply is to a comment that isn't on this pull request. Refresh and try again.");
  }
  const secrets = findSecrets([
    { where: "the summary", text: String(p.body || "") },
    ...(p.comments || []).map((c) => ({ where: `the comment on ${c?.path}:${c?.line}`, text: String(c?.body || "") })),
    ...(p.replies || []).map((r) => ({ where: "a reply", text: String(r?.body || "") })),
  ]);
  if (secrets.length) {
    throw new Error(`This review has what looks like ${secrets.join(", ")}. Remove it before posting; nothing was sent.`);
  }
  return p;
}

/** owner/name#number or a pull request link. Only names GitHub allows, so a key can't reach outside Diffline's folders. */
export function parseKey(s: string): PrKey | null {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(s.trim()) || /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(s);
  if (!m) return null;
  const [, owner, name, number] = m;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || /^\.+$/.test(name)) return null;
  return { owner, name, number: Number(number) };
}
