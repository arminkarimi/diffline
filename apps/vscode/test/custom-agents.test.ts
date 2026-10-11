import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUILT_IN, DEFAULT_INSTRUCTIONS, LEGACY_HEADINGS, NEW_AGENT_INSTRUCTIONS } from "../src/agents/defaults.ts";

/** Run with a fresh ~/.diffline. */
async function withHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const prev = process.env.DIFFLINE_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-agents-"));
  process.env.DIFFLINE_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DIFFLINE_HOME;
    else process.env.DIFFLINE_HOME = prev;
  }
}

const settings = () => import("../src/agents/settings.ts");

test("a new agent: added to agents.yml, waits for instructions, then runs as a reviewer with its own name and focus", async () => {
  await withHome(async () => {
    const s = await settings();
    await s.ensureSettings();
    const id = s.agentIdFor("Performance agent", BUILT_IN);
    assert.equal(id, "performance");
    const file = await s.addAgent(id, "Performance agent", "Slow queries and needless work in loops");
    assert.equal(await readFile(file, "utf8"), NEW_AGENT_INSTRUCTIONS);
    await assert.rejects(s.addAgent(id, "Again", "x"), /already an agent/);

    let { settings: cfg, problems } = await s.loadSettings();
    assert.deepEqual(Object.keys(cfg.agents), [...BUILT_IN, "performance"], "added at the end, guide first");
    assert.equal(cfg.agents.performance.enabled, false, "the template alone isn't instructions");
    assert.match(problems.join(" "), /performance: agents\/performance\.md has no instructions yet/);

    await writeFile(file, NEW_AGENT_INSTRUCTIONS.replace("## Look for\n", "## Look for\n\nN+1 queries in request handlers.\n"), "utf8");
    ({ settings: cfg, problems } = await s.loadSettings());
    assert.deepEqual(problems, []);
    const perf = cfg.agents.performance;
    assert.equal(perf.enabled, true);
    assert.equal(perf.name, "Performance agent");
    assert.equal(perf.focus, "Slow queries and needless work in loops");
    assert.ok(!perf.instructions.includes("<!--"), "comments are left out");
    assert.match(perf.instructions, /N\+1 queries/);

    const { reviewerPrompt } = await import("../src/agents/prompts.ts");
    const data = { repo: "r", base: { ref: "main", sha: "a", short: "a" }, head: { ref: "x", sha: "b", short: "b" }, files: [], commits: [] } as any;
    const prompt = reviewerPrompt("performance", { key: "o/r#1", data, detail: null, settings: cfg, diffFile: null });
    assert.match(prompt, /^You are the Performance agent in Diffline/);
    assert.match(prompt, /Your focus: Slow queries and needless work in loops\./);
    assert.match(prompt, /N\+1 queries in request handlers/);

    const { selectAgents } = await import("../src/agents/review.ts");
    const diff = { ...data, files: [{ path: "src/a.ts", hunks: [] }] };
    assert.ok(selectAgents(diff, cfg, []).run.includes("performance"), "an empty enabled setting allows every agent");
    const only = selectAgents(diff, cfg, ["guide", "performance"]);
    assert.deepEqual(only.run, ["guide", "performance"]);
    assert.ok(only.skipped.some((x) => x.id === "security" && /diffline\.agents\.enabled/.test(x.why)));

    await s.removeAgent("performance");
    ({ settings: cfg } = await s.loadSettings());
    assert.ok(!("performance" in cfg.agents));
    assert.equal(await readFile(file, "utf8").then(() => true), true, "its instruction file stays");
    await assert.rejects(s.removeAgent("guide"), /can't be removed/);
  });
});

test("agents.yml decides which agents exist; bad ids are reported; the guide always comes first", async () => {
  await withHome(async (dir) => {
    const s = await settings();
    await mkdir(path.join(dir, "agents"), { recursive: true });
    await writeFile(path.join(dir, "agents", "docs.md"), "## Look for\n\nREADME drift.\n", "utf8");
    await writeFile(
      s.settingsFile(),
      ["agents:", "  security:", "    max-findings: 2", "  docs:", "    focus: Docs that the change makes wrong", "  Bad_Id:", "    enabled: true", "  lede:", "    enabled: true", "  ghost:", "    enabled: true"].join("\n"),
      "utf8",
    );
    const { settings: cfg, problems } = await s.loadSettings();
    assert.deepEqual(Object.keys(cfg.agents), ["guide", "security", "docs", "ghost"]);
    assert.equal(cfg.agents.security.maxFindings, 2);
    assert.equal(cfg.agents.security.name, "Security agent", "a built-in agent keeps its defaults for what's left out");
    assert.equal(cfg.agents.docs.name, "Docs agent", "a name is made from the id when there's none");
    assert.equal(cfg.agents.docs.enabled, true);
    assert.equal(cfg.agents.ghost.enabled, false);
    const text = problems.join("\n");
    assert.match(text, /Agent "Bad_Id" skipped/);
    assert.match(text, /Agent "lede" skipped.*taken/);
    assert.match(text, /ghost: .*ghost\.md is missing/);
  });
});

test("older settings files are brought up to date; edited instructions are left alone", async () => {
  await withHome(async (dir) => {
    const s = await settings();
    await mkdir(path.join(dir, "agents"), { recursive: true });
    for (const id of BUILT_IN) await writeFile(path.join(dir, "agents", `${id}.md`), LEGACY_HEADINGS[id] + DEFAULT_INSTRUCTIONS[id], "utf8");
    const edited = `${LEGACY_HEADINGS.security}${DEFAULT_INSTRUCTIONS.security}\nAlso check webhooks.\n`;
    await writeFile(path.join(dir, "agents", "security.md"), edited, "utf8");
    const old = [
      "# enabled: run this agent. max-findings: at most this many findings.",
      "agents:",
      "  guide:",
      "    enabled: true",
      "    harness: codex",
      "  security:",
      "    enabled: true",
      "    max-findings: 5",
      "",
    ].join("\n");
    await writeFile(s.settingsFile(), old, "utf8");

    assert.equal(await s.ensureSettings(), false, "updating an existing setup isn't a first run");
    assert.equal(await readFile(path.join(dir, "agents", "guide.md"), "utf8"), DEFAULT_INSTRUCTIONS.guide);
    assert.equal(await readFile(path.join(dir, "agents", "security.md"), "utf8"), edited);
    const yml = await readFile(s.settingsFile(), "utf8");
    assert.match(yml, /# name: what the review page calls it/);
    assert.match(yml, /  guide:\n    name: Guide agent\n    focus: Checks the description/, "name and focus go first");
    assert.match(yml, /harness: codex/, "other values stay");
    const { settings: cfg } = await s.loadSettings();
    assert.deepEqual(Object.keys(cfg.agents), ["guide", "security"], "agents left out of an existing file stay out");
    assert.equal(cfg.agents.guide.harness, "codex");

    await s.ensureSettings();
    assert.equal(await readFile(s.settingsFile(), "utf8"), yml, "running it again changes nothing");
  });
});

test("agentIdFor: readable, unique, valid", async () => {
  const { agentIdFor } = await settings();
  assert.equal(agentIdFor("Accessibility", []), "accessibility");
  assert.equal(agentIdFor("API contracts agent", []), "api-contracts");
  assert.equal(agentIdFor("Security", ["security"]), "security-2");
  assert.equal(agentIdFor("42 checks", []), "agent-42-checks");
  assert.equal(agentIdFor("Lede", []), "lede-2");
});
