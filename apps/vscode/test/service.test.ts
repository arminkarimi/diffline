import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { closedSince, mergeSearchResults, setGhRunner } from "../src/core/github.ts";
import { approvedBy, approverWords, DifflineService, isApproved, RECENTLY_CLOSED_DAYS, REFRESH_TIMING, type RefreshTiming, type ServiceConfig } from "../src/core/service.ts";
import { Store } from "../src/core/store.ts";
import { ensureSampleRepo } from "./fixtures/make-sample-repo.ts";

const SAMPLE = ensureSampleRepo();

function config(over: { pollSeconds?: number; metrics?: boolean; closedDays?: number | null; team?: boolean; others?: boolean } = {}): ServiceConfig {
  return {
    watch: {
      direct: true,
      team: over.team ?? false,
      assigned: false,
      reviewed: false,
      codeOwners: false,
      others: over.others ?? false,
      authored: true,
      repositories: [],
      pollSeconds: over.pollSeconds ?? 60,
      // null: the setting is missing, so the default applies.
      ...(over.closedDays === null ? {} : { recentlyClosedDays: over.closedDays ?? 0 }),
    },
    agents: { autoRun: false, enabled: ["guide"], maxParallel: 1, quietPeriodSeconds: 0, maxAutomaticRuns: 5, skipDrafts: true, timeoutMinutes: 1, autoRunMaxFiles: 100, autoRunMaxLines: 5000 },
    harnesses: { default: "claude", claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] }, codex: { id: "codex", command: "codex", model: "", extraArgs: [] }, pi: { id: "pi", command: "pi", model: "", extraArgs: [], thinking: "" } },
    sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 },
    ...(over.metrics !== undefined ? { metrics: { enabled: over.metrics } } : {}),
  };
}

async function makeService(opts: { root?: string; repos?: unknown; config?: () => ServiceConfig; log?: (line: string) => void; memory?: Map<string, unknown>; timing?: Partial<RefreshTiming> } = {}) {
  const store = new Store(opts.root ?? (await mkdtemp(path.join(os.tmpdir(), "diffline-service-"))));
  await store.init();
  const memory = opts.memory ?? new Map<string, unknown>();
  return new DifflineService({
    timing: opts.timing,
    store,
    repos: (opts.repos ?? { reset() {}, async cleanTrees() {} }) as any,
    memory: { get: (k, f) => (memory.has(k) ? (memory.get(k) as any) : f), update: async (k, v) => void memory.set(k, v) },
    config: opts.config ?? (() => config()),
    log: opts.log ?? (() => undefined),
  });
}

test("runAgents: a run that can't take its lock fails instead of staying queued", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-service-"));
  await writeFile(path.join(root, "locks"), "not a folder"); // the locks folder can't be made
  const service = await makeService({ root });
  const key = { owner: "o", name: "r", number: 3 };
  let failed = "";
  service.on("runFailed", (_key, message: string) => (failed = message));
  await service.runAgents(key);
  assert.equal(service.get(key)?.run.state, "failed");
  assert.match(failed, /Couldn't check whether another VS Code window is running these agents/);
  assert.equal(service.isBusy(key), false);
  service.dispose();
});

test("configChanged: changing settings such as the sort order doesn't search GitHub again", async () => {
  let calls = 0;
  setGhRunner(async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me", name: null }, rateLimit: { remaining: 5000, resetAt: "", cost: 1 } } }), stderr: "", killed: false };
  });
  let poll = 60;
  const service = await makeService({ config: () => config({ pollSeconds: poll }) });
  try {
    service.start();
    await service.refresh();
    assert.equal(calls, 1);
    service.configChanged();
    poll = 120; // a new interval restarts the timer, still without searching at once
    service.configChanged();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
  } finally {
    service.dispose();
    setGhRunner(null);
  }
});

test("unpin: a pull request whose agents are running stays listed", async () => {
  const service = await makeService();
  const key = { owner: "o", name: "r", number: 4 };
  await service.pin(key);
  service.get(key)!.run = { state: "running" };
  await service.unpin(key);
  assert.ok(service.get(key), "still listed while its agents run");
  service.get(key)!.run = { state: "done" };
  await service.unpin(key);
  assert.equal(service.get(key), undefined);
  service.dispose();
});

test("loadData: opening a pull request that's being prepared shares its build", async () => {
  const logs: string[] = [];
  const repos = {
    reset() {},
    resolve: async () => ({ path: SAMPLE, remote: "origin", managed: false }),
    ensureCommits: async () => ({ fetched: false }),
    hasCommit: async () => true,
  };
  const service = await makeService({ repos, log: (l) => logs.push(l) });
  const key = { owner: "o", name: "sample", number: 5 };
  const detail = { viewer: { login: "me", name: null }, pr: { baseRefOid: "main", headRefOid: "feature/promo-codes", baseRefName: "main", headRefName: "feature/promo-codes", lastReview: null }, threads: [] } as any;
  const [a, b] = await Promise.all([service.loadData(key, detail), service.loadData(key, detail)]);
  assert.equal(a.data, b.data);
  assert.equal(logs.filter((l) => l.startsWith("Built ")).length, 1, "built once");
  service.dispose();
});

test("review metrics: the page's events and every run go to metrics/events.jsonl unless turned off; delete removes it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-service-"));
  let on = true;
  const service = await makeService({ root, config: () => config({ metrics: on }) });
  const key = { owner: "acme", name: "web", number: 9 };
  const file = path.join(root, "metrics", "events.jsonl");
  assert.equal(service.metricsLog.file, file);
  const review = { kind: "review", action: "submitted", review: { event: "approve", own: false, comments: 0, fromFindings: 0, reviewed: 3, hunks: 3, agents: false, activeMs: 5000 } };
  await service.metrics(key, { head: "d".repeat(40), run: null, events: [review] });
  // A run that fails after it started (GitHub doesn't answer) still writes a run event.
  setGhRunner(async () => ({ code: 1, stdout: "", stderr: "HTTP 502", killed: false }));
  try {
    await service.runAgents(key);
  } finally {
    setGhRunner(null);
  }
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.kind, e.action]), [["review", "submitted"], ["run", "failed"]]);
  assert.equal(lines[1].trigger, "manual");
  assert.deepEqual(lines[1].agents, []);
  assert.equal(lines[1].run, null);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  on = false;
  assert.deepEqual(await service.metrics(key, { events: [review] }), []);
  setGhRunner(async () => ({ code: 1, stdout: "", stderr: "HTTP 502", killed: false }));
  try {
    await service.runAgents(key);
  } finally {
    setGhRunner(null);
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2, "nothing written while turned off");

  assert.equal(await service.metricsLog.delete(), true);
  await assert.rejects(stat(file));
  service.dispose();
});

test("review metrics report: an empty or missing log, turned off, a damaged line, and the page's period and grouping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-service-"));
  let on = true;
  const service = await makeService({ root, config: () => config({ metrics: on }) });
  const now = new Date("2026-10-14T12:00:00Z");

  const none = await service.metricsReport({ days: 7, groupBy: "harness" }, now);
  assert.deepEqual([none.enabled, none.days, none.report.total, none.report.groupBy], [true, 7, 0, "harness"]);
  on = false;
  assert.equal((await service.metricsReport({}, now)).enabled, false);
  on = true;

  const finding = { v: 1, at: "2026-10-13T12:00:00Z", pr: "acme/web#9", head: null, run: "r1", kind: "finding", action: "added", finding: { id: "tests-1", agent: "tests", severity: "low", confidence: "Minor", label: "nit", path: "a.ts", title: "T" }, agent: { id: "tests", harness: "pi", model: "m", thinking: null, instructions: "i" } };
  const old = { ...finding, at: "2026-08-01T12:00:00Z", finding: { ...finding.finding, id: "tests-2" } };
  await service.metricsLog.delete();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(service.metricsLog.file), { recursive: true });
  await writeFile(service.metricsLog.file, [JSON.stringify(finding), "{damaged", JSON.stringify(old)].join("\n") + "\n");
  const r = await service.metricsReport({ days: "lots", groupBy: "nonsense" }, now);
  assert.deepEqual([r.days, r.report.groupBy], [30, "agent"], "values the page doesn't offer fall back");
  assert.deepEqual([r.report.total, r.report.inPeriod, r.report.skipped, r.report.findings.total.useful], [2, 1, 1, 1]);
  const all = await service.metricsReport({ days: null, groupBy: "thinking" }, now);
  assert.deepEqual([all.days, all.report.findings.total.useful, all.report.findings.groups[0].key], [null, 2, "default"]);

  const csv = await service.metricsExport("csv", 30, now);
  assert.equal(csv.name, "diffline-finding-outcomes-2026-10-14.csv");
  assert.equal(csv.text.trimEnd().split("\r\n").length, 2);
  const json = await service.metricsExport("json", null, now);
  assert.equal(json.name, "diffline-review-metrics-2026-10-14.json");
  assert.equal(JSON.parse(json.text).events.length, 2);
  service.dispose();
});

test("approvedBy: an approval counts unless anyone requested changes; dismissed reviews and comments don't", () => {
  const pr = (...reviews: Array<[string, string]>) => ({ latestReviews: reviews.map(([login, state]) => ({ login, state })) });
  assert.deepEqual(approvedBy(pr(["lee", "APPROVED"], ["sam", "COMMENTED"])), ["lee"]);
  assert.deepEqual(approvedBy(pr(["lee", "APPROVED"], ["sam", "APPROVED"])), ["lee", "sam"]);
  assert.equal(approvedBy(pr(["lee", "APPROVED"], ["sam", "CHANGES_REQUESTED"])), null, "changes requested wins");
  assert.equal(approvedBy(pr(["lee", "DISMISSED"], ["sam", "COMMENTED"])), null);
  assert.equal(approvedBy(pr()), null);
  assert.equal(approvedBy({}), null, "a list saved before reviews were kept");
  assert.equal(approvedBy(null), null);
  assert.equal(isApproved(pr(["lee", "APPROVED"])), true);
  assert.equal(approverWords(["lee"], "me"), "lee");
  assert.equal(approverWords(["Me"], "me"), "you");
  assert.equal(approverWords(["lee", "sam"], null), "lee and sam");
  assert.equal(approverWords(["lee", "sam", "kim", "ada"], null), "lee, sam and 2 others");
});

/** A search that returns these pull requests as requested from "me"; every other gh call fails. */
function fakeSearch(prs: () => Array<{ number: number; head: string; reviews?: Array<[string, string]> }>) {
  setGhRunner(async (args) => {
    const query = args.find((a) => a.startsWith("query=")) || "";
    if (!query.includes("direct: search")) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found", killed: false };
    const nodes = prs().map((p) => ({
      number: p.number,
      title: `Change ${p.number}`,
      url: `https://github.com/acme/web/pull/${p.number}`,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      state: "OPEN",
      isDraft: false,
      author: { login: "lee" },
      repository: { nameWithOwner: "acme/web" },
      baseRefName: "main",
      headRefName: `change-${p.number}`,
      headRefOid: p.head,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      files: { nodes: [{ path: "a.ts", additions: 10, deletions: 2 }] },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "me" } }] },
      latestOpinionatedReviews: { nodes: (p.reviews || []).map(([login, state]) => ({ author: { login }, state })) },
    }));
    const data = { viewer: { login: "me", name: null }, direct: { issueCount: nodes.length, nodes }, authored: { issueCount: 0, nodes: [] } };
    return { code: 0, stdout: JSON.stringify({ data }), stderr: "", killed: false };
  });
}

/** A service that schedules automatic runs, with a long quiet period so released runs stay "waiting". */
async function autoService(policy: () => "ask" | "skip" | "run" | undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-service-"));
  const memory = new Map<string, unknown>();
  const store = new Store(root);
  await store.init();
  const base = config();
  const service = new DifflineService({
    store,
    repos: { reset() {}, async cleanTrees() {}, resolve: async () => Promise.reject(new Error("no clone")) } as any,
    memory: { get: (k, f) => (memory.has(k) ? (memory.get(k) as any) : f), update: async (k, v) => void memory.set(k, v) },
    config: () => ({ ...base, agents: { ...base.agents, autoRun: true, quietPeriodSeconds: 3600, approvedPullRequests: policy() } }),
    log: () => undefined,
  });
  const asked: string[][] = [];
  service.on("approvedHeld", (keys: Array<{ number: number }>) => asked.push(keys.map((k) => `#${k.number}`)));
  const skippedRuns = async () =>
    (await service.metricsLog.read())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "run" && e.action === "skipped")
      .map((e) => `${e.pr}@${e.head} ${e.reason} ${e.trigger} ${e.agents.length}`);
  return { service, memory, asked, skippedRuns };
}

test("automatic runs on approved pull requests: ask holds and asks once per head, logging one skipped run each", async () => {
  let head = "a".repeat(40);
  let reviews: Array<[string, string]> = [["sam", "APPROVED"]];
  fakeSearch(() => [
    { number: 1, head, reviews },
    { number: 2, head: "b".repeat(40), reviews: [["sam", "APPROVED"], ["kim", "CHANGES_REQUESTED"]] },
    { number: 3, head: "c".repeat(40) },
  ]);
  const { service, memory, asked, skippedRuns } = await autoService(() => undefined);
  const key = (n: number) => ({ owner: "acme", name: "web", number: n });
  try {
    await service.refresh();
    assert.deepEqual([service.get(key(1))?.run.state, service.get(key(1))?.run.note], ["held", "Approved; waiting for your choice"]);
    assert.equal(service.awaitingApprovedChoice(key(1)), true);
    assert.equal(service.get(key(2))?.run.state, "waiting", "changes requested: not approved");
    assert.equal(service.get(key(3))?.run.state, "waiting");
    assert.deepEqual(asked, [["#1"]]);
    assert.deepEqual(service.approval(key(1)), ["sam"]);

    await service.refresh();
    assert.deepEqual(asked, [["#1"]], "not asked again for the same head");
    assert.deepEqual(await skippedRuns(), [`acme/web#1@${head} approved auto 0`]);

    head = "d".repeat(40); // a new push asks again
    await service.refresh();
    assert.deepEqual(asked, [["#1"], ["#1"]]);
    assert.equal((await skippedRuns()).length, 2);
    assert.equal((memory.get("approvedRuns") as any)["acme/web#1"].asked, head);

    reviews = [["sam", "APPROVED"], ["kim", "CHANGES_REQUESTED"]]; // no longer approved: the run goes ahead
    await service.refresh();
    assert.equal(service.get(key(1))?.run.state, "waiting");
  } finally {
    service.dispose();
    setGhRunner(null);
  }
});

test("automatic runs on approved pull requests: skip and run settings, and choices remembered per pull request", async () => {
  let head = "a".repeat(40);
  fakeSearch(() => [
    { number: 1, head, reviews: [["sam", "APPROVED"]] },
    { number: 2, head, reviews: [["sam", "APPROVED"]] },
  ]);
  let policy: "ask" | "skip" | "run" = "skip";
  const { service, asked, skippedRuns } = await autoService(() => policy);
  const key = (n: number) => ({ owner: "acme", name: "web", number: n });
  try {
    await service.refresh();
    assert.deepEqual([service.get(key(1))?.run.state, service.get(key(1))?.run.note], ["held", "Approved; automatic runs skipped"]);
    assert.equal(service.awaitingApprovedChoice(key(1)), false);
    assert.deepEqual(asked, [], "skip doesn't ask");
    assert.equal((await skippedRuns()).length, 2);

    policy = "run";
    await service.refresh();
    assert.equal(service.get(key(1))?.run.state, "waiting");
    service.cancel(key(1));
    service.cancel(key(2));

    policy = "ask";
    head = "e".repeat(40);
    await service.refresh();
    assert.deepEqual(asked, [["#1", "#2"]], "both held in one refresh come together");
    service.chooseForApproved(key(1), "skip");
    service.chooseForApproved(key(2), "run");
    assert.deepEqual([service.get(key(1))?.run.state, service.get(key(1))?.run.note], ["held", "Approved; automatic runs skipped"]);
    assert.equal(service.get(key(2))?.run.state, "waiting", "Run anyway starts it (after the quiet period here)");
    service.cancel(key(2));

    head = "f".repeat(40); // later pushes: Skip this PR stays held without asking, Run anyway runs
    await service.refresh();
    assert.deepEqual(asked, [["#1", "#2"]]);
    assert.equal(service.get(key(1))?.run.state, "held");
    assert.equal(service.get(key(2))?.run.state, "waiting");
    assert.deepEqual((await skippedRuns()).filter((e) => e.includes(head)), [`acme/web#1@${head} approved auto 0`], "a run that goes ahead isn't logged as skipped");
  } finally {
    service.dispose();
    setGhRunner(null);
  }
});

test("a run in progress on a pull request that gets approved offers to stop once, unless the setting runs approved ones", async () => {
  let reviews: Array<[string, string]> = [];
  fakeSearch(() => [{ number: 1, head: "a".repeat(40), reviews }]);
  let policy: "ask" | "skip" | "run" = "ask";
  const { service } = await autoService(() => policy);
  const key = { owner: "acme", name: "web", number: 1 };
  const offers: string[] = [];
  service.on("approvedWhileRunning", (k: { number: number }, by: string[], startedAt: number) => offers.push(`#${k.number} ${by.join(",")} ${startedAt}`));
  try {
    await service.refresh();
    service.get(key)!.run = { state: "running", startedAt: 5, approvedAtStart: false };
    await service.refresh();
    assert.deepEqual(offers, [], "not approved yet");
    reviews = [["sam", "APPROVED"]];
    await service.refresh();
    await service.refresh();
    assert.deepEqual(offers, ["#1 sam 5"], "once per run");

    service.get(key)!.run = { state: "running", startedAt: 6, approvedAtStart: true };
    await service.refresh();
    assert.equal(offers.length, 1, "approved before it started: run on purpose");

    policy = "run";
    service.get(key)!.run = { state: "running", startedAt: 7, approvedAtStart: false };
    await service.refresh();
    assert.equal(offers.length, 1);
  } finally {
    service.get(key)!.run = { state: "done" };
    service.dispose();
    setGhRunner(null);
  }
});

test("agentReviewMarkdown: lines from the reviewed commit, rebuilt when the pull request moved on, and the page's decisions", async () => {
  const head = "f53a7f581b5c4afa889751cbb4daf6d06871aebe";
  const older = "17b83e24937d09bf70b34ca1e8c16a2ed7172156"; // the sample's last-review tag
  const base = "7e6a0998253a65947c5d2c7edee58f1e6429bc31";
  let has = true;
  const repos = {
    reset() {},
    resolve: async () => ({ path: SAMPLE, remote: "origin", managed: false }),
    ensureCommits: async () => ({ fetched: false }),
    hasCommit: async () => has,
  };
  const service = await makeService({ repos });
  (service as any).version = "1.2.3";
  const key = { owner: "acme", name: "web", number: 12 };
  const pr = { title: "Add promo codes at checkout", url: "https://github.com/acme/web/pull/12", author: { login: "alex-doe", name: null }, baseRefOid: base, headRefOid: head, baseRefName: "main", headRefName: "feature/promo-codes", lastReview: null };
  (service as any).detail = async () => ({ viewer: { login: "me", name: null }, pr, threads: [] });
  await assert.rejects(service.agentReviewMarkdown(key), /acme\/web#12 has no agent review yet/);

  const agent = JSON.parse(await readFile(new URL("./fixtures/agent-file.json", import.meta.url), "utf8"));
  await service.store.writeAgent(key, agent);
  await service.store.writeState(key, { findings: { [agent.findings[3].id]: { state: "dismissed", reason: "Out of scope", run: agent.ranAt } } });
  const now = new Date("2026-10-12T00:00:00Z");
  const all = await service.agentReviewMarkdown(key, { now });
  assert.equal(all.name, "acme-web-12-agent-review.md");
  assert.deepEqual([all.findings, all.total], [5, 5]);
  assert.match(all.markdown, new RegExp(`\\[permalink\\]\\(https://github.com/acme/web/blob/${head}/src/checkout/checkout.ts#L54\\)`));
  assert.match(all.markdown, /Status: dismissed \(Out of scope\)/);
  assert.match(all.markdown, /Exported by Diffline 1\.2\.3 on 2026-10-12\./);
  const open = await service.agentReviewMarkdown(key, { openOnly: true });
  assert.deepEqual([open.findings, open.total], [4, 5]);

  // The agents reviewed an older push: the diff at that commit is built from the clone (and cached), so line numbers
  // and permalinks are in the reviewed commit.
  await service.store.writeAgent(key, { ...agent, commit: older, findings: [{ ...agent.findings[2] }] });
  const moved = await service.agentReviewMarkdown(key);
  assert.match(moved.markdown, new RegExp(`- Reviewed commit \\(the head when the agents ran\\): \`${older}\``));
  assert.match(moved.markdown, new RegExp(`- Current head: \`${head}\`. The pull request moved on`));
  assert.match(moved.markdown, new RegExp(`- Merge base: \`${base}\``));
  assert.match(moved.markdown, new RegExp(`\`src/cart/cart.ts:34\` \\(removed line, base side\\) · \\[permalink\\]\\(https://github.com/acme/web/blob/${base}/src/cart/cart.ts#L34\\)`));
  assert.ok(await service.store.findReviewData(key, older), "the rebuilt diff is cached");

  // Without that commit in the clone or the cache, findings keep their paths and quoted lines, without numbers.
  has = false;
  await service.store.writeAgent(key, { ...agent, commit: "e".repeat(40) });
  const lost = await service.agentReviewMarkdown(key);
  assert.match(lost.markdown, /Merge base: not known here/);
  assert.doesNotMatch(lost.markdown, /\]\(https:\/\/github\.com\/acme\/web\/blob\//);
  assert.match(lost.markdown, /\*\*Location\*\*: `src\/checkout\/checkout\.ts` \(the line isn't in the diff/);
  service.dispose();
});

/** A list node as GitHub returns it for the searches you're in (DifflineMine). */
function mineNode(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    author: { login: "lee" },
    repository: { nameWithOwner: "acme/web" },
    baseRefName: "main",
    headRefName: `change-${number}`,
    headRefOid: "h1",
    additions: 1,
    deletions: 1,
    changedFiles: 0,
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "me" } }] },
    latestOpinionatedReviews: { nodes: [{ author: { login: "sam" }, state: "APPROVED" }] },
    latestReviews: { nodes: [{ author: { login: "me" }, state: "COMMENTED", submittedAt: "2026-10-04T00:00:00Z", commit: { oid: "h0" } }] },
    ...over,
  };
}

/** Wait until a condition holds (background searches finish on their own). */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NO_CLONE = { reset() {}, async cleanTrees() {}, resolve: async () => Promise.reject(new Error("no clone")) };

/**
 * A fake GitHub for the list's searches: the main search, recently closed, team requests and others, each counted in
 * `calls` as it starts. A gate holds a search until it's opened, to see what shows before it answers.
 */
function fakeGitHub(opts: { open: () => any[]; closed?: () => any[] | Error; team?: () => any[]; gate?: Partial<Record<"closed" | "team", Promise<void>>> }) {
  const calls: string[] = [];
  const variables: Record<string, string> = {};
  setGhRunner(async (args) => {
    const query = args.find((a) => a.startsWith("query=")) || "";
    for (const a of args) {
      const m = /^(\w+)=(.*)$/s.exec(a);
      if (m && m[1] !== "query") variables[m[1]] = m[2];
    }
    const kind = query.includes("closedReviewed: search") ? "closed" : query.includes("direct: search") ? "main" : query.includes("team: search") ? "team" : query.includes("others0: search") ? "others" : "other";
    calls.push(kind);
    const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me", name: null }, ...(data as object) } }), stderr: "", killed: false });
    if (kind === "closed" || kind === "team") await opts.gate?.[kind];
    if (kind === "main") {
      assert.doesNotMatch(query, /closedReviewed|team: search/, "the main search has neither recently closed nor team requests");
      const nodes = opts.open();
      return ok({ direct: { issueCount: nodes.length, nodes }, authored: { issueCount: 0, nodes: [] } });
    }
    if (kind === "closed") {
      const closed = opts.closed?.() ?? [];
      if (closed instanceof Error) return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway", killed: false };
      return ok({ closedReviewed: { issueCount: closed.length + 4, nodes: closed }, closedAuthored: { issueCount: 0, nodes: [] } });
    }
    if (kind === "team") {
      const nodes = opts.team?.() ?? [];
      return ok({ team: { issueCount: nodes.length + 20, nodes } });
    }
    if (kind === "others") return ok({ others0: { issueCount: 0, nodes: [] } });
    // Preparing a requested pull request's diff ahead of time asks for its detail; not part of these tests.
    return { code: 1, stdout: "", stderr: "HTTP 404: Not Found", killed: false };
  });
  return { calls, variables };
}

/** A list node as the list keeps it. */
const summaryOf = (node: any) => mergeSearchResults({ viewer: { login: "me" }, x: { nodes: [node] } }, [{ alias: "x", reason: "review-requested", kind: "search", label: "x" }]).items[0];

const merged = (n: number, over: Record<string, unknown> = {}) => mineNode(n, { state: "MERGED", mergedAt: "2026-10-06T00:00:00Z", closedAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", reviewRequests: { nodes: [] }, ...over });

test("refresh: the list shows before recently closed pull requests load; they join it when they arrive, and changes are announced", async () => {
  let open: any[] = [mineNode(1)];
  let closed: any[] | Error = [merged(2)];
  let release = () => {};
  const gate = { closed: new Promise<void>((r) => (release = r)) };
  const { calls } = fakeGitHub({ open: () => open, closed: () => closed, gate });
  const service = await makeService({ config: () => config({ closedDays: 7 }), repos: NO_CLONE });
  const moved: string[] = [];
  const groups = async () => (await service.pageGroups()).map((g) => [g.id, g.keys]);
  service.on("pullRequestChanged", (key: { number: number }) => moved.push(`#${key.number}`));
  try {
    await service.refresh();
    assert.deepEqual(await groups(), [["requested", ["acme/web#1"]]], "the main search's list shows without waiting");
    assert.deepEqual(calls.filter((c) => c !== "other"), ["main", "closed"], "recently closed ones are asked for after the main search");
    let changes = 0;
    service.on("change", () => changes++);
    release();
    await until(async () => (await groups()).length === 2, "the recently closed pull requests");
    assert.ok(changes > 0, "their arrival repaints the list");
    assert.deepEqual(await groups(), [["requested", ["acme/web#1"]], ["closed", ["acme/web#2"]]]);
    assert.deepEqual(service.totals.closed, { shown: 1, total: 5 });
    const items = await service.listItems();
    const one = items.find((i) => i.number === 1)!;
    assert.deepEqual(one.viewerLastReview, { state: "COMMENTED", at: "2026-10-04T00:00:00Z", commit: "h0" });
    assert.deepEqual(one.sinceReview, { newCommits: true, updated: true });
    assert.deepEqual(one.reviewCounts, { approvals: 1, changesRequested: 0 });
    const two = items.find((i) => i.number === 2)!;
    assert.deepEqual([two.state, two.mergedAt, two.closedAt], ["MERGED", "2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z"]);

    // Polls don't ask for recently closed ones again (every 10 minutes), but they keep their row; a push is announced.
    calls.length = 0;
    open = [mineNode(1, { headRefOid: "h2", updatedAt: "2026-10-07T00:00:00Z" })];
    await service.refresh();
    assert.deepEqual(calls.filter((c) => c !== "other"), ["main"]);
    assert.deepEqual(await groups(), [["requested", ["acme/web#1"]], ["closed", ["acme/web#2"]]]);
    assert.deepEqual(moved, ["#1"]);

    // #1 is merged: it leaves the main search, keeps its row, and recently closed ones are asked for at once, which
    // moves it and announces it.
    open = [];
    closed = [merged(1, { headRefOid: "h2", updatedAt: "2026-10-08T00:00:00Z" }), ...(closed as any[])];
    calls.length = 0;
    await service.refresh();
    assert.ok(service.get({ owner: "acme", name: "web", number: 1 }), "still listed while the recently-closed search runs");
    await until(() => moved.length === 2, "the merge to be announced");
    assert.deepEqual(calls.filter((c) => c !== "other"), ["main", "closed"]);
    assert.deepEqual(await groups(), [["closed", ["acme/web#1", "acme/web#2"]]]);

    // A pull request that leaves the main search without merging (no longer requested) goes once that search says so.
    open = [mineNode(3)];
    await service.refresh();
    open = [];
    await service.refresh();
    await until(() => !service.get({ owner: "acme", name: "web", number: 3 }), "#3 to leave");

    // A failed recently-closed search keeps the last ones found.
    closed = new Error("down");
    await service.refresh({ full: true });
    await until(() => calls.filter((c) => c === "closed").length === 3, "the manual refresh's recently-closed search");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.get({ owner: "acme", name: "web", number: 2 })?.summary?.state, "MERGED");
    assert.equal(service.lastError, null, "the main list still loaded");
  } finally {
    release();
    service.dispose();
    setGhRunner(null);
  }
});

test("refresh: recently closed every 10 minutes, team requests and others 5 seconds after the first list then every 5 minutes, everything on a manual refresh", async () => {
  assert.deepEqual(REFRESH_TIMING, { closedEveryMs: 600_000, extrasDelayMs: 5_000, extrasEveryMs: 300_000 });
  const { calls } = fakeGitHub({ open: () => [mineNode(1)], closed: () => [merged(2)], team: () => [mineNode(4, { reviewRequests: { nodes: [] } })] });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const service = await makeService({ config: () => config({ closedDays: 3, team: true, others: true }), repos: NO_CLONE, timing: { extrasDelayMs: 40 } });
  const count = (kind: string) => calls.filter((c) => c === kind).length;
  const counts = () => ({ main: count("main"), closed: count("closed"), team: count("team"), others: count("others") });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  try {
    await service.refresh();
    assert.deepEqual(counts(), { main: 1, closed: 1, team: 0, others: 0 }, "team requests and others wait");
    await until(() => count("others") === 1, "team requests and others to load");
    assert.deepEqual(counts(), { main: 1, closed: 1, team: 1, others: 1 });
    assert.deepEqual((await service.pageGroups()).map((g) => g.id), ["requested", "team", "closed"]);

    offset = 60_000; // the next poll: the main search only
    await service.refresh();
    await settle();
    assert.deepEqual(counts(), { main: 2, closed: 1, team: 1, others: 1 });

    offset = 5 * 60_000 + 1_000; // team requests and others are due again
    await service.refresh();
    await until(() => count("others") === 2, "the 5-minute background searches");
    assert.deepEqual(counts(), { main: 3, closed: 1, team: 2, others: 2 });

    offset = 10 * 60_000 + 500; // recently closed ones are due (team requests and others not yet: 4m59s since)
    await service.refresh();
    await until(() => count("closed") === 2, "the 10-minute recently-closed search");
    await settle();
    assert.deepEqual(counts(), { main: 4, closed: 2, team: 2, others: 2 });

    offset += 1_000; // a manual refresh runs everything at once
    await service.refresh({ full: true });
    await until(() => count("others") === 3 && count("closed") === 3, "everything");
    assert.deepEqual(counts(), { main: 5, closed: 3, team: 3, others: 3 });
  } finally {
    Date.now = realNow;
    service.dispose();
    setGhRunner(null);
  }
});

test("refresh: a manual refresh asked for while a poll is under way still runs the background searches", async () => {
  const { calls } = fakeGitHub({ open: () => [mineNode(1)], closed: () => [], team: () => [] });
  const service = await makeService({ config: () => config({ closedDays: 3, team: true }), repos: NO_CLONE, timing: { extrasDelayMs: 60_000 } });
  try {
    await service.refresh();
    await until(() => calls.includes("closed"), "the first recently-closed search");
    const poll = service.refresh();
    const manual = service.refresh({ full: true });
    await Promise.all([poll, manual]);
    await until(() => calls.filter((c) => c === "team").length === 1 && calls.filter((c) => c === "closed").length === 2, "the manual refresh's background searches");
    assert.equal(calls.filter((c) => c === "main").length, 2, "they shared one main search");
  } finally {
    service.dispose();
    setGhRunner(null);
  }
});

test("refresh: rows and counts from the background searches stay while they load again, from the last session too", async () => {
  const team = mineNode(4, { reviewRequests: { nodes: [] } });
  // The last session's list: a requested one, a team request (1 of 21) and a merged one (1 of 5).
  const memory = new Map<string, unknown>([
    [
      "lastList",
      [
        { ...summaryOf(mineNode(1)), reasons: ["review-requested"] },
        { ...summaryOf(team), reasons: ["team-requested"] },
        { ...summaryOf(merged(2)), reasons: ["recently-closed"] },
      ],
    ],
    ["lastTotals", { direct: { shown: 1, total: 1 }, team: { shown: 1, total: 21 }, closed: { shown: 1, total: 5 } }],
  ]);
  let release = () => {};
  const gate = { closed: new Promise<void>((r) => (release = r)), team: new Promise<void>(() => undefined) };
  fakeGitHub({ open: () => [mineNode(1)], closed: () => [merged(2, { title: "Change 2, merged" })], team: () => [team], gate });
  const service = await makeService({ memory, config: () => config({ closedDays: null, team: true }), repos: NO_CLONE, timing: { extrasDelayMs: 0 } });
  const groups = async () => (await service.pageGroups()).map((g) => [g.id, g.description, g.keys]);
  const expected = [
    ["requested", "1", ["acme/web#1"]],
    ["team", "1 of 21", ["acme/web#4"]],
    ["closed", "1 of 5", ["acme/web#2"]],
  ];
  try {
    assert.deepEqual(await groups(), expected, "the last session's list shows at once");
    await service.refresh();
    assert.deepEqual(await groups(), expected, "the main search alone doesn't drop the others' rows or counts");
    release();
    await until(() => !!(memory.get("lastTotals") as any)?.closed && service.totals.closed?.total === 5 && service.get({ owner: "acme", name: "web", number: 2 })?.summary?.title === "Change 2, merged", "recently closed ones");
    assert.deepEqual(await groups(), expected);
  } finally {
    release();
    service.dispose();
    setGhRunner(null);
  }
});

test("diffline.watch.recentlyClosedDays: missing means 3 days, and the setting's default says so", async () => {
  assert.equal(RECENTLY_CLOSED_DAYS, 3);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const setting = pkg.contributes.configuration.properties?.["diffline.watch.recentlyClosedDays"] ?? pkg.contributes.configuration.flatMap?.((c: any) => c.properties["diffline.watch.recentlyClosedDays"] || []).at(0);
  assert.equal(setting.default, 3);
  const { calls, variables } = fakeGitHub({ open: () => [], closed: () => [] });
  const service = await makeService({ config: () => config({ closedDays: null }), repos: NO_CLONE });
  try {
    await service.refresh();
    await until(() => calls.includes("closed"), "the recently-closed search");
    assert.match(variables.closedReviewed, new RegExp(` closed:>=${closedSince(3)} `));
  } finally {
    service.dispose();
    setGhRunner(null);
  }
});
