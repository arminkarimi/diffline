import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_SETTINGS } from "../src/agents/defaults.ts";
import { reviewerSchema, guideSchema } from "../src/agents/schema.ts";
import { instructionsHash, runConfig, selectAgents, type Harnesses } from "../src/agents/review.ts";
import { AnchorIndex, assemble, assignIds, findingId, guideParts, reviewerFindings, type Problems } from "../src/agents/validate.ts";
import type { DiffLine, ReviewData } from "../src/core/types.ts";

const line = (t: DiffLine[0], text: string, n: number): DiffLine => [t, t === "+" ? null : n, t === "-" ? null : n, text, 0, 0];

const data: ReviewData = {
  version: 1,
  generatedAt: "",
  repo: "o/r",
  base: { ref: "main", sha: "b".repeat(40), short: "bbbbbbb" },
  head: { ref: "f", sha: "h".repeat(40), short: "hhhhhhh" },
  mergeBase: "b".repeat(40),
  since: null,
  commits: [],
  workspace: {},
  files: [
    {
      path: "src/pay.ts", oldPath: null, status: "modified", similarity: null, binary: false, lang: "ts", generated: false, additions: 2, deletions: 1, tests: null,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, section: "", fresh: false, lines: [
        line(" ", "export function pay(amount) {", 1),
        line("-", "  return charge(amount);", 2),
        line("+", "  const cents = Math.round(amount * 100);", 2),
        line("+", "  return charge(cents);", 3),
        line(" ", "}", 4),
      ] }],
    },
    {
      path: "src/pay.test.ts", oldPath: null, status: "added", similarity: null, binary: false, lang: "ts", generated: false, additions: 1, deletions: 0, tests: null,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: "", fresh: false, lines: [line("+", "test('pays', () => {});", 1)] }],
    },
  ],
};

test("anchors resolve to non-deleted lines and repair small mistakes", () => {
  const ix = new AnchorIndex(data);
  assert.deepEqual(ix.locate("src/pay.ts", "return charge(cents);")?.match, "return charge(cents);");
  // Whitespace differences.
  assert.equal(ix.locate("src/pay.ts", "const   cents = Math.round(amount * 100);")?.match, "const cents = Math.round(amount * 100);");
  // Wrong path, unique elsewhere.
  assert.equal(ix.locate("pay.ts", "test('pays', () => {});")?.path, "src/pay.test.ts");
  // "return charge(" first appears on a deleted line: use the full text of the live line.
  assert.equal(ix.locate("src/pay.ts", "return charge(")?.match, "return charge(cents);");
  // Only on a deleted line.
  assert.equal(ix.locate("src/pay.ts", "return charge(amount);"), null);
  assert.equal(ix.resolvePath("b/src/pay.ts"), "src/pay.ts");
});

test("reviewer findings: drops unanchored, caps per agent, demotes blocking, orders by severity", () => {
  const problems: Problems = { dropped: [], repaired: [] };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agents.correctness.maxFindings = 2;
  const f = (title: string, severity: "high" | "medium" | "low", match: string, label: any = "question") => ({
    severity, confidence: "High confidence" as const, label, path: "src/pay.ts", match, title, body: "b", steps: [{ path: null, match: "}", text: "end" }], fix: null, comment: "c",
  });
  const out = reviewerFindings("correctness", {
    findings: [f("low one", "low", "}"), f("gone", "high", "return charge(amount);"), f("high one", "high", "const cents", "blocking"), f("medium one", "medium", "export function pay", "blocking")],
    checked: [{ path: "src/pay.ts", text: "Rounding is fine." }, { path: "nope.ts", text: "x" }],
  }, new AnchorIndex(data), settings, problems);
  assert.deepEqual(out.findings.map((x) => x.title), ["high one", "medium one"]);
  assert.equal(out.findings[0].label, "blocking");
  assert.equal(out.findings[1].label, "question"); // blocking needs high severity
  assert.equal(out.checked[1].path, undefined);
  assert.ok(problems.dropped.some((d) => d.includes("gone")));
});

test("guide: chapters cover every file once, quotes must be in the description, rules in order", () => {
  const problems: Problems = { dropped: [], repaired: [] };
  const ix = new AnchorIndex(data);
  const g = guideParts({
    description: { kind: "fix", why: "w", items: [
      { rule: "rollout", status: "covered", quote: "not in the body", note: null, ask: null, refs: [] },
      { rule: "evidence", status: "covered", quote: "Customers were charged dollars", note: null, ask: null, refs: [] },
      { rule: "risks", status: "missing", quote: null, note: "n", ask: "a", refs: [] },
    ] },
    chapters: [{ title: "Pay", note: "n", source: "auto", sourceText: "", files: ["src/pay.ts", "src/pay.ts", "missing.ts"], quiet: false }],
    reasons: ["r"],
    diagrams: [{ id: "flow", title: "t", short: "s", summary: "x", nodes: [
      { id: "a", label: "A", detail: null, kind: "actor", change: null, beforeLabel: null, beforeDetail: null, refs: [] },
      { id: "b", label: "B", detail: null, kind: "step", change: "changed", beforeLabel: "old", beforeDetail: null, refs: [{ path: "src/pay.ts", match: "const cents", end: null }] },
    ], edges: [{ from: "a", to: "b", label: null, change: "added" }, { from: "a", to: "zz", label: null, change: null }] }],
    checked: [],
  }, data, "Customers were charged dollars instead of cents.", ix, DEFAULT_SETTINGS, problems);
  assert.deepEqual(g.description.items.map((i) => i.rule), ["evidence", "diagram", "rollout", "dependencies"]);
  assert.equal(g.description.items[0].quote, "Customers were charged dollars");
  assert.equal(g.description.items[2].quote, undefined);
  assert.equal(g.description.items[2].status, "partly");
  assert.equal(g.description.items[1].status, "missing"); // diagram wasn't assessed
  assert.deepEqual(g.plan.chapters.map((c) => c.files), [["src/pay.ts"], ["src/pay.test.ts"]]);
  assert.equal(g.diagrams[0].edges.length, 1);
  assert.deepEqual(g.diagrams[0].nodes[1].before, { label: "old" });

  const file = assemble({ harnessLabel: "Diffline (claude)", head: data.head.sha, lede: "L", ran: ["guide", "correctness"], guide: g, reviewers: [reviewerFindings("correctness", {
    findings: [{ severity: "high", confidence: "High confidence", label: "blocking", path: "src/pay.ts", match: "return charge(cents);", title: "t", body: "b", steps: [], fix: "f", comment: "c" }],
    checked: [],
  }, ix, DEFAULT_SETTINGS, problems)], index: ix, settings: DEFAULT_SETTINGS });
  assert.match(file.findings[0].id, /^correctness-[0-9a-f]{8}$/);
  assert.deepEqual(file.diagrams![0].nodes[1].findings, [file.findings[0].id], "diagram steps pin the stable id");
  assert.equal(file.findings[0].fix?.text, "f");
  assert.equal((file.findings[0] as any).at, undefined);
});

/** One reviewer finding as an agent reports it. */
const raw = (title: string, match: string, over: Record<string, unknown> = {}) => ({
  severity: "high" as const, confidence: "High confidence" as const, label: "question" as const, path: "src/pay.ts", match, title, body: `body of ${title}`, steps: [], fix: null, comment: `comment on ${title}`, ...over,
});

function fileFrom(byAgent: Record<string, Array<ReturnType<typeof raw>>>, runs?: Parameters<typeof assemble>[0]["runs"]) {
  const ix = new AnchorIndex(data);
  const problems: Problems = { dropped: [], repaired: [] };
  const reviewers = Object.entries(byAgent).map(([agent, findings]) => reviewerFindings(agent, { findings, checked: [] } as any, ix, DEFAULT_SETTINGS, problems));
  return assemble({ harnessLabel: "Diffline (claude)", head: data.head.sha, lede: "", ran: Object.keys(byAgent), guide: null, reviewers, index: ix, settings: DEFAULT_SETTINGS, runs });
}

test("finding ids: the same agent on the same line keeps its id whatever the wording", () => {
  const first = fileFrom({ correctness: [raw("Cents are rounded", "charge(cents)")] });
  // A later run words it differently and quotes more of the line, with other spacing.
  const later = fileFrom({ correctness: [raw("Rounding loses a cent", "return   charge(cents);", { severity: "medium", confidence: "Worth asking" })] });
  assert.equal(first.findings[0].id, later.findings[0].id);
  assert.match(first.findings[0].id, /^correctness-[0-9a-f]{8}$/);
  // Another agent on that line, or the same agent on another line, gets another id.
  const other = fileFrom({ security: [raw("x", "return charge(cents);")], correctness: [raw("y", "const cents")] });
  assert.notEqual(other.findings.find((f) => f.agent === "security")!.id, first.findings[0].id);
  assert.notEqual(other.findings.find((f) => f.agent === "correctness")!.id, first.findings[0].id);
});

test("finding ids: whitespace doesn't matter, collisions get -2 and -3 in order, ids are safe in HTML", () => {
  assert.equal(findingId("tests", "a.ts", "  if (x  &&\ty) {"), findingId("tests", "a.ts", "if (x && y) {"));
  assert.notEqual(findingId("tests", "a.ts", "if (x && y) {"), findingId("tests", "b.ts", "if (x && y) {"));
  const ids = assignIds([
    { agent: "tests", path: "a.ts", line: "x" },
    { agent: "tests", path: "a.ts", line: " x " },
    { agent: "security", path: "a.ts", line: "x" },
    { agent: "tests", path: "a.ts", line: "x" },
  ]);
  assert.equal(ids[1], `${ids[0]}-2`);
  assert.equal(ids[3], `${ids[0]}-3`);
  assert.notEqual(ids[2].replace(/^security-/, ""), ids[0]);
  const file = fileFrom({ correctness: [raw("one", "return charge(cents);"), raw("two", "charge(cents)", { severity: "low" })] });
  assert.deepEqual(file.findings.map((f) => f.id), [file.findings[0].id, `${file.findings[0].id}-2`]);
  assert.equal(file.findings[1].title, "two", "the suffix follows the severity order");
  for (const f of file.findings) assert.match(f.id, /^[a-z][a-z0-9-]*$/);
});

test("agent file: each agent records the harness, model, thinking and instructions it ran with", () => {
  const harnesses: Harnesses = {
    default: "claude",
    claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] },
    codex: { id: "codex", command: "codex", model: "", extraArgs: [] },
    pi: { id: "pi", command: "pi", model: "", extraArgs: [], thinking: "low" },
  };
  const s = structuredClone(DEFAULT_SETTINGS);
  // Reported by the harness beats configured.
  assert.deepEqual(runConfig("correctness", s, harnesses, "claude-sonnet-9"), { harness: "claude", model: "claude-sonnet-9", instructions: instructionsHash(s.agents.correctness) });
  assert.equal(runConfig("correctness", s, harnesses, null).model, "sonnet");
  assert.equal(runConfig("correctness", s, { ...harnesses, claude: { ...harnesses.claude, model: "" } }, null).model, null);
  // Pi: the thinking level from the agent's model suffix, else diffline.pi.thinking; the model without the suffix.
  s.agents.security.harness = "pi";
  s.agents.security.model = "openai/gpt-x:high";
  assert.deepEqual(runConfig("security", s, harnesses, null), { harness: "pi", model: "openai/gpt-x", thinking: "high", instructions: instructionsHash(s.agents.security) });
  s.agents.security.model = "";
  assert.equal(runConfig("security", s, harnesses, "openai/gpt-y").thinking, "low");
  assert.equal(runConfig("security", s, { ...harnesses, pi: { ...harnesses.pi, thinking: "" } }, null).thinking, null);
  // The hash changes with the instructions or the focus, and is 12 hex.
  const h = instructionsHash(s.agents.tests);
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.notEqual(instructionsHash({ ...s.agents.tests, instructions: s.agents.tests.instructions + "\nAlso check fixtures." }), h);
  assert.notEqual(instructionsHash({ ...s.agents.tests, focus: "Something else" }), h);

  const file = fileFrom({ correctness: [raw("t", "const cents")] }, { correctness: runConfig("correctness", DEFAULT_SETTINGS, harnesses, null) });
  assert.deepEqual(
    { ...file.agents[0], focus: undefined },
    { id: "correctness", name: DEFAULT_SETTINGS.agents.correctness.name, short: file.agents[0].short, focus: undefined, harness: "claude", model: "sonnet", instructions: instructionsHash(DEFAULT_SETTINGS.agents.correctness) },
  );
  // Without run details (as in files from before), AgentInfo is as it was.
  assert.deepEqual(Object.keys(fileFrom({ correctness: [] }).agents[0]), ["id", "name", "short", "focus"]);
});

test("schemas are strict: every property required, no extras", () => {
  const walk = (s: any): void => {
    if (s && typeof s === "object") {
      if (s.type === "object") {
        assert.deepEqual(Object.keys(s.properties).sort(), [...s.required].sort());
        assert.equal(s.additionalProperties, false);
      }
      Object.values(s).forEach(walk);
    }
  };
  walk(reviewerSchema);
  walk(guideSchema);
});

test("agent selection honours enabled, skip and runs-when", () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.agents.security.runsWhen = ["src/auth/**"];
  s.agents.tests.skip = ["src/**"];
  const { run, skipped } = selectAgents(data, s, ["guide", "correctness", "tests", "security"]);
  assert.deepEqual(run, ["guide", "correctness"]);
  assert.deepEqual(skipped.map((x) => x.id).sort(), ["architecture", "security", "tests"]);
});

test("settings: defaults written on first run, edits and bad values fall back", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-settings-"));
  process.env.DIFFLINE_HOME = dir;
  const settings = await import("../src/agents/settings.ts");
  assert.equal(await settings.ensureSettings(), true);
  assert.equal(await settings.ensureSettings(), false);
  let text = await readFile(settings.settingsFile(), "utf8");
  text = text.replace(/max-findings: 3/, "max-findings: 1").replace(/min-confidence: minor/, "min-confidence: sometimes");
  await writeFile(settings.settingsFile(), text);
  await writeFile(settings.instructionsFile("tests"), "Only look at SQL.");
  const { settings: s, problems } = await settings.loadSettings();
  assert.equal(s.agents.architecture.maxFindings, 1);
  assert.equal(s.agents.correctness.minConfidence, "minor"); // invalid value fell back
  assert.equal(s.agents.tests.instructions, "Only look at SQL.");
  assert.deepEqual(problems, []);
  assert.ok(settings.matchesAny("docs/a/b.md", ["docs/**"]));
  assert.ok(settings.matchesAny("x.lock", ["**/*.lock"]));
  assert.ok(!settings.matchesAny("src/a.ts", ["src/*.js"]));
  delete process.env.DIFFLINE_HOME;
});

test("harnessFor: an agent's own harness, else the default; the lede follows the guide", async () => {
  const { harnessFor } = await import("../src/agents/review.ts");
  const { DEFAULT_SETTINGS } = await import("../src/agents/defaults.ts");
  const settings = structuredClone(DEFAULT_SETTINGS);
  const harnesses = {
    default: "claude" as const,
    claude: { id: "claude" as const, command: "claude", model: "sonnet", extraArgs: [] },
    codex: { id: "codex" as const, command: "codex", model: "", extraArgs: [] },
    pi: { id: "pi" as const, command: "pi", model: "", extraArgs: [], thinking: "" },
  };
  assert.equal(harnessFor("tests", settings, harnesses).id, "claude");
  settings.agents.guide.harness = "codex";
  assert.equal(harnessFor("guide", settings, harnesses).id, "codex");
  assert.equal(harnessFor("lede", settings, harnesses).id, "codex");
  assert.equal(harnessFor("security", settings, { ...harnesses, default: "codex" }).id, "codex");
  settings.agents.tests.harness = "pi";
  assert.equal(harnessFor("tests", settings, harnesses).id, "pi");
});

test("token usage: Claude counts cache reads and writes as input; Codex sums its turns", async () => {
  const { claudeUsage, codexUsage, formatTokens } = await import("../src/agents/harness.ts");
  const c = claudeUsage({ usage: { input_tokens: 2, cache_creation_input_tokens: 40_248, cache_read_input_tokens: 10_000, output_tokens: 6 }, modelUsage: { "claude-sonnet-5": {} } });
  assert.deepEqual(c, { tokens: { input: 50_250, cachedInput: 10_000, output: 6 }, model: "claude-sonnet-5" });
  assert.deepEqual(claudeUsage({}), { tokens: null, model: null });
  const jsonl = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.completed","item":{"type":"error","message":"a config warning"}}',
    '{"type":"turn.completed","usage":{"input_tokens":48813,"cached_input_tokens":24064,"output_tokens":105,"reasoning_output_tokens":0}}',
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":20}}',
    "not json",
  ].join("\n");
  assert.deepEqual(codexUsage(jsonl), { input: 49_813, cachedInput: 24_064, output: 125 });
  assert.equal(codexUsage(""), null);
  assert.equal(formatTokens({ input: 182_400, cachedInput: 120_000, output: 3400 }), "182k in (120k cached), 3.4k out");
});

test("settings: per-agent harness is read, validated, and written without losing comments", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const prev = process.env.DIFFLINE_HOME;
  process.env.DIFFLINE_HOME = await mkdtemp(path.join(os.tmpdir(), "diffline-settings-"));
  try {
    const { ensureSettings, loadSettings, setAgentHarness, setAgentModel, settingsFile } = await import("../src/agents/settings.ts");
    await ensureSettings();
    let { settings, problems } = await loadSettings();
    assert.equal(settings.agents.guide.harness, "");
    assert.deepEqual(problems, []);

    // An agent with a Claude model switching to Codex loses the model, since Codex wouldn't know it.
    const text = (await readFile(settingsFile(), "utf8")).replace(/(  correctness:[\s\S]*?model: )""/, '$1"sonnet"');
    await writeFile(settingsFile(), text, "utf8");
    assert.deepEqual(await setAgentHarness("correctness", "codex"), { clearedModel: "sonnet" });
    assert.deepEqual(await setAgentHarness("guide", "codex"), { clearedModel: null });
    const after = await readFile(settingsFile(), "utf8");
    assert.match(after, /# harness: claude, codex or pi runs this agent/, "comments are kept");
    ({ settings } = await loadSettings());
    assert.equal(settings.agents.guide.harness, "codex");
    assert.equal(settings.agents.correctness.harness, "codex");
    assert.equal(settings.agents.correctness.model, "");
    assert.equal(settings.agents.tests.harness, "");

    await writeFile(settingsFile(), after.replace(/(  tests:[\s\S]*?harness: )""/, '$1"gemini"').replace(/(  security:[\s\S]*?harness: )""/, '$1pi'), "utf8");
    ({ settings, problems } = await loadSettings());
    assert.equal(settings.agents.tests.harness, "");
    assert.match(problems.join(" "), /tests: unknown harness "gemini" ignored; use claude, codex or pi/);
    assert.equal(settings.agents.security.harness, "pi", "harness: pi is read");

    // A Pi agent's model takes Pi's syntax, a thinking suffix included, and is written without losing comments.
    await setAgentModel("security", "openai/gpt-6.1-sol:high");
    ({ settings } = await loadSettings());
    assert.equal(settings.agents.security.model, "openai/gpt-6.1-sol:high");
    assert.match(await readFile(settingsFile(), "utf8"), /# model: a model for this agent/);
  } finally {
    if (prev === undefined) delete process.env.DIFFLINE_HOME;
    else process.env.DIFFLINE_HOME = prev;
  }
});
