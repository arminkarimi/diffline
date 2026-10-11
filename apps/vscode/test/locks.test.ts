import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Locks, STALE_MS } from "../src/core/locks.ts";
import { tooLargeToAutoRun } from "../src/core/service.ts";

const dir = () => mkdtemp(path.join(os.tmpdir(), "diffline-locks-"));

test("Locks: a second window can't take a held lock until it's released", async () => {
  const d = await dir();
  const a = new Locks(d);
  const b = new Locks(d);
  assert.deepEqual(await a.acquire("run-x", { head: "abc" }), { ok: true });
  const blocked = await b.acquire("run-x");
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.holder.owner, a.owner);
  assert.equal(!blocked.ok && blocked.holder.head, "abc");
  assert.deepEqual(await a.acquire("run-x"), { ok: true }, "the holder can take it again");
  await a.release("run-x");
  assert.equal(await a.holder("run-x"), null);
  assert.deepEqual(await b.acquire("run-x"), { ok: true });
  await b.releaseAll();
});

test("Locks: release by another window leaves the lock alone", async () => {
  const d = await dir();
  const a = new Locks(d);
  const b = new Locks(d);
  await a.acquire("leader");
  await b.release("leader");
  assert.equal((await b.holder("leader"))?.owner, a.owner);
  await a.releaseAll();
});

test("Locks: a lock whose window is gone, or whose heartbeat stopped, is free", async () => {
  const d = await dir();
  const a = new Locks(d);
  const now = Date.now();
  await writeFile(path.join(d, "run-dead.json"), JSON.stringify({ pid: 999_999_999, owner: "gone", since: now, heartbeat: now }));
  await writeFile(path.join(d, "run-old.json"), JSON.stringify({ pid: process.pid, owner: "old", since: now, heartbeat: now - STALE_MS - 1 }));
  assert.equal(await a.holder("run-dead"), null);
  assert.equal(await a.holder("run-old"), null);
  assert.deepEqual(await a.acquire("run-dead"), { ok: true });
  assert.deepEqual(await a.acquire("run-old"), { ok: true });
  assert.equal(JSON.parse(await readFile(path.join(d, "run-old.json"), "utf8")).owner, a.owner);
  await a.releaseAll();
});

test("tooLargeToAutoRun: holds pull requests over either limit", () => {
  const cfg = { autoRunMaxFiles: 100, autoRunMaxLines: 5000 };
  assert.equal(tooLargeToAutoRun({ changedFiles: 100, additions: 4000, deletions: 1000 }, cfg), null);
  assert.match(tooLargeToAutoRun({ changedFiles: 383, additions: 10, deletions: 0 }, cfg) || "", /383 files/);
  assert.match(tooLargeToAutoRun({ changedFiles: 3, additions: 4000, deletions: 1001 }, cfg) || "", /5,001 lines/);
});

test("runAgents: a pull request another window is running isn't started again", async () => {
  const { DifflineService } = await import("../src/core/service.ts");
  const { Store } = await import("../src/core/store.ts");
  const root = await dir();
  const store = new Store(root);
  await store.init();
  const memory = new Map<string, unknown>();
  const service = new DifflineService({
    store,
    repos: {} as any,
    memory: { get: (k, f) => (memory.has(k) ? (memory.get(k) as any) : f), update: async (k, v) => void memory.set(k, v) },
    config: () => ({
      watch: { direct: true, team: false, assigned: false, reviewed: false, codeOwners: false, others: false, authored: true, repositories: [], pollSeconds: 60 },
      agents: { autoRun: true, enabled: ["guide"], maxParallel: 1, quietPeriodSeconds: 0, maxAutomaticRuns: 5, skipDrafts: true, timeoutMinutes: 1, autoRunMaxFiles: 100, autoRunMaxLines: 5000 },
      harnesses: { default: "claude", claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] }, codex: { id: "codex", command: "codex", model: "", extraArgs: [] }, pi: { id: "pi", command: "pi", model: "", extraArgs: [], thinking: "" } },
      sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 },
    }),
    log: () => undefined,
  });
  const other = new Locks(path.join(root, "locks"));
  await other.acquire("run-o__r__7", { head: "feed" });
  const key = { owner: "o", name: "r", number: 7 };
  let told = false;
  service.on("runElsewhere", () => (told = true));
  await service.runAgents(key);
  assert.equal(service.get(key)?.run.state, "elsewhere");
  assert.equal(service.get(key)?.run.head, "feed");
  assert.equal(service.isBusy(key), true);
  assert.equal(told, true);
  await other.releaseAll();
  service.dispose();
});
