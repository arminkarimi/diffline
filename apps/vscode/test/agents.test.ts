import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { DEFAULT_SETTINGS } from "../src/agents/defaults.ts";
import { reviewerSchema, guideSchema } from "../src/agents/schema.ts";
import { selectAgents } from "../src/agents/review.ts";
import { AnchorIndex, assemble, guideParts, reviewerFindings, type Problems } from "../src/agents/validate.ts";
import { computeRisk } from "../src/core/risk.ts";
import type { DiffLine, ReviewData, RiskInput } from "../src/core/types.ts";

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
  assert.equal(file.findings[0].id, "f1");
  assert.deepEqual(file.diagrams![0].nodes[1].findings, ["f1"]);
  assert.equal(file.findings[0].fix?.text, "f");
  assert.equal((file.findings[0] as any).at, undefined);
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

test("risk matches the page's computeRisk exactly", async () => {
  const src = await readFile(new URL("../../../packages/review-ui/app.js", import.meta.url), "utf8");
  const start = src.indexOf("// Path words that mark code");
  const end = src.indexOf("function currentCheckCounts");
  const sandbox: any = { plural: (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : many || one + "s"}` };
  vm.runInNewContext(`${src.slice(start, end)}; this.pageRisk = computeRisk;`, sandbox);
  const inputs: RiskInput[] = [
    { files: [{ path: "src/auth/session.ts", additions: 120, deletions: 30 }, { path: "src/payments/charge.ts", additions: 40, deletions: 2, tests: { path: "src/payments/charge.test.ts", changed: false } }], findings: [{ severity: "high", state: "open" }, { severity: "low", state: "dismissed" }], checks: { total: 3, failed: 1, running: 0 } },
    { files: [{ path: "README.md", additions: 3, deletions: 1 }], findings: [], checks: { total: 0, failed: 0, running: 0 } },
    { files: Array.from({ length: 25 }, (_, i) => ({ path: `src/api/routes/r${i}.ts`, additions: 50, deletions: 10 })).concat([{ path: "package-lock.json", additions: 900, deletions: 800, generated: true } as any]), findings: [{ severity: "medium", state: "accepted" }], checks: { total: 4, failed: 0, running: 2 } },
  ];
  for (const input of inputs) assert.deepEqual(JSON.parse(JSON.stringify(computeRisk(input))), JSON.parse(JSON.stringify(sandbox.pageRisk(input))));
});

test("harnessFor: an agent's own harness, else the default; the lede follows the guide", async () => {
  const { harnessFor } = await import("../src/agents/review.ts");
  const { DEFAULT_SETTINGS } = await import("../src/agents/defaults.ts");
  const settings = structuredClone(DEFAULT_SETTINGS);
  const harnesses = {
    default: "claude" as const,
    claude: { id: "claude" as const, command: "claude", model: "sonnet", extraArgs: [] },
    codex: { id: "codex" as const, command: "codex", model: "", extraArgs: [] },
  };
  assert.equal(harnessFor("tests", settings, harnesses).id, "claude");
  settings.agents.guide.harness = "codex";
  assert.equal(harnessFor("guide", settings, harnesses).id, "codex");
  assert.equal(harnessFor("lede", settings, harnesses).id, "codex");
  assert.equal(harnessFor("security", settings, { ...harnesses, default: "codex" }).id, "codex");
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
    const { ensureSettings, loadSettings, setAgentHarness, settingsFile } = await import("../src/agents/settings.ts");
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
    assert.match(after, /# harness: claude or codex runs this agent/, "comments are kept");
    ({ settings } = await loadSettings());
    assert.equal(settings.agents.guide.harness, "codex");
    assert.equal(settings.agents.correctness.harness, "codex");
    assert.equal(settings.agents.correctness.model, "");
    assert.equal(settings.agents.tests.harness, "");

    await writeFile(settingsFile(), after.replace(/(  tests:[\s\S]*?harness: )""/, '$1"pi"'), "utf8");
    ({ settings, problems } = await loadSettings());
    assert.equal(settings.agents.tests.harness, "");
    assert.match(problems.join(" "), /tests: unknown harness "pi"/);
  } finally {
    if (prev === undefined) delete process.env.DIFFLINE_HOME;
    else process.env.DIFFLINE_HOME = prev;
  }
});
