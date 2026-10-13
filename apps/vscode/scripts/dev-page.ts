// Builds the review page for a real pull request the way the VS Code panel does, but with a stand-in for VS Code's
// webview messaging, so the page can be checked in a browser. Writes .dev/index.html next to copies of media/ui.
//   node scripts/dev-page.ts owner/name#123 --clone /path [--agent agent-file.json]
// --sample builds it from test/fixtures/review-data.json instead, without GitHub. --metrics adds the review metrics
// report: --metrics sample (made-up events), --metrics events.jsonl, --metrics empty or --metrics off; --start metrics
// opens the page on it. With --sample, --state sets your review and the pull request's state: never, approved, changes,
// commented, requested (re-requested after you approved), dismissed, merged, closed, rewritten (force-pushed, the
// commit you reviewed still in the clone) or rewritten-gone (and gone from it); --notice merged|closed|reopened|commits|
// updated sends the page a "changed on GitHub" message a second after it loads.

import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Repos } = await import("../src/core/repos.ts");
const { Store } = await import("../src/core/store.ts");
const { DifflineService, parseKey } = await import("../src/core/service.ts");
const { hostShim, scriptJson } = await import("../src/vscode/page.ts");
const { prKeyString } = await import("../src/core/types.ts");

const { aggregate, GROUP_BYS, parseEvents, PERIODS, sinceDays } = await import("../src/core/metrics.ts");
type MetricsEvent = import("../src/core/metrics-log.ts").MetricsEvent;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
const sample = args.includes("--sample");
const parsed = parseKey(args[0] && !args[0].startsWith("--") ? args[0] : sample ? "acme/web#12" : "");
if (!parsed) throw new Error("Pass owner/name#number");
const key = parsed;
const { data, live } = sample ? await sampleReview() : await realReview();
if (opt("start") === "metrics") (live as any).startView = "metrics";

async function realReview() {
  const storage = await mkdtemp(path.join(os.tmpdir(), "diffline-dev-"));
  const store = new Store(storage);
  await store.init();
  const clone = opt("clone");
  const repos = new Repos({ storage, configured: () => (clone ? { [`${key.owner}/${key.name}`]: clone } : {}), workspaceDirs: () => [], log: console.log });
  const memory = new Map<string, unknown>();
  const service = new DifflineService({
    store, repos,
    memory: { get: (k, f) => (memory.has(k) ? (memory.get(k) as any) : f), update: async (k, v) => void memory.set(k, v) },
    config: () => ({ watch: { direct: true, team: false, assigned: false, reviewed: false, codeOwners: false, others: false, authored: true, repositories: [], pollSeconds: 60 }, agents: { autoRun: false, enabled: ["guide"], maxParallel: 1, quietPeriodSeconds: 0, maxAutomaticRuns: 0, skipDrafts: true, timeoutMinutes: 1, autoRunMaxFiles: 100, autoRunMaxLines: 5000 }, sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 }, harnesses: { default: "claude", claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] }, codex: { id: "codex", command: "codex", model: "", extraArgs: [] }, pi: { id: "pi", command: "pi", model: "", extraArgs: [], thinking: "" } } }),
    log: console.log,
  });
  if (opt("agent")) await store.writeAgent(key, JSON.parse(await readFile(opt("agent")!, "utf8")));
  const t = Date.now();
  // --list loads the real list from GitHub first, as the sidebar has it; --home starts the page on the list.
  if (args.includes("--list")) {
    const base = (service as any).config;
    (service as any).config = () => ({ ...base(), watch: { direct: true, team: true, assigned: true, reviewed: true, codeOwners: true, others: true, authored: true, repositories: [], pollSeconds: 60 } });
    (service as any).warmUp = async () => {};
    await service.refresh();
    while ((service as any).extrasRunning) await new Promise((r) => setTimeout(r, 200));
  }
  const { data, live } = await service.loadReview(key, { home: args.includes("--home") });
  console.log(`loadReview took ${Date.now() - t} ms`);
  return { data, live };
}

/** A pull request from the test fixture, without GitHub: the page's views work, nothing can be posted. */
async function sampleReview() {
  const data = JSON.parse(await readFile(path.join(root, "test", "fixtures", "review-data.json"), "utf8"));
  const k = prKeyString(key);
  const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
  const viewer = { login: "sam-reviewer", name: "Sam Reviewer" };
  const alex = { login: "alex-doe", name: "Alex Doe" };
  const pr: Record<string, any> = { title: "Add promo codes at checkout", author: alex, body: "Adds promo codes to checkout.", createdAt: ago(4), updatedAt: ago(0.1), state: "OPEN", isDraft: false, headRefOid: data.head.sha, baseRefName: "main", checks: [], reviewRequests: [], latestReviews: [], reviews: [], comments: [], lastReview: null, mergedAt: null, mergedBy: null, closedAt: null };
  const threads: any[] = [];
  // --state: your review of it, and how it ended.
  const state = opt("state") || "never";
  const review = (st: string, commit: string | null, days = 2) => {
    pr.lastReview = { submittedAt: ago(days), commit, state: st };
    pr.reviews.push({ ...viewer, state: st, submittedAt: ago(days), body: "", commit });
    if (st === "APPROVED" || st === "CHANGES_REQUESTED") pr.latestReviews.push({ ...viewer, state: st, submittedAt: ago(days) });
  };
  const since = data.since?.sha ?? null;
  const gone = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
  const noFresh = () => data.files.forEach((f: any) => f.hunks.forEach((h: any) => { h.fresh = false; h.lines.forEach((l: any[]) => { l[5] = 0; }); }));
  if (state === "never") { data.since = null; noFresh(); pr.reviewRequests.push(viewer); }
  if (["approved", "requested", "merged", "closed"].includes(state)) review("APPROVED", since);
  if (state === "changes") review("CHANGES_REQUESTED", since);
  if (state === "commented") review("COMMENTED", since, 0.3);
  if (state === "dismissed") review("DISMISSED", since);
  if (state === "requested") pr.reviewRequests.push(viewer);
  if (state === "rewritten") { review("APPROVED", gone); data.since = { ...data.since, sha: gone, short: gone.slice(0, 7), index: -1 }; }
  if (state === "rewritten-gone") { review("APPROVED", gone); data.since = null; noFresh(); }
  if (state === "merged") Object.assign(pr, { state: "MERGED", mergedAt: ago(1), mergedBy: alex, closedAt: ago(1) });
  if (state === "closed") Object.assign(pr, { state: "CLOSED", closedAt: ago(3) });
  if (pr.lastReview) {
    pr.comments.push({ ...alex, body: "Clamped the discount, as asked.", createdAt: ago(1), url: null });
    threads.push({ id: "t1", resolved: false, outdated: false, path: data.files[4]?.path ?? data.files[0].path, line: null, startLine: null, side: "RIGHT", comments: [{ id: "c1", dbId: 1, ...alex, body: "Does this cover expired codes?", createdAt: ago(0.5), url: null }] });
  }
  const repo = `${key.owner}/${key.name}`;
  const row = (n: number, extra: Record<string, unknown>) => ({ key: `${repo}#${n}`, repo, number: n, author: alex, state: "OPEN", isDraft: false, requested: false, additions: 40 + n, deletions: n, checks: { total: 3, failed: 0, running: 0 }, agent: { findings: 2, openHigh: 0, open: 1 }, viewerReview: null, viewerLastReview: null, sinceReview: null, reviewCounts: { approvals: 0, changesRequested: 0 }, mergedAt: null, closedAt: null, ...extra });
  const current = row(key.number, { title: pr.title, state: pr.state, requested: pr.reviewRequests.length > 0, agent: null, mergedAt: pr.mergedAt, closedAt: pr.closedAt, viewerReview: pr.latestReviews[0]?.state ?? null, viewerLastReview: pr.lastReview ? { state: pr.lastReview.state, at: pr.lastReview.submittedAt, commit: pr.lastReview.commit } : null, sinceReview: pr.lastReview ? { newCommits: true, updated: true } : null, reviewCounts: { approvals: pr.latestReviews.filter((r: any) => r.state === "APPROVED").length, changesRequested: 0 } });
  const list = [
    current,
    row(31, { title: "Fix rounding in invoice totals", isDraft: true, requested: true, viewerReview: "APPROVED", viewerLastReview: { state: "COMMENTED", at: ago(0.2), commit: "a".repeat(40) }, sinceReview: { newCommits: false, updated: true }, reviewCounts: { approvals: 1, changesRequested: 0 } }),
    row(28, { title: "Refactor session storage", viewerReview: "APPROVED", viewerLastReview: { state: "APPROVED", at: ago(2), commit: "b".repeat(40) }, sinceReview: { newCommits: true, updated: true }, reviewCounts: { approvals: 2, changesRequested: 0 } }),
    row(26, { title: "Add retries to webhook delivery", mergeStateStatus: "DIRTY", viewerReview: "CHANGES_REQUESTED", viewerLastReview: { state: "CHANGES_REQUESTED", at: ago(1), commit: "c".repeat(40) }, sinceReview: { newCommits: false, updated: false }, reviewCounts: { approvals: 0, changesRequested: 1 } }),
    row(24, { title: "Bump the test runner", state: "MERGED", mergedAt: ago(1), closedAt: ago(1), viewerReview: "APPROVED", viewerLastReview: { state: "APPROVED", at: ago(2), commit: "d".repeat(40) }, reviewCounts: { approvals: 1, changesRequested: 0 } }),
    row(22, { title: "Drop the legacy CSV export", state: "CLOSED", closedAt: ago(3), viewerLastReview: { state: "COMMENTED", at: ago(4), commit: "e".repeat(40) }, reviewCounts: { approvals: 0, changesRequested: 0 } }),
  ];
  const live = {
    repo, number: key.number, url: `https://github.com/${repo}/pull/${key.number}`, github: true, githubError: null,
    viewer, pr, threads, loadedAt: new Date().toISOString(), token: "", api: "", agent: null, state: null,
    list,
    groups: [
      { id: "requested", label: "Review requested", description: "", collapsed: false, keys: [k, `${repo}#31`] },
      { id: "reviewed", label: "You reviewed", description: "", collapsed: false, keys: [`${repo}#28`, `${repo}#26`] },
      { id: "closed", label: "Recently merged or closed", description: "", collapsed: false, keys: [`${repo}#24`, `${repo}#22`] },
    ],
    grouping: { by: "relationship", sort: "risk" },
    ...(args.includes("--home") ? { startView: "inbox" } : {}),
  };
  return { data, live };
}

/** Made-up review metrics over the last ten weeks: three agents on three harnesses, reviews, runs and a change of instructions. */
function sampleEvents(now = Date.now()): MetricsEvent[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const agents = [
    { id: "security", harness: "claude", model: "claude-sonnet", instructions: "3f9a1c0b7e21", useful: 0.62 },
    { id: "tests", harness: "codex", model: "gpt-codex", instructions: "a81d44c9e0f3", useful: 0.35 },
    { id: "bugs", harness: "pi", model: "openai/gpt-large", thinking: "high", instructions: "c0ffee12ab34", useful: 0.5 },
  ];
  const titles = ["Token read from the query string", "No test for the expired-code path", "Discount can go below zero", "Race between apply and remove", "Error swallowed in the retry loop", "Missing index on promo_codes.code", "Unused export left behind", "Off-by-one in the page size"];
  const events: MetricsEvent[] = [];
  for (let n = 0; n < 34; n++) {
    const at = new Date(now - (70 - n * 2) * 864e5 + rnd() * 864e5 * 0.5);
    const pr = `acme/${pick(["web", "api", "mobile"])}#${100 + n}`;
    const run = at.toISOString();
    const head = (n.toString(16) + "0".repeat(40)).slice(0, 40);
    const base = { v: 1 as const, pr, head };
    const auto = rnd() < 0.6;
    const lateConfig = n > 20; // security's instructions changed three weeks ago
    events.push({ ...base, at: run, run, kind: "run", action: rnd() < 0.08 ? "failed" : "finished", trigger: auto ? "auto" : "manual", ms: 120_000 + rnd() * 240_000,
      agents: [
        { id: "lede", harness: "claude", model: "claude-sonnet", instructions: null, ms: 20_000, tokens: { input: 9000, cachedInput: 4000, output: 400 }, costUsd: 0.03, findings: 0 },
        ...agents.map((a) => ({ id: a.id, harness: a.harness, model: a.model, ...(a.thinking ? { thinking: a.thinking } : {}), instructions: a.id === "security" && lateConfig ? "77b2e5d10a9c" : a.instructions,
          ms: 60_000 + rnd() * 200_000, tokens: a.harness === "codex" && rnd() < 0.3 ? null : { input: 40_000 + Math.round(rnd() * 80_000), cachedInput: 20_000, output: 3000 + Math.round(rnd() * 4000) },
          costUsd: a.harness === "codex" ? null : Math.round((0.15 + rnd() * 0.5) * 100) / 100, findings: 2, ...(a.id === "tests" && rnd() < 0.1 ? { failed: "timeout" as const } : {}) })),
      ] });
    let t = at.getTime() + 3600_000;
    let fromFindings = 0;
    for (const a of agents) {
      for (let i = 0; i < 2; i++) {
        const id = `${a.id}-${(n * 7 + i).toString(16).padStart(8, "0")}`;
        const finding = { id, agent: a.id, severity: pick(["high", "medium", "medium", "low"]) as "high", confidence: pick(["High confidence", "Worth asking", "Minor"]) as "Minor", label: "question" as const, path: "src/checkout.ts", title: pick(titles) };
        const agent = { id: a.id, harness: a.harness, model: a.model, ...(a.thinking ? { thinking: a.thinking } : {}), instructions: a.id === "security" && lateConfig ? "77b2e5d10a9c" : a.instructions };
        const ev = (action: MetricsEvent["action"], extra: Partial<MetricsEvent> = {}): MetricsEvent => ({ ...base, at: new Date((t += 60_000)).toISOString(), run, kind: "finding", action, finding, agent, ...extra });
        const r = rnd();
        const useful = a.useful + (a.id === "security" && lateConfig ? 0.2 : 0);
        if (r < useful) {
          events.push(ev("added"));
          if (rnd() < 0.7) { events.push(ev("posted", { edit: Math.round(rnd() * rnd() * 1000) / 1000 })); fromFindings++; }
        } else if (r < useful + 0.25) events.push(ev("dismissed", { reason: pick(["Not a problem", "Intended", "Out of scope", "Not a problem"]) }));
        else if (r < useful + 0.3) { events.push(ev("added")); events.push(ev("undone", { reason: "added" })); }
        else events.push(ev("left-open"));
      }
    }
    for (const rule of ["why", "evidence", "risks"]) {
      const r = rnd();
      if (r < 0.3) events.push({ ...base, at: new Date((t += 60_000)).toISOString(), run, kind: "description", action: "asked", rule, descKind: "feature" });
      else if (r < 0.55) events.push({ ...base, at: new Date((t += 60_000)).toISOString(), run, kind: "description", action: "skipped", rule, descKind: "feature", reason: pick(["Not needed here", "Covered elsewhere"]) });
    }
    const comments = fromFindings + Math.floor(rnd() * 4);
    events.push({ ...base, at: new Date((t += 60_000)).toISOString(), run, kind: "review", action: "submitted",
      review: { event: pick(["approve", "approve", "changes", "comment"]) as "approve", own: rnd() < 0.15, comments, fromFindings, reviewed: 20 + Math.floor(rnd() * 20), hunks: 40, agents: true, activeMs: 300_000 + rnd() * 1_500_000, round: rnd() < 0.25 ? 2 : 1, newPush: rnd() < 0.2 } });
  }
  return events;
}

const out = path.join(root, ".dev");
await mkdir(out, { recursive: true });
for (const f of ["app.js", "styles.css"]) await cp(path.join(root, "media", "ui", f), path.join(out, f));
const shim = `window.__posted = [];
window.acquireVsCodeApi = () => ({ postMessage(m) {
  window.__posted.push(m);
  if (m.type === "api") setTimeout(() => window.postMessage({ type: "api-result", id: m.id, ok: true, data: m.path.startsWith("/push") ? { dry: true, as: "you", steps: [] } : { ok: true } }, "*"), 10);
  if (m.type === "metricsReport") setTimeout(() => window.postMessage(METRICS ? { type: "api-result", id: m.id, ok: true, data: METRICS[(m.days ?? "all") + "|" + m.groupBy] } : { type: "api-result", id: m.id, ok: false, error: "Run dev-page with --metrics." }, "*"), 120);
  if (m.type === "metricsExport") setTimeout(() => window.postMessage({ type: "api-result", id: m.id, ok: true, data: { saved: "/tmp/diffline-export." + m.format, events: 0 } }, "*"), 10);
} });
const METRICS = ${scriptJson(await metricsReports())};${noticeScript()}`;

/** --notice: a "changed on GitHub" message, as ReviewPanel.noticeChange sends it, a second after the page loads. */
function noticeScript() {
  const kind = opt("notice");
  if (!kind) return "";
  const pr = (live as any).pr || {};
  const state = kind === "merged" ? "MERGED" : kind === "closed" ? "CLOSED" : kind === "reopened" ? "OPEN" : pr.state;
  const change = { kind, state, head: kind === "commits" ? "f".repeat(40) : pr.headRefOid, updatedAt: new Date().toISOString(), stateChanged: state !== pr.state || kind === "reopened", newCommits: kind === "commits", updated: true, was: { state: pr.state, head: pr.headRefOid, updatedAt: pr.updatedAt } };
  return `\nsetTimeout(() => window.postMessage(${scriptJson({ type: "host-pr-changed", key: prKeyString(key), change })}, "*"), 1000);`;
}

/** Every report the page's pickers can ask for, worked out ahead, since this page has no extension to ask. */
async function metricsReports() {
  const which = opt("metrics");
  if (!which) return null;
  const events = which === "sample" ? sampleEvents() : which === "empty" || which === "off" ? [] : parseEvents(await readFile(which, "utf8")).events;
  const reports: Record<string, unknown> = {};
  for (const days of PERIODS) for (const groupBy of GROUP_BYS) reports[`${days ?? "all"}|${groupBy}`] = { enabled: which !== "off", days, report: aggregate(events, { since: sinceDays(days), groupBy }) };
  return reports;
}
const html = (await readFile(path.join(root, "media", "ui", "index.html"), "utf8")).replace(
  '<script src="review-data.js"></script>',
  () => `<script>${shim}\n${hostShim(prKeyString(key))}\nwindow.REVIEW_DATA = ${scriptJson(data)};\nwindow.DIFFLINE_LIVE = ${scriptJson(live)};</script>`,
);
await writeFile(path.join(out, "index.html"), html, "utf8");
console.log(`Wrote ${path.join(out, "index.html")}: ${data.files.length} files, ${live.list.length} list items, agent ${live.agent ? "yes" : "no"}`);
