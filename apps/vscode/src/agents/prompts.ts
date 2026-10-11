// Prompts for the review agents. Every agent gets the same pull request context and the diff; the instructions
// come from the user's settings (~/.diffline/agents/<id>.md).

import type { AgentId, DiffFile, PullRequestDetail, ReviewData } from "../core/types.ts";
import { DESC_RULES, GUIDE, type ReviewSettings } from "./defaults.ts";
import { matchesAny } from "./settings.ts";

/** Above this size the diff goes to a file the agent reads, instead of into the prompt. */
export const INLINE_DIFF_LIMIT = 160_000;

export function renderDiff(data: ReviewData, include: (f: DiffFile) => boolean = () => true): string {
  const out: string[] = [];
  for (const f of data.files) {
    if (!include(f)) continue;
    const from = f.status === "added" ? "/dev/null" : `a/${f.oldPath || f.path}`;
    const to = f.status === "deleted" ? "/dev/null" : `b/${f.path}`;
    out.push(`diff --git a/${f.oldPath || f.path} b/${f.path}`);
    if (f.status === "renamed") out.push(`rename from ${f.oldPath}`, `rename to ${f.path}`);
    if (f.binary) {
      out.push("Binary file changed");
      continue;
    }
    if (f.generated) {
      out.push(`(generated file: +${f.additions} -${f.deletions}, not shown)`);
      continue;
    }
    out.push(`--- ${from}`, `+++ ${to}`);
    for (const h of f.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? " " + h.section : ""}`);
      for (const l of h.lines) out.push(`${l[0]}${l[3]}`);
    }
  }
  return out.join("\n");
}

function prContext(detail: PullRequestDetail | null, data: ReviewData, key: string): string {
  const pr = detail?.pr;
  const lines: string[] = [];
  lines.push(`# Pull request ${key}${pr ? `: ${pr.title}` : ""}`);
  if (pr) {
    lines.push(
      "",
      `- Author: ${pr.author.login ?? "unknown"}${pr.isDraft ? " (draft)" : ""}`,
      `- Merges ${pr.headRefName} into ${pr.baseRefName}`,
      `- Labels: ${pr.labels.join(", ") || "none"}`,
    );
    const failing = pr.checks.filter((c) => c.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion || ""));
    if (failing.length) lines.push(`- Failing checks: ${failing.map((c) => c.name).join(", ")}`);
  }
  lines.push(
    `- Base (merge base): ${data.mergeBase}`,
    `- Head: ${data.head.sha}`,
    "",
    "## Description",
    "",
    pr?.body?.trim() ? pr.body.trim() : "(The description is empty.)",
    "",
    "## Commits",
    "",
    ...data.commits.map((c) => `- ${c.short} ${c.subject}`),
    "",
    "## Changed files",
    "",
    ...data.files.map((f) => `- ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ""}: +${f.additions} -${f.deletions}${f.generated ? ", generated" : ""}${f.binary ? ", binary" : ""}`),
  );
  const threads = detail?.threads ?? [];
  if (threads.length) {
    lines.push("", "## Existing review threads", "", "Don't repeat what these already raise; you may build on them.", "");
    for (const t of threads) {
      const first = t.comments[0];
      if (!first) continue;
      const body = first.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      lines.push(`- ${t.path}:${t.line ?? "?"}${t.resolved ? " (resolved)" : ""}${t.outdated ? " (outdated)" : ""} — ${first.login}: ${body}${t.comments.length > 1 ? ` (+${t.comments.length - 1} replies)` : ""}`);
    }
  }
  return lines.join("\n");
}

const HOW_TO_READ = (data: ReviewData, baseDir: string | null, checkout: string | null) => `## Reading the code

${
  checkout
    ? `The pull request's code at its head commit (${data.head.short}) is in ${checkout}. Your working directory is an empty folder, so always give your file tools absolute paths under ${checkout}. Read and search the code to trace callers, contracts and tests beyond the diff. In your answer, give paths relative to ${checkout}, as the diff does.`
    : `Your working directory is the pull request's code at its head commit (${data.head.short}). Read and search it with your file tools to trace callers, contracts and tests beyond the diff.`
}${baseDir ? ` The changed files as they were before the pull request are under ${baseDir}, at the same paths (new files aren't there).` : ""} You can only read; there's no shell, and nothing you do changes the repository or reaches GitHub.`;

const ANCHOR_RULES = `## Pointing at lines

Wherever you name a line (a finding's \`match\`, a step, a ref), copy the exact text of ONE line from the diff above that is an added line (starting with +) or a context line (starting with a space). Copy it character for character without the leading + or space, including indentation is optional. Never use a deleted line (starting with -). \`path\` is the changed file's path as listed above.`;

export interface PromptContext {
  key: string;
  data: ReviewData;
  detail: PullRequestDetail | null;
  settings: ReviewSettings;
  /** Set when the diff is too large to inline: the file the agent should read instead. */
  diffFile: string | null;
  /** Where the changed files are as they were before the pull request, when they were exported. */
  baseDir?: string | null;
  /** Set when the agent doesn't work in the checkout (Pi): the checkout's absolute path. */
  checkout?: string | null;
}

function diffSection(ctx: PromptContext, id: AgentId): string {
  const agent = ctx.settings.agents[id];
  const include = (f: DiffFile) => !matchesAny(f.path, agent.skip);
  const skipped = ctx.data.files.filter((f) => !include(f)).map((f) => f.path);
  const note = skipped.length ? `\n\nYour settings skip these files: ${skipped.join(", ")}.` : "";
  if (ctx.diffFile) {
    return `## The diff\n\nThe diff is large, so it's in a file. Read it with your file tool: ${ctx.diffFile}${note}`;
  }
  return `## The diff\n\n\`\`\`diff\n${renderDiff(ctx.data, include)}\n\`\`\`${note}`;
}

export function reviewerPrompt(id: AgentId, ctx: PromptContext): string {
  const a = ctx.settings.agents[id];
  const s = ctx.settings.severity;
  const minConf =
    a.minConfidence === "high" ? 'Only report findings you can rate "High confidence".' : a.minConfidence === "worth-asking" ? 'Don\'t report "Minor" findings.' : "";
  return `You are the ${a.name} in Diffline, reviewing pull request ${ctx.key} for a human reviewer. You never post anything: the reviewer decides on every finding, and only what they choose reaches the author.

Your focus: ${a.focus || "the problems your instructions describe"}.

${a.instructions}

${prContext(ctx.detail, ctx.data, ctx.key)}

${diffSection(ctx, id)}

${HOW_TO_READ(ctx.data, ctx.baseDir ?? null, ctx.checkout ?? null)}

${ANCHOR_RULES}

## What to return

- \`findings\`: at most ${a.maxFindings}, most severe first. Report only problems you verified by reading the code: trace the callers, the other side of each contract, and the tests. If you can't verify something but it matters, rate it "Worth asking" and label it "question". Return no findings rather than weak ones. ${minConf}
  - \`severity\`: high = ${s.high}; medium = ${s.medium}; low = ${s.low}.
  - \`confidence\`: "High confidence" (verified with evidence), "Worth asking" (plausible, needs the author), "Minor".
  - \`label\`: "blocking" only for a verified high-severity defect; otherwise "question", "suggestion" or "nit".
  - \`title\`: at most 8 words, a plain statement of the problem.
  - \`body\`: the concrete failure: what input or state leads to what wrong outcome, with file and line evidence. Two to five sentences.
  - \`steps\`: 1 to 4 diff lines that show the path to the problem, each with a short \`text\`; \`path\` is null when it's the finding's own file.
  - \`fix\`: one sentence, or null.
  - \`comment\`: what the reviewer would post on the line: at most 50 words, in a reviewer's voice, asking rather than telling when there's room for doubt. Don't say "I verified" or mention agents. Name pull requests as owner/repo#number.
- \`checked\`: 2 to 6 one-sentence notes on things you checked that are fine, each with its \`path\` (or null), so the reviewer knows what was covered.

Write in plain English with short sentences.`;
}

export function guidePrompt(ctx: PromptContext): string {
  const a = ctx.settings.agents[GUIDE];
  const rules = (ids: string[]) => ids.map((r) => `\`${r}\` (${DESC_RULES[r].text})`).join("; ");
  return `You are the ${a.name} in Diffline, preparing pull request ${ctx.key} for a human reviewer. You never post anything.

Your focus: ${a.focus}.

${a.instructions}

${prContext(ctx.detail, ctx.data, ctx.key)}

${diffSection(ctx, GUIDE)}

${HOW_TO_READ(ctx.data, ctx.baseDir ?? null, ctx.checkout ?? null)}

${ANCHOR_RULES}

## What to return

- \`description\`: the description check.
  - \`kind\`: "feature" for a new feature, "fix" for a bug fix or improvement. Decide from the title, labels and changes.
  - \`why\`: at most 30 words on why you chose the kind.
  - \`items\`: exactly one item per rule, in this order. A feature: ${rules(ctx.settings.descriptionRules.feature)}. A fix: ${rules(ctx.settings.descriptionRules.fix)}.
    - \`status\`: "covered", "partly", "missing", or "none" (only for \`dependencies\`, when nothing points to another pull request).
    - \`quote\`: for covered and partly, text copied exactly from the description; otherwise null.
    - \`note\`: what's thin or missing, compared with the diff (null when fully covered).
    - \`ask\`: for partly and missing, the question the reviewer can send the author, at most 45 words, naming pull requests as owner/repo#number; otherwise null.
    - \`refs\`: diff lines that show a gap (often empty).
- \`chapters\`: the reading order. Every changed file in exactly one chapter. \`source\` is "description" when the chapter follows the description's list, "commits" when it follows a commit (put the commit subject in \`sourceText\`), "auto" otherwise (put a short reason in \`sourceText\`). \`quiet\` is true for housekeeping a reviewer can skim. \`note\` says in one sentence what the chapter does.
- \`reasons\`: one to three sentences on why this order.
- \`diagrams\`: zero or one flow (two if the change has two separate flows). 4 to 10 nodes in the order the code runs. \`kind\` is "actor" for whoever starts the flow, "data" for a store, otherwise "step". \`change\` is "added", "changed", "removed", or null for an unchanged step; for a changed step, \`beforeLabel\`/\`beforeDetail\` can say how it read before. Each node's \`refs\` point at the diff lines it stands for (empty for steps outside the diff). Edges connect node ids. Use short ids like "checkout".
- \`checked\`: 1 to 4 notes on what you checked about the description and structure.

Write in plain English with short sentences.`;
}

export function ledePrompt(key: string, summary: string): string {
  return `Write the opening line of a pull request review briefing for ${key}: 15 to 70 words, plain English, for the human reviewer. Say whether the change looks sound, then name the most important findings or description gaps to look at first. Don't list everything, don't use headings, and don't mention agents.

What the review found:

${summary}`;
}
