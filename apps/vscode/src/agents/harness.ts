// Runs one agent prompt through a local agent harness (Claude Code CLI, Codex CLI or Pi) and returns its JSON output.
// Agents are read-only: they may read and search files, nothing else.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { agentEnv, piEnv, run } from "../core/exec.ts";

export type HarnessId = "claude" | "codex" | "pi";
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "codex", "pi"];
export const isHarnessId = (v: unknown): v is HarnessId => typeof v === "string" && (HARNESS_IDS as readonly string[]).includes(v);

export interface HarnessConfig {
  id: HarnessId;
  /** Path to the CLI. */
  command: string;
  /** Default model; empty uses the CLI's default. */
  model: string;
  extraArgs: string[];
  /** Pi only: the thinking level (off … xhigh); empty uses Pi's default. */
  thinking?: string;
}

export interface AgentRun {
  prompt: string;
  schema: object;
  /** The repository clone; agents run git commands here. */
  cwd: string;
  /** Extra directories the agent may read (the run's input files). */
  readDirs: string[];
  /** Overrides the harness model for this agent. */
  model?: string;
  /**
   * An empty folder of this agent's own, under the run folder. Pi works there instead of in the checkout, since it
   * reads settings from its working folder; it's made before the run and removed after. The other harnesses ignore it.
   */
  workDir?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

/** Tokens one agent call used. `input` counts every input token, including the ones read from the prompt cache. */
export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
}

export interface AgentResult {
  output: unknown;
  /** Claude Code and Pi report a cost; Codex doesn't. */
  costUsd: number | null;
  tokens: TokenUsage | null;
  /** The model that answered, when the harness says. */
  model: string | null;
  /** Claude Code only: other models the run called for side work, such as a small model's quick calls. */
  otherModels?: string[];
  durationMs: number;
}

export const addTokens = (a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null =>
  !a ? b : !b ? a : { input: a.input + b.input, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output };

/** "182k in (120k cached), 3.4k out" */
export function formatTokens(t: TokenUsage): string {
  const n = (x: number) => (x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 1000 ? `${(x / 1000).toFixed(x >= 100_000 ? 0 : 1)}k` : String(x));
  return `${n(t.input)} in${t.cachedInput ? ` (${n(t.cachedInput)} cached)` : ""}, ${n(t.output)} out`;
}

/**
 * Token usage from Claude Code's JSON result. Its input_tokens leaves out cache reads and writes. Its modelUsage lists
 * every model the run called, side calls to a small model included, so the model is the one with the most output
 * tokens (then cost); the rest are `otherModels`, in the same order.
 */
export function claudeUsage(parsed: any): { tokens: TokenUsage | null; model: string | null; otherModels: string[] } {
  const u = parsed?.usage;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const tokens = u
    ? {
        input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
        cachedInput: num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
      }
    : null;
  const byModel = parsed?.modelUsage && typeof parsed.modelUsage === "object" ? Object.entries<any>(parsed.modelUsage) : [];
  // Array.sort is stable, so models that tie keep Claude Code's order.
  const models = byModel.sort(([, a], [, b]) => num(b?.outputTokens) - num(a?.outputTokens) || num(b?.costUSD) - num(a?.costUSD)).map(([m]) => m);
  return { tokens, model: models[0] || null, otherModels: models.slice(1) };
}

/** Token usage from Codex's JSONL events (codex exec --json): the sum of every turn.completed. */
export function codexUsage(jsonl: string): TokenUsage | null {
  let total: TokenUsage | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.includes("turn.completed")) continue;
    try {
      const e = JSON.parse(line);
      const u = e?.usage;
      if (e?.type !== "turn.completed" || !u) continue;
      total = addTokens(total, { input: u.input_tokens || 0, cachedInput: u.cached_input_tokens || 0, output: u.output_tokens || 0 });
    } catch {
      /* not an event line */
    }
  }
  return total;
}

/** The assistant messages in Pi's JSONL events (pi --mode json), in order. */
function piAssistantMessages(jsonl: string): any[] {
  const out: any[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"message_end"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "message_end" && e.message?.role === "assistant") out.push(e.message);
    } catch {
      /* not an event line */
    }
  }
  return out;
}

/**
 * Token usage and cost from Pi's JSONL events: the sum of every assistant message. Pi's input leaves out cache reads
 * and writes. The model is the one that answered last, as provider/id, so it's known even when Pi chose its default.
 */
export function piUsage(jsonl: string): { tokens: TokenUsage | null; costUsd: number | null; model: string | null } {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  let tokens: TokenUsage | null = null;
  let costUsd: number | null = null;
  let model: string | null = null;
  for (const m of piAssistantMessages(jsonl)) {
    const u = m.usage;
    if (u && typeof u === "object") {
      tokens = addTokens(tokens, { input: num(u.input) + num(u.cacheRead) + num(u.cacheWrite), cachedInput: num(u.cacheRead), output: num(u.output) });
      if (typeof u.cost?.total === "number") costUsd = (costUsd ?? 0) + u.cost.total;
    }
    if (typeof m.model === "string" && m.model) model = typeof m.provider === "string" && m.provider ? `${m.provider}/${m.model}` : m.model;
  }
  return { tokens, costUsd, model };
}

/** Pi's last assistant message: its text and why it stopped (stop, length, toolUse, error or aborted). Null when there's none. */
export function piReply(jsonl: string): { text: string; stopReason: string; errorMessage: string } | null {
  const last = piAssistantMessages(jsonl).at(-1);
  if (!last) return null;
  const text = Array.isArray(last.content)
    ? last.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n")
    : typeof last.content === "string"
      ? last.content
      : "";
  return { text, stopReason: String(last.stopReason || ""), errorMessage: String(last.errorMessage || "") };
}

export class HarnessError extends Error {
  readonly kind: "missing" | "auth" | "timeout" | "cancelled" | "failed" | "badOutput";
  readonly detail: string;
  constructor(kind: HarnessError["kind"], message: string, detail = "") {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Claude agents read pull request content, which can try to steer them, so they get file tools only (no shell: even
 * "read-only" git commands take options that write files or run programs) and may read only their working folder (a
 * checkout of the pull request) and the run folder. Listing Read for those folders alone, and Grep and Glob not at
 * all, keeps all three inside them in dontAsk mode; anything else is refused. The user's settings still apply (model,
 * sign-in), but not the repository's own settings or hooks, and no hooks at all.
 */
export function claudeAccessArgs(cwd: string, readDirs: string[]): string[] {
  const read = [cwd, ...readDirs].map((d) => `Read(/${path.resolve(d)}/**)`);
  return [
    "--setting-sources",
    "user",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--tools",
    "Read",
    "Grep",
    "Glob",
    "--allowedTools",
    ...read,
    ...readDirs.flatMap((d) => ["--add-dir", d]),
  ];
}

/**
 * Codex features a read-only review has no use for. Each one adds tools and context to every call, and some reach
 * outside the repository (connectors, plugins, browsers, the user's MCP servers and hooks).
 */
const CODEX_OFF = [
  "apps",
  "plugins",
  "remote_plugin",
  "skill_search",
  "skill_mcp_dependency_install",
  "hooks",
  "memories",
  "multi_agent",
  "goals",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
];

/** Pi's thinking levels, lowest first. */
export const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiThinking = (typeof PI_THINKING)[number];
export const isPiThinking = (v: unknown): v is PiThinking => typeof v === "string" && (PI_THINKING as readonly string[]).includes(v);

/** The level in a Pi model's ":<thinking>" suffix ("openai/gpt-6.1-sol:high" → "high"), or null when it has none. */
export function piModelThinking(model: string): PiThinking | null {
  const m = /:([a-z]+)$/.exec(model.trim());
  return m && isPiThinking(m[1]) ? m[1] : null;
}

/** Pi resources a review has no use for: each can add tools, prompts or startup work. */
const PI_NO_RESOURCES = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

/**
 * Newer Pi's own guards, for the versions that have them: --no-approve (0.79) ignores a folder's project files, and
 * --no-mcp (1.0.4) connects no MCP servers. Pi already runs in an empty folder without extensions, so these back that up.
 */
export function piVersionArgs(version: string | null): string[] {
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!v) return [];
  const n = Number(v[1]) * 1e6 + Number(v[2]) * 1e3 + Number(v[3]);
  return [...(n >= 79_000 ? ["--no-approve"] : []), ...(n >= 1_000_004 ? ["--no-mcp"] : [])];
}

/** Pi's version per command, asked once; a failed check is asked again next time. */
const piVersions = new Map<string, Promise<string | null>>();
function piVersion(h: HarnessConfig): Promise<string | null> {
  let v = piVersions.get(h.command);
  if (!v) {
    v = harnessVersion(h).then((found) => {
      if (!found) piVersions.delete(h.command);
      return found;
    });
    piVersions.set(h.command, v);
  }
  return v;
}

/**
 * Pi's arguments: events on stdout, no session file, and file tools only. Pi's read, grep, find and ls can't write or
 * run a program, but like Codex's read-only sandbox they aren't limited to a folder. No extensions, skills, prompt
 * templates, themes or context files (AGENTS.md), and offline, so nothing is installed, downloaded or checked at
 * startup. The agent's own model wins over diffline.pi.model; diffline.pi.thinking applies unless the agent's model
 * names its own level, and otherwise wins over a level in diffline.pi.model, as it does in Pi.
 */
export function piArgs(h: HarnessConfig, agentModel?: string, version: string | null = null): string[] {
  const model = agentModel || h.model;
  const thinking = h.thinking && !(agentModel && piModelThinking(agentModel)) ? h.thinking : "";
  return [
    "--mode",
    "json",
    "--offline",
    "--no-session",
    "--tools",
    "read,grep,find,ls",
    ...PI_NO_RESOURCES,
    ...piVersionArgs(version),
    ...(model ? ["--model", model] : []),
    ...(thinking ? ["--thinking", thinking] : []),
    ...h.extraArgs,
  ];
}

/**
 * Pi works outside the checkout, so the paths in its answer may be absolute. Make the ones under the checkout, and
 * ones starting with ./, relative to it, so they match the diff's paths.
 */
export function relativePaths(value: unknown, roots: string[]): unknown {
  const fix = (p: string) => {
    for (const root of roots) {
      if (p.startsWith(root) && (p[root.length] === "/" || p[root.length] === "\\")) return p.slice(root.length + 1).replace(/\\/g, "/");
    }
    return p.replace(/^(?:\.\/)+/, "");
  };
  if (Array.isArray(value)) return value.map((v) => relativePaths(v, roots));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === "path" && typeof v === "string" ? fix(v) : k === "files" && Array.isArray(v) ? v.map((f) => (typeof f === "string" ? fix(f) : f)) : relativePaths(v, roots),
    ]),
  );
}

const tail = (s: string, n = 800) => (s.length > n ? "…" + s.slice(-n) : s);

function classify(stderr: string, code: number, label: string): HarnessError {
  const text = stderr.toLowerCase();
  if (/not (logged|signed) in|login|unauthorized|authentication|api key|401/.test(text)) {
    return new HarnessError("auth", `${label} isn't signed in. Sign in with the CLI in a terminal, then run the agents again.`, tail(stderr));
  }
  return new HarnessError("failed", `${label} exited with code ${code}.`, tail(stderr));
}

async function runClaude(h: HarnessConfig, r: AgentRun): Promise<AgentResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(r.schema),
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    // Reviews need no MCP servers, plugins' skills or editing tools; leaving them out halves each call's context.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    ...claudeAccessArgs(r.cwd, r.readDirs),
    ...(r.model || h.model ? ["--model", r.model || h.model] : []),
    ...h.extraArgs,
  ];
  const started = Date.now();
  const res = await run(h.command, args, { cwd: r.cwd, env: agentEnv(), input: r.prompt, timeoutMs: r.timeoutMs, signal: r.signal, onStderr: (c) => r.onLog?.(c.trimEnd()) });
  if (res.killed) throw r.signal?.aborted ? new HarnessError("cancelled", "Stopped.") : new HarnessError("timeout", "The agent took too long and was stopped.");
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    if (res.code !== 0) throw classify(res.stderr || res.stdout, res.code, "Claude Code");
    throw new HarnessError("badOutput", "Claude Code returned something that isn't JSON.", tail(res.stdout));
  }
  if (parsed.is_error || parsed.subtype !== "success") {
    const msg = String(parsed.result || parsed.subtype || "error");
    if (/login|auth|api key|credit|billing/i.test(msg)) throw new HarnessError("auth", `Claude Code: ${msg}`);
    throw new HarnessError("failed", `Claude Code: ${msg.slice(0, 300)}`, tail(res.stderr));
  }
  const output = parsed.structured_output ?? tryJson(parsed.result);
  if (output === undefined) throw new HarnessError("badOutput", "Claude Code didn't return structured output.", tail(String(parsed.result)));
  const { tokens, model, otherModels } = claudeUsage(parsed);
  return {
    output,
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    tokens,
    model,
    ...(otherModels.length ? { otherModels } : {}),
    durationMs: Date.now() - started,
  };
}

async function runCodex(h: HarnessConfig, r: AgentRun): Promise<AgentResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-codex-"));
  const schemaFile = path.join(dir, "schema.json");
  const outFile = path.join(dir, "out.json");
  await writeFile(schemaFile, JSON.stringify(r.schema), "utf8");
  const args = [
    "exec",
    // Events on stdout, for token counts; the answer goes to --output-last-message.
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    // Leave out ~/.codex/config.toml (its MCP servers, plugins, hooks, notify command and project settings) and the
    // features above. Sign-in lives in auth.json, so it still works; model and effort come from Diffline's settings.
    "--ignore-user-config",
    ...CODEX_OFF.flatMap((f) => ["-c", `features.${f}=false`]),
    "--sandbox",
    "read-only",
    "--cd",
    r.cwd,
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outFile,
    ...(r.model || h.model ? ["--model", r.model || h.model] : []),
    ...h.extraArgs,
    "-",
  ];
  const started = Date.now();
  try {
    const res = await run(h.command, args, { cwd: r.cwd, env: agentEnv(), input: r.prompt, timeoutMs: r.timeoutMs, signal: r.signal, onStderr: (c) => r.onLog?.(c.trimEnd()) });
    if (res.killed) throw r.signal?.aborted ? new HarnessError("cancelled", "Stopped.") : new HarnessError("timeout", "The agent took too long and was stopped.");
    if (res.code !== 0) throw classify([res.stderr, codexErrors(res.stdout)].filter(Boolean).join("\n") || res.stdout, res.code, "Codex");
    const text = await readFile(outFile, "utf8").catch(() => "");
    const output = tryJson(text);
    if (output === undefined) throw new HarnessError("badOutput", "Codex didn't return JSON.", tail(text || res.stdout));
    return { output, costUsd: null, tokens: codexUsage(res.stdout), model: r.model || h.model || null, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pi prints "Error: …" and exits 1 when it can't start: no provider signed in, or a model it doesn't know. */
function piError(text: string, code: number): HarnessError {
  if (/no models available|no api key found/i.test(text)) {
    return new HarnessError("auth", "Pi isn't signed in to a model provider. Run pi in a terminal and use /login, or set the provider's API key, then run the agents again.", tail(text));
  }
  const unknown = /(model "[^"]*" not found|unknown provider "[^"]*")/i.exec(text);
  if (unknown) {
    return new HarnessError("failed", `Pi: ${unknown[1]}. Check diffline.pi.model, or the agent's model in agents.yml; pi --list-models lists the ones you can use.`, tail(text));
  }
  return classify(text, code, "Pi");
}

async function runPi(h: HarnessConfig, r: AgentRun): Promise<AgentResult> {
  if (h.thinking && !isPiThinking(h.thinking)) {
    throw new HarnessError("failed", `diffline.pi.thinking is "${h.thinking}". Use ${PI_THINKING.join(", ")}, or leave it empty for Pi's default.`);
  }
  // Pi always reads .pi/settings.json from its working folder (which can install packages and run commands at startup)
  // and .pi/SYSTEM.md (which replaces the prompt), and no flag turns that off. So it never starts in the checkout: it
  // works in an empty folder of its own, and the prompt gives it the checkout's absolute path.
  const dir = r.workDir ?? (await mkdtemp(path.join(os.tmpdir(), "diffline-pi-")));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // Pi has no flag for an output schema, so the prompt carries it.
  const prompt = `${r.prompt}\n\nReply with only a JSON object matching this JSON Schema:\n\n${JSON.stringify(r.schema)}\n`;
  const started = Date.now();
  try {
    const res = await run(h.command, piArgs(h, r.model, await piVersion(h)), { cwd: dir, env: piEnv(), input: prompt, timeoutMs: r.timeoutMs, signal: r.signal, onStderr: (c) => r.onLog?.(c.trimEnd()) });
    if (res.killed) throw r.signal?.aborted ? new HarnessError("cancelled", "Stopped.") : new HarnessError("timeout", "The agent took too long and was stopped.");
    if (res.code !== 0) throw piError(res.stderr || res.stdout, res.code);
    // A provider error still exits 0 in Pi's JSON mode; the last message says what went wrong.
    const reply = piReply(res.stdout);
    if (!reply) throw new HarnessError("badOutput", "Pi didn't reply.", tail(res.stderr || res.stdout));
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      const msg = reply.errorMessage || `the request ended (${reply.stopReason})`;
      if (/login|auth|api key|401|credit|billing/i.test(msg)) throw new HarnessError("auth", `Pi: ${msg.slice(0, 300)}`, tail(res.stderr));
      throw new HarnessError("failed", `Pi: ${msg.slice(0, 300)}`, tail(res.stderr));
    }
    if (reply.stopReason === "length") throw new HarnessError("badOutput", "Pi's reply was cut off before it finished.", tail(reply.text));
    const text = reply.text.trim();
    const parsed = tryJson(text) ?? tryJson(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (parsed === undefined) throw new HarnessError("badOutput", "Pi didn't return JSON.", tail(text || res.stdout));
    const roots = [...new Set([path.resolve(r.cwd), await realpath(r.cwd).catch(() => path.resolve(r.cwd))])];
    const { tokens, costUsd, model } = piUsage(res.stdout);
    return { output: relativePaths(parsed, roots), costUsd, tokens, model: model || r.model || h.model || null, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface PiModel {
  provider: string;
  id: string;
  /** Whether the model can think; Pi turns thinking off for the ones that can't. */
  thinking: boolean;
}

/**
 * The models in pi --list-models output: a header (provider, model, context, max-out, thinking, images) and one padded
 * row per model. An empty list when Pi says no models are available; null when the text isn't a model list.
 */
export function parsePiModels(text: string): PiModel[] | null {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  if (lines.some((l) => /^no models available/i.test(l.trim()))) return [];
  const start = lines.findIndex((l) => /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/.test(l.trim()));
  if (start < 0) return null;
  // Columns are padded to the widest value, so the header says where each one starts.
  const header = lines[start];
  const at = (name: string) => header.search(new RegExp(`(?<=^|\\s)${name}(?=\\s|$)`));
  const [model, context, thinking, images] = ["model", "context", "thinking", "images"].map(at);
  const models: PiModel[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const provider = line.slice(0, model).trim();
    const id = line.slice(model, context).trim();
    if (!provider || !id || /\s/.test(provider) || /\s/.test(id)) continue;
    models.push({ provider, id, thinking: line.slice(thinking, images).trim() === "yes" });
  }
  return models;
}

/**
 * The models Pi can use: the ones with credentials. Run from an empty folder, offline and without resources, for the
 * same reasons as a review. Null when Pi isn't there or its output isn't a list.
 */
export async function listPiModels(h: HarnessConfig): Promise<PiModel[] | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-pi-"));
  try {
    const res = await run(h.command, ["--list-models", "--offline", ...PI_NO_RESOURCES], { cwd: dir, env: piEnv(), timeoutMs: 30_000 });
    if (res.killed || res.code !== 0) return null;
    // Pi prints the list to stderr when its input isn't a terminal, as here.
    return parsePiModels(res.stdout) ?? parsePiModels(res.stderr);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Error messages from Codex's events, where a failed turn says what went wrong. */
function codexErrors(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e?.type === "turn.failed" && e.error?.message) out.push(e.error.message);
      else if (e?.type === "error" && e.message) out.push(e.message);
    } catch {
      /* not an event line */
    }
  }
  return out.join("\n");
}

function tryJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  const t = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export const HARNESS_NAME: Record<HarnessId, string> = { claude: "Claude Code CLI", codex: "Codex CLI", pi: "Pi coding agent" };

export async function runAgent(h: HarnessConfig, r: AgentRun): Promise<AgentResult> {
  try {
    switch (h.id) {
      case "claude":
        return await runClaude(h, r);
      case "codex":
        return await runCodex(h, r);
      case "pi":
        return await runPi(h, r);
    }
    throw new HarnessError("failed", `Unknown harness "${h.id}".`);
  } catch (err: any) {
    if (err instanceof HarnessError) throw err;
    if (err?.code === "ENOENT") {
      const name = HARNESS_NAME[h.id];
      throw new HarnessError("missing", `The ${name} wasn't found at "${h.command}". Install it or set its path in Diffline's settings.`);
    }
    throw new HarnessError("failed", String(err?.message || err));
  }
}

/** Check that the harness CLI is installed; returns its version line. `runner` stands in for exec's run in tests. */
export async function harnessVersion(h: Pick<HarnessConfig, "command">, runner: typeof run = run): Promise<string | null> {
  try {
    const res = await runner(h.command, ["--version"], { timeoutMs: 15_000 });
    // Pi prints its version to stderr when its input isn't a terminal.
    return res.code === 0 ? (res.stdout.trim() || res.stderr.trim()).split("\n")[0] || null : null;
  } catch {
    return null;
  }
}
