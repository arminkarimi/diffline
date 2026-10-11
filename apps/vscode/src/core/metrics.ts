// The review metrics report: what the log (metrics-log.ts) adds up to over a period. Pure functions over parsed
// events, so the numbers can be tested without VS Code; the extension reads the file and the page draws the result.
// Three parts: the reviews you posted, what happened to agent findings, and what agent runs took and cost.

import type { MetricsEvent } from "./metrics-log.ts";

export type GroupBy = "agent" | "harness" | "model" | "thinking";
export const GROUP_BYS: readonly GroupBy[] = ["agent", "harness", "model", "thinking"];
/** The page's period picker; null is all time. */
export const PERIODS: ReadonlyArray<number | null> = [7, 30, 90, null];

/** A finding's last event decides it: added, posted or copied = useful; left open when a review posted = ignored. */
export type Outcome = "useful" | "dismissed" | "ignored" | "undecided";
/** Groups with fewer decided findings than this say "too few to tell" instead of percentages that mean little. */
export const TOO_FEW = 10;
/** Examples kept per group for the drill-down, newest first. */
const MAX_EXAMPLES = 100;
/** Weeks in the reviews table at most (all time on an old log). */
const MAX_WEEKS = 104;

const KINDS = new Set(["finding", "description", "review", "run"]);
const OUTCOME_OF: Record<string, Outcome> = { added: "useful", posted: "useful", copied: "useful", dismissed: "dismissed", "left-open": "ignored", undone: "undecided" };
const SEVERITIES = ["high", "medium", "low"];
const CONFIDENCES = ["High confidence", "Worth asking", "Minor"];
const RULES = ["what", "why", "evidence", "diagram", "rollout", "dependencies", "risks"];

/* ---------- Reading the log ---------- */

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Whether a parsed line is an event this version reads. Unknown fields are fine; unknown kinds and versions aren't. */
function usable(e: unknown): e is MetricsEvent {
  if (!isObj(e) || e.v !== 1 || !isStr(e.at) || !Number.isFinite(Date.parse(e.at)) || !isStr(e.pr) || !KINDS.has(e.kind) || !isStr(e.action)) return false;
  if (e.kind === "finding") return isObj(e.finding) && isStr(e.finding.id);
  if (e.kind === "description") return isStr(e.rule);
  if (e.kind === "review") return isObj(e.review);
  return Array.isArray(e.agents) && e.agents.every((a: unknown) => isObj(a) && isStr(a.id));
}

/** The log's lines as events. Damaged lines, other versions and kinds this version doesn't know are counted, not read. */
export function parseEvents(text: string): { events: MetricsEvent[]; skipped: number } {
  const events: MetricsEvent[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (usable(e)) events.push(e);
    else skipped++;
  }
  return { events, skipped };
}

export const sinceDays = (days: number | null, now = new Date()): Date | null => (days ? new Date(now.getTime() - days * 864e5) : null);
const inPeriod = (at: string, since: Date | null) => !since || Date.parse(at) >= since.getTime();

/** The raw events in a period, for the JSON export. */
export const eventsSince = (events: MetricsEvent[], since: Date | null) => events.filter((e) => inPeriod(e.at, since));

/* ---------- Small statistics ---------- */

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const share = (n: number, of: number) => (of ? round(n / of) : null);
const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
  return [...m].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
};
/** The values seen, known ones in their order first, then the rest alphabetically. */
const ordered = (known: string[], seen: string[]) => {
  const set = new Set(seen);
  return [...known.filter((x) => set.has(x)), ...[...set].filter((x) => !known.includes(x)).sort()];
};

/* ---------- Agent findings ---------- */

/** One finding's final outcome: its last event per pull request and finding id. One row of the CSV export. */
export interface FindingOutcome {
  /** When the last event happened: when it was decided. */
  at: string;
  pr: string;
  /** The run the reviewer saw when deciding it (the agent file's ranAt). */
  run: string | null;
  id: string;
  title: string;
  agent: string;
  harness: string | null;
  model: string | null;
  /** Pi's thinking level (null for Pi's default); undefined for other harnesses. */
  thinking?: string | null;
  instructions: string | null;
  severity: string;
  confidence: string;
  /** The last event's action. */
  action: string;
  outcome: Outcome;
  /** Why it was dismissed. */
  reason: string | null;
  /** Posted findings: how much of the text was reworded, 0 to 1. */
  edit: number | null;
}

/** Every finding's outcome over the whole log (each finding once, as its last event left it), oldest decision first. */
export function findingOutcomes(events: MetricsEvent[]): FindingOutcome[] {
  const last = new Map<string, MetricsEvent>();
  for (const e of events) {
    if (e.kind !== "finding" || !e.finding || !OUTCOME_OF[e.action]) continue;
    const k = `${e.pr.toLowerCase()}\0${e.finding.id}`;
    last.delete(k); // keeps the map in order of each finding's last event
    last.set(k, e);
  }
  return [...last.values()].map((e) => {
    const f = e.finding!;
    const a = e.agent;
    const outcome = OUTCOME_OF[e.action];
    return {
      at: e.at,
      pr: e.pr,
      run: e.run ?? null,
      id: f.id,
      title: String(f.title ?? ""),
      agent: a?.id || f.agent || "unknown",
      harness: a?.harness ?? null,
      model: a?.model ?? null,
      ...(a && a.thinking !== undefined ? { thinking: a.thinking } : {}),
      instructions: a?.instructions ?? null,
      severity: String(f.severity ?? "unknown"),
      confidence: String(f.confidence ?? "unknown"),
      action: e.action,
      outcome,
      reason: outcome === "dismissed" && typeof e.reason === "string" ? e.reason : null,
      edit: e.action === "posted" && typeof e.edit === "number" ? e.edit : null,
    };
  });
}

type Configured = { id?: string; agent?: string; harness: string | null; model: string | null; thinking?: string | null };
/** The group an agent (a finding's, or one agent in a run) falls in. */
export function groupKey(a: Configured, by: GroupBy): string {
  if (by === "agent") return a.agent || a.id || "unknown";
  if (by === "harness") return a.harness || "unknown";
  if (by === "model") return a.model || "unknown";
  return a.thinking === undefined ? "not used" : a.thinking === null ? "default" : a.thinking;
}

export interface FindingStats {
  findings: number;
  /** Useful, dismissed or ignored: the reviewer did something with it, or posted a review leaving it open. */
  decided: number;
  useful: number;
  dismissed: number;
  ignored: number;
  undecided: number;
  /** Shares of decided findings, 0 to 1; null without decided findings. */
  usefulPct: number | null;
  dismissedPct: number | null;
  ignoredPct: number | null;
  /** Fewer than TOO_FEW decided findings. */
  tooFew: boolean;
}

export interface FindingGroup extends FindingStats {
  key: string;
  topDismissReason: { reason: string; count: number } | null;
  dismissReasons: Array<{ reason: string; count: number }>;
  posted: number;
  /** Median rewording of posted findings, 0 (as written) to 1 (rewritten). */
  editMedian: number | null;
}

function stats(xs: FindingOutcome[]): FindingStats {
  const n = (o: Outcome) => xs.filter((x) => x.outcome === o).length;
  const useful = n("useful"), dismissed = n("dismissed"), ignored = n("ignored");
  const decided = useful + dismissed + ignored;
  return {
    findings: xs.length, decided, useful, dismissed, ignored, undecided: n("undecided"),
    usefulPct: share(useful, decided), dismissedPct: share(dismissed, decided), ignoredPct: share(ignored, decided),
    tooFew: decided < TOO_FEW,
  };
}

function findingGroup(key: string, xs: FindingOutcome[]): FindingGroup {
  const dismissReasons = tally(xs.filter((x) => x.outcome === "dismissed").map((x) => x.reason || "No reason"));
  const edits = xs.map((x) => x.edit).filter((x): x is number => x !== null);
  return { key, ...stats(xs), topDismissReason: dismissReasons[0] || null, dismissReasons, posted: xs.filter((x) => x.action === "posted").length, editMedian: median(edits) };
}

export interface ExampleRow {
  at: string;
  pr: string;
  id: string;
  title: string;
  agent: string;
  severity: string;
  confidence: string;
  outcome: Outcome;
  action: string;
  reason: string | null;
}

export interface ConfigSide extends FindingStats {
  instructions: string | null;
  model: string | null;
  /** The first and last run (or decision, without a run) of this configuration in the period. */
  from: string;
  to: string;
}

/** An agent whose instructions or model changed in the period: its latest configuration against the one before. */
export interface ConfigChange {
  agent: string;
  changed: Array<"instructions" | "model">;
  before: ConfigSide;
  after: ConfigSide;
}

function configChanges(outcomes: FindingOutcome[]): ConfigChange[] {
  const byAgent = new Map<string, FindingOutcome[]>();
  for (const o of outcomes) byAgent.set(o.agent, [...(byAgent.get(o.agent) || []), o]);
  const out: ConfigChange[] = [];
  for (const [agent, xs] of byAgent) {
    const configs = new Map<string, { xs: FindingOutcome[]; from: string; to: string }>();
    for (const o of xs) {
      const k = `${o.instructions ?? ""}\0${o.model ?? ""}`;
      const when = o.run || o.at;
      const c = configs.get(k);
      if (!c) configs.set(k, { xs: [o], from: when, to: when });
      else {
        c.xs.push(o);
        if (when < c.from) c.from = when;
        if (when > c.to) c.to = when;
      }
    }
    if (configs.size < 2) continue;
    // Latest: the configuration of the newest run; before it: the one used most recently until then.
    const [after, before] = [...configs.values()].sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
    const side = (c: typeof after): ConfigSide => ({ instructions: c.xs[0].instructions, model: c.xs[0].model, from: c.from, to: c.to, ...stats(c.xs) });
    const a = side(after), b = side(before);
    const changed: ConfigChange["changed"] = [];
    if (a.instructions !== b.instructions) changed.push("instructions");
    if (a.model !== b.model) changed.push("model");
    out.push({ agent, changed, before: b, after: a });
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}

/* ---------- Your reviews ---------- */

export interface ReviewStats {
  reviews: number;
  approve: number;
  changes: number;
  comment: number;
  /** Reviews of your own pull requests, and of others'. */
  own: number;
  others: number;
  /** Median minutes the page was in use per review, of the reviews that measured it. */
  activeMinutes: number | null;
  activeMeasured: number;
  /** Median share of hunks marked reviewed, of reviews with hunks. */
  coverage: number | null;
  /** Reviews that weren't the first on their pull request, and those after a new push. */
  laterRounds: number;
  laterRoundsPct: number | null;
  newPush: number;
  newPushPct: number | null;
  /** Inline comments and replies posted: written by you, and from agent findings. */
  comments: number;
  yours: number;
  fromFindings: number;
}

export interface ReviewWeek extends ReviewStats {
  /** ISO week, "2026-W41". */
  week: string;
  /** Its Monday, "2026-10-05" (local time). */
  start: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mondayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));

/** The ISO week of a date in local time: "2026-W41" and its Monday. */
export function isoWeek(d: Date): { week: string; start: string } {
  const monday = mondayOf(d);
  const year = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3).getFullYear(); // the week's Thursday
  const firstMonday = mondayOf(new Date(year, 0, 4));
  const n = 1 + Math.round((monday.getTime() - firstMonday.getTime()) / (7 * 864e5)); // round: daylight saving shifts
  return { week: `${year}-W${pad(n)}`, start: ymd(monday) };
}

function reviewStats(xs: MetricsEvent[]): ReviewStats {
  const rs = xs.map((e) => e.review!);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const active = rs.map((r) => num(r.activeMs)).filter((ms) => ms > 0);
  const coverage = rs.filter((r) => num(r.hunks) > 0).map((r) => Math.min(1, num(r.reviewed) / num(r.hunks)));
  const comments = rs.reduce((s, r) => s + num(r.comments), 0);
  const fromFindings = rs.reduce((s, r) => s + Math.min(num(r.fromFindings), num(r.comments)), 0);
  const later = rs.filter((r) => num(r.round) > 1).length;
  const pushed = rs.filter((r) => r.newPush === true).length;
  const m = median(active);
  const c = median(coverage);
  return {
    reviews: rs.length,
    approve: rs.filter((r) => r.event === "approve").length,
    changes: rs.filter((r) => r.event === "changes").length,
    comment: rs.filter((r) => r.event === "comment").length,
    own: rs.filter((r) => r.own === true).length,
    others: rs.filter((r) => r.own !== true).length,
    activeMinutes: m === null ? null : round(m / 60000, 1),
    activeMeasured: active.length,
    coverage: c === null ? null : round(c),
    laterRounds: later,
    laterRoundsPct: share(later, rs.length),
    newPush: pushed,
    newPushPct: share(pushed, rs.length),
    comments,
    yours: comments - fromFindings,
    fromFindings,
  };
}

function reviewWeeks(xs: MetricsEvent[], since: Date | null, now: Date): ReviewWeek[] {
  if (!xs.length && !since) return [];
  const byWeek = new Map<string, MetricsEvent[]>();
  for (const e of xs) {
    const w = isoWeek(new Date(e.at)).start;
    byWeek.set(w, [...(byWeek.get(w) || []), e]);
  }
  const first = since ?? new Date(Math.min(...xs.map((e) => Date.parse(e.at))));
  const lastAt = Math.max(now.getTime(), ...xs.map((e) => Date.parse(e.at)));
  const weeks: ReviewWeek[] = [];
  let d = mondayOf(new Date(Math.max(first.getTime(), lastAt - MAX_WEEKS * 7 * 864e5)));
  while (d.getTime() <= lastAt) {
    const w = isoWeek(d);
    weeks.push({ ...w, ...reviewStats(byWeek.get(w.start) || []) });
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
  }
  return weeks;
}

/* ---------- Agent runs ---------- */

export interface RunGroup {
  key: string;
  /** Agent runs: one per agent per run. */
  runs: number;
  failed: number;
  /** Failed agent runs by kind: missing, auth, timeout, cancelled, failed, badOutput. */
  failures: Record<string, number>;
  msMedian: number | null;
  /** Summed over the runs that reported tokens. */
  tokens: { input: number; cachedInput: number; output: number } | null;
  tokensReported: number;
  /** Summed over the runs that reported a cost; costMissing runs didn't (Codex doesn't). Null when none did. */
  costUsd: number | null;
  costReported: number;
  costMissing: number;
  /** Useful findings from the runs that reported a cost, and that cost divided by them. */
  usefulFindings: number;
  costPerUseful: number | null;
  auto: number;
  manual: number;
}

export interface RunTotals {
  /** Run events: one per time agents ran on a pull request. */
  runs: number;
  finished: number;
  failed: number;
  cancelled: number;
  auto: number;
  manual: number;
  msMedian: number | null;
  costUsd: number | null;
  costMissing: number;
  usefulFindings: number;
  costPerUseful: number | null;
}

type RunAgent = NonNullable<MetricsEvent["agents"]>[number] & { trigger?: string; pr: string; run: string | null };

const runKey = (pr: string, run: string | null, agent: string) => `${pr.toLowerCase()}\0${run ?? ""}\0${agent}`;

function costPer(records: RunAgent[], usefulByRun: Map<string, number>) {
  const costed = records.filter((r) => typeof r.costUsd === "number" && Number.isFinite(r.costUsd));
  const cost = costed.reduce((s, r) => s + (r.costUsd as number), 0);
  const useful = costed.reduce((s, r) => s + (r.run ? usefulByRun.get(runKey(r.pr, r.run, r.id)) || 0 : 0), 0);
  return { costUsd: costed.length ? round(cost, 4) : null, costReported: costed.length, costMissing: records.length - costed.length, usefulFindings: useful, costPerUseful: useful && costed.length ? round(cost / useful, 4) : null };
}

function runGroup(key: string, records: RunAgent[], usefulByRun: Map<string, number>): RunGroup {
  const failures: Record<string, number> = {};
  for (const r of records) if (r.failed) failures[r.failed] = (failures[r.failed] || 0) + 1;
  const withTokens = records.filter((r) => isObj(r.tokens));
  const sum = (k: "input" | "cachedInput" | "output") => withTokens.reduce((s, r) => s + (Number(r.tokens![k]) || 0), 0);
  return {
    key,
    runs: records.length,
    failed: records.filter((r) => r.failed).length,
    failures,
    msMedian: median(records.filter((r) => typeof r.ms === "number").map((r) => r.ms)),
    tokens: withTokens.length ? { input: sum("input"), cachedInput: sum("cachedInput"), output: sum("output") } : null,
    tokensReported: withTokens.length,
    ...costPer(records, usefulByRun),
    auto: records.filter((r) => r.trigger === "auto").length,
    manual: records.filter((r) => r.trigger !== "auto").length,
  };
}

/* ---------- The report ---------- */

export interface MetricsReport {
  v: 1;
  generatedAt: string;
  since: string | null;
  groupBy: GroupBy;
  /** Events in the log, and in the period. */
  total: number;
  inPeriod: number;
  /** Lines that couldn't be read (damaged, from a newer version, or of a kind this version doesn't know). */
  skipped: number;
  reviews: { total: ReviewStats; weeks: ReviewWeek[] };
  findings: {
    total: FindingGroup;
    groups: FindingGroup[];
    /** Rows of severity, columns of confidence. */
    severities: string[];
    confidences: string[];
    matrix: Array<FindingStats & { severity: string; confidence: string }>;
    rewording: { posted: number; median: number | null; unchanged: number; rewritten: number };
    description: Array<{ rule: string; asked: number; skipped: number; reasons: Array<{ reason: string; count: number }> }>;
    /** Group key → its findings, newest first. */
    examples: Record<string, ExampleRow[]>;
    changes: ConfigChange[];
  };
  runs: { total: RunTotals; groups: RunGroup[] };
}

export function aggregate(events: MetricsEvent[], opts: { since: Date | null; groupBy: GroupBy; now?: Date; skipped?: number }): MetricsReport {
  const { since, groupBy } = opts;
  const now = opts.now ?? new Date();
  const period = events.filter((e) => inPeriod(e.at, since));

  // Findings: each one as its last event left it, counted in the period its outcome came in.
  const all = findingOutcomes(events);
  const outcomes = all.filter((o) => inPeriod(o.at, since));
  const groups = new Map<string, FindingOutcome[]>();
  for (const o of outcomes) {
    const k = groupKey(o, groupBy);
    groups.set(k, [...(groups.get(k) || []), o]);
  }
  const findingGroups = [...groups].map(([k, xs]) => findingGroup(k, xs)).sort((a, b) => b.findings - a.findings || a.key.localeCompare(b.key));
  const severities = ordered(SEVERITIES, outcomes.map((o) => o.severity));
  const confidences = ordered(CONFIDENCES, outcomes.map((o) => o.confidence));
  const matrix = severities.flatMap((severity) => confidences.map((confidence) => ({ severity, confidence, ...stats(outcomes.filter((o) => o.severity === severity && o.confidence === confidence)) })));
  const edits = outcomes.map((o) => o.edit).filter((x): x is number => x !== null);
  const examples: Record<string, ExampleRow[]> = {};
  for (const [k, xs] of groups) {
    examples[k] = [...xs].reverse().slice(0, MAX_EXAMPLES).map((o) => ({ at: o.at, pr: o.pr, id: o.id, title: o.title, agent: o.agent, severity: o.severity, confidence: o.confidence, outcome: o.outcome, action: o.action, reason: o.reason }));
  }

  // Description rules: each rule on each pull request as its last event left it (undone: neither).
  const lastDesc = new Map<string, MetricsEvent>();
  for (const e of events) if (e.kind === "description" && e.rule) lastDesc.set(`${e.pr.toLowerCase()}\0${e.rule}`, e);
  const desc = [...lastDesc.values()].filter((e) => inPeriod(e.at, since) && (e.action === "asked" || e.action === "skipped"));
  const description = ordered(RULES, desc.map((e) => e.rule!)).map((rule) => {
    const xs = desc.filter((e) => e.rule === rule);
    const skipped = xs.filter((e) => e.action === "skipped");
    return { rule, asked: xs.length - skipped.length, skipped: skipped.length, reasons: tally(skipped.map((e) => (typeof e.reason === "string" ? e.reason : "No reason"))) };
  });

  // Reviews.
  const reviews = period.filter((e) => e.kind === "review" && e.action === "submitted" && e.review);

  // Runs. Useful findings are matched to the run the reviewer saw them on, from the whole log: a finding from a run
  // in the period may be decided after it.
  const runs = period.filter((e) => e.kind === "run" && Array.isArray(e.agents));
  const usefulByRun = new Map<string, number>();
  for (const o of all) if (o.outcome === "useful" && o.run) usefulByRun.set(runKey(o.pr, o.run, o.agent), (usefulByRun.get(runKey(o.pr, o.run, o.agent)) || 0) + 1);
  const records: RunAgent[] = runs.flatMap((e) => e.agents!.map((a) => ({ ...a, trigger: e.trigger, pr: e.pr, run: e.run ?? null })));
  const runGroups = new Map<string, RunAgent[]>();
  for (const r of records) {
    const k = groupKey(r, groupBy);
    runGroups.set(k, [...(runGroups.get(k) || []), r]);
  }

  return {
    v: 1,
    generatedAt: now.toISOString(),
    since: since ? since.toISOString() : null,
    groupBy,
    total: events.length,
    inPeriod: period.length,
    skipped: opts.skipped ?? 0,
    reviews: { total: reviewStats(reviews), weeks: reviewWeeks(reviews, since, now) },
    findings: {
      total: findingGroup("All agents", outcomes),
      groups: findingGroups,
      severities,
      confidences,
      matrix,
      rewording: { posted: edits.length, median: median(edits), unchanged: edits.filter((x) => x === 0).length, rewritten: edits.filter((x) => x >= 0.5).length },
      description,
      examples,
      changes: configChanges(outcomes),
    },
    runs: {
      total: {
        runs: runs.length,
        finished: runs.filter((e) => e.action === "finished").length,
        failed: runs.filter((e) => e.action === "failed").length,
        cancelled: runs.filter((e) => e.action === "cancelled").length,
        auto: runs.filter((e) => e.trigger === "auto").length,
        manual: runs.filter((e) => e.trigger !== "auto").length,
        msMedian: median(runs.filter((e) => typeof e.ms === "number").map((e) => e.ms!)),
        ...costPer(records, usefulByRun),
      },
      groups: [...runGroups].map(([k, xs]) => runGroup(k, xs, usefulByRun)).sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key)),
    },
  };
}

/* ---------- Export ---------- */

export const CSV_COLUMNS = ["date", "pr", "finding id", "agent", "harness", "model", "thinking", "severity", "confidence", "outcome", "reason", "edit"] as const;

/** A CSV field: quoted when it holds a comma, quote or line break; a leading = + - @ is prefixed so spreadsheets don't run it. */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per finding outcome in the period. */
export function outcomesCsv(outcomes: FindingOutcome[]): string {
  const rows = outcomes.map((o) => [o.at, o.pr, o.id, o.agent, o.harness, o.model, o.thinking, o.severity, o.confidence, o.outcome, o.reason, o.edit]);
  return [CSV_COLUMNS, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** The two exports: the raw events in the period as JSON, or the finding outcomes in it as CSV. */
export function exportText(events: MetricsEvent[], format: "json" | "csv", since: Date | null, now = new Date()): string {
  if (format === "csv") return outcomesCsv(findingOutcomes(events).filter((o) => inPeriod(o.at, since)));
  return JSON.stringify({ v: 1, exportedAt: now.toISOString(), since: since ? since.toISOString() : null, events: eventsSince(events, since) }, null, 2) + "\n";
}
