import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setGhRunner } from "../src/core/github.ts";
import { DifflineService, type ServiceConfig } from "../src/core/service.ts";
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
