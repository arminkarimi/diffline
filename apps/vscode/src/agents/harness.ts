// Runs one agent prompt through a local agent harness (Claude Code CLI or Codex CLI) and returns its JSON output.
// Agents are read-only: they may read files and run read-only git commands, nothing else.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { agentEnv, run } from "../core/exec.ts";

export type HarnessId = "claude" | "codex";

export interface HarnessConfig {
  id: HarnessId;
  /** Path to the CLI. */
  command: string;
  /** Default model; empty uses the CLI's default. */
  model: string;
  extraArgs: string[];
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
  /** Claude Code reports a cost; Codex doesn't. */
  costUsd: number | null;
  tokens: TokenUsage | null;
  /** The model that answered, when the harness says. */
  model: string | null;
  durationMs: number;
}

export const addTokens = (a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null =>
  !a ? b : !b ? a : { input: a.input + b.input, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output };

/** "182k in (120k cached), 3.4k out" */
export function formatTokens(t: TokenUsage): string {
  const n = (x: number) => (x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 1000 ? `${(x / 1000).toFixed(x >= 100_000 ? 0 : 1)}k` : String(x));
  return `${n(t.input)} in${t.cachedInput ? ` (${n(t.cachedInput)} cached)` : ""}, ${n(t.output)} out`;
}

/** Token usage from Claude Code's JSON result. Its input_tokens leaves out cache reads and writes. */
export function claudeUsage(parsed: any): { tokens: TokenUsage | null; model: string | null } {
  const u = parsed?.usage;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const tokens = u
    ? {
        input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
        cachedInput: num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
      }
    : null;
  const models = Object.keys(parsed?.modelUsage || {});
  return { tokens, model: models[0] || null };
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
  const { tokens, model } = claudeUsage(parsed);
  return { output, costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null, tokens, model, durationMs: Date.now() - started };
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

export const HARNESS_NAME: Record<HarnessId, string> = { claude: "Claude Code CLI", codex: "Codex CLI" };

export async function runAgent(h: HarnessConfig, r: AgentRun): Promise<AgentResult> {
  try {
    return h.id === "codex" ? await runCodex(h, r) : await runClaude(h, r);
  } catch (err: any) {
    if (err instanceof HarnessError) throw err;
    if (err?.code === "ENOENT") {
      const name = HARNESS_NAME[h.id];
      throw new HarnessError("missing", `The ${name} wasn't found at "${h.command}". Install it or set its path in Diffline's settings.`);
    }
    throw new HarnessError("failed", String(err?.message || err));
  }
}

/** Check that the harness CLI is installed; returns its version line. */
export async function harnessVersion(h: HarnessConfig): Promise<string | null> {
  try {
    const res = await run(h.command, ["--version"], { timeoutMs: 15_000 });
    return res.code === 0 ? res.stdout.trim().split("\n")[0] : null;
  } catch {
    return null;
  }
}
