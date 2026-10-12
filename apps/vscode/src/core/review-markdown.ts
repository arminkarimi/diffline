// A pull request's agent review as Markdown, to paste into another agent (Claude Code, Codex, Pi, a chat). It keeps
// the git references the other agent needs to find everything: the repository, the pull request, the reviewed commit
// and merge base, file paths with line numbers in that commit, and permalinks. No VS Code here, so it's testable.

import { AnchorIndex } from "../agents/validate.ts";
import { DESC_RULES } from "../agents/defaults.ts";
import type { AgentFile, DiffFile, DiffLine, Diagram, Finding, PrKey, ReviewData, ReviewState } from "./types.ts";
import { decided, prKeyString } from "./types.ts";

/** What the export says about the pull request. The current head may differ from the commit the agents reviewed. */
export interface ExportPullRequest {
  title: string;
  url?: string | null;
  author?: { login: string | null; name?: string | null } | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  /** The pull request's head now. */
  headRefOid?: string | null;
}

export interface ReviewMarkdownInput {
  key: PrKey;
  pr: ExportPullRequest;
  agent: AgentFile;
  /** The diff at the commit the agents reviewed (the agent file's `commit`), or null when it isn't available. */
  data: ReviewData | null;
  /** The page's review state: decisions on findings and on the description check. */
  state: ReviewState | null;
  /** Leave out findings that are dismissed or already in the reviewer's review. */
  openOnly?: boolean;
  version?: string;
  now?: Date;
}

export interface ReviewMarkdown {
  markdown: string;
  /** Findings in the export, and in the agent review. */
  findings: number;
  total: number;
}

/* ---------- Lines ---------- */

/** Where a line the agents named sits in the reviewed commit. `line` is null when it couldn't be found in the diff. */
export interface LineRef {
  path: string;
  /** "new" for added and unchanged lines (the reviewed commit), "old" for removed ones (the merge base). */
  side: "new" | "old";
  line: number | null;
  /** The last line of a range (a diagram ref with `end` or `lines`). */
  endLine?: number;
  /** The line's full text, or what the agent quoted when it wasn't found. */
  text: string;
  file: DiffFile | null;
}

const lineNo = (l: DiffLine) => (l[0] === "-" ? l[1] : l[2]);

/**
 * Resolves a (path, match) pair the way the page does: the first line in the file that contains the text, any side
 * (or, with `prefer`, that side first, as the page does for diagram steps). Falls back to the validation's repairs
 * (whitespace differences, a wrong path with a unique hit elsewhere). Unresolved keeps the path and the quoted text.
 */
export function resolveLine(
  data: ReviewData | null,
  index: AnchorIndex | null,
  path: string,
  match: string,
  opts: { prefer?: "old" | "new"; end?: string; lines?: number } = {},
): LineRef {
  const needle = String(match || "").trim();
  const unresolved = (file: DiffFile | null): LineRef => ({ path: file ? file.path : path, side: "new", line: null, text: needle, file });
  if (!data || !index) return unresolved(null);
  const own = index.resolvePath(path);
  const file = own ? data.files.find((f) => f.path === own) || null : null;
  const at = (f: DiffFile, h: number, i: number): LineRef => {
    const hunk = f.hunks[h];
    const l = hunk.lines[i];
    let to = i;
    if (opts.end) {
      const e = hunk.lines.findIndex((x, j) => j >= i && x[3].includes(opts.end!.trim()));
      if (e >= 0) to = e;
    } else if (opts.lines && opts.lines > 1) to = Math.min(hunk.lines.length - 1, i + opts.lines - 1);
    // A range ends on the last line of the same side.
    const side = l[0] === "-" ? "old" : "new";
    const last = hunk.lines.slice(i, to + 1).filter((x) => (side === "old" ? x[0] !== "+" : x[0] !== "-")).at(-1);
    const end = last ? lineNo(last) : null;
    return {
      path: side === "old" && f.oldPath ? f.oldPath : f.path,
      side,
      line: lineNo(l),
      ...(end != null && end !== lineNo(l) ? { endLine: end } : {}),
      text: l[3],
      file: f,
    };
  };
  if (file && needle) {
    const wanted = opts.prefer === "old" ? (l: DiffLine) => l[0] === "-" : opts.prefer === "new" ? (l: DiffLine) => l[0] !== "-" : null;
    for (const ok of [wanted, () => true].filter(Boolean) as Array<(l: DiffLine) => boolean>) {
      for (let h = 0; h < file.hunks.length; h++) {
        const i = file.hunks[h].lines.findIndex((l) => ok(l) && l[3].includes(needle));
        if (i >= 0) return at(file, h, i);
      }
    }
  }
  const hit = needle ? index.locate(path, needle) : null;
  if (hit) {
    const f = data.files.find((x) => x.path === hit.path);
    if (f) return at(f, hit.hunk, hit.line);
  }
  return unresolved(file);
}

/** A GitHub permalink to a line: the reviewed commit for new-side lines, the merge base for removed ones. */
export function permalink(repo: string, ref: LineRef, commits: { reviewed: string; mergeBase: string | null }): string | null {
  if (ref.line == null) return null;
  const sha = ref.side === "old" ? commits.mergeBase : commits.reviewed;
  if (!sha) return null;
  const path = ref.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${sha}/${path}#L${ref.line}${ref.endLine ? `-L${ref.endLine}` : ""}`;
}

/* ---------- Markdown safety ---------- */

/** One line: newlines and runs of spaces collapsed, for headings and list items. */
export const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Inline code that survives backticks in the text. */
export function code(s: string): string {
  const runs = s.match(/`+/g) || [];
  const n = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(n + 1);
  return n ? `${fence} ${s} ${fence}` : `\`${s}\``;
}

/** A fenced code block whose fence is longer than any run of backticks in the code. */
export function codeBlock(text: string, lang = ""): string {
  const runs = text.match(/`{3,}/g) || [];
  const n = runs.reduce((m, r) => Math.max(m, r.length + 1), 3);
  const fence = "`".repeat(n);
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Agent text is Markdown already; keep it, but keep it from breaking the export's structure: headings become level
 * `minLevel` or deeper, a setext underline can't turn the line above into a heading, and a code fence the text leaves
 * open is closed.
 */
export function safeMarkdown(text: unknown, minLevel = 4): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const out: string[] = [];
  let fence: { ch: string; n: number } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.n) fence = null;
      out.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], n: open[1].length };
      out.push(line);
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?=\s|$)/.exec(line);
    if (atx) {
      const level = Math.min(6, atx[1].length + minLevel - 1);
      out.push("#".repeat(level) + line.slice(atx[0].length));
      continue;
    }
    // "Title\n---" is a heading; with a blank line between, "---" is only a rule and "===" only text.
    if (/^ {0,3}(=+|-+)\s*$/.test(line) && out.length && out[out.length - 1].trim() && !/^ {0,3}([-*+]|\d+[.)])\s/.test(out[out.length - 1])) out.push("");
    out.push(line);
  }
  if (fence) out.push(fence.ch.repeat(fence.n));
  return out.join("\n");
}

const quote = (md: string) => md.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

/* ---------- Mermaid ---------- */

/** Text for a quoted Mermaid label: entity codes for the characters Mermaid reads as syntax or HTML. */
export function mermaidText(s: unknown): string {
  return oneLine(s)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .replace(/\|/g, "#124;");
}

/* ---------- Words ---------- */

const SEV_WORD = { high: "High", medium: "Medium", low: "Low" } as const;
const DESC_STATUS: Record<string, string> = { covered: "Covered", partly: "Partly covered", missing: "Missing", none: "None found" };
const FENCE_LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json", sql: "sql", yml: "yaml", yaml: "yaml",
  md: "markdown", sh: "sh", bash: "bash", rs: "rust", py: "python", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
  css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte", php: "php", cs: "csharp", c: "c", h: "c", cpp: "cpp", toml: "toml",
};
const langOf = (path: string) => FENCE_LANG[(/\.([A-Za-z0-9]+)$/.exec(path)?.[1] || "").toLowerCase()] || "";

export type FindingStatus = { kind: "open" } | { kind: "added" } | { kind: "posted" } | { kind: "dismissed"; reason: string };

/** What the reviewer did with a finding, from the page's state, the way the page shows it. */
export function findingStatus(state: ReviewState | null, f: Pick<Finding, "id">, ranAt: string | undefined): FindingStatus {
  if (!decided(state, f.id, ranAt)) return { kind: "open" };
  const rec = state!.findings![f.id];
  if (rec.state === "dismissed") return { kind: "dismissed", reason: String(rec.reason || "no reason given") };
  if (rec.state === "accepted") {
    const drafts = Array.isArray(state!.drafts) ? (state!.drafts as Array<{ id?: unknown }>) : [];
    const pending = !!rec.draft && drafts.some((d) => d && d.id === rec.draft);
    return { kind: pending ? "added" : "posted" };
  }
  return { kind: "open" };
}

const statusWord = (s: FindingStatus) => (s.kind === "open" ? "open" : s.kind === "added" ? "added to my review" : s.kind === "posted" ? "posted" : `dismissed (${oneLine(s.reason)})`);

/* ---------- The export ---------- */

export function reviewMarkdown(input: ReviewMarkdownInput): ReviewMarkdown {
  const { key, pr, agent, data, state } = input;
  const repo = `${key.owner}/${key.name}`;
  const reviewed = agent.commit;
  const mergeBase = data && data.head.sha === reviewed ? data.mergeBase : null;
  const diff = mergeBase ? data : null;
  const index = diff ? new AnchorIndex(diff) : null;
  const commits = { reviewed, mergeBase };
  const moved = !!pr.headRefOid && pr.headRefOid !== reviewed;
  const out: string[] = [];
  const section = (title: string, body: string) => body.trim() && out.push(`## ${title}\n\n${body.trim()}`);

  // Where a line is, as `path:line` with a permalink, or the path alone when the line isn't in the diff.
  const where = (ref: LineRef) => {
    if (ref.line == null) return code(ref.path);
    const link = permalink(repo, ref, commits);
    const at = code(`${ref.path}:${ref.line}${ref.endLine ? `-${ref.endLine}` : ""}`);
    return `${at}${ref.side === "old" ? " (removed line, base side)" : ""}${link ? ` · [permalink](${link})` : ""}`;
  };

  out.push(`# Agent review of ${prKeyString(key)}: ${oneLine(pr.title) || `Pull request #${key.number}`}`);
  out.push(
    [
      `This is what Diffline's review agents found on this pull request. Paths are relative to the repository root, and line numbers are in the reviewed commit named under Git references (lines marked "removed" are in the merge base).`,
      `The findings are claims to verify against the code, not facts.`,
    ].join(" "),
  );

  /* Git references */
  const refs: string[] = [];
  refs.push(`- Repository: ${repo} (https://github.com/${repo})`);
  refs.push(`- Pull request: #${key.number}${pr.url ? ` (${pr.url})` : ""}`);
  if (pr.author?.login) refs.push(`- Author: @${pr.author.login}${pr.author.name && pr.author.name !== pr.author.login ? ` (${oneLine(pr.author.name)})` : ""}`);
  if (pr.baseRefName || pr.headRefName) refs.push(`- Base branch: ${code(pr.baseRefName || "unknown")} · head branch: ${code(pr.headRefName || "unknown")}`);
  refs.push(`- Reviewed commit (the head when the agents ran): ${code(reviewed)}`);
  if (moved) refs.push(`- Current head: ${code(pr.headRefOid!)}. The pull request moved on since the review; everything here refers to the reviewed commit.`);
  refs.push(mergeBase ? `- Merge base: ${code(mergeBase)}` : `- Merge base: not known here; ${code(`git merge-base origin/${pr.baseRefName || "<base branch>"} ${reviewed}`)} prints it.`);
  const sh = [
    `git fetch origin pull/${key.number}/head`,
    ...(moved ? [`# The pull request moved on; if the reviewed commit isn't in what was fetched: git fetch origin ${reviewed}`] : []),
    `git checkout --detach ${reviewed}`,
    `git diff ${mergeBase || `$(git merge-base origin/${pr.baseRefName || "main"} ${reviewed})`}...${reviewed} --stat`,
  ];
  section("Git references", `${refs.join("\n")}\n\nTo get the code:\n\n${codeBlock(sh.join("\n"), "sh")}`);

  /* Summary */
  const names = agent.agents.map((a) => a.name || a.id);
  const ran = agent.ranAt && !Number.isNaN(Date.parse(agent.ranAt)) ? ` on ${new Date(agent.ranAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  section("Summary", [agent.lede ? safeMarkdown(agent.lede, 3) : "", names.length ? `Agents that ran${ran}: ${names.map(oneLine).join(", ")}.` : ""].filter(Boolean).join("\n\n"));

  /* Description check */
  if (agent.description && agent.description.items.length) {
    const d = agent.description;
    const lines = [`Checked as a ${d.kind === "feature" ? "feature" : "fix"}.${d.why ? ` ${oneLine(d.why)}` : ""}`, ""];
    for (const it of d.items) {
      const title = DESC_RULES[it.rule]?.title || it.rule;
      const parts = [`- **${oneLine(title)}**: ${DESC_STATUS[it.status] || it.status}.`];
      if (it.quote) parts.push(`Quote: “${oneLine(it.quote)}”`);
      if (it.note) parts.push(oneLine(it.note));
      const gap = it.status === "partly" || it.status === "missing";
      if (gap && it.ask) parts.push(`Question for the author: ${oneLine(it.ask)}`);
      if (gap) {
        const dec = state?.desc?.[it.rule];
        const word = dec?.state === "asked" ? (dec.posted ? "asked in a posted review" : "asked (in my review summary)") : dec?.state === "skipped" ? `skipped (${oneLine(dec.reason || "no reason given")})` : "not decided";
        parts.push(`My decision: ${word}.`);
      }
      lines.push(parts.join(" "));
      for (const r of it.refs || []) lines.push(`  - ${where(resolveLine(diff, index, r.path, r.match))}`);
    }
    section("Description check", lines.join("\n"));
  }

  /* Findings */
  const all = agent.findings.map((f) => ({ f, status: findingStatus(state, f, agent.ranAt) }));
  const shown = input.openOnly ? all.filter((x) => x.status.kind === "open") : all;
  const number = new Map(shown.map((x, i) => [x.f.id, i + 1]));
  if (shown.length) {
    const blocks: string[] = [];
    if (input.openOnly && shown.length < all.length) {
      blocks.push(`Open findings only: ${all.length - shown.length} of ${all.length} (dismissed, or already in my review) are left out.`);
    }
    shown.forEach(({ f, status }, i) => {
      const parts: string[] = [];
      parts.push(`### ${i + 1}. ${SEV_WORD[f.severity] || f.severity} · ${f.label}: ${oneLine(f.title)}`);
      parts.push(`Agent: ${f.agent} · Confidence: ${f.confidence} · Status: ${statusWord(status)} · Id: ${f.id}`);
      const at = resolveLine(diff, index, f.path, f.match);
      if (at.line == null) {
        parts.push(`**Location**: ${code(at.path)} (the line isn't in the diff of the reviewed commit; the agent quoted it as below)\n\n${codeBlock(at.text, langOf(at.path))}`);
      } else {
        parts.push(`**Location**: ${where(at)}\n\n${codeBlock(at.text, langOf(at.path))}`);
      }
      if (f.body) parts.push(safeMarkdown(f.body));
      if (f.steps && f.steps.length) {
        parts.push(
          `**Steps**\n\n` +
            f.steps
              .map((s, j) => {
                const ref = resolveLine(diff, index, s.path || f.path, s.match);
                return `${j + 1}. ${where(ref)}: ${oneLine(s.text)}${ref.line == null ? ` (${code(oneLine(s.match))})` : ""}`;
              })
              .join("\n"),
        );
      }
      if (f.fix && f.fix.text) parts.push(`**Suggested fix**\n\n${safeMarkdown(f.fix.text)}`);
      if (f.comment) parts.push(`**Draft review comment**\n\n${quote(safeMarkdown(f.comment))}`);
      const follow = (f.followups || []).map((q) => (typeof q === "string" ? q : (q as { q?: string })?.q || "")).filter((q) => q && q.trim());
      if (follow.length) parts.push(`**Follow-ups**\n\n${follow.map((q) => `- ${oneLine(q)}`).join("\n")}`);
      blocks.push(parts.join("\n\n"));
    });
    section("Findings", blocks.join("\n\n"));
  } else if (all.length) {
    section("Findings", `No open findings: all ${all.length} are dismissed or already in my review.`);
  }

  /* Checked and fine */
  if (agent.checked.length) {
    section("Checked and fine", agent.checked.map((c) => `- ${c.agent}${c.path ? ` · ${code(c.path)}` : ""}: ${oneLine(c.text)}`).join("\n"));
  }

  /* Reading order */
  const chapters = agent.plan?.chapters || [];
  if (chapters.length) {
    section(
      "Reading order",
      chapters
        .map((c, i) => [`${i + 1}. **${oneLine(c.title)}**${c.note ? `: ${oneLine(c.note)}` : ""}`, ...c.files.map((p) => `   - ${code(p)}`)].join("\n"))
        .join("\n"),
    );
  }

  /* Flows */
  const flows = (agent.diagrams || []).filter((g) => g && g.nodes && g.nodes.length);
  if (flows.length) section("Flows", flows.map((g) => flowMarkdown(g, (path, match, removed, end, lines) => where(resolveLine(diff, index, path, match, { prefer: removed ? "old" : "new", end, lines })), number)).join("\n\n"));

  out.push(`---\n\nExported by Diffline${input.version ? ` ${input.version}` : ""} on ${(input.now || new Date()).toISOString().slice(0, 10)}.`);
  return { markdown: out.join("\n\n") + "\n", findings: shown.length, total: all.length };
}

const CHANGE_WORD = { added: "new", changed: "changed", removed: "removed" } as const;

/** A diagram as a Mermaid flowchart, with each box's lines listed under it. */
function flowMarkdown(
  g: Diagram,
  where: (path: string, match: string, removed: boolean, end?: string, lines?: number) => string,
  number: Map<string, number>,
): string {
  const ids = new Map(g.nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const shape = (n: Diagram["nodes"][number]) => {
    const label = `"${mermaidText(n.label)}"`;
    return n.kind === "actor" ? `([${label}])` : n.kind === "data" ? `[(${label})]` : `[${label}]`;
  };
  const chart = ["flowchart TD"];
  for (const n of g.nodes) chart.push(`  ${ids.get(n.id)}${shape(n)}`);
  for (const e of g.edges || []) {
    const from = ids.get(e.from), to = ids.get(e.to);
    if (!from || !to || from === to) continue;
    const arrow = e.change === "removed" ? "-.->" : e.change === "added" ? "==>" : "-->";
    chart.push(`  ${from} ${arrow}${e.label ? `|"${mermaidText(e.label)}"|` : ""} ${to}`);
  }
  for (const c of ["added", "changed", "removed"] as const) {
    const these = g.nodes.filter((n) => n.change === c).map((n) => ids.get(n.id));
    if (these.length) chart.push(`  class ${these.join(",")} ${c}`);
  }
  if (g.nodes.some((n) => n.change)) {
    chart.push("  classDef added stroke:#1a7f37,stroke-width:2px", "  classDef changed stroke:#9a6700,stroke-width:2px", "  classDef removed stroke:#cf222e,stroke-dasharray:4 3");
  }
  const list = g.nodes.map((n) => {
    const bits = [`- ${ids.get(n.id)} **${oneLine(n.label)}**${n.change ? ` (${CHANGE_WORD[n.change]})` : ""}${n.detail ? `: ${oneLine(n.detail)}` : ""}`];
    if (n.change === "changed" && n.before && (n.before.label || n.before.detail)) bits.push(`· before: ${oneLine([n.before.label, n.before.detail].filter(Boolean).join(": "))}`);
    const lines = (n.refs || []).map((r) => where(r.path, r.match, n.change === "removed", r.end, r.lines));
    const finds = (n.findings || []).map((id) => (number.has(id) ? `finding ${number.get(id)} (${id})` : id));
    const sub = [...lines.map((l) => `  - ${l}`), ...(finds.length ? [`  - Findings: ${finds.join(", ")}`] : [])];
    return [bits.join(" "), ...sub].join("\n");
  });
  const head = `### ${oneLine(g.title)}${g.summary ? `\n\n${oneLine(g.summary)}` : ""}`;
  return `${head}\n\n${codeBlock(chart.join("\n"), "mermaid")}\n\n${list.join("\n")}`;
}
