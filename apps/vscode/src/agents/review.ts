// Runs the review agents on one pull request and returns the agent file the page renders.

import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentFile, AgentId, PullRequestDetail, ReviewData } from "../core/types.ts";
import type { Semaphore } from "../core/limit.ts";
import { DESC_RULES, GUIDE, type AgentSettings, type ReviewSettings } from "./defaults.ts";
import { addTokens, formatTokens, HarnessError, piModelThinking, runAgent, type HarnessConfig, type HarnessId, type TokenUsage } from "./harness.ts";
import { guidePrompt, INLINE_DIFF_LIMIT, ledePrompt, renderDiff, reviewerPrompt, type PromptContext } from "./prompts.ts";
import { guideSchema, ledeSchema, reviewerSchema, type GuideOutput, type ReviewerOutput } from "./schema.ts";
import { matchesAny } from "./settings.ts";
import { AnchorIndex, assemble, guideParts, reviewerFindings, type Problems, type RunConfig } from "./validate.ts";

export type AgentState = "queued" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface ReviewProgress {
  agents: Partial<Record<AgentId | "lede", { state: AgentState; harness?: HarnessId; ms?: number; error?: string; costUsd?: number | null; tokens?: TokenUsage | null }>>;
}

/** The harnesses a run can use: the diffline.harness default, and each CLI's settings. */
export interface Harnesses {
  default: HarnessId;
  claude: HarnessConfig;
  codex: HarnessConfig;
  pi: HarnessConfig;
}

/** The harness an agent runs on: its own from agents.yml, else the default. The lede uses the guide's. */
export function harnessFor(id: AgentId | "lede", settings: ReviewSettings, harnesses: Harnesses): HarnessConfig {
  const own = settings.agents[id === "lede" ? GUIDE : id]?.harness;
  return harnesses[own || harnesses.default];
}

/** A short hash of what an agent is told (its focus and instructions), so a change shows in the review metrics. */
export const instructionsHash = (a: Pick<AgentSettings, "focus" | "instructions">): string =>
  createHash("sha256").update(`${a.focus}\n${a.instructions}`).digest("hex").slice(0, 12);

/**
 * What an agent ran with, for the agent file: its harness, the model the harness reported (else the configured one),
 * Pi's thinking level and its instructions' hash.
 */
export function runConfig(id: AgentId, settings: ReviewSettings, harnesses: Harnesses, reportedModel: string | null): RunConfig {
  const h = harnessFor(id, settings, harnesses);
  const own = settings.agents[id === "lede" ? GUIDE : id].model;
  const configured = own || h.model || "";
  const suffix = h.id === "pi" ? piModelThinking(configured) : null;
  const model = reportedModel || (suffix ? configured.replace(/:[a-z]+$/, "") : configured) || null;
  return {
    harness: h.id,
    model,
    // Pi's diffline.pi.thinking applies unless the agent's own model names a level (see piArgs).
    ...(h.id === "pi" ? { thinking: (own && piModelThinking(own)) || h.thinking || suffix || null } : {}),
    instructions: instructionsHash(settings.agents[id === "lede" ? GUIDE : id]),
  };
}

/** How one agent's part of a run went, for the run event in the review metrics. The lede is an agent here too. */
export interface AgentRunRecord {
  id: string;
  harness: string;
  model: string | null;
  /** Other models the harness called for side work (Claude Code only); left out when there are none. */
  otherModels?: string[];
  thinking?: string | null;
  /** The lede's instructions are Diffline's own, so it has none. */
  instructions: string | null;
  ms: number;
  tokens: TokenUsage | null;
  costUsd: number | null;
  /** Findings it has in the agent file. */
  findings: number;
  failed?: HarnessError["kind"];
}

export interface AgentFailure {
  agent: string;
  error: string;
  /** "missing" or "auth" when the agent's CLI isn't installed or signed in. */
  kind?: HarnessError["kind"];
}

export interface ReviewRunInput {
  key: string;
  /** A checkout of the pull request's head, where the agents work. */
  repoPath: string;
  /** The changed files as they were before the pull request, under the run folder. */
  baseDir?: string | null;
  data: ReviewData;
  detail: PullRequestDetail | null;
  harnesses: Harnesses;
  settings: ReviewSettings;
  /** Agents allowed by the diffline.agents.enabled setting; empty allows every agent agents.yml turns on. */
  enabled: AgentId[];
  runDir: string;
  timeoutMs: number;
  limiter: Semaphore;
  signal?: AbortSignal;
  onProgress?: (p: ReviewProgress) => void;
  /** Filled in as agents finish or fail, whether or not the run as a whole succeeds (for the review metrics). */
  agentRuns?: AgentRunRecord[];
}

export interface ReviewRunResult {
  file: AgentFile;
  problems: Problems;
  failed: AgentFailure[];
  /** The cost Claude Code and Pi agents report; Codex doesn't report one. */
  costUsd: number | null;
  tokens: TokenUsage | null;
  ms: number;
}

/** Which agents should run on this diff, and why the others don't. */
export function selectAgents(data: ReviewData, settings: ReviewSettings, enabled: AgentId[]): { run: AgentId[]; skipped: Array<{ id: AgentId; why: string }> } {
  const run: AgentId[] = [];
  const skipped: Array<{ id: AgentId; why: string }> = [];
  for (const [id, a] of Object.entries(settings.agents)) {
    if (!a.enabled) {
      skipped.push({ id, why: "turned off" });
      continue;
    }
    if (enabled.length && !enabled.includes(id)) {
      skipped.push({ id, why: "not in the diffline.agents.enabled setting" });
      continue;
    }
    const files = data.files.filter((f) => !matchesAny(f.path, a.skip));
    if (id !== GUIDE && !files.length) {
      skipped.push({ id, why: "every changed file is in its skip list" });
      continue;
    }
    if (a.runsWhen.length && !data.files.some((f) => matchesAny(f.path, a.runsWhen))) {
      skipped.push({ id, why: "no changed file matches its runs-when patterns" });
      continue;
    }
    if (id !== GUIDE && a.maxFindings === 0) {
      skipped.push({ id, why: "its max-findings is 0" });
      continue;
    }
    run.push(id);
  }
  return { run, skipped };
}

function fallbackLede(file: Pick<AgentFile, "findings" | "description">): string {
  const n = file.findings.length;
  const high = file.findings.filter((f) => f.severity === "high").length;
  const gaps = (file.description?.items || []).filter((it) => it.status === "partly" || it.status === "missing");
  const parts = [
    n ? `${n} finding${n === 1 ? "" : "s"}${high ? `, ${high} high` : ""}.` : "No findings.",
    n ? `Start with "${file.findings[0].title}".` : "",
    gaps.length ? `The description is thin on ${gaps.map((g) => DESC_RULES[g.rule]?.title.toLowerCase() || g.rule).join(", ")}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const started = Date.now();
  await mkdir(input.runDir, { recursive: true });
  const log = (line: string) => appendFile(path.join(input.runDir, "run.log"), `${new Date().toISOString()} ${line}\n`).catch(() => undefined);
  const fullDiff = renderDiff(input.data);
  const diffPath = path.join(input.runDir, "diff.patch");
  await writeFile(diffPath, fullDiff, "utf8");
  const ctx: PromptContext = {
    key: input.key,
    data: input.data,
    detail: input.detail,
    settings: input.settings,
    diffFile: fullDiff.length > INLINE_DIFF_LIMIT ? diffPath : null,
    baseDir: input.baseDir ?? null,
  };

  const { run, skipped } = selectAgents(input.data, input.settings, input.enabled);
  const progress: ReviewProgress = { agents: {} };
  const emit = () => input.onProgress?.({ agents: { ...progress.agents } });
  for (const s of skipped) progress.agents[s.id] = { state: "skipped", error: s.why };
  for (const id of run) progress.agents[id] = { state: "queued" };
  emit();
  const harnessOf = (id: AgentId | "lede") => harnessFor(id, input.settings, input.harnesses);
  // Pi works outside the checkout (harness.ts says why), so its prompt names the checkout's folder.
  const ctxFor = (id: AgentId): PromptContext => (harnessOf(id).id === "pi" ? { ...ctx, checkout: input.repoPath } : ctx);
  const modelOf = (id: AgentId | "lede") => input.settings.agents[id === "lede" ? GUIDE : id].model || harnessOf(id).model || "default model";
  // Pi's diffline.pi.thinking applies unless the agent's own model names a level (see piArgs).
  const thinkingOf = (id: AgentId) => {
    const h = harnessOf(id);
    const own = input.settings.agents[id].model;
    return h.id === "pi" && h.thinking && !(own && piModelThinking(own)) ? `, thinking ${h.thinking}` : "";
  };
  void log(`run ${input.key} @ ${input.data.head.short}: ${run.map((id) => `${id} (${harnessOf(id).id}, ${modelOf(id)}${thinkingOf(id)})`).join(", ")}; skipped ${skipped.map((s) => `${s.id} (${s.why})`).join(", ") || "none"}`);

  const failed: AgentFailure[] = [];
  let cost: number | null = null;
  let tokens: TokenUsage | null = null;
  const usage: Record<string, { harness: HarnessId; model: string | null; otherModels?: string[]; ms: number; costUsd: number | null; tokens: TokenUsage | null }> = {};

  const records = new Map<string, AgentRunRecord>();
  const record = (id: AgentId | "lede", reportedModel: string | null, rest: Pick<AgentRunRecord, "ms" | "tokens" | "costUsd" | "otherModels"> & { failed?: AgentRunRecord["failed"] }) => {
    const cfg = runConfig(id, input.settings, input.harnesses, reportedModel);
    const r: AgentRunRecord = { id, ...cfg, instructions: id === "lede" ? null : cfg.instructions!, ...rest, findings: 0 } as AgentRunRecord;
    records.set(id, r);
    input.agentRuns?.push(r);
  };

  const one = async <T>(id: AgentId | "lede", prompt: string, schema: object, timeoutMs: number): Promise<T | null> => {
    const harness = harnessOf(id);
    const model = input.settings.agents[id === "lede" ? GUIDE : id].model;
    let agentStarted = 0;
    try {
      return await input.limiter.use(async () => {
        agentStarted = Date.now();
        progress.agents[id] = { state: "running", harness: harness.id };
        emit();
        await writeFile(path.join(input.runDir, `${id}.prompt.md`), prompt, "utf8");
        const res = await runAgent(harness, {
          prompt,
          schema,
          cwd: input.repoPath,
          readDirs: [input.runDir],
          model: model || undefined,
          workDir: path.join(input.runDir, `${harness.id}-${id}`),
          timeoutMs,
          signal: input.signal,
          onLog: (line) => void appendFile(path.join(input.runDir, `${id}.log`), line + "\n").catch(() => undefined),
        });
        await writeFile(path.join(input.runDir, `${id}.json`), JSON.stringify(res.output, null, 1), "utf8");
        if (res.costUsd !== null) cost = (cost ?? 0) + res.costUsd;
        tokens = addTokens(tokens, res.tokens);
        const others = res.otherModels?.length ? { otherModels: res.otherModels } : {};
        usage[id] = { harness: harness.id, model: res.model, ...others, ms: res.durationMs, costUsd: res.costUsd, tokens: res.tokens };
        record(id, res.model, { ...others, ms: res.durationMs, tokens: res.tokens, costUsd: res.costUsd });
        progress.agents[id] = { state: "done", harness: harness.id, ms: res.durationMs, costUsd: res.costUsd, tokens: res.tokens };
        emit();
        void log(
          `${id} done on ${harness.id}${res.model ? ` (${res.model}${others.otherModels ? `, also ${others.otherModels.join(", ")}` : ""})` : ""} in ${Math.round(res.durationMs / 1000)}s` +
            `${res.costUsd !== null ? `, $${res.costUsd.toFixed(3)}` : ""}${res.tokens ? `, ${formatTokens(res.tokens)}` : ""}`,
        );
        return res.output as T;
      }, input.signal);
    } catch (err: any) {
      const cancelled = input.signal?.aborted || (err instanceof HarnessError && err.kind === "cancelled");
      const message = err instanceof HarnessError ? err.message : String(err?.message || err);
      progress.agents[id] = { state: cancelled ? "cancelled" : "failed", harness: harness.id, error: message };
      emit();
      // A missing or signed-out CLI fails only the agents that use it; the others carry on.
      if (!cancelled) failed.push({ agent: id, error: message, kind: err instanceof HarnessError ? err.kind : undefined });
      record(id, null, { ms: agentStarted ? Date.now() - agentStarted : 0, tokens: null, costUsd: null, failed: cancelled ? "cancelled" : err instanceof HarnessError ? err.kind : "failed" });
      void log(`${id} ${cancelled ? "cancelled" : "failed"} on ${harness.id}: ${message}${err instanceof HarnessError && err.detail ? `\n${err.detail}` : ""}`);
      return null;
    }
  };

  const outputs = await Promise.all(
    run.map((id) =>
      id === GUIDE
        ? one<GuideOutput>(id, guidePrompt(ctxFor(id)), guideSchema, input.timeoutMs)
        : one<ReviewerOutput>(id, reviewerPrompt(id, ctxFor(id)), reviewerSchema, input.timeoutMs),
    ),
  );
  if (input.signal?.aborted) throw new HarnessError("cancelled", "Stopped.");

  const index = new AnchorIndex(input.data);
  const problems: Problems = { dropped: [], repaired: [] };
  const ran: AgentId[] = [];
  let guide: ReturnType<typeof guideParts> | null = null;
  const reviewers: Array<ReturnType<typeof reviewerFindings>> = [];
  run.forEach((id, i) => {
    const out = outputs[i];
    if (!out) return;
    try {
      if (id === GUIDE) guide = guideParts(out as GuideOutput, input.data, input.detail?.pr.body || "", index, input.settings, problems);
      else reviewers.push(reviewerFindings(id, out as ReviewerOutput, index, input.settings, problems));
      ran.push(id);
    } catch (err: any) {
      failed.push({ agent: id, error: `Its output didn't fit: ${err?.message || err}` });
      const r = records.get(id);
      if (r) r.failed = "badOutput";
      progress.agents[id] = { state: "failed", error: "Its output didn't fit the expected shape" };
    }
  });
  if (!ran.length) {
    // When every agent's CLI is missing or signed out, say so, so the user is offered the harness picker.
    const setup = failed.find((f) => f.kind === "missing" || f.kind === "auth");
    if (setup && failed.every((f) => f.kind === "missing" || f.kind === "auth")) throw new HarnessError(setup.kind!, setup.error);
    throw new HarnessError("failed", failed.length ? `Every agent failed. First error: ${failed[0].error}` : "No agents ran.");
  }

  const used = [...new Set(ran.map((id) => harnessOf(id).id))];
  const runs = Object.fromEntries(ran.map((id) => [id, runConfig(id, input.settings, input.harnesses, usage[id]?.model ?? null)]));
  const draft = assemble({ harnessLabel: `Diffline (${used.join(" + ")})`, head: input.data.head.sha, lede: "", ran, guide, reviewers, index, settings: input.settings, runs });

  for (const r of records.values()) r.findings = draft.findings.filter((f) => f.agent === r.id).length;

  // The opening line of the briefing, written once every finding is known.
  let lede = fallbackLede(draft);
  const summary = [
    ...draft.findings.map((f) => `- ${f.severity} (${f.agent}): ${f.title}. ${f.body.slice(0, 300)}`),
    ...(draft.description?.items || []).filter((it) => it.status === "partly" || it.status === "missing").map((it) => `- description ${it.status}: ${DESC_RULES[it.rule]?.title || it.rule}. ${it.note || ""}`),
    ...draft.checked.slice(0, 8).map((c) => `- checked fine: ${c.text}`),
  ].join("\n");
  const ledeOut = await one<{ lede: string }>("lede", ledePrompt(input.key, summary || "Nothing was flagged."), ledeSchema, Math.min(input.timeoutMs, 180_000));
  if (ledeOut?.lede?.trim()) lede = ledeOut.lede.trim();
  draft.lede = lede;

  for (const d of problems.dropped) void log(`dropped: ${d}`);
  for (const r of problems.repaired) void log(`repaired: ${r}`);
  await writeFile(path.join(input.runDir, "agent-file.json"), JSON.stringify(draft, null, 1), "utf8");
  await writeFile(path.join(input.runDir, "usage.json"), JSON.stringify({ costUsd: cost, tokens, agents: usage }, null, 1), "utf8");
  if (tokens) void log(`total: ${formatTokens(tokens)}${cost !== null ? `, $${(cost as number).toFixed(3)}` : ""}`);
  return { file: draft, problems, failed, costUsd: cost, tokens, ms: Date.now() - started };
}
