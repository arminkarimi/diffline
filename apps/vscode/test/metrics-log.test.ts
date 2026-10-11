import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildEvents, editRatio, MetricsLog, runEvent, verbatimText, type MetricsEvent } from "../src/core/metrics-log.ts";
import { decided } from "../src/core/service.ts";
import type { AgentFile, Finding } from "../src/core/types.ts";

const KEY = { owner: "acme", name: "web", number: 123 };
const HEAD = "a".repeat(40);
const RAN = "2026-10-11T09:00:00.000Z";

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id, agent: "security", severity: "high", confidence: "High confidence", label: "blocking", path: "src/auth.ts", match: "token = req.query.token",
  title: `Title of ${id}`, body: "SECRET BODY TEXT", comment: "Could this read the token from a header instead of the query string?", ...over,
});

const agentFile = (): AgentFile => ({
  version: 1, agent: "Diffline (claude + pi)", ranAt: RAN, commit: HEAD, lede: "",
  agents: [
    { id: "guide", name: "Guide agent", short: "Guide", focus: "f", harness: "claude", model: "claude-sonnet-9", instructions: "111111111111" },
    { id: "security", name: "Security agent", short: "Security", focus: "f", harness: "pi", model: "openai/gpt-x", thinking: "high", instructions: "abcdefabcdef" },
  ],
  findings: [finding("security-0a1b2c3d"), finding("security-0a1b2c3d-2", { severity: "low", confidence: "Minor", label: "nit", fix: { text: "Use a header." } })],
  checked: [],
  description: { kind: "feature", why: "", items: [{ rule: "why", status: "missing", ask: "Why?" }, { rule: "risks", status: "partly" }] },
});

const tmpDir = () => mkdtemp(path.join(os.tmpdir(), "diffline-metrics-"));
const lines = async (file: string): Promise<MetricsEvent[]> => (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

test("editRatio: 0 for the same words, 1 for none kept, word-level and cheap on long texts", () => {
  assert.equal(editRatio("Could this  read the token?", "Could this read\nthe token?"), 0);
  assert.equal(editRatio("a b c d", "w x y z"), 1);
  assert.equal(editRatio("a b c d", "a b c e"), 0.25);
  assert.equal(editRatio("a b c d", "a b c d e f g h"), 0.5);
  assert.equal(editRatio("", ""), 0);
  assert.equal(editRatio("", "new words"), 1);
  const long = Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(" ");
  const started = Date.now();
  assert.equal(editRatio(long, long + " more"), 0, "compared on the first 1500 words");
  assert.ok(Date.now() - started < 2000);
});

test("finding events: enriched from the agent file, no finding text, unknown ids and legacy f1 ids left out", () => {
  const f = agentFile();
  const { events, skipped } = buildEvents(KEY, { head: HEAD, run: RAN, events: [
    { kind: "finding", action: "added", finding: "security-0a1b2c3d" },
    { kind: "finding", action: "dismissed", finding: "security-0a1b2c3d-2", reason: "Not a problem" },
    { kind: "finding", action: "copied", finding: "security-0a1b2c3d" },
    { kind: "finding", action: "undone", finding: "security-0a1b2c3d", reason: "added" },
    { kind: "finding", action: "left-open", finding: "security-0a1b2c3d" },
    { kind: "finding", action: "added", finding: "f1" },
    { kind: "finding", action: "dismissed", finding: "security-0a1b2c3d" }, // no reason
    { kind: "finding", action: "deleted", finding: "security-0a1b2c3d" },
    "junk",
  ] }, f, new Date("2026-10-11T10:00:00Z"));
  assert.equal(skipped, 4);
  assert.deepEqual(events.map((e) => e.action), ["added", "dismissed", "copied", "undone", "left-open"]);
  assert.deepEqual(events[1], {
    v: 1, at: "2026-10-11T10:00:00.000Z", pr: "acme/web#123", head: HEAD, run: RAN, kind: "finding", action: "dismissed", reason: "Not a problem",
    finding: { id: "security-0a1b2c3d-2", agent: "security", severity: "low", confidence: "Minor", label: "nit", path: "src/auth.ts", title: "Title of security-0a1b2c3d-2" },
    agent: { id: "security", harness: "pi", model: "openai/gpt-x", thinking: "high", instructions: "abcdefabcdef" },
  });
  assert.equal(events[3].reason, "added");
  assert.ok(!JSON.stringify(events).includes("SECRET BODY TEXT"));
  assert.ok(!JSON.stringify(events).includes("header instead"), "no comment text");
  // Older agent files don't say what an agent ran with.
  const old = agentFile();
  old.agents = old.agents.map(({ id, name, short, focus }) => ({ id, name, short, focus }));
  assert.deepEqual(buildEvents(KEY, { events: [{ kind: "finding", action: "copied", finding: "security-0a1b2c3d" }] }, old).events[0].agent, { id: "security", harness: null, model: null, instructions: null });
  // No page head or run: the agent file's.
  const bare = buildEvents(KEY, { head: "not a sha", events: [{ kind: "finding", action: "copied", finding: "security-0a1b2c3d" }] }, f).events[0];
  assert.equal(bare.head, HEAD);
  assert.equal(bare.run, RAN);
  // No agent file: nothing to say about findings.
  assert.equal(buildEvents(KEY, { events: [{ kind: "finding", action: "copied", finding: "security-0a1b2c3d" }] }, null).skipped, 1);
});

test("posted findings: edit compares the posted text with what the draft started from", () => {
  const f = agentFile();
  const [same, rewritten, partly, verbatim] = buildEvents(KEY, { events: [
    { kind: "finding", action: "posted", finding: "security-0a1b2c3d", text: f.findings[0].comment },
    { kind: "finding", action: "posted", finding: "security-0a1b2c3d", text: "Please move it." },
    { kind: "finding", action: "posted", finding: "security-0a1b2c3d", text: "Could this read the token from a cookie instead of the query string?" },
    { kind: "finding", action: "posted", finding: "security-0a1b2c3d-2", text: verbatimText(f.findings[1]), verbatim: true },
  ] }, f).events;
  assert.equal(same.edit, 0);
  assert.equal(rewritten.edit, 1);
  assert.ok(partly.edit! > 0 && partly.edit! < 0.2);
  assert.equal(verbatim.edit, 0);
  assert.equal(buildEvents(KEY, { events: [{ kind: "finding", action: "posted", finding: "security-0a1b2c3d" }] }, f).skipped, 1, "posted needs its text");
  assert.ok(!JSON.stringify([same, partly]).includes("cookie"), "the posted text isn't logged");
});

test("description events: asked, skipped with a reason, undone; the rule must be in the check", () => {
  const { events, skipped } = buildEvents(KEY, { events: [
    { kind: "description", action: "asked", rule: "why" },
    { kind: "description", action: "skipped", rule: "risks", reason: "Covered elsewhere" },
    { kind: "description", action: "undone", rule: "risks", reason: "skipped" },
    { kind: "description", action: "skipped", rule: "risks" },
    { kind: "description", action: "asked", rule: "rollout" },
  ] }, agentFile());
  assert.equal(skipped, 2);
  assert.deepEqual(events.map((e) => [e.action, e.rule, e.reason, e.descKind, e.agent?.id]), [
    ["asked", "why", undefined, "feature", "guide"],
    ["skipped", "risks", "Covered elsewhere", "feature", "guide"],
    ["undone", "risks", "skipped", "feature", "guide"],
  ]);
});

test("review events: counts checked, run null without agents, no text", () => {
  const review = { event: "changes", own: false, comments: 3, fromFindings: 2, reviewed: 7, hunks: 9, agents: true, activeMs: 754_321.6 };
  const [e] = buildEvents(KEY, { head: HEAD, run: RAN, events: [{ kind: "review", action: "submitted", review }] }, agentFile()).events;
  assert.deepEqual(e.review, { event: "changes", own: false, comments: 3, fromFindings: 2, reviewed: 7, hunks: 9, agents: true, activeMs: 754_322, round: 1, newPush: false });
  assert.equal(e.run, RAN);
  const [none] = buildEvents(KEY, { head: HEAD, run: null, events: [{ kind: "review", action: "submitted", review: { ...review, agents: false, fromFindings: 0 } }] }, null).events;
  assert.equal(none.run, null);
  assert.equal(none.head, HEAD);
  const bad = buildEvents(KEY, { events: [
    { kind: "review", action: "submitted", review: { ...review, event: "merge" } },
    { kind: "review", action: "submitted", review: { ...review, comments: -1 } },
    { kind: "review", action: "submitted", review: { ...review, own: "no" } },
  ] }, null);
  assert.equal(bad.skipped, 3);
  const [noTime] = buildEvents(KEY, { events: [{ kind: "review", action: "submitted", review: { ...review, activeMs: "x" } }] }, null).events;
  assert.equal(noTime.review!.activeMs, 0);
});

test("run events: per-agent harness, model, tokens, cost, findings and failures", () => {
  const e = runEvent(KEY, {
    head: HEAD, run: RAN, action: "finished", trigger: "auto", ms: 61_000.4,
    agents: [
      { id: "security", harness: "pi", model: "openai/gpt-x", thinking: "high", instructions: "abcdefabcdef", ms: 40_000, tokens: { input: 1000, cachedInput: 400, output: 200 }, costUsd: 0.12, findings: 2 },
      { id: "tests", harness: "codex", model: null, instructions: "123456123456", ms: 3000, tokens: null, costUsd: null, findings: 0, failed: "timeout" },
      { id: "lede", harness: "claude", model: "claude-sonnet-9", instructions: null, ms: 900, tokens: null, costUsd: 0.01, findings: 0 },
    ],
  }, new Date(RAN));
  assert.equal(e.kind, "run");
  assert.equal(e.action, "finished");
  assert.equal(e.trigger, "auto");
  assert.equal(e.ms, 61_000);
  assert.deepEqual(e.agents![0], { id: "security", harness: "pi", model: "openai/gpt-x", thinking: "high", instructions: "abcdefabcdef", ms: 40_000, tokens: { input: 1000, cachedInput: 400, output: 200 }, costUsd: 0.12, findings: 2 });
  assert.equal(e.agents![1].failed, "timeout");
  assert.equal("thinking" in e.agents![1], false, "thinking only for Pi");
});

test("MetricsLog: appends in order however fast messages come, file mode 0600", async () => {
  const dir = await tmpDir();
  const log = new MetricsLog(path.join(dir, "metrics"), { enabled: () => true });
  const f = agentFile();
  // Agent file reads that finish out of order mustn't reorder the lines.
  const slowRead = (ms: number) => () => new Promise<AgentFile>((r) => setTimeout(() => r(f), ms));
  const writes = [];
  for (let i = 0; i < 30; i++) {
    writes.push(log.record(KEY, { events: [{ kind: "finding", action: i % 2 ? "copied" : "added", finding: "security-0a1b2c3d" }, { kind: "description", action: "asked", rule: "why" }] }, slowRead((30 - i) % 7)));
  }
  await Promise.all(writes);
  const got = await lines(log.file);
  assert.equal(got.length, 60);
  got.forEach((e, n) => assert.equal(e.action, n % 2 ? "asked" : Math.floor(n / 2) % 2 ? "copied" : "added"));
  assert.equal((await stat(log.file)).mode & 0o777, 0o600);
  assert.equal(log.file, path.join(dir, "metrics", "events.jsonl"));
});

test("MetricsLog: left-open once per run and finding; review rounds and new pushes come from the log", async () => {
  const dir = await tmpDir();
  const f = agentFile();
  const read = async () => f;
  const open = { kind: "finding", action: "left-open", finding: "security-0a1b2c3d" };
  const review = (head: string) => ({ head, run: RAN, events: [open, { kind: "review", action: "submitted", review: { event: "comment", own: false, comments: 1, fromFindings: 0, reviewed: 1, hunks: 2, agents: true, activeMs: 1000 } }] });
  const log = new MetricsLog(dir, { enabled: () => true });
  const first = await log.record(KEY, review(HEAD), read);
  assert.deepEqual(first.map((e) => e.action), ["left-open", "submitted"]);
  assert.deepEqual([first[1].review!.round, first[1].review!.newPush], [1, false]);
  const second = await log.record(KEY, review(HEAD), read);
  assert.deepEqual(second.map((e) => e.action), ["submitted"], "left open on this run already");
  assert.deepEqual([second[0].review!.round, second[0].review!.newPush], [2, false]);
  // A new log object (another session) reads what's in the file.
  const again = new MetricsLog(dir, { enabled: () => true });
  const third = await again.record(KEY, review("b".repeat(40)), read);
  assert.deepEqual(third.map((e) => e.action), ["submitted"]);
  assert.deepEqual([third[0].review!.round, third[0].review!.newPush], [3, true]);
  // Another pull request starts at round 1; a later run can be left open again.
  const other = await again.record({ ...KEY, number: 124 }, review(HEAD), read);
  assert.deepEqual([other[1].review!.round, other[1].review!.newPush], [1, false]);
  const later = await again.record(KEY, { ...review(HEAD), run: "2026-10-12T09:00:00.000Z" }, read);
  assert.equal(later[0].action, "left-open");
  assert.equal((await lines(again.file)).length, 8);
});

test("MetricsLog: nothing is written when turned off; delete removes the file", async () => {
  const dir = await tmpDir();
  let on = false;
  const log = new MetricsLog(dir, { enabled: () => on });
  const msg = { events: [{ kind: "finding", action: "copied", finding: "security-0a1b2c3d" }] };
  assert.deepEqual(await log.record(KEY, msg, async () => agentFile()), []);
  assert.deepEqual(await log.recordRun(KEY, { head: HEAD, run: null, action: "failed", trigger: "manual", ms: 1, agents: [] }), []);
  await assert.rejects(stat(log.file));
  on = true;
  await log.record(KEY, msg, async () => agentFile());
  await log.recordRun(KEY, { head: HEAD, run: null, action: "cancelled", trigger: "manual", ms: 1, agents: [] });
  assert.deepEqual((await lines(log.file)).map((e) => e.kind), ["finding", "run"]);
  assert.equal(await log.delete(), true);
  await assert.rejects(stat(log.file));
  assert.equal(await log.delete(), false);
  // Writing again after a delete starts a new file, and rounds start over.
  const [e] = await log.record(KEY, { events: [{ kind: "review", action: "submitted", review: { event: "approve", own: false, comments: 0, fromFindings: 0, reviewed: 0, hunks: 0, agents: false, activeMs: 0 } }] }, async () => null);
  assert.equal(e.review!.round, 1);
});

test("decided: positional ids from before stable ids count only with their run", () => {
  const state = { findings: { f1: { state: "dismissed" }, f2: { state: "accepted", run: RAN }, "security-0a1b2c3d": { state: "dismissed", run: "2026-10-01T00:00:00.000Z" } } };
  assert.equal(decided(state, "f1", RAN), false, "an old decision without a run is ignored");
  assert.equal(decided(state, "f2", RAN), true);
  assert.equal(decided(state, "f2", "2026-10-12T00:00:00.000Z"), false);
  assert.equal(decided(state, "security-0a1b2c3d", RAN), true, "stable ids keep decisions from earlier runs");
  assert.equal(decided(state, "tests-12345678", RAN), false);
  assert.equal(decided(null, "f1", RAN), false);
});
