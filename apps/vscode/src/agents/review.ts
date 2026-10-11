// Runs the review agents on one pull request and returns the agent file the page renders.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentFile, AgentId, PullRequestDetail, ReviewData } from "../core/types.ts";
import type { Semaphore } from "../core/limit.ts";
import { DESC_RULES, GUIDE, type ReviewSettings } from "./defaults.ts";
import { addTokens, formatTokens, HarnessError, runAgent, type HarnessConfig, type HarnessId, type TokenUsage } from "./harness.ts";
import { guidePrompt, INLINE_DIFF_LIMIT, ledePrompt, renderDiff, reviewerPrompt, type PromptContext } from "./prompts.ts";
import { guideSchema, ledeSchema, reviewerSchema, type GuideOutput, type ReviewerOutput } from "./schema.ts";
import { matchesAny } from "./settings.ts";
import { AnchorIndex, assemble, guideParts, reviewerFindings, type Problems } from "./validate.ts";

export type AgentState = "queued" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface ReviewProgress {
  agents: Partial<Record<AgentId | "lede", { state: AgentState; harness?: HarnessId; ms?: number; error?: string; costUsd?: number | null; tokens?: TokenUsage | null }>>;
}

/** The harnesses a run can use: the diffline.harness default, and each CLI's settings. */
export interface Harnesses {
  default: HarnessId;
  claude: HarnessConfig;
  codex: HarnessConfig;
}

/** The harness an agent runs on: its own from agents.yml, else the default. The lede uses the guide's. */
export function harnessFor(id: AgentId | "lede", settings: ReviewSettings, harnesses: Harnesses): HarnessConfig {
  const own = settings.agents[id === "lede" ? GUIDE : id]?.harness;
  return harnesses[own || harnesses.default];
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
}

export interface ReviewRunResult {
  file: AgentFile;
  problems: Problems;
  failed: AgentFailure[];
  /** Claude Code agents' cost; Codex doesn't report one. */
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
  const modelOf = (id: AgentId | "lede") => input.settings.agents[id === "lede" ? GUIDE : id].model || harnessOf(id).model || "default model";
  void log(`run ${input.key} @ ${input.data.head.short}: ${run.map((id) => `${id} (${harnessOf(id).id}, ${modelOf(id)})`).join(", ")}; skipped ${skipped.map((s) => `${s.id} (${s.why})`).join(", ") || "none"}`);

  const failed: AgentFailure[] = [];
  let cost: number | null = null;
  let tokens: TokenUsage | null = null;
  const usage: Record<string, { harness: HarnessId; model: string | null; ms: number; costUsd: number | null; tokens: TokenUsage | null }> = {};

  const one = async <T>(id: AgentId | "lede", prompt: string, schema: object, timeoutMs: number): Promise<T | null> => {
    const harness = harnessOf(id);
    const model = input.settings.agents[id === "lede" ? GUIDE : id].model;
    try {
      return await input.limiter.use(async () => {
        progress.agents[id] = { state: "running", harness: harness.id };
        emit();
        await writeFile(path.join(input.runDir, `${id}.prompt.md`), prompt, "utf8");
        const res = await runAgent(harness, {
          prompt,
          schema,
          cwd: input.repoPath,
          readDirs: [input.runDir],
          model: model || undefined,
          timeoutMs,
          signal: input.signal,
          onLog: (line) => void appendFile(path.join(input.runDir, `${id}.log`), line + "\n").catch(() => undefined),
        });
        await writeFile(path.join(input.runDir, `${id}.json`), JSON.stringify(res.output, null, 1), "utf8");
        if (res.costUsd !== null) cost = (cost ?? 0) + res.costUsd;
        tokens = addTokens(tokens, res.tokens);
        usage[id] = { harness: harness.id, model: res.model, ms: res.durationMs, costUsd: res.costUsd, tokens: res.tokens };
        progress.agents[id] = { state: "done", harness: harness.id, ms: res.durationMs, costUsd: res.costUsd, tokens: res.tokens };
        emit();
        void log(
          `${id} done on ${harness.id}${res.model ? ` (${res.model})` : ""} in ${Math.round(res.durationMs / 1000)}s` +
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
      void log(`${id} ${cancelled ? "cancelled" : "failed"} on ${harness.id}: ${message}${err instanceof HarnessError && err.detail ? `\n${err.detail}` : ""}`);
      return null;
    }
  };

  const outputs = await Promise.all(
    run.map((id) =>
      id === GUIDE
        ? one<GuideOutput>(id, guidePrompt(ctx), guideSchema, input.timeoutMs)
        : one<ReviewerOutput>(id, reviewerPrompt(id, ctx), reviewerSchema, input.timeoutMs),
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
  const draft = assemble({ harnessLabel: `Diffline (${used.join(" + ")})`, head: input.data.head.sha, lede: "", ran, guide, reviewers, index, settings: input.settings });

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
