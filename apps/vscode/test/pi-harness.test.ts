import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  harnessVersion,
  piVersionArgs,
  HarnessError,
  listPiModels,
  parsePiModels,
  piArgs,
  piModelThinking,
  piReply,
  piUsage,
  relativePaths,
  runAgent,
  type AgentRun,
  type HarnessConfig,
} from "../src/agents/harness.ts";
import { reviewerPrompt } from "../src/agents/prompts.ts";
import { DEFAULT_SETTINGS } from "../src/agents/defaults.ts";
import { instructionsHash, runReview, type AgentRunRecord } from "../src/agents/review.ts";
import { Semaphore } from "../src/core/limit.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

/** The fake pi as an executable called "pi" in a folder of its own, a checkout, a run folder and a record file. */
async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "diffline-pi-test-")));
  const bin = path.join(root, "bin", "pi");
  await mkdir(path.dirname(bin));
  await copyFile(FIXTURE, bin);
  await chmod(bin, 0o755);
  const checkout = path.join(root, "checkout");
  const runDir = path.join(root, "run");
  await mkdir(checkout);
  await mkdir(runDir);
  return { root, bin, checkout, runDir, recordFile: path.join(root, "record.json") };
}

/** Run with these environment variables set, then put the old values back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const SECURITY_ARGS = ["--mode", "json", "--offline", "--no-session", "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

const pi = (command: string, over: Partial<HarnessConfig> = {}): HarnessConfig => ({ id: "pi", command, model: "", extraArgs: [], thinking: "", ...over });

test("piVersionArgs: --no-approve from Pi 0.79, --no-mcp from 1.0.4, nothing for older or unknown versions", () => {
  assert.deepEqual(piVersionArgs("0.73.1"), []);
  assert.deepEqual(piVersionArgs("0.79.0"), ["--no-approve"]);
  assert.deepEqual(piVersionArgs("1.0.3"), ["--no-approve"]);
  assert.deepEqual(piVersionArgs("1.0.4"), ["--no-approve", "--no-mcp"]);
  assert.deepEqual(piVersionArgs("pi 1.1.0"), ["--no-approve", "--no-mcp"]);
  assert.deepEqual(piVersionArgs(null), []);
  assert.deepEqual(piArgs(pi("pi"), undefined, "1.1.0"), [...SECURITY_ARGS, "--no-approve", "--no-mcp"]);
});

test("piArgs: read-only file tools, offline, no resources or session; agent model and thinking precedence", () => {
  assert.deepEqual(piArgs(pi("pi")), SECURITY_ARGS, "Pi's defaults: no --model or --thinking");
  assert.deepEqual(piArgs(pi("pi", { model: "anthropic/claude-sonnet-5-5", thinking: "high", extraArgs: ["--verbose"] })), [...SECURITY_ARGS, "--model", "anthropic/claude-sonnet-5-5", "--thinking", "high", "--verbose"]);
  // diffline.pi.thinking wins over a suffix in diffline.pi.model, as in Pi.
  assert.deepEqual(piArgs(pi("pi", { model: "openai/gpt-6.1-sol:low", thinking: "high" })).slice(-4), ["--model", "openai/gpt-6.1-sol:low", "--thinking", "high"]);
  // The agent's model wins, and a level in it wins over diffline.pi.thinking.
  assert.deepEqual(piArgs(pi("pi", { model: "anthropic/claude-sonnet-5-5", thinking: "high" }), "openai/gpt-6.1-sol:minimal").slice(SECURITY_ARGS.length), ["--model", "openai/gpt-6.1-sol:minimal"]);
  assert.deepEqual(piArgs(pi("pi", { thinking: "high" }), "openai/gpt-6.1-sol").slice(SECURITY_ARGS.length), ["--model", "openai/gpt-6.1-sol", "--thinking", "high"]);
  assert.ok(!piArgs(pi("pi")).some((a) => /bash|edit|write/.test(a)));
});

test("piModelThinking: only a known level counts as a suffix", () => {
  assert.equal(piModelThinking("openai/gpt-6.1-sol:high"), "high");
  assert.equal(piModelThinking("xhigh-model:xhigh"), "xhigh");
  assert.equal(piModelThinking("anthropic/claude-sonnet-5-5"), null);
  assert.equal(piModelThinking("bedrock/anthropic.claude-x-v1:0"), null);
  assert.equal(piModelThinking("openrouter/some-model:free"), null);
});

test("piUsage and piReply: usage summed over assistant messages, the last one is the answer", () => {
  const jsonl = [
    '{"type":"session","version":3,"id":"s"}',
    '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"read"}],"provider":"anthropic","model":"claude-opus-4-7","usage":{"input":10,"output":5,"cacheRead":100,"cacheWrite":50,"cost":{"total":0.25}},"stopReason":"toolUse"}}',
    '{"type":"message_update","message":{"role":"assistant","content":[]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"{\\"lede\\":\\"ok\\"}"}],"provider":"openai","model":"gpt-6.1-sol","usage":{"input":1,"output":2,"cacheRead":3,"cacheWrite":0,"cost":{"total":0.5}},"stopReason":"stop"}}',
    '{"type":"agent_end","messages":[]}',
    "not json",
  ].join("\n");
  assert.deepEqual(piUsage(jsonl), { tokens: { input: 164, cachedInput: 103, output: 7 }, costUsd: 0.75, model: "openai/gpt-6.1-sol" });
  assert.deepEqual(piReply(jsonl), { text: '{"lede":"ok"}', stopReason: "stop", errorMessage: "" });
  assert.deepEqual(piUsage(""), { tokens: null, costUsd: null, model: null });
  assert.equal(piReply('{"type":"agent_start"}'), null);
});

test("parsePiModels: the padded table, wherever it's printed; none signed in; not a list", () => {
  const table = [
    "Warning: errors loading models.json:",
    "provider   model                       context  max-out  thinking  images",
    "\x1b[0manthropic  claude-opus-4-7             200K     64K      yes       yes",
    "groq       llama-4-scout-small         128K     8K       no        no",
    "",
  ].join("\n");
  assert.deepEqual(parsePiModels(table), [
    { provider: "anthropic", id: "claude-opus-4-7", thinking: true },
    { provider: "groq", id: "llama-4-scout-small", thinking: false },
  ]);
  assert.deepEqual(parsePiModels("No models available. Use /login or set an API key environment variable.\n"), []);
  assert.equal(parsePiModels(""), null);
  assert.equal(parsePiModels("Error: something else"), null);
});

test("relativePaths: paths under the checkout and ./ paths become repository-relative", () => {
  const out = relativePaths(
    {
      findings: [{ path: "/repo/src/a.ts", match: "/repo/src/a.ts stays in text", steps: [{ path: "./src/b.ts" }, { path: null }] }],
      chapters: [{ files: ["/repo/x.md", "y.md", "/elsewhere/z.md"] }],
      checked: [{ path: "/private/repo/c.ts", text: "fine" }],
    },
    ["/repo", "/private/repo"],
  );
  assert.deepEqual(out, {
    findings: [{ path: "src/a.ts", match: "/repo/src/a.ts stays in text", steps: [{ path: "src/b.ts" }, { path: null }] }],
    chapters: [{ files: ["x.md", "y.md", "/elsewhere/z.md"] }],
    checked: [{ path: "c.ts", text: "fine" }],
  });
  assert.equal((relativePaths({ path: "/repository/a.ts" }, ["/repo"]) as { path: string }).path, "/repository/a.ts", "a sibling folder isn't under the checkout");
});

test("reviewer prompt for Pi names the checkout and asks for absolute paths", () => {
  const data = JSON.parse(JSON.stringify({ files: [], commits: [], head: { sha: "abc", short: "abc" }, mergeBase: "def" }));
  const ctx = { key: "acme/web#1", data, detail: null, settings: structuredClone(DEFAULT_SETTINGS), diffFile: null };
  const plain = reviewerPrompt("security", ctx);
  assert.match(plain, /Your working directory is the pull request's code/);
  const forPi = reviewerPrompt("security", { ...ctx, checkout: "/tmp/checkout" });
  assert.match(forPi, /is in \/tmp\/checkout\. Your working directory is an empty folder, so always give your file tools absolute paths under \/tmp\/checkout/);
  assert.match(forPi, /give paths relative to \/tmp\/checkout/);
  assert.match(forPi, /there's no shell/);
});

test("runPi end to end: security flags, an empty folder of its own, a filtered environment, parsed output and usage", async () => {
  const s = await setup();
  const workDir = path.join(s.runDir, "pi-security");
  const reply = "```json\n" + JSON.stringify({ findings: [{ path: `${s.checkout}/src/a.ts`, steps: [{ path: "./src/b.ts" }] }], checked: [] }) + "\n```";
  const res = await withEnv(
    { PI_FAKE_RECORD: s.recordFile, PI_FAKE_REPLY: reply, PI_FAKE_MODE: "ok", GH_TOKEN: "ghp_secret", GITHUB_TOKEN: "x", GH_API_KEY: "y", ANTHROPIC_API_KEY: "a", PI_TELEMETRY: "1", NPM_TOKEN: "n" },
    () =>
      runAgent(pi(s.bin, { model: "anthropic/claude-sonnet-5-5", thinking: "high" }), {
        prompt: "Review it.",
        schema: { type: "object" },
        cwd: s.checkout,
        readDirs: [s.runDir],
        model: "anthropic/claude-opus-4-7:low",
        workDir,
        timeoutMs: 20_000,
      }),
  );
  const rec = JSON.parse(await readFile(s.recordFile, "utf8"));
  assert.deepEqual(rec.args, [...SECURITY_ARGS, "--no-approve", "--no-mcp", "--model", "anthropic/claude-opus-4-7:low"], "Pi 1.1's own guards; the agent's :low wins, so no --thinking");
  assert.equal(rec.cwd, workDir, "Pi runs in its own folder, never the checkout");
  assert.deepEqual(rec.entries, [], "and the folder is empty");
  assert.ok(!existsSync(workDir), "the folder is removed afterwards");
  assert.equal(rec.env.PI_OFFLINE, "1");
  assert.equal(rec.env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(rec.env.PI_TELEMETRY, "0");
  assert.equal(rec.env.ANTHROPIC_API_KEY, "a");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_API_KEY", "NPM_TOKEN"]) assert.equal(rec.env[k], undefined, `${k} isn't passed`);
  assert.match(rec.stdin, /^Review it\.\n\nReply with only a JSON object matching this JSON Schema:\n\n\{"type":"object"\}/, "the schema is in the prompt on stdin");
  assert.deepEqual(res.output, { findings: [{ path: "src/a.ts", steps: [{ path: "src/b.ts" }] }], checked: [] });
  assert.deepEqual(res.tokens, { input: 45_520, cachedInput: 40_000, output: 850 });
  assert.ok(Math.abs((res.costUsd ?? 0) - 0.11) < 1e-9);
  assert.equal(res.model, "anthropic/claude-opus-4-7");
});

test("runPi failures: stopReason error, cut-off replies, exits, sign-in, unknown models, timeouts, a missing CLI", async () => {
  const s = await setup();
  const r: AgentRun = { prompt: "p", schema: {}, cwd: s.checkout, readDirs: [s.runDir], timeoutMs: 20_000 };
  const fails = (mode: string, over: Partial<AgentRun> = {}, h = pi(s.bin)) =>
    withEnv({ PI_FAKE_MODE: mode, PI_FAKE_REPLY: '{"lede":"a long enough answer"}', PI_FAKE_RECORD: undefined }, () => runAgent(h, { ...r, ...over })).then(
      () => assert.fail(`${mode} should fail`),
      (err) => {
        assert.ok(err instanceof HarnessError, String(err));
        return err as HarnessError;
      },
    );
  let err = await fails("provider-error");
  assert.equal(err.kind, "failed");
  assert.match(err.message, /^Pi: 429 rate_limit_error/);
  assert.equal((await fails("auth-error")).kind, "auth");
  err = await fails("length");
  assert.equal(err.kind, "badOutput");
  assert.match(err.message, /cut off/);
  assert.equal((await fails("silent")).kind, "badOutput");
  err = await fails("no-key");
  assert.equal(err.kind, "auth");
  assert.match(err.message, /\/login/);
  err = await fails("unknown-model");
  assert.equal(err.kind, "failed");
  assert.match(err.message, /Model "nope" not found.*diffline\.pi\.model/);
  err = await fails("crash");
  assert.equal(err.kind, "failed");
  assert.match(err.message, /Pi exited with code 2/);
  assert.equal((await fails("hang", { timeoutMs: 300 })).kind, "timeout");
  err = await fails("ok", {}, pi(s.bin, { thinking: "ultra" }));
  assert.match(err.message, /diffline\.pi\.thinking is "ultra"/);
  err = await fails("ok", {}, pi(path.join(s.root, "nowhere", "pi")));
  assert.equal(err.kind, "missing");
  assert.match(err.message, /Pi coding agent wasn't found/);
});

test("listPiModels and harnessVersion read Pi's stderr; the list runs in an empty folder with the same environment rules", async () => {
  const s = await setup();
  assert.equal(await harnessVersion(pi(s.bin)), "1.1.0");
  const models = await withEnv({ PI_FAKE_RECORD: s.recordFile, PI_FAKE_MODE: "ok", GH_TOKEN: "ghp_secret" }, () => listPiModels(pi(s.bin)));
  assert.deepEqual(models?.map((m) => `${m.provider}/${m.id}:${m.thinking}`), ["anthropic/claude-opus-4-7:true", "openai/gpt-6.1-sol:true", "groq/llama-4-scout-small:false"]);
  const rec = JSON.parse(await readFile(s.recordFile, "utf8"));
  assert.deepEqual(rec.args, ["--list-models", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]);
  assert.deepEqual(rec.entries, []);
  assert.equal(rec.env.GH_TOKEN, undefined);
  assert.deepEqual(await withEnv({ PI_FAKE_MODE: "no-models", PI_FAKE_RECORD: undefined }, () => listPiModels(pi(s.bin))), []);
  assert.equal(await listPiModels(pi(path.join(s.root, "nowhere", "pi"))), null);
});

test("runReview: each agent's harness, model, thinking, time, tokens, cost and findings go to the run's records", async () => {
  const s = await setup();
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (const a of Object.values(settings.agents)) a.enabled = false;
  settings.agents.correctness = { ...settings.agents.correctness, enabled: true, harness: "pi", model: "anthropic/claude-sonnet-5-5:high" };
  settings.agents.security = { ...settings.agents.security, enabled: true, harness: "codex" };
  const line = (t: " " | "+", text: string, n: number) => [t, t === "+" ? null : n, n, text, 0, 0] as any;
  const data = {
    version: 1, generatedAt: "", repo: "acme/web", base: { ref: "main", sha: "b".repeat(40), short: "b" }, head: { ref: "f", sha: "c".repeat(40), short: "c" },
    mergeBase: "b".repeat(40), since: null, commits: [], workspace: {},
    files: [{ path: "src/pay.ts", oldPath: null, status: "modified", similarity: null, binary: false, lang: "ts", generated: false, additions: 1, deletions: 0, tests: null,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, section: "", fresh: false, lines: [line(" ", "export function pay() {", 1), line("+", "  return charge(cents);", 2)] }] }],
  } as any;
  const reply = JSON.stringify({
    findings: [{ severity: "high", confidence: "High confidence", label: "question", path: "src/pay.ts", match: "return charge(cents);", title: "t", body: "b", steps: [], fix: null, comment: "c" }],
    checked: [],
  });
  const agentRuns: AgentRunRecord[] = [];
  const result = await withEnv({ PI_FAKE_MODE: "ok", PI_FAKE_REPLY: reply, PI_FAKE_RECORD: undefined }, () =>
    runReview({
      key: "acme/web#1", repoPath: s.checkout, data, detail: null, settings, enabled: [], runDir: s.runDir, timeoutMs: 20_000, limiter: new Semaphore(2), agentRuns,
      harnesses: { default: "pi", pi: pi(s.bin, { thinking: "low" }), claude: { id: "claude", command: "claude", model: "", extraArgs: [] }, codex: { id: "codex", command: path.join(s.root, "nowhere", "codex"), model: "", extraArgs: [] } },
    }),
  );
  const byId = Object.fromEntries(agentRuns.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ["correctness", "lede", "security"]);
  const c = byId.correctness;
  assert.equal(c.harness, "pi");
  assert.equal(c.model, "anthropic/claude-opus-4-7", "the model Pi reported");
  assert.equal(c.thinking, "high", "the agent's model suffix wins over diffline.pi.thinking");
  assert.equal(c.instructions, instructionsHash(settings.agents.correctness));
  assert.equal(c.findings, 1);
  assert.ok(c.tokens && c.tokens.output > 0);
  assert.ok(c.costUsd! > 0);
  assert.equal(c.failed, undefined);
  assert.equal(byId.security.harness, "codex");
  assert.equal(byId.security.failed, "missing");
  assert.equal(byId.security.findings, 0);
  assert.equal(byId.lede.instructions, null);
  // The agent file says what each agent ran with.
  assert.deepEqual(result.file.agents.map((a) => [a.id, a.harness, a.model, a.thinking, a.instructions]), [["correctness", "pi", "anthropic/claude-opus-4-7", "high", instructionsHash(settings.agents.correctness)]]);
});
