// Review metrics: what the reviewer did with each agent finding and description check, each review they posted, and
// each agent run, one JSON object per line in <global storage>/metrics/events.jsonl. Only the extension writes it: the
// page sends what happened, and the extension checks it and adds the rest from the pull request's agent file. Nothing
// leaves the computer, and no finding text, code, diff or comment goes in: a finding's title is the one readable field.

import { access, appendFile, chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { AgentRunRecord } from "../agents/review.ts";
import type { AgentFile, AgentInfo, Finding, PrKey } from "./types.ts";
import { prKeyString } from "./types.ts";

export const METRICS_VERSION = 1;

export type MetricsKind = "finding" | "description" | "review" | "run";
export type MetricsAction =
  | "added" | "dismissed" | "copied" | "undone" | "posted" | "left-open" // finding
  | "asked" | "skipped" // description (and undone)
  | "submitted" // review
  | "finished" | "failed" | "cancelled"; // run

export interface ReviewSummary {
  event: "approve" | "changes" | "comment";
  /** The viewer authored the pull request. */
  own: boolean;
  /** Inline comments and replies posted. */
  comments: number;
  /** Of those, drafts that came from agent findings. */
  fromFindings: number;
  /** Hunks marked reviewed, of `hunks`. */
  reviewed: number;
  hunks: number;
  /** An agent review existed for the pull request. */
  agents: boolean;
  /** Time the review page was focused and in use for this pull request since it opened or the last review posted. */
  activeMs: number;
  /** 1 for the first review of this pull request in the log, 2 for the next, …. */
  round: number;
  /** The head differs from the one the previous review in the log was posted on. */
  newPush: boolean;
}

/** One line of the log (schema version 1). */
export interface MetricsEvent {
  v: 1;
  at: string;
  pr: string;
  head: string | null;
  /** The agent file's ranAt: the run the reviewer saw, or the run that just finished. Null without one. */
  run: string | null;
  kind: MetricsKind;
  action: MetricsAction;
  reason?: string;
  finding?: Pick<Finding, "id" | "agent" | "severity" | "confidence" | "label" | "path" | "title">;
  agent?: { id: string; harness: string | null; model: string | null; thinking?: string | null; instructions: string | null };
  rule?: string;
  descKind?: "feature" | "fix";
  /** Posted findings: 0 when posted as the agent wrote it, 1 when fully rewritten. */
  edit?: number;
  review?: ReviewSummary;
  /** Runs: what started it, how long it took, and how each agent did. */
  trigger?: "auto" | "manual";
  ms?: number;
  agents?: AgentRunRecord[];
}

/** What the page sends: `{ type: "metrics", key, head, run, events }`. */
export interface PageMetrics {
  head?: unknown;
  run?: unknown;
  events?: unknown;
}

const FINDING_ACTIONS = ["added", "dismissed", "copied", "undone", "posted", "left-open"] as const;
const DESC_ACTIONS = ["asked", "skipped", "undone"] as const;
const REVIEW_EVENTS = ["approve", "changes", "comment"] as const;
/** Long enough for any reason the page offers; anything longer isn't one of them. */
const MAX_REASON = 80;
/** Word-level edit distance is quadratic: longer texts are compared on their first this-many words. */
const MAX_WORDS = 1500;
/** A day: more active time than this on one review is a clock problem, not a review. */
const MAX_ACTIVE_MS = 86_400_000;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);

/**
 * How much of a text was rewritten: the word-level edit distance between them over the longer one's length, 0 (the
 * same words) to 1 (nothing kept), rounded to three places.
 */
export function editRatio(from: string, to: string): number {
  const a = words(from);
  const b = words(to);
  const longer = Math.max(a.length, b.length);
  if (!longer) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((prev[b.length] / longer) * 1000) / 1000;
}

/** The agent's finding word for word, as the page's "As written" draft has it (verbatimOf in app.js). */
export function verbatimText(f: Pick<Finding, "title" | "body" | "fix">): string {
  return [`**${f.title}**`, f.body, ...(f.fix ? [`Suggested fix: ${f.fix.text}`] : [])].join("\n\n");
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const count = (v: unknown, max = 1e7): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | null => (xs.includes(v as T) ? (v as T) : null);

function agentOf(info: AgentInfo | undefined, id: string): NonNullable<MetricsEvent["agent"]> {
  return {
    id,
    harness: info?.harness ?? null,
    model: info?.model ?? null,
    ...(info && info.thinking !== undefined ? { thinking: info.thinking } : {}),
    instructions: info?.instructions ?? null,
  };
}

/**
 * The log lines for one message from the page: each event checked, and the finding, agent and description details
 * added from the agent file. Events that don't check out (an unknown finding or rule, a bad action) are left out and
 * counted. A review's `round` and `newPush` come from the log, so they're set when it's appended (MetricsLog).
 */
export function buildEvents(key: PrKey, msg: PageMetrics, agent: AgentFile | null, now = new Date()): { events: MetricsEvent[]; skipped: number } {
  const list = Array.isArray(msg.events) ? msg.events : [];
  const head = typeof msg.head === "string" && /^[0-9a-f]{40}$/.test(msg.head) ? msg.head : agent?.commit || null;
  // The run the page showed: an agent file can be replaced while a page from before it stays open.
  const run = str(msg.run, 40) ?? agent?.ranAt ?? null;
  const base = { v: METRICS_VERSION, at: now.toISOString(), pr: prKeyString(key), head, run } as const;
  const events: MetricsEvent[] = [];
  let skipped = 0;
  for (const raw of list) {
    const ev = toEvent((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>, base, agent);
    if (ev) events.push(ev);
    else skipped++;
  }
  return { events, skipped };
}

function toEvent(e: Record<string, unknown>, base: Pick<MetricsEvent, "v" | "at" | "pr" | "head" | "run">, agent: AgentFile | null): MetricsEvent | null {
  if (e.kind === "finding") {
    const action = oneOf(e.action, FINDING_ACTIONS);
    const f = agent?.findings.find((x) => x.id === e.finding);
    if (!action || !f) return null;
    const reason = action === "dismissed" || action === "undone" ? str(e.reason, MAX_REASON) : null;
    if (action === "dismissed" && !reason) return null;
    let edit: number | undefined;
    if (action === "posted") {
      if (typeof e.text !== "string") return null;
      edit = editRatio(e.verbatim === true ? verbatimText(f) : f.comment || verbatimText(f), e.text);
    }
    return {
      ...base,
      kind: "finding",
      action,
      ...(reason ? { reason } : {}),
      finding: { id: f.id, agent: f.agent, severity: f.severity, confidence: f.confidence, label: f.label, path: f.path, title: f.title },
      agent: agentOf(agent!.agents.find((a) => a.id === f.agent), f.agent),
      ...(edit !== undefined ? { edit } : {}),
    };
  }
  if (e.kind === "description") {
    const action = oneOf(e.action, DESC_ACTIONS);
    const d = agent?.description;
    const rule = typeof e.rule === "string" && d?.items.some((it) => it.rule === e.rule) ? e.rule : null;
    if (!action || !d || !rule) return null;
    const reason = action === "skipped" || action === "undone" ? str(e.reason, MAX_REASON) : null;
    if (action === "skipped" && !reason) return null;
    return { ...base, kind: "description", action, ...(reason ? { reason } : {}), agent: agentOf(agent!.agents.find((a) => a.id === "guide"), "guide"), rule, descKind: d.kind };
  }
  if (e.kind === "review" && e.action === "submitted") {
    const r = (e.review && typeof e.review === "object" ? e.review : {}) as Record<string, unknown>;
    const event = oneOf(r.event, REVIEW_EVENTS);
    const n = { comments: count(r.comments), fromFindings: count(r.fromFindings), reviewed: count(r.reviewed), hunks: count(r.hunks) };
    if (!event || typeof r.own !== "boolean" || typeof r.agents !== "boolean" || Object.values(n).some((x) => x === null)) return null;
    const activeMs = typeof r.activeMs === "number" && Number.isFinite(r.activeMs) ? Math.min(MAX_ACTIVE_MS, Math.max(0, Math.round(r.activeMs))) : 0;
    return {
      ...base,
      run: r.agents ? base.run : null,
      kind: "review",
      action: "submitted",
      review: { event, own: r.own, comments: n.comments!, fromFindings: Math.min(n.fromFindings!, n.comments!), reviewed: n.reviewed!, hunks: n.hunks!, agents: r.agents, activeMs, round: 1, newPush: false },
    };
  }
  return null;
}

/** A run event: written after every agent run, whether it finished, failed or was stopped. */
export function runEvent(key: PrKey, r: { head: string | null; run: string | null; action: "finished" | "failed" | "cancelled"; trigger: "auto" | "manual"; ms: number; agents: AgentRunRecord[] }, now = new Date()): MetricsEvent {
  return {
    v: METRICS_VERSION,
    at: now.toISOString(),
    pr: prKeyString(key),
    head: r.head,
    run: r.run,
    kind: "run",
    action: r.action,
    trigger: r.trigger,
    ms: Math.max(0, Math.round(r.ms)),
    agents: r.agents.map((a) => ({
      id: a.id,
      harness: a.harness,
      model: a.model,
      ...(a.thinking !== undefined ? { thinking: a.thinking } : {}),
      instructions: a.instructions,
      ms: Math.max(0, Math.round(a.ms)),
      tokens: a.tokens ? { input: a.tokens.input, cachedInput: a.tokens.cachedInput, output: a.tokens.output } : null,
      costUsd: a.costUsd,
      findings: a.findings,
      ...(a.failed ? { failed: a.failed } : {}),
    })),
  };
}

/** What earlier lines say, for the lines being appended: `left-open` already written, and each pull request's reviews. */
interface LogIndex {
  /** "pr\0run\0finding" */
  leftOpen: Set<string>;
  /** Pull request (lowercase) → reviews so far and the head of the last one. */
  reviews: Map<string, { count: number; head: string | null }>;
}

/**
 * Appends events to the log. Messages are handled one at a time in the order they arrive, so the lines keep that
 * order however quickly they come. `left-open` is written once per pull request, run and finding.
 */
export class MetricsLog {
  readonly file: string;
  private readonly enabled: () => boolean;
  private readonly log: (line: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  /** Read from the file the first time it's needed, then kept up to date. */
  private index: LogIndex | null = null;

  constructor(dir: string, opts: { enabled: () => boolean; log?: (line: string) => void }) {
    this.file = path.join(dir, "events.jsonl");
    this.enabled = opts.enabled;
    this.log = opts.log || (() => undefined);
  }

  private then<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Record a message from the page about one pull request. Resolves with the events written. */
  record(key: PrKey, msg: PageMetrics, readAgent: () => Promise<AgentFile | null>): Promise<MetricsEvent[]> {
    if (!this.enabled()) return Promise.resolve([]);
    return this.then(async () => {
      const agent = await readAgent().catch(() => null);
      const { events, skipped } = buildEvents(key, msg, agent);
      if (skipped) this.log(`Review metrics: ${skipped} event${skipped === 1 ? "" : "s"} from the review page didn't match ${prKeyString(key)}'s agent review and weren't logged`);
      return this.append(events);
    });
  }

  /** Record a finished, failed or stopped agent run. */
  recordRun(key: PrKey, r: Parameters<typeof runEvent>[1]): Promise<MetricsEvent[]> {
    if (!this.enabled()) return Promise.resolve([]);
    return this.then(() => this.append([runEvent(key, r)]));
  }

  private async append(events: MetricsEvent[]): Promise<MetricsEvent[]> {
    const ix = events.some((e) => e.action === "left-open" || e.kind === "review") ? await this.loadIndex() : null;
    const keep = events.filter((e) => {
      if (e.action === "left-open") {
        const id = `${e.pr}\0${e.run}\0${e.finding!.id}`;
        if (ix!.leftOpen.has(id)) return false;
        ix!.leftOpen.add(id);
      }
      if (e.kind === "review" && e.review) {
        const pr = e.pr.toLowerCase();
        const before = ix!.reviews.get(pr);
        e.review.round = (before?.count ?? 0) + 1;
        e.review.newPush = !!before && before.head !== e.head;
        ix!.reviews.set(pr, { count: e.review.round, head: e.head });
      }
      return true;
    });
    if (!keep.length) return keep;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, keep.map((e) => JSON.stringify(e) + "\n").join(""), { encoding: "utf8", mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => undefined);
    return keep;
  }

  private async loadIndex(): Promise<LogIndex> {
    if (this.index) return this.index;
    const ix: LogIndex = { leftOpen: new Set(), reviews: new Map() };
    const text = await readFile(this.file, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"left-open"') && !line.includes('"review"')) continue;
      try {
        const e = JSON.parse(line) as MetricsEvent;
        if (e.action === "left-open" && e.finding) ix.leftOpen.add(`${e.pr}\0${e.run}\0${e.finding.id}`);
        if (e.kind === "review" && typeof e.pr === "string") {
          const pr = e.pr.toLowerCase();
          ix.reviews.set(pr, { count: (ix.reviews.get(pr)?.count ?? 0) + 1, head: e.head ?? null });
        }
      } catch {
        /* a damaged line */
      }
    }
    this.index = ix;
    return ix;
  }

  /** Whether new events are written (diffline.metrics.enabled). */
  get on(): boolean {
    return this.enabled();
  }

  /** The log's text, after anything already queued is written; empty when there's no log yet. */
  read(): Promise<string> {
    return this.then(() => readFile(this.file, "utf8").catch((err) => (err && err.code === "ENOENT" ? "" : Promise.reject(err))));
  }

  /** Delete the log, after anything already queued is written. Resolves true when there was one. */
  delete(): Promise<boolean> {
    return this.then(async () => {
      this.index = { leftOpen: new Set(), reviews: new Map() };
      const had = await access(this.file).then(() => true, () => false);
      await rm(this.file, { force: true });
      return had;
    });
  }
}
