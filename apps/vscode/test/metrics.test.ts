import assert from "node:assert/strict";
import { test } from "node:test";

import type { MetricsEvent } from "../src/core/metrics-log.ts";
import { aggregate, csvField, exportText, findingOutcomes, isoWeek, median, outcomesCsv, parseEvents, sinceDays, TOO_FEW } from "../src/core/metrics.ts";

// Mid-day times, so the local dates (and weeks) are the same in any time zone the tests run in.
const NOW = new Date("2026-10-14T12:00:00Z");
const PR = "acme/web#12";
const RUN = "2026-10-12T09:00:00.000Z";

type Over = Partial<MetricsEvent> & { f?: Partial<NonNullable<MetricsEvent["finding"]>>; a?: Partial<NonNullable<MetricsEvent["agent"]>> };
function fe(action: string, id: string, at: string, over: Over = {}): MetricsEvent {
  const { f, a, ...rest } = over;
  return {
    v: 1, at, pr: PR, head: "a".repeat(40), run: RUN, kind: "finding", action: action as MetricsEvent["action"],
    finding: { id, agent: a?.id || "security", severity: "high", confidence: "High confidence", label: "blocking", path: "src/a.ts", title: `Title ${id}`, ...f },
    agent: { id: "security", harness: "claude", model: "sonnet-9", instructions: "aaaaaaaaaaaa", ...a },
    ...rest,
  };
}
const review = (at: string, r: Partial<NonNullable<MetricsEvent["review"]>> = {}, over: Partial<MetricsEvent> = {}): MetricsEvent => ({
  v: 1, at, pr: PR, head: "a".repeat(40), run: null, kind: "review", action: "submitted",
  review: { event: "approve", own: false, comments: 0, fromFindings: 0, reviewed: 10, hunks: 10, agents: true, activeMs: 600_000, round: 1, newPush: false, ...r },
  ...over,
});
type RunAgent = NonNullable<MetricsEvent["agents"]>[number];
const agentRun = (over: Partial<RunAgent> = {}): RunAgent => ({ id: "security", harness: "claude", model: "sonnet-9", instructions: "aaaaaaaaaaaa", ms: 60_000, tokens: { input: 1000, cachedInput: 500, output: 200 }, costUsd: 0.5, findings: 2, ...over });
const run = (at: string, agents: RunAgent[], over: Partial<MetricsEvent> = {}): MetricsEvent => ({
  v: 1, at, pr: PR, head: "a".repeat(40), run: RUN, kind: "run", action: "finished", trigger: "manual", ms: 90_000, agents, ...over,
});

test("parseEvents: reads version 1 lines and counts damaged lines, other versions and unknown kinds", () => {
  const good = fe("added", "security-1", "2026-10-13T12:00:00Z");
  const text = [
    JSON.stringify({ ...good, extra: { anything: true } }), // unknown fields are fine
    "",
    "{not json",
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, kind: "something-new" }),
    JSON.stringify({ ...good, at: "yesterday" }),
    JSON.stringify({ ...good, finding: null }),
    JSON.stringify(review("2026-10-13T12:00:00Z")),
    JSON.stringify(run("2026-10-13T12:00:00Z", [agentRun()])),
    JSON.stringify(run("2026-10-13T12:00:00Z", [{ harness: "claude" }] as any)),
    "[1,2]",
  ].join("\n");
  const { events, skipped } = parseEvents(text);
  assert.deepEqual(events.map((e) => e.kind), ["finding", "review", "run"]);
  assert.equal(skipped, 7);
  assert.deepEqual(parseEvents(""), { events: [], skipped: 0 });
});

test("finding outcomes: the last event per pull request and finding decides; undone goes back to undecided", () => {
  const events = [
    fe("added", "security-1", "2026-10-13T10:00:00Z"),
    fe("posted", "security-1", "2026-10-13T11:00:00Z", { edit: 0.25 }),
    fe("added", "security-2", "2026-10-13T10:00:00Z"),
    fe("dismissed", "security-2", "2026-10-13T10:05:00Z", { reason: "Intended" }), // last event wins
    fe("dismissed", "security-3", "2026-10-13T10:00:00Z", { reason: "Not a problem" }),
    fe("undone", "security-3", "2026-10-13T10:01:00Z", { reason: "dismissed" }),
    fe("copied", "security-4", "2026-10-13T10:00:00Z"),
    fe("left-open", "security-5", "2026-10-13T11:00:00Z"),
    fe("added", "security-6", "2026-10-13T10:00:00Z"),
    fe("undone", "security-6", "2026-10-13T10:00:30Z", { reason: "added" }),
    fe("left-open", "security-6", "2026-10-13T11:00:00Z"), // then left open when the review posted
    fe("added", "security-1", "2026-10-13T10:00:00Z", { pr: "acme/web#13" }), // another pull request, another finding
  ];
  const out = findingOutcomes(events);
  const by = Object.fromEntries(out.map((o) => [`${o.pr} ${o.id}`, o]));
  assert.equal(out.length, 7);
  assert.equal(by[`${PR} security-1`].outcome, "useful");
  assert.equal(by[`${PR} security-1`].edit, 0.25);
  assert.equal(by[`${PR} security-2`].outcome, "dismissed");
  assert.equal(by[`${PR} security-2`].reason, "Intended");
  assert.equal(by[`${PR} security-3`].outcome, "undecided");
  assert.equal(by[`${PR} security-3`].reason, null, "an undo's reason isn't a dismiss reason");
  assert.equal(by[`${PR} security-4`].outcome, "useful");
  assert.equal(by[`${PR} security-5`].outcome, "ignored");
  assert.equal(by[`${PR} security-6`].outcome, "ignored");
  assert.equal(by["acme/web#13 security-1"].outcome, "useful");
  // In the order of each finding's last event in the log.
  assert.deepEqual(out.map((o) => `${o.pr} ${o.id}`), [1, 2, 3, 4, 5, 6].map((n) => `${PR} security-${n}`).concat("acme/web#13 security-1"));

  const r = aggregate(events, { since: null, groupBy: "agent", now: NOW });
  const t = r.findings.total;
  assert.deepEqual([t.findings, t.decided, t.useful, t.dismissed, t.ignored, t.undecided], [7, 6, 3, 1, 2, 1]);
  assert.equal(t.usefulPct, 0.5);
  assert.equal(t.tooFew, true);
  assert.deepEqual(t.topDismissReason, { reason: "Intended", count: 1 });
});

test("finding groups: too few to tell under 10 decided findings; groups by harness, model and thinking", () => {
  const events: MetricsEvent[] = [];
  for (let i = 0; i < TOO_FEW; i++) events.push(fe(i < 6 ? "added" : i < 9 ? "dismissed" : "left-open", `security-${i}`, "2026-10-13T12:00:00Z", { reason: i < 6 ? undefined : i < 8 ? "Not a problem" : "Out of scope" }));
  for (let i = 0; i < 4; i++) events.push(fe("added", `tests-${i}`, "2026-10-13T12:00:00Z", { a: { id: "tests", harness: "pi", model: "openai/gpt-x", thinking: i < 2 ? "high" : null } }));
  const r = aggregate(events, { since: null, groupBy: "agent", now: NOW });
  const sec = r.findings.groups.find((g) => g.key === "security")!;
  assert.equal(sec.decided, 10);
  assert.equal(sec.tooFew, false);
  assert.deepEqual([sec.usefulPct, sec.dismissedPct, sec.ignoredPct], [0.6, 0.3, 0.1]);
  assert.deepEqual(sec.topDismissReason, { reason: "Not a problem", count: 2 });
  assert.deepEqual(sec.dismissReasons, [{ reason: "Not a problem", count: 2 }, { reason: "Out of scope", count: 1 }]);
  const tests = r.findings.groups.find((g) => g.key === "tests")!;
  assert.equal(tests.tooFew, true);
  assert.equal(r.findings.examples.tests.length, 4);
  assert.deepEqual(Object.keys(r.findings.examples).sort(), ["security", "tests"]);

  const keys = (by: "harness" | "model" | "thinking") => aggregate(events, { since: null, groupBy: by, now: NOW }).findings.groups.map((g) => `${g.key}:${g.findings}`).sort();
  assert.deepEqual(keys("harness"), ["claude:10", "pi:4"]);
  assert.deepEqual(keys("model"), ["openai/gpt-x:4", "sonnet-9:10"]);
  assert.deepEqual(keys("thinking"), ["default:2", "high:2", "not used:10"]);
});

test("findings: severity by confidence, rewording and description rules", () => {
  const events = [
    fe("posted", "s-1", "2026-10-13T12:00:00Z", { edit: 0 }),
    fe("posted", "s-2", "2026-10-13T12:00:00Z", { edit: 0.2 }),
    fe("posted", "s-3", "2026-10-13T12:00:00Z", { edit: 0.9 }),
    fe("dismissed", "s-4", "2026-10-13T12:00:00Z", { reason: "Intended", f: { severity: "low", confidence: "Minor" } }),
    { v: 1, at: "2026-10-13T12:00:00Z", pr: PR, head: null, run: RUN, kind: "description", action: "asked", rule: "why", descKind: "feature" },
    { v: 1, at: "2026-10-13T12:00:00Z", pr: PR, head: null, run: RUN, kind: "description", action: "skipped", rule: "risks", reason: "Not needed here" },
    { v: 1, at: "2026-10-13T12:00:00Z", pr: "acme/web#13", head: null, run: RUN, kind: "description", action: "skipped", rule: "risks", reason: "Covered elsewhere" },
    { v: 1, at: "2026-10-13T12:00:00Z", pr: "acme/web#14", head: null, run: RUN, kind: "description", action: "asked", rule: "evidence" },
    { v: 1, at: "2026-10-13T12:01:00Z", pr: "acme/web#14", head: null, run: RUN, kind: "description", action: "undone", rule: "evidence", reason: "asked" },
  ] as MetricsEvent[];
  const f = aggregate(events, { since: null, groupBy: "agent", now: NOW }).findings;
  assert.deepEqual(f.severities, ["high", "low"]);
  assert.deepEqual(f.confidences, ["High confidence", "Minor"]);
  const cell = (s: string, c: string) => f.matrix.find((x) => x.severity === s && x.confidence === c)!;
  assert.deepEqual([cell("high", "High confidence").findings, cell("high", "High confidence").useful], [3, 3]);
  assert.equal(cell("high", "Minor").findings, 0);
  assert.equal(cell("low", "Minor").dismissed, 1);
  assert.deepEqual(f.rewording, { posted: 3, median: 0.2, unchanged: 1, rewritten: 1 });
  assert.equal(f.groups[0].editMedian, 0.2);
  assert.deepEqual(f.description, [
    { rule: "why", asked: 1, skipped: 0, reasons: [] },
    { rule: "risks", asked: 0, skipped: 2, reasons: [{ reason: "Covered elsewhere", count: 1 }, { reason: "Not needed here", count: 1 }] },
  ]);
});

test("findings: before and after an agent's instructions or model changed", () => {
  const events: MetricsEvent[] = [];
  for (let i = 0; i < 12; i++) events.push(fe(i < 3 ? "added" : "dismissed", `old-${i}`, "2026-10-02T12:00:00Z", { run: "2026-10-02T09:00:00.000Z", reason: "Not a problem" }));
  for (let i = 0; i < 4; i++) events.push(fe(i < 3 ? "added" : "dismissed", `new-${i}`, "2026-10-13T12:00:00Z", { run: "2026-10-12T09:00:00.000Z", reason: "Intended", a: { instructions: "bbbbbbbbbbbb" } }));
  // A late decision on a finding from the old setup doesn't make the old setup the latest.
  events.push(fe("added", "old-late", "2026-10-14T08:00:00Z", { run: "2026-10-02T09:00:00.000Z" }));
  // Another agent that didn't change has no comparison.
  events.push(fe("added", "tests-1", "2026-10-13T12:00:00Z", { a: { id: "tests" } }));
  const changes = aggregate(events, { since: null, groupBy: "agent", now: NOW }).findings.changes;
  assert.equal(changes.length, 1);
  const c = changes[0];
  assert.equal(c.agent, "security");
  assert.deepEqual(c.changed, ["instructions"]);
  assert.equal(c.after.instructions, "bbbbbbbbbbbb");
  assert.deepEqual([c.after.decided, c.after.useful, c.after.usefulPct, c.after.tooFew], [4, 3, 0.75, true]);
  assert.deepEqual([c.before.decided, c.before.useful, c.before.usefulPct, c.before.tooFew], [13, 4, 0.308, false]);
  assert.equal(c.before.from, "2026-10-02T09:00:00.000Z");

  // A model change, and the period: with only the new setup in it, there's nothing to compare.
  const model = [fe("added", "m-1", "2026-10-02T12:00:00Z", { run: "2026-10-02T09:00:00.000Z" }), fe("added", "m-2", "2026-10-13T12:00:00Z", { a: { model: "sonnet-10" } })];
  assert.deepEqual(aggregate(model, { since: null, groupBy: "agent", now: NOW }).findings.changes[0].changed, ["model"]);
  assert.equal(aggregate(model, { since: sinceDays(7, NOW), groupBy: "agent", now: NOW }).findings.changes.length, 0);
});

test("isoWeek: ISO weeks and their Mondays, across a year's edge", () => {
  assert.deepEqual(isoWeek(new Date(2026, 9, 14, 12)), { week: "2026-W42", start: "2026-10-12" });
  assert.deepEqual(isoWeek(new Date(2026, 9, 18, 12)), { week: "2026-W42", start: "2026-10-12" }); // Sunday
  assert.deepEqual(isoWeek(new Date(2026, 0, 1, 12)), { week: "2026-W01", start: "2025-12-29" });
  assert.deepEqual(isoWeek(new Date(2027, 0, 1, 12)), { week: "2026-W53", start: "2026-12-28" });
  assert.deepEqual(isoWeek(new Date(2027, 0, 4, 12)), { week: "2027-W01", start: "2027-01-04" });
});

test("your reviews: per week by decision, own and others', time, coverage, rounds and comments", () => {
  const events = [
    review("2026-09-29T15:00:00Z", { event: "comment", own: true, activeMs: 120_000, reviewed: 5, hunks: 10, comments: 3, fromFindings: 1 }),
    review("2026-10-13T15:00:00Z", { event: "approve", activeMs: 600_000, reviewed: 10, hunks: 10, comments: 2, fromFindings: 2 }),
    review("2026-10-14T10:00:00Z", { event: "changes", activeMs: 0, reviewed: 0, hunks: 0, comments: 4, fromFindings: 9, round: 2, newPush: true }),
    review("2026-10-14T11:00:00Z", { event: "approve", activeMs: 1_200_000, reviewed: 4, hunks: 8, round: 3 }),
  ];
  const r = aggregate(events, { since: null, groupBy: "agent", now: NOW }).reviews;
  assert.deepEqual(r.weeks.map((w) => [w.week, w.reviews]), [["2026-W40", 1], ["2026-W41", 0], ["2026-W42", 3]], "empty weeks between are filled in");
  const w = r.weeks[2];
  assert.equal(w.start, "2026-10-12");
  assert.deepEqual([w.approve, w.changes, w.comment, w.own, w.others], [2, 1, 0, 0, 3]);
  assert.equal(w.activeMinutes, 15, "the median of the reviews that measured time (10 and 20 minutes)");
  assert.equal(w.activeMeasured, 2);
  assert.equal(w.coverage, 0.75, "the median of 100% and 50%; no hunks isn't counted");
  assert.deepEqual([w.laterRounds, w.laterRoundsPct, w.newPush, w.newPushPct], [2, 0.667, 1, 0.333]);
  assert.deepEqual([w.comments, w.yours, w.fromFindings], [6, 0, 6], "from findings can't exceed the comments");
  assert.deepEqual([r.total.reviews, r.total.own, r.total.comment, r.total.yours, r.total.fromFindings], [4, 1, 1, 2, 7]);
  assert.equal(r.total.activeMinutes, 10);

  // A period starts its weeks at the period's start, even without reviews early on.
  const last30 = aggregate(events, { since: sinceDays(30, NOW), groupBy: "agent", now: NOW }).reviews;
  assert.equal(last30.weeks[0].week, "2026-W38");
  assert.equal(last30.weeks.at(-1)!.week, "2026-W42");
  const last7 = aggregate(events, { since: sinceDays(7, NOW), groupBy: "agent", now: NOW }).reviews;
  assert.equal(last7.total.reviews, 3);
});

test("agent runs: failures, durations, tokens, cost that wasn't reported, cost per useful finding, triggers", () => {
  const runA = "2026-10-12T09:00:00.000Z", runB = "2026-10-13T09:00:00.000Z";
  const events = [
    run("2026-10-12T09:05:00Z", [agentRun({ costUsd: 0.6, ms: 30_000 }), agentRun({ id: "tests", harness: "codex", model: "gpt-x", costUsd: null, tokens: null, ms: 90_000 }), agentRun({ id: "lede", instructions: null, costUsd: 0.1, findings: 0 })], { run: runA, trigger: "auto" }),
    run("2026-10-13T09:05:00Z", [agentRun({ costUsd: 0.4, ms: 50_000 }), agentRun({ id: "tests", harness: "codex", model: "gpt-x", costUsd: null, failed: "timeout", findings: 0 })], { run: runB }),
    run("2026-10-13T10:00:00Z", [], { run: null, action: "failed" }),
    run("2026-10-13T11:00:00Z", [agentRun({ costUsd: 0.2, failed: "cancelled", findings: 0 })], { run: null, action: "cancelled" }),
    // Decisions on the runs' findings: two useful from run A, one from run B, one from the cost-less tests run.
    fe("added", "security-1", "2026-10-12T10:00:00Z", { run: runA }),
    fe("posted", "security-2", "2026-10-12T10:00:00Z", { run: runA }),
    fe("dismissed", "security-3", "2026-10-12T10:00:00Z", { run: runA, reason: "Intended" }),
    fe("copied", "security-4", "2026-10-13T10:00:00Z", { run: runB }),
    fe("added", "tests-1", "2026-10-12T10:00:00Z", { run: runA, a: { id: "tests", harness: "codex", model: "gpt-x" } }),
  ];
  const r = aggregate(events, { since: null, groupBy: "agent", now: NOW }).runs;
  assert.deepEqual([r.total.runs, r.total.finished, r.total.failed, r.total.cancelled, r.total.auto, r.total.manual], [4, 2, 1, 1, 1, 3]);
  assert.equal(r.total.costUsd, 1.3);
  assert.equal(r.total.costMissing, 2);
  assert.equal(r.total.usefulFindings, 3, "the tests agent's useful finding came from a run without a cost");
  assert.equal(r.total.costPerUseful, 0.4333);
  const by = Object.fromEntries(r.groups.map((g) => [g.key, g]));
  const sec = by.security;
  assert.deepEqual([sec.runs, sec.failed, sec.failures.cancelled, sec.msMedian], [3, 1, 1, 50_000]);
  assert.deepEqual(sec.tokens, { input: 3000, cachedInput: 1500, output: 600 });
  assert.deepEqual([sec.costUsd, sec.costReported, sec.costMissing, sec.usefulFindings, sec.costPerUseful], [1.2, 3, 0, 3, 0.4]);
  assert.deepEqual([sec.auto, sec.manual], [1, 2]);
  const tests = by.tests;
  assert.deepEqual([tests.costUsd, tests.costReported, tests.costMissing, tests.costPerUseful], [null, 0, 2, null], "no reported cost is null, not $0");
  assert.deepEqual(tests.failures, { timeout: 1 });
  assert.equal(tests.tokensReported, 1);
  assert.deepEqual([by.lede.costUsd, by.lede.usefulFindings, by.lede.costPerUseful], [0.1, 0, null]);

  const harness = Object.fromEntries(aggregate(events, { since: null, groupBy: "harness", now: NOW }).runs.groups.map((g) => [g.key, g]));
  assert.deepEqual([harness.claude.runs, harness.claude.costUsd, harness.claude.costPerUseful], [4, 1.3, 0.4333]);
  assert.deepEqual([harness.codex.runs, harness.codex.costUsd], [2, null]);
});

test("aggregate: periods count what's in them, and an empty log is an empty report", () => {
  const events = [
    fe("added", "security-1", "2026-09-01T12:00:00Z"),
    fe("dismissed", "security-2", "2026-09-01T12:00:00Z", { reason: "Intended" }),
    fe("left-open", "security-2", "2026-10-13T12:00:00Z"), // its outcome came in the period
    review("2026-09-01T12:00:00Z"),
    run("2026-09-01T12:00:00Z", [agentRun()]),
  ];
  const r = aggregate(events, { since: sinceDays(7, NOW), groupBy: "agent", now: NOW });
  assert.equal(r.total, 5);
  assert.equal(r.inPeriod, 1);
  assert.equal(r.findings.total.findings, 1);
  assert.equal(r.findings.total.ignored, 1);
  assert.equal(r.reviews.total.reviews, 0);
  assert.equal(r.runs.total.runs, 0);
  assert.equal(r.since, "2026-10-07T12:00:00.000Z");

  const empty = aggregate([], { since: null, groupBy: "model", now: NOW, skipped: 2 });
  assert.equal(empty.total, 0);
  assert.equal(empty.skipped, 2);
  assert.deepEqual(empty.reviews.weeks, []);
  assert.equal(empty.reviews.total.activeMinutes, null);
  assert.deepEqual(empty.findings.groups, []);
  assert.equal(empty.findings.total.usefulPct, null);
  assert.equal(empty.runs.total.costUsd, null);
  assert.equal(empty.runs.total.costPerUseful, null);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
});

test("CSV: one row per finding outcome, escaped, and safe to open in a spreadsheet", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField('Say "no", twice'), '"Say ""no"", twice"');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("-1+2"), "'-1+2");
  assert.equal(csvField(-0.5), "-0.5", "numbers stay numbers");
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");

  const events = [
    fe("dismissed", "security-1", "2026-10-13T12:00:00Z", { reason: "Not a problem, really", a: { harness: "pi", thinking: "high" } }),
    fe("posted", "security-2", "2026-10-13T12:00:00Z", { edit: 0.125 }),
  ];
  const csv = outcomesCsv(findingOutcomes(events));
  const rows = csv.trimEnd().split("\r\n");
  assert.equal(rows[0], "date,pr,finding id,agent,harness,model,thinking,severity,confidence,outcome,reason,edit");
  assert.equal(rows[1], `2026-10-13T12:00:00Z,acme/web#12,security-1,security,pi,sonnet-9,high,high,High confidence,dismissed,"Not a problem, really",`);
  assert.equal(rows[2], "2026-10-13T12:00:00Z,acme/web#12,security-2,security,claude,sonnet-9,,high,High confidence,useful,,0.125");
  assert.ok(!csv.includes("Title"), "no titles in the CSV");
});

test("exports: JSON holds the raw events in the period, CSV the outcomes in it", () => {
  const events = [fe("added", "security-1", "2026-09-01T12:00:00Z"), fe("added", "security-2", "2026-10-13T12:00:00Z"), review("2026-10-13T12:00:00Z")];
  const json = JSON.parse(exportText(events, "json", sinceDays(7, NOW), NOW));
  assert.equal(json.v, 1);
  assert.equal(json.exportedAt, NOW.toISOString());
  assert.deepEqual(json.events, events.slice(1));
  assert.equal(JSON.parse(exportText(events, "json", null, NOW)).events.length, 3);
  const csv = exportText(events, "csv", sinceDays(7, NOW), NOW).trimEnd().split("\r\n");
  assert.equal(csv.length, 2);
  assert.match(csv[1], /security-2/);
});
