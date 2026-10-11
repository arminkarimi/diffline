import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setGhRunner } from "../src/core/github.ts";
import { DifflineService, type ServiceConfig } from "../src/core/service.ts";
import { Store } from "../src/core/store.ts";
import { ensureSampleRepo } from "./fixtures/make-sample-repo.ts";

const SAMPLE = ensureSampleRepo();

function config(over: { pollSeconds?: number } = {}): ServiceConfig {
  return {
    watch: { direct: true, team: false, assigned: false, reviewed: false, codeOwners: false, others: false, authored: true, repositories: [], pollSeconds: over.pollSeconds ?? 60 },
    agents: { autoRun: false, enabled: ["guide"], maxParallel: 1, quietPeriodSeconds: 0, maxAutomaticRuns: 5, skipDrafts: true, timeoutMinutes: 1, autoRunMaxFiles: 100, autoRunMaxLines: 5000 },
    harnesses: { default: "claude", claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] }, codex: { id: "codex", command: "codex", model: "", extraArgs: [] }, pi: { id: "pi", command: "pi", model: "", extraArgs: [], thinking: "" } },
    sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 },
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
