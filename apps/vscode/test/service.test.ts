import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setGhRunner } from "../src/core/github.ts";
import { approvedBy, approverWords, DifflineService, isApproved, type ServiceConfig } from "../src/core/service.ts";
import { Store } from "../src/core/store.ts";
import { ensureSampleRepo } from "./fixtures/make-sample-repo.ts";

const SAMPLE = ensureSampleRepo();

function config(over: { pollSeconds?: number; metrics?: boolean } = {}): ServiceConfig {
  return {
    watch: { direct: true, team: false, assigned: false, reviewed: false, codeOwners: false, others: false, authored: true, repositories: [], pollSeconds: over.pollSeconds ?? 60 },
    agents: { autoRun: false, enabled: ["guide"], maxParallel: 1, quietPeriodSeconds: 0, maxAutomaticRuns: 5, skipDrafts: true, timeoutMinutes: 1, autoRunMaxFiles: 100, autoRunMaxLines: 5000 },
    harnesses: { default: "claude", claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] }, codex: { id: "codex", command: "codex", model: "", extraArgs: [] }, pi: { id: "pi", command: "pi", model: "", extraArgs: [], thinking: "" } },
    sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 },
    ...(over.metrics !== undefined ? { metrics: { enabled: over.metrics } } : {}),
  };
}

async function makeService(opts: { root?: string; repos?: unknown; config?: () => ServiceConfig; log?: (line: string) => void } = {}) {
  const store = new Store(opts.root ?? (await mkdtemp(path.join(os.tmpdir(), "diffline-service-"))));
  await store.init();
  const memory = new Map<string, unknown>();
  return new DifflineService({
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
