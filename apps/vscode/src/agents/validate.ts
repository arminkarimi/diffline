// Turns raw agent outputs into a valid agent file: every line anchor must resolve to a non-deleted diff line,
// chapters cover every file once, description quotes appear in the description, diagram edges join real nodes.

import { createHash } from "node:crypto";

import type { AgentFile, AgentId, AgentInfo, Chapter, CheckedNote, DescriptionItem, Diagram, Finding, ReviewData, Ref } from "../core/types.ts";
import { CONFIDENCE_ORDER, shortName, type ReviewSettings } from "./defaults.ts";
import type { GuideOutput, ReviewerOutput } from "./schema.ts";

interface Located {
  path: string;
  match: string;
  hunk: number;
  line: number;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A pull request description as it reads, for checking the guide's quotes, which copy the text rather than its
 * Markdown: a link counts as its text, and code, emphasis, heading, list and quote marks, curly quotes and spacing don't
 * matter. descPlain in the page (app.js) is the same, so a quote that passes here isn't shown as out of date there.
 */
export const descPlain = (s: string): string =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Finds diff lines by text, the way the page resolves `match` (the first line containing the text). */
export class AnchorIndex {
  private readonly files: Map<string, Array<{ type: string; text: string; hunk: number; line: number }>>;
  readonly paths: string[];

  constructor(data: ReviewData) {
    this.files = new Map();
    for (const f of data.files) {
      const lines: Array<{ type: string; text: string; hunk: number; line: number }> = [];
      f.hunks.forEach((h, hi) => h.lines.forEach((l, li) => lines.push({ type: l[0], text: l[3], hunk: hi, line: li })));
      this.files.set(f.path, lines);
    }
    this.paths = data.files.map((f) => f.path);
  }

  resolvePath(p: string | null | undefined): string | null {
    if (!p) return null;
    const clean = p.replace(/^[ab]\//, "").replace(/^\.\//, "").trim();
    if (this.files.has(clean)) return clean;
    const lower = this.paths.filter((x) => x.toLowerCase() === clean.toLowerCase());
    if (lower.length === 1) return lower[0];
    const suffix = this.paths.filter((x) => x.endsWith("/" + clean) || clean.endsWith("/" + x));
    return suffix.length === 1 ? suffix[0] : null;
  }

  private inFile(file: string, match: string): Located | null {
    const lines = this.files.get(file)!;
    const needle = match.trim();
    if (!needle) return null;
    const firstHit = lines.find((l) => l.text.includes(needle));
    if (firstHit && firstHit.type !== "-") return { path: file, match: needle, hunk: firstHit.hunk, line: firstHit.line };
    // The first line with this text is deleted: use the full text of the first non-deleted line that has it.
    const live = lines.find((l) => l.type !== "-" && l.text.includes(needle));
    if (live) {
      const full = live.text.trim();
      const first = lines.find((l) => l.text.includes(full));
      if (first && first.type !== "-") return { path: file, match: full, hunk: live.hunk, line: live.line };
    }
    // Whitespace differences: compare with runs of spaces collapsed.
    const sq = squash(needle);
    const loose = lines.find((l) => l.type !== "-" && squash(l.text).includes(sq));
    if (loose) {
      const full = loose.text.trim();
      const first = lines.find((l) => l.text.includes(full));
      if (first && first.type !== "-") return { path: file, match: full, hunk: loose.hunk, line: loose.line };
    }
    return null;
  }

  /** The full text of a located line. */
  lineText(at: Located): string {
    const hit = this.files.get(at.path)?.find((l) => l.hunk === at.hunk && l.line === at.line);
    return hit ? hit.text : at.match;
  }

  /** Resolve a (path, match) pair, repairing small mistakes. Null when no non-deleted line has the text. */
  locate(p: string | null | undefined, match: string): Located | null {
    const file = this.resolvePath(p);
    if (file) {
      const hit = this.inFile(file, match);
      if (hit) return hit;
    }
    // The agent may have named the wrong file: accept a unique hit elsewhere.
    const hits = this.paths.filter((x) => x !== file).map((x) => this.inFile(x, match)).filter((x): x is Located => !!x);
    return hits.length === 1 ? hits[0] : null;
  }
}

export interface Problems {
  dropped: string[];
  repaired: string[];
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const confRank = (c: string) => CONFIDENCE_ORDER.indexOf(c as (typeof CONFIDENCE_ORDER)[number]);
const minRank = { minor: 0, "worth-asking": 1, high: 2 } as const;
const SEV_RANK = { high: 3, medium: 2, low: 1 } as const;

function refsOf(index: AnchorIndex, refs: Array<{ path: string; match: string; end: string | null }> | undefined, problems: Problems, where: string): Ref[] {
  const out: Ref[] = [];
  for (const r of refs || []) {
    const hit = index.locate(r.path, r.match);
    if (!hit) {
      problems.dropped.push(`${where}: ref not in the diff (${r.path}: ${r.match.slice(0, 60)})`);
      continue;
    }
    out.push({ path: hit.path, match: hit.match, ...(r.end ? { end: r.end.trim() } : {}) });
  }
  return out;
}

/**
 * A value from a fixed set, or the fallback. The schemas ask for these sets, but a harness's output isn't guaranteed to
 * follow its schema, and the page puts several of these values into class names.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
const SEVERITIES = ["high", "medium", "low"] as const;
const CONFIDENCES = ["High confidence", "Worth asking", "Minor"] as const;
const LABELS = ["blocking", "question", "suggestion", "nit"] as const;
const CHANGES = ["added", "changed", "removed"] as const;

export function reviewerFindings(
  agent: AgentId,
  raw: ReviewerOutput,
  index: AnchorIndex,
  settings: ReviewSettings,
  problems: Problems,
): { findings: Array<Omit<Finding, "id"> & { at: Located }>; checked: CheckedNote[] } {
  const cfg = settings.agents[agent];
  const findings: Array<Omit<Finding, "id"> & { at: Located }> = [];
  for (const f of raw.findings || []) {
    if (confRank(f.confidence) < minRank[cfg.minConfidence]) continue;
    const at = index.locate(f.path, f.match);
    if (!at) {
      problems.dropped.push(`${agent}: "${f.title}" points at a line that isn't in the diff (${f.path})`);
      continue;
    }
    if (at.path !== f.path || at.match !== f.match.trim()) problems.repaired.push(`${agent}: anchored "${f.title}" to ${at.path}`);
    const steps = (f.steps || [])
      .map((s) => {
        const hit = index.locate(s.path || at.path, s.match);
        return hit ? { ...(hit.path !== at.path ? { path: hit.path } : {}), match: hit.match, text: s.text.trim() } : null;
      })
      .filter((s): s is NonNullable<typeof s> => !!s)
      .slice(0, 4);
    const severity = oneOf(f.severity, SEVERITIES, "medium");
    const label = oneOf(f.label, LABELS, "question");
    findings.push({
      agent,
      severity,
      confidence: oneOf(f.confidence, CONFIDENCES, "Worth asking"),
      label: label === "blocking" && severity !== "high" ? "question" : label,
      path: at.path,
      match: at.match,
      title: f.title.trim(),
      body: f.body.trim(),
      ...(steps.length ? { steps } : {}),
      ...(f.fix && f.fix.trim() ? { fix: { text: f.fix.trim() } } : {}),
      comment: f.comment.trim(),
      at,
    });
  }
  findings.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || confRank(b.confidence) - confRank(a.confidence));
  const limited = cfg.maxFindings > 0 ? findings.slice(0, cfg.maxFindings) : [];
  if (findings.length > limited.length) problems.dropped.push(`${agent}: ${findings.length - limited.length} findings over its limit of ${cfg.maxFindings}`);
  const checked = (raw.checked || [])
    .filter((c) => c.text && c.text.trim())
    .map((c) => {
      const p = index.resolvePath(c.path);
      return { agent, ...(p ? { path: p } : {}), text: c.text.trim() };
    });
  for (const f of limited) {
    if (words(f.comment) > 70) problems.repaired.push(`${agent}: "${f.title}" has a long comment (${words(f.comment)} words)`);
  }
  return { findings: limited, checked };
}

export function guideParts(raw: GuideOutput, data: ReviewData, body: string, index: AnchorIndex, settings: ReviewSettings, problems: Problems) {
  // Description check: one item per rule, in the configured order, quotes copied from the description.
  const d = raw.description;
  const kind = d.kind === "feature" ? "feature" : "fix";
  const rules = settings.descriptionRules[kind];
  const byRule = new Map(d.items.map((it) => [it.rule, it]));
  const plainBody = descPlain(body);
  const items: DescriptionItem[] = rules.map((rule) => {
    const it = byRule.get(rule);
    if (!it) {
      problems.repaired.push(`guide: description rule "${rule}" was missing`);
      return { rule, status: "missing", note: "The guide agent didn't assess this rule." };
    }
    const said = oneOf(it.status, ["covered", "partly", "missing", "none"] as const, "missing");
    const status = said === "none" && rule !== "dependencies" ? "missing" : said;
    let quote = it.quote && it.quote.trim() ? it.quote.trim() : undefined;
    const quoted = !!quote;
    if (quote && !(descPlain(quote) && plainBody.includes(descPlain(quote)))) {
      problems.repaired.push(`guide: quote for "${rule}" isn't in the description`);
      quote = undefined;
    }
    // Covered shows the text that covers the rule. Without it the agent's call stands, since nothing says the
    // description is thin, and the note says the reviewer has to check it.
    let unchecked = "";
    if (status === "covered" && !quote) {
      if (!quoted) problems.repaired.push(`guide: "${rule}" is covered without a quote`);
      unchecked = quoted
        ? "The guide agent marked this covered, but the text it quoted isn't in the description, so check it yourself."
        : "The guide agent marked this covered but didn't quote the description, so check it yourself.";
    }
    const note = [unchecked, it.note?.trim() || ""].filter(Boolean).join(" ");
    const refs = refsOf(index, it.refs, problems, `guide description ${rule}`);
    return {
      rule,
      status,
      ...(quote && (status === "covered" || status === "partly") ? { quote } : {}),
      ...(note ? { note } : {}),
      ...(it.ask && it.ask.trim() && (status === "partly" || status === "missing") ? { ask: it.ask.trim() } : {}),
      ...(refs.length ? { refs } : {}),
    } as DescriptionItem;
  });
  const description = { kind, why: d.why.trim(), items } as const;

  // Chapters: every file exactly once, in the guide's order; files it forgot go into a last chapter.
  const seen = new Set<string>();
  const chapters: Chapter[] = [];
  for (const c of raw.chapters || []) {
    const files: string[] = [];
    for (const f of c.files.map((x) => index.resolvePath(x))) {
      if (f && !seen.has(f)) {
        seen.add(f);
        files.push(f);
      }
    }
    if (!files.length) continue;
    chapters.push({
      title: c.title.trim(),
      note: c.note.trim(),
      source: { kind: c.source, text: (c.sourceText || "").trim() || (c.source === "auto" ? "Grouped by the guide agent" : c.title) },
      files,
      quiet: !!c.quiet,
    });
  }
  const rest = data.files.map((f) => f.path).filter((p) => !seen.has(p));
  if (rest.length) {
    if (chapters.length) problems.repaired.push(`guide: ${rest.length} files weren't in any chapter`);
    chapters.push({ title: chapters.length ? "Everything else" : "All changes", note: "Files the reading order doesn't place elsewhere.", source: { kind: "auto", text: "Files not placed in a chapter" }, files: rest, quiet: false });
  }

  // Diagrams: refs must resolve, edges must join real nodes.
  const diagrams: Diagram[] = [];
  for (const g of raw.diagrams || []) {
    const ids = new Set<string>();
    const nodes = g.nodes
      .filter((n) => n.id && !ids.has(n.id) && ids.add(n.id))
      .map((n) => {
        const refs = refsOf(index, n.refs, problems, `guide diagram ${g.id}/${n.id}`);
        return {
          id: n.id,
          label: n.label.trim(),
          ...(n.detail && n.detail.trim() ? { detail: n.detail.trim() } : {}),
          ...(n.kind === "actor" || n.kind === "data" ? { kind: n.kind } : {}),
          ...(CHANGES.includes(n.change as any) ? { change: n.change as (typeof CHANGES)[number] } : {}),
          ...(n.change === "changed" && (n.beforeLabel || n.beforeDetail) ? { before: { ...(n.beforeLabel ? { label: n.beforeLabel } : {}), ...(n.beforeDetail ? { detail: n.beforeDetail } : {}) } } : {}),
          ...(refs.length ? { refs } : {}),
        };
      });
    const edges = g.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(CHANGES.includes(e.change as any) ? { change: e.change as (typeof CHANGES)[number] } : {}) }));
    if (nodes.length < 2) continue;
    diagrams.push({ id: g.id || `flow-${diagrams.length + 1}`, title: g.title.trim(), short: (g.short || g.title).trim(), summary: g.summary.trim(), nodes, edges });
  }

  const checked: CheckedNote[] = (raw.checked || [])
    .filter((c) => c.text && c.text.trim())
    .map((c) => {
      const p = index.resolvePath(c.path);
      return { agent: "guide", ...(p ? { path: p } : {}), text: c.text.trim() };
    });

  return { description, plan: { chapters, reasons: (raw.reasons || []).map((r) => r.trim()).filter(Boolean) }, diagrams, checked };
}

/**
 * A finding's id: its agent and a hash of the line it's anchored to (path and the line's text, whitespace collapsed),
 * so the same agent flagging the same line on a later run gets the same id whatever its wording. Letters, digits and
 * dashes only: the page puts ids in HTML ids and attributes.
 */
export function findingId(agent: AgentId, file: string, lineText: string): string {
  return `${agent}-${createHash("sha256").update(`${file}\n${squash(lineText)}`).digest("hex").slice(0, 8)}`;
}

/** Ids for findings in their order; a second finding from the same agent on the same line gets -2, a third -3. */
export function assignIds(findings: Array<{ agent: AgentId; path: string; line: string }>): string[] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const base = findingId(f.agent, f.path, f.line);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** What an agent ran with, for AgentInfo: see review.ts runConfig. */
export type RunConfig = Pick<AgentInfo, "harness" | "model" | "thinking" | "instructions">;

/** Pin each finding to the diagram steps whose refs sit in the same hunk. */
function pinFindings(diagrams: Diagram[], findings: Array<Finding & { at?: Located }>, index: AnchorIndex) {
  for (const g of diagrams) {
    for (const n of g.nodes) {
      const hunks = (n.refs || []).map((r) => index.locate(r.path, r.match)).filter((x): x is Located => !!x);
      const pins = findings.filter((f) => f.at && hunks.some((h) => h.path === f.at!.path && h.hunk === f.at!.hunk)).map((f) => f.id);
      if (pins.length) n.findings = pins;
    }
  }
}

export function assemble(input: {
  harnessLabel: string;
  head: string;
  lede: string;
  ran: AgentId[];
  guide: ReturnType<typeof guideParts> | null;
  reviewers: Array<ReturnType<typeof reviewerFindings>>;
  index: AnchorIndex;
  settings: ReviewSettings;
  /** Per agent, the harness, model, thinking level and instructions it ran with. */
  runs?: Record<AgentId, RunConfig>;
}): AgentFile {
  const order = Object.keys(input.settings.agents);
  const all = input.reviewers.flatMap((r) => r.findings);
  all.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || order.indexOf(a.agent) - order.indexOf(b.agent));
  const ids = assignIds(all.map((f) => ({ agent: f.agent, path: f.at.path, line: input.index.lineText(f.at) })));
  const findings = all.map((f, i) => ({ ...f, id: ids[i] }));
  const diagrams = input.guide?.diagrams || [];
  pinFindings(diagrams, findings, input.index);
  const clean: Finding[] = findings.map(({ at: _at, ...f }) => f);
  return {
    version: 1,
    agent: input.harnessLabel,
    ranAt: new Date().toISOString(),
    commit: input.head,
    lede: input.lede,
    agents: input.ran.map((id) => {
      const a = input.settings.agents[id];
      return { id, name: a.name, short: shortName(a.name), focus: a.focus, ...(input.runs?.[id] || {}) };
    }),
    ...(input.guide ? { plan: input.guide.plan } : {}),
    findings: clean,
    checked: [...(input.guide?.checked || []), ...input.reviewers.flatMap((r) => r.checked)],
    ...(input.guide ? { description: input.guide.description } : {}),
    ...(diagrams.length ? { diagrams } : {}),
  };
}
