import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AnchorIndex } from "../src/agents/validate.ts";
import { code, codeBlock, findingStatus, mermaidText, permalink, resolveLine, reviewMarkdown, safeMarkdown, type ReviewMarkdownInput } from "../src/core/review-markdown.ts";
import type { AgentFile, DiffLine, Finding, ReviewData, ReviewState } from "../src/core/types.ts";

const DATA: ReviewData = JSON.parse(readFileSync(new URL("./fixtures/review-data.json", import.meta.url), "utf8"));
const AGENT: AgentFile = JSON.parse(readFileSync(new URL("./fixtures/agent-file.json", import.meta.url), "utf8"));
const HEAD = DATA.head.sha;
const BASE = DATA.mergeBase;
const KEY = { owner: "acme", name: "web", number: 12 };
const PR = { title: "Add promo codes at checkout", url: "https://github.com/acme/web/pull/12", author: { login: "alex-doe", name: "Alex Doe" }, baseRefName: "main", headRefName: "feature/promo-codes", headRefOid: HEAD };
const NOW = new Date("2026-10-12T09:00:00Z");

const input = (over: Partial<ReviewMarkdownInput> = {}): ReviewMarkdownInput => ({ key: KEY, pr: PR, agent: AGENT, data: DATA, state: null, version: "9.9.9", now: NOW, ...over });
const md = (over: Partial<ReviewMarkdownInput> = {}) => reviewMarkdown(input(over)).markdown;
const agentWith = (over: Partial<AgentFile>): AgentFile => ({ ...structuredClone(AGENT), ...over });
const finding = (over: Partial<Finding>): Finding => ({
  id: "correctness-00000001", agent: "correctness", severity: "medium", confidence: "Worth asking", label: "question", path: "src/cart/cart.ts", match: "const discounted = subtotal - discount;",
  title: "T", body: "B", comment: "C", ...over,
});
/** The text of one "## " section, without its heading. */
const sectionOf = (text: string, title: string) => {
  const m = new RegExp(`\\n## ${title}\\n\\n([\\s\\S]*?)(?=\\n## |\\n---\\n)`).exec(text);
  return m ? m[1].replace(/\n+$/, "") : null;
};

test("review markdown: sections in order, title, note for the receiving agent, footer", () => {
  const text = md();
  assert.ok(text.startsWith("# Agent review of acme/web#12: Add promo codes at checkout\n\n"));
  assert.match(text, /Paths are relative to the repository root, and line numbers are in the reviewed commit/);
  assert.match(text, /claims to verify against the code, not facts/);
  const order = ["Git references", "Summary", "Description check", "Findings", "Checked and fine", "Reading order", "Flows"].map((t) => text.indexOf(`\n## ${t}\n`));
  assert.ok(order.every((i) => i > 0), "every section is there");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the designed order");
  assert.ok(text.endsWith("---\n\nExported by Diffline 9.9.9 on 2026-10-12.\n"));
  assert.doesNotMatch(text, /generated (with|by) (an )?AI|Claude|Codex/i);
  assert.equal(reviewMarkdown(input({ version: undefined })).markdown.split("\n").at(-2), "Exported by Diffline on 2026-10-12.");
});

test("review markdown: git references, and a pull request that moved on since the review", () => {
  const refs = sectionOf(md(), "Git references")!;
  assert.match(refs, /- Repository: acme\/web \(https:\/\/github\.com\/acme\/web\)/);
  assert.match(refs, /- Pull request: #12 \(https:\/\/github\.com\/acme\/web\/pull\/12\)/);
  assert.match(refs, /- Author: @alex-doe \(Alex Doe\)/);
  assert.match(refs, /- Base branch: `main` · head branch: `feature\/promo-codes`/);
  assert.match(refs, new RegExp(`- Reviewed commit \\(the head when the agents ran\\): \`${HEAD}\``));
  assert.match(refs, new RegExp(`- Merge base: \`${BASE}\``));
  assert.ok(refs.includes(["```sh", "git fetch origin pull/12/head", `git checkout --detach ${HEAD}`, `git diff ${BASE}...${HEAD} --stat`, "```"].join("\n")));
  assert.doesNotMatch(refs, /Current head|moved on/);

  // The agents ran on an older push: references stay on the reviewed commit, and the current head is named.
  const now = "c".repeat(40);
  const moved = sectionOf(md({ pr: { ...PR, headRefOid: now } }), "Git references")!;
  assert.match(moved, new RegExp(`- Current head: \`${now}\`. The pull request moved on since the review`));
  assert.match(moved, new RegExp(`git checkout --detach ${HEAD}\n`));
  assert.match(moved, new RegExp(`# The pull request moved on; if the reviewed commit isn't in what was fetched: git fetch origin ${HEAD}`));
  assert.ok(moved.indexOf("Current head") > moved.indexOf("Reviewed commit"));

  // Without a diff at the reviewed commit, the merge base isn't known: say how to get it.
  const none = sectionOf(md({ data: null }), "Git references")!;
  assert.match(none, /- Merge base: not known here; `git merge-base origin\/main f53a7f5/);
  assert.match(none, new RegExp(`git diff \\$\\(git merge-base origin/main ${HEAD}\\)\\.\\.\\.${HEAD} --stat`));
  // A diff built for another commit isn't used for line numbers.
  const other = md({ data: { ...DATA, head: { ...DATA.head, sha: "d".repeat(40) } } });
  assert.match(other, /Merge base: not known here/);
  assert.doesNotMatch(sectionOf(other, "Findings")!, /permalink/);
});

test("resolveLine: new side for added and unchanged lines, base side for removed ones, renamed files, unresolved", () => {
  const ix = new AnchorIndex(DATA);
  const added = resolveLine(DATA, ix, "src/cart/cart.ts", "const discounted = subtotal - discount;");
  assert.deepEqual([added.path, added.side, added.line, added.text], ["src/cart/cart.ts", "new", 36, "  const discounted = subtotal - discount;"]);
  const context = resolveLine(DATA, ix, "src/cart/cart.ts", "export interface CartItem {");
  assert.deepEqual([context.side, context.line], ["new", 4]);
  const removed = resolveLine(DATA, ix, "src/cart/cart.ts", "const tax = Math.round(subtotal * TAX_RATE);");
  assert.deepEqual([removed.side, removed.line], ["old", 34]);
  // Whitespace differences and a wrong path, repaired the way validation does.
  assert.equal(resolveLine(DATA, ix, "src/cart/cart.ts", "const   discounted = subtotal -  discount;").line, 36);
  const moved = resolveLine(DATA, ix, "cart.ts", "const discounted = subtotal - discount;");
  assert.deepEqual([moved.path, moved.line], ["src/cart/cart.ts", 36]);
  // Not in the diff: the path stays, the quoted text is kept, there's no number.
  const gone = resolveLine(DATA, ix, "src/payments/provider.ts", "apiKey: process.env.PAYMENTS_KEY");
  assert.deepEqual([gone.path, gone.line, gone.text], ["src/payments/provider.ts", null, "apiKey: process.env.PAYMENTS_KEY"]);
  assert.equal(resolveLine(null, null, "src/cart/cart.ts", "const discounted").line, null);
  // Diagram steps that show removed code look at removed lines first; a range ends on its last line.
  const range = resolveLine(DATA, ix, "src/checkout/checkout.ts", "const parsed = CheckoutRequest.safeParse(input);", { end: "const req = parsed.data;" });
  assert.deepEqual([range.line, range.endLine], [14, 18]);

  // A removed line in a renamed file is named by its old path, on the base side.
  const line = (t: DiffLine[0], text: string, o: number | null, n: number | null): DiffLine => [t, o, n, text, 0, 0];
  const renamed: ReviewData = {
    ...DATA,
    files: [{ path: "src/new/name.ts", oldPath: "src/old/name.ts", status: "renamed", similarity: 90, binary: false, lang: "ts", generated: false, additions: 1, deletions: 1, tests: null,
      hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, section: "", fresh: false, lines: [line("-", "export const a = 1;", 4, null), line("+", "export const a = 2;", null, 4)] }] }],
  };
  const r = resolveLine(renamed, new AnchorIndex(renamed), "src/new/name.ts", "export const a = 1;");
  assert.deepEqual([r.path, r.side, r.line], ["src/old/name.ts", "old", 4]);
  assert.equal(permalink("acme/web", r, { reviewed: HEAD, mergeBase: BASE }), `https://github.com/acme/web/blob/${BASE}/src/old/name.ts#L4`);
});

test("permalinks: the reviewed commit for new lines, the merge base for removed ones, ranges, encoded paths", () => {
  const commits = { reviewed: HEAD, mergeBase: BASE };
  const ref = (over: object) => ({ path: "src/a.ts", side: "new" as const, line: 3, text: "", file: null, ...over });
  assert.equal(permalink("acme/web", ref({}), commits), `https://github.com/acme/web/blob/${HEAD}/src/a.ts#L3`);
  assert.equal(permalink("acme/web", ref({ side: "old" }), commits), `https://github.com/acme/web/blob/${BASE}/src/a.ts#L3`);
  assert.equal(permalink("acme/web", ref({ endLine: 9 }), commits), `https://github.com/acme/web/blob/${HEAD}/src/a.ts#L3-L9`);
  assert.equal(permalink("acme/web", ref({ path: "docs/my notes#1.md" }), commits), `https://github.com/acme/web/blob/${HEAD}/docs/my%20notes%231.md#L3`);
  assert.equal(permalink("acme/web", ref({ line: null }), commits), null);
  assert.equal(permalink("acme/web", ref({ side: "old" }), { reviewed: HEAD, mergeBase: null }), null);
});

test("review markdown: each finding's heading, line, location, code, steps, fix, comment and follow-ups", () => {
  const text = sectionOf(md(), "Findings")!;
  assert.match(text, /^### 1\. High · blocking: Redemption limit can be exceeded by concurrent checkouts\n\nAgent: correctness · Confidence: High confidence · Status: open · Id: correctness-a7f05b87\n/m);
  assert.ok(text.includes(`**Location**: \`src/checkout/checkout.ts:54\` · [permalink](https://github.com/acme/web/blob/${HEAD}/src/checkout/checkout.ts#L54)\n\n\`\`\`ts\n    await db.promoCodes.increment(promo.code, "redemptions");\n\`\`\``));
  assert.ok(text.includes(`1. \`src/promotions/promo.ts:51\` · [permalink](https://github.com/acme/web/blob/${HEAD}/src/promotions/promo.ts#L51): The limit is read here, before the charge`));
  assert.match(text, /\*\*Suggested fix\*\*\n\nReserve the redemption atomically/);
  assert.match(text, /```sql\nUPDATE promo_codes/);
  assert.match(text, /\*\*Draft review comment\*\*\n\n> Two checkouts racing/);
  assert.match(text, /\*\*Follow-ups\*\*\n\n- Is `max_redemptions` a hard limit/);
  // A removed line, on the base side.
  assert.ok(text.includes(`**Location**: \`src/cart/cart.ts:34\` (removed line, base side) · [permalink](https://github.com/acme/web/blob/${BASE}/src/cart/cart.ts#L34)`));
  // Not in the diff: the path and the quoted line, no number.
  assert.ok(text.includes("**Location**: `src/payments/provider.ts` (the line isn't in the diff of the reviewed commit; the agent quoted it as below)\n\n```ts\napiKey: process.env.PAYMENTS_KEY\n```"));
  assert.doesNotMatch(text, /provider\.ts:\d/);
  // In the order of the agent file (as the page lists them), numbered from 1.
  assert.deepEqual([...text.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1])), [1, 2, 3, 4, 5]);
  // A step that isn't in the diff keeps its path and quotes its text.
  const lost = md({ agent: agentWith({ findings: [finding({ steps: [{ match: "nowhere to be found", text: "Gone" }] })] }) });
  assert.match(lost, /1\. `src\/cart\/cart\.ts`: Gone \(`nowhere to be found`\)/);
});

test("finding status from the page's state: open, added, posted, dismissed with its reason; legacy ids need their run", () => {
  const state: ReviewState = {
    drafts: [{ id: "d1" }],
    findings: {
      a: { state: "accepted", draft: "d1", run: "r1" },
      b: { state: "accepted", draft: "d2", run: "r1" },
      c: { state: "dismissed", reason: "Intended", run: "r0" },
      f1: { state: "dismissed", reason: "Not a problem" },
      f2: { state: "dismissed", reason: "Not a problem", run: "r1" },
    },
  };
  assert.deepEqual(findingStatus(state, { id: "a" }, "r1"), { kind: "added" });
  assert.deepEqual(findingStatus(state, { id: "b" }, "r1"), { kind: "posted" });
  assert.deepEqual(findingStatus(state, { id: "c" }, "r1"), { kind: "dismissed", reason: "Intended" }, "a decision from an earlier run still counts");
  assert.deepEqual(findingStatus(state, { id: "f1" }, "r1"), { kind: "open" }, "a positional id without its run doesn't");
  assert.deepEqual(findingStatus(state, { id: "f2" }, "r1"), { kind: "dismissed", reason: "Not a problem" });
  assert.deepEqual(findingStatus(state, { id: "x" }, "r1"), { kind: "open" });
  assert.deepEqual(findingStatus(null, { id: "a" }, "r1"), { kind: "open" });

  const [hi, mid, tax, tests] = AGENT.findings;
  const page: ReviewState = {
    drafts: [{ id: "d1" }],
    findings: { [mid.id]: { state: "accepted", draft: "d1", run: AGENT.ranAt }, [tax.id]: { state: "accepted", draft: "gone", run: AGENT.ranAt }, [tests.id]: { state: "dismissed", reason: "Out of scope", run: AGENT.ranAt } },
  };
  const text = md({ state: page });
  assert.match(text, new RegExp(`Status: open · Id: ${hi.id}`));
  assert.match(text, new RegExp(`Status: added to my review · Id: ${mid.id}`));
  assert.match(text, new RegExp(`Status: posted · Id: ${tax.id}`));
  assert.match(text, new RegExp(`Status: dismissed \\(Out of scope\\) · Id: ${tests.id}`));
});

test("open findings only: leaves out dismissed, added and posted ones, and renumbers", () => {
  const [hi, mid, tax, tests, sec] = AGENT.findings;
  const state: ReviewState = {
    drafts: [{ id: "d1" }],
    findings: { [mid.id]: { state: "accepted", draft: "d1", run: AGENT.ranAt }, [tax.id]: { state: "accepted", run: AGENT.ranAt }, [tests.id]: { state: "dismissed", reason: "Out of scope", run: AGENT.ranAt } },
  };
  const out = reviewMarkdown(input({ state, openOnly: true }));
  assert.equal(out.findings, 2);
  assert.equal(out.total, 5);
  const text = sectionOf(out.markdown, "Findings")!;
  assert.match(text, /^Open findings only: 3 of 5 \(dismissed, or already in my review\) are left out\./);
  assert.deepEqual([...text.matchAll(/Id: ([\w-]+)/g)].map((m) => m[1]), [hi.id, sec.id]);
  assert.match(text, /### 2\. Low · nit: Provider key read without a check/);
  // The flow names findings by their number in this export, and by id when they're left out.
  assert.match(out.markdown, new RegExp(`Findings: finding 1 \\(${hi.id}\\), ${tests.id}`));
  // Everything shown when not filtered.
  assert.equal(reviewMarkdown(input({ state })).findings, 5);

  // Everything decided: the section says so instead of listing nothing.
  const all: ReviewState = { findings: Object.fromEntries(AGENT.findings.map((f) => [f.id, { state: "dismissed", reason: "Intended", run: AGENT.ranAt }])) };
  const none = reviewMarkdown(input({ state: all, openOnly: true }));
  assert.equal(none.findings, 0);
  assert.equal(sectionOf(none.markdown, "Findings"), "No open findings: all 5 are dismissed or already in my review.");
});

test("description check: kind, each rule with its state, the question and the reviewer's ask or skip", () => {
  const state: ReviewState = { desc: { why: { state: "asked" }, diagram: { state: "skipped", reason: "Not needed here" }, risks: { state: "asked", posted: true } } };
  const text = sectionOf(md({ state }), "Description check")!;
  assert.match(text, /^Checked as a feature\. It adds a new capability customers use\./);
  assert.match(text, /- \*\*What changes\*\*: Covered\. Quote: “Adds promo codes to checkout\.”\n/);
  assert.match(text, /- \*\*Why\*\*: Missing\. .* Question for the author: What's the reason .* My decision: asked \(in my review summary\)\./);
  assert.match(text, /- \*\*Diagram\*\*: Missing\. .* My decision: skipped \(Not needed here\)\./);
  assert.match(text, /- \*\*Rollout\*\*: Partly covered\. .* My decision: not decided\.\n  - `src\/db\/migrations\/0007_promo_codes\.sql:2` · \[permalink\]/);
  assert.match(text, /- \*\*Dependencies\*\*: None found\.\n/);
  assert.match(text, /- \*\*Risks\*\*: Missing\. .* My decision: asked in a posted review\./);
  assert.doesNotMatch(text.split("\n").find((l) => l.includes("What changes"))!, /My decision/, "covered rules have nothing to decide");
});

test("checked notes, reading order and the summary", () => {
  const text = md();
  assert.equal(
    sectionOf(text, "Checked and fine"),
    [
      "- guide: The description matches what the diff does.",
      "- security · `src/checkout/checkout.ts`: The promo code is validated with zod and capped at 32 characters before it reaches the database.",
      "- correctness · `src/lib/money.ts`: `percentOf` rounds down, so a percentage discount never exceeds what was advertised.",
    ].join("\n"),
  );
  assert.match(sectionOf(text, "Reading order")!, /^1\. \*\*The promo code model\*\*: The table and the type everything else uses\.\n   - `src\/db\/migrations\/0007_promo_codes\.sql`\n/);
  assert.match(sectionOf(text, "Summary")!, /^Adds promo codes end to end.*\n\nAgents that ran on 2026-10-10 14:32 UTC: Guide agent, Correctness agent, Security agent, Tests agent\.$/);
});

test("flows: a Mermaid flowchart with escaped labels, and each box's lines under it", () => {
  const text = sectionOf(md(), "Flows")!;
  assert.match(text, /^### Applying a promo code at checkout\n\nThe code goes from the field/);
  const chart = /```mermaid\n([\s\S]*?)\n```/.exec(text)![1].split("\n");
  assert.equal(chart[0], "flowchart TD");
  assert.ok(chart.includes('  n1(["Customer"])'), "actors are rounded");
  assert.ok(chart.includes('  n4[("promo_codes")]'), "data is a cylinder");
  assert.ok(chart.includes('  n1 -->|"types #quot;FALL15#quot;"| n2'), "quotes in labels are escaped");
  assert.ok(chart.includes('  n3 -->|"promo #124; undefined"| n5'));
  assert.ok(chart.includes("  n3 -.-> n6"), "removed edges are dotted");
  assert.ok(chart.includes('  n2 ==>|"POST /checkout"| n3'), "added edges are thick");
  assert.ok(chart.includes("  class n6 removed"));
  assert.ok(text.includes(`- n6 **Tax on the full subtotal** (removed)\n  - \`src/cart/cart.ts:34\` (removed line, base side) · [permalink](https://github.com/acme/web/blob/${BASE}/src/cart/cart.ts#L34)`));
  assert.ok(text.includes(`- n3 **checkout()** (changed): Parses the request and validates the code · before: checkout(req): Typed request, no validation\n  - \`src/checkout/checkout.ts:14-18\` · [permalink](https://github.com/acme/web/blob/${HEAD}/src/checkout/checkout.ts#L14-L18)`));

  assert.equal(mermaidText('a "b" <c> #d `e` | f\nnext'), "a #quot;b#quot; #lt;c#gt; #35;d #96;e#96; #124; f next");
  // Ids an agent picked never reach Mermaid, so odd ones can't break the chart.
  const odd = md({ agent: agentWith({ diagrams: [{ id: "x", title: "T", short: "T", summary: "", nodes: [{ id: "end", label: "A" }, { id: 'b"]; click', label: "B" }], edges: [{ from: "end", to: 'b"]; click' }] }] }) });
  assert.match(odd, /flowchart TD\n  n1\["A"\]\n  n2\["B"\]\n  n1 --> n2\n```/);
});

test("fence safety: agent Markdown can't break the export's structure", () => {
  // Headings are demoted below the finding's own, outside code only.
  assert.equal(safeMarkdown("# Big\n## Less\n```\n# a comment in code\n```\ntext"), "#### Big\n##### Less\n```\n# a comment in code\n```\ntext");
  assert.equal(safeMarkdown("###### Deep"), "###### Deep");
  // A fence the text leaves open is closed, with the same fence.
  assert.equal(safeMarkdown("Look:\n~~~~js\nconst a = 1;"), "Look:\n~~~~js\nconst a = 1;\n~~~~");
  assert.equal(safeMarkdown("````\n```\nstill code\n````\n# after"), "````\n```\nstill code\n````\n#### after");
  // Setext headings become text.
  assert.equal(safeMarkdown("Title\n=====\nMore\n---"), "Title\n\n=====\nMore\n\n---");
  assert.equal(safeMarkdown("- item\n---"), "- item\n---", "a rule after a list item stays a rule");
  // Quoted code with backtick fences in it gets a longer fence.
  assert.equal(codeBlock("x\n```\ny", "md"), "````md\nx\n```\ny\n````");
  assert.equal(codeBlock("````", ""), "`````\n````\n`````");
  assert.equal(code("a`b"), "`` a`b ``");

  const evil = finding({
    title: "Line\nbreak # in title",
    body: "# Heading\nSome text\n```js\nnever closed",
    fix: { text: "## Fix\nDo it" },
    comment: "Quote ```this``` and\n# that",
    match: "const discounted = subtotal - discount;",
  });
  const text = md({ agent: agentWith({ findings: [evil] }) });
  assert.match(text, /### 1\. Medium · question: Line break # in title\n/);
  assert.match(text, /#### Heading\nSome text\n```js\nnever closed\n```\n\n\*\*Suggested fix\*\*/);
  assert.match(text, /\*\*Suggested fix\*\*\n\n##### Fix\nDo it/);
  assert.match(text, /> Quote ```this``` and\n> #### that/);
  // Every fence opened in the export is closed: the sections after the findings are still sections.
  assert.ok(sectionOf(text, "Checked and fine"));
  assert.ok(sectionOf(text, "Flows"));
  // A diff line with backticks in it.
  const ticks = structuredClone(DATA);
  ticks.files.find((f) => f.path === "src/cart/cart.ts")!.hunks[2].lines[6][3] = "  const s = ```${x}```;";
  const t2 = md({ data: ticks, agent: agentWith({ findings: [finding({ match: "const s = ```" })] }) });
  assert.match(t2, /````ts\n {2}const s = ```\$\{x\}```;\n````/);
});

test("empty sections are left out", () => {
  const bare = agentWith({ lede: "", agents: [], findings: [], checked: [], plan: undefined, description: undefined, diagrams: undefined });
  const text = md({ agent: bare });
  for (const t of ["Summary", "Description check", "Findings", "Checked and fine", "Reading order", "Flows"]) assert.doesNotMatch(text, new RegExp(`\\n## ${t}\\n`), t);
  assert.match(text, /\n## Git references\n/);
  assert.equal(reviewMarkdown(input({ agent: bare })).findings, 0);
  // A pull request without a title still gets one.
  assert.match(md({ agent: bare, pr: { title: "" } }), /^# Agent review of acme\/web#12: Pull request #12\n/);
});
