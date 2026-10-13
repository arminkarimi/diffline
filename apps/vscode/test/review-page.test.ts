// The review page (packages/review-ui/app.js) run in a small fake DOM: what it says about your review, what changed since,
// a merged or closed pull request, the notice when it changes on GitHub, and the confirm before posting on one that ended.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = await readFile(path.join(here, "..", "..", "..", "packages", "review-ui", "app.js"), "utf8");
const FIXTURE = await readFile(path.join(here, "fixtures", "review-data.json"), "utf8");

const DAY = 864e5;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const viewer = { login: "sam-reviewer", name: "Sam Reviewer" };
const alex = { login: "alex-doe", name: "Alex Doe" };

/** An element that keeps what's written into it and finds nothing inside. */
function el(id: string) {
  return {
    id, innerHTML: "", outerHTML: "", dataset: {} as Record<string, string>, style: {}, children: [] as unknown[],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {}, remove() {}, focus() {}, scrollIntoView() {}, addEventListener() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    offsetHeight: 0, firstElementChild: null,
  };
}

// The page's hunk ids (hashStr in app.js), to mark hunks reviewed in the saved state.
function hunkId(file: any, hunk: any): string {
  const text = `${file.path}\n${hunk.lines.map((l: any[]) => l[0] + l[3]).join("\n")}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

interface Options {
  pr?: Record<string, unknown>;
  live?: Record<string, unknown>;
  data?: (d: any) => void;
  state?: Record<string, unknown> | ((d: any) => Record<string, unknown>);
  route?: string;
}

function openPage(o: Options = {}) {
  const data = JSON.parse(FIXTURE);
  o.data?.(data);
  const pr = { title: "Add promo codes at checkout", author: alex, body: "", url: "https://github.com/acme/web/pull/12", state: "OPEN", isDraft: false, createdAt: ago(5), updatedAt: ago(0.5), mergedAt: null, mergedBy: null, closedAt: null, headRefOid: data.head.sha, baseRefName: "main", reviewDecision: null, mergeStateStatus: null, checks: [], reviewRequests: [], latestReviews: [], reviews: [], comments: [], lastReview: null, ...o.pr };
  const live = { repo: "acme/web", number: 12, url: pr.url, github: true, githubError: null, viewer, pr, threads: [], loadedAt: new Date().toISOString(), agent: null, state: typeof o.state === "function" ? o.state(data) : (o.state ?? null), list: [], ...o.live };
  const nodes: Record<string, ReturnType<typeof el>> = Object.fromEntries(["app", "overlay", "toasts", "notice", "push-foot", "stream"].map((id) => [id, el(id)]));
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const on = (prefix: string) => (type: string, fn: (e: any) => void) => { (listeners[prefix + type] ||= []).push(fn); };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const location = { hash: o.route ? `#${o.route}` : "" };
  const mq = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const window: Record<string, any> = {
    REVIEW_DATA: data, DIFFLINE_LIVE: live,
    DIFFLINE_HOST: { api: async (method: string, p: string, body: unknown) => { calls.push({ method, path: p, body: JSON.parse(JSON.stringify(body ?? null)) }); return { ok: true }; }, reload() {}, open() {}, runAgents() {}, metrics() {} },
    location, history: { replaceState: (_a: unknown, _b: unknown, h: string) => { location.hash = h; } },
    matchMedia: mq, localStorage: { getItem: () => null, setItem() {} }, navigator: { platform: "MacIntel", userAgent: "node" },
    addEventListener: on(""), removeEventListener() {}, scrollTo() {}, scrollY: 0, innerHeight: 900,
    getComputedStyle: () => ({ paddingTop: "0", position: "static" }), requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} }, Element: class {}, CustomEvent: class {},
    console,
  };
  window.window = window;
  window.document = {
    documentElement: { ...el("html"), dataset: {} }, body: el("body"),
    getElementById: (id: string) => nodes[id] || null,
    querySelector: (s: string) => (/^#[\w-]+$/.test(s) ? nodes[s.slice(1)] || null : null),
    querySelectorAll: () => [], createElement: () => el(""), addEventListener: on("doc:"), contains: () => false,
    hasFocus: () => true, visibilityState: "visible", activeElement: null,
  };
  vm.runInNewContext(APP, window, { filename: "app.js" });
  const click = (act: string, dataset: Record<string, string> = {}) => {
    const target = { dataset: { act, ...dataset }, disabled: false, tagName: "BUTTON" };
    for (const fn of listeners["doc:click"] || []) fn({ target: { closest: (sel: string) => (sel === "[data-act]" ? target : null) }, preventDefault() {} });
  };
  return {
    data, calls, nodes,
    html: () => nodes.app.innerHTML,
    text: () => nodes.app.innerHTML.replace(/<[^>]+>/g, "").replace(/\s+/g, " "),
    host: (m: unknown) => { for (const fn of listeners["diffline-host"] || []) fn({ detail: m }); },
    click,
  };
}

const flat = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// assert.match and doesNotMatch, without printing the whole page when they fail.
function like(text: string, re: RegExp, message = "") {
  if (!re.test(text)) assert.fail(`${message ? message + ": " : ""}expected ${re} in ${JSON.stringify(text.length > 400 ? text.slice(0, 400) + "…" : text)}`);
}
function unlike(text: string, re: RegExp, message = "") {
  const m = re.exec(text);
  if (m) assert.fail(`${message ? message + ": " : ""}didn't expect ${re}, found ${JSON.stringify(text.slice(Math.max(0, m.index - 150), m.index + 150))}`);
}
const statusOf = (html: string) => flat(/<p class="pr-status[^"]*" id="pr-status">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
const count = (html: string, s: string) => html.split(s).length - 1;
// Your gate on the Workflow tab: its classes and its text.
const youGate = (html: string) => {
  const m = /<li class="(gate [^"]*is-you)">([\s\S]*?)<\/li>/.exec(html);
  return m ? `${m[1]}: ${flat(m[2])}` : "";
};
const allReviewed = (d: any) => ({ reviewedIds: d.files.flatMap((f: any) => f.hunks.map((h: any) => hunkId(f, h))) });

test("review page: your approval, with the commits and comments since, in the status line, pill and Workflow", () => {
  const page = openPage({
    route: "workflow",
    pr: {
      reviewRequests: [viewer],
      latestReviews: [{ ...viewer, state: "APPROVED", submittedAt: ago(2) }],
      lastReview: { submittedAt: ago(2), commit: "17b83e24937d09bf70b34ca1e8c16a2ed7172156", state: "APPROVED" },
      comments: [{ ...alex, body: "Clamped it.", createdAt: ago(1) }, { ...viewer, body: "Thanks", createdAt: ago(0.5) }, { ...alex, body: "Before", createdAt: ago(3) }],
    },
    live: { threads: [{ id: "t", path: "src/promotions/promo.ts", line: null, side: "RIGHT", resolved: false, outdated: false, comments: [{ ...alex, body: "Expired codes?", createdAt: ago(0.2) }] }] },
  });
  const html = page.html();
  assert.equal(statusOf(html), "Your review is requested again · you approved this 2 days ago at 17b83e2 · 2 new commits and 2 new comments since");
  like(html, /<span class="state s-ok">Approved<\/span>/, "approved from the reviews, without a review decision");
  // One gate for you, though you're also among the requested reviewers, done because you approved.
  assert.equal(count(html, "is-you"), 1);
  assert.equal(youGate(html), "gate g-passed is-you: SR You · You approved · requested again 2 days ago at 17b83e2 · No drafts yet Finish review");
  unlike(html, /live in production|Shipped/);
});

test("review page: what you did last, in the status line and your gate", () => {
  const review = (state: string, opinion: string | null, extra: Record<string, unknown> = {}) =>
    // Reviewed at the head: the extension builds no "since" then.
    openPage({ route: "workflow", data: (d) => { d.since = null; }, pr: { lastReview: { submittedAt: ago(0.25), commit: "f53a7f581b5c4afa889751cbb4daf6d06871aebe", state }, latestReviews: opinion ? [{ ...viewer, state: opinion, submittedAt: ago(1) }] : [], ...extra } }).html();
  const commented = review("COMMENTED", null);
  assert.equal(statusOf(commented), "You commented 6 hours ago at f53a7f5 · nothing new since");
  assert.equal(youGate(commented), "gate g-info is-you: SR You · You commented 6 hours ago at f53a7f5 · No drafts yet Finish review");
  const after = review("COMMENTED", "CHANGES_REQUESTED");
  assert.equal(statusOf(after), "You requested changes, then commented 6 hours ago at f53a7f5 · nothing new since");
  like(youGate(after), /^gate g-blocked is-you: SR You · You requested changes, then commented/);
  like(after, /<span class="state s-bad">Changes requested<\/span>/);
  assert.equal(statusOf(review("DISMISSED", null)), "Your review from 6 hours ago at f53a7f5 was dismissed · nothing new since");
  // Your own pull request: no line about your review.
  assert.equal(statusOf(openPage({ pr: { author: viewer } }).html()), "");
});

test("review page: never reviewed, every hunk is new to you until it's marked, and the empty view says why", () => {
  const page = openPage({ pr: { reviewRequests: [viewer] }, data: (d) => { d.since = null; } });
  const html = page.html();
  assert.equal(statusOf(html), "Your review is requested · you haven't reviewed this yet");
  const flow = openPage({ route: "workflow", pr: { reviewRequests: [viewer] }, data: (d) => { d.since = null; } }).html();
  assert.equal(youGate(flow), "gate g-waiting is-you: SR You · Review requested No drafts yet Finish review");
  assert.equal(count(flow, "is-you"), 1, "no second gate for the request");
  const total = page.data.files.reduce((n: number, f: any) => n + f.hunks.length, 0);
  like(html, new RegExp(`New to you<b>${total}</b>`));
  unlike(html, /Welcome back/);

  const done = openPage({ data: (d) => { d.since = null; }, state: allReviewed });
  like(done.html(), /New to you<b>0<\/b>/);
  done.click("filter", { filter: "new" });
  like(flat(done.nodes.stream.innerHTML), /Nothing new to you You haven't reviewed this pull request yet, so every hunk counts as new until you mark it reviewed\. You've marked them all\./);

  // Reviewed before, all marked: caught up.
  const caught = openPage({ pr: { lastReview: { submittedAt: ago(2), commit: "17b83e24937d09bf70b34ca1e8c16a2ed7172156", state: "APPROVED" } }, state: allReviewed });
  caught.click("filter", { filter: "new" });
  like(flat(caught.nodes.stream.innerHTML), /You're caught up Everything that changed since your last review is marked reviewed\./);
});

test("review page: after a force-push the banner says the branch was rewritten, without a commit count", () => {
  const gone = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
  const pr = { lastReview: { submittedAt: ago(2), commit: gone, state: "APPROVED" }, latestReviews: [{ ...viewer, state: "APPROVED", submittedAt: ago(2) }] };
  // The clone still has the commit you reviewed: the extension diffed against it (since.index is -1).
  const kept = openPage({ pr, data: (d) => { d.since = { ...d.since, sha: gone, index: -1 }; } }).html();
  like(statusOf(kept), /^You approved this 2 days ago at 0f1e2d3 · the branch was rewritten since$/);
  like(flat(kept), /Welcome back\. The branch was rewritten since your review on \w+\. A force-push or rebase replaced 0f1e2d3 ?, the commit you reviewed, so there's no count of new commits\. Lines that differ from it have a blue mark in the margin: 7 hunks in 7 files\./);
  unlike(kept, /pushed \d+ commit|welcome-commits/);
  like(kept, /New to you<b>7<\/b>/);

  // Gone from the clone too: nothing to compare with, so every unreviewed hunk is new.
  const lost = openPage({ pr, data: (d) => { d.since = null; } });
  like(flat(lost.html()), /and it isn't in the local clone, so every hunk you haven't marked reviewed counts as new\./);
  const total = lost.data.files.reduce((n: number, f: any) => n + f.hunks.length, 0);
  like(lost.html(), new RegExp(`New to you<b>${total}</b>`));
});

test("review page: the Welcome back banner, once closed, stays closed for that head only", async () => {
  const pr = { lastReview: { submittedAt: ago(2), commit: "17b83e24937d09bf70b34ca1e8c16a2ed7172156", state: "APPROVED" } };
  const fresh = openPage({ pr });
  like(fresh.html(), /Welcome back\. Alex pushed 2 commits since your review/);
  fresh.click("banner-close");
  // The page saves its state 350 ms after a change.
  await new Promise((r) => setTimeout(r, 450));
  const head = fresh.data.head.sha;
  assert.equal(fresh.calls.filter((c) => c.path === "/state").at(-1)?.body.prefs.bannerHead, head);
  unlike(openPage({ pr, state: { prefs: { bannerHead: head } } }).html(), /Welcome back/);
  like(openPage({ pr, state: { prefs: { bannerHead: "a".repeat(40) } } }).html(), /Welcome back/, "new commits since it was closed");
  like(openPage({ pr, state: { prefs: { banner: false } } }).html(), /Welcome back/, "the old setting closed it for good");
});

test("review page: merged and closed pull requests say so, and posting on one asks first", () => {
  const merged = openPage({ route: "workflow", pr: { state: "MERGED", mergedAt: ago(3), closedAt: ago(3), mergedBy: alex, reviewDecision: "APPROVED", lastReview: { submittedAt: ago(4), commit: "f53a7f581b5c4afa889751cbb4daf6d06871aebe", state: "APPROVED" } } });
  const html = merged.html();
  assert.equal(statusOf(html), "Merged by Alex Doe 3 days ago");
  like(html, /<span class="state s-ok">Merged<\/span>/);
  like(html, /<span class="mini-label">Merged<\/span>/);
  like(html, /<li class="lane-stage st-done" id="stage-review">[\s\S]*?<span class="lane-st">Approved<\/span>/);
  like(flat(html), /Merged by Alex Doe 3 days ago You can still read it and post a review\. GitHub records it on the pull request\./);
  unlike(html, /In review|live in production/);
  merged.click("push-post");
  like(flat(merged.nodes["push-foot"].innerHTML), /^acme\/web#12 is already merged\. Post your review anyway\? GitHub still records it\. It posts as @sam-reviewer\. Back Post anyway$/);

  const closed = openPage({ pr: { state: "CLOSED", closedAt: ago(3) } });
  assert.equal(statusOf(closed.html()), "Closed 3 days ago without merging");
  like(closed.html(), /<li class="stg st-closed"|class="stg st-closed"/);
  closed.click("push-post");
  like(flat(closed.nodes["push-foot"].innerHTML), /^acme\/web#12 is already closed\. Post your review anyway\?/);

  const open = openPage();
  open.click("push-post");
  like(flat(open.nodes["push-foot"].innerHTML), /^Post as @sam-reviewer to acme\/web #12\? Everyone who can see the pull request will see it\. Back Post now$/);
});

test("review page: a change on GitHub shows one notice bar with Refresh, the latest change replacing the one before", async () => {
  const page = openPage();
  assert.equal(page.nodes.notice.innerHTML, "");
  const change = (kind: string, state = "OPEN") => ({ kind, state, head: "h", updatedAt: ago(0), stateChanged: state !== "OPEN" || kind === "reopened", newCommits: kind === "commits", updated: true, was: { state: "OPEN", head: "g", updatedAt: ago(1) } });
  page.host({ type: "host-pr-changed", key: "acme/other#12", change: change("merged", "MERGED") });
  assert.equal(page.nodes.notice.innerHTML, "", "another pull request's change");
  const words: Array<[string, string, string]> = [
    ["commits", "OPEN", "New commits were pushed."],
    ["updated", "OPEN", "Updated on GitHub."],
    ["reopened", "OPEN", "This pull request was reopened."],
    ["closed", "CLOSED", "This pull request was closed."],
    ["merged", "MERGED", "This pull request was merged."],
  ];
  for (const [kind, state, text] of words) {
    page.host({ type: "host-pr-changed", key: "ACME/web#12", change: change(kind, state) });
    assert.equal(flat(page.nodes.notice.innerHTML), `${text} Refresh`);
    assert.equal(count(page.nodes.notice.innerHTML, 'class="notice '), 1);
  }
  like(page.nodes.notice.innerHTML, /data-act="live-refresh"[\s\S]*data-act="notice-close"/);

  // Dismissed, the bar goes; the pull request is still known to be merged when posting.
  page.click("notice-close");
  assert.equal(page.nodes.notice.innerHTML, "");
  page.click("push-post");
  like(flat(page.nodes["push-foot"].innerHTML), /is already merged\. Post your review anyway\?/);

  // Refresh: saves, then asks the extension for the latest, which reloads the page.
  page.click("live-refresh");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(page.calls.map((c) => `${c.method} ${c.path}`), ["PUT /state", "POST /refresh"]);
});

test("review page: Home rows show your review, what changed since, the state and the approvals", () => {
  const row = (n: number, extra: Record<string, unknown>) => ({ key: `acme/web#${n}`, repo: "acme/web", number: n, title: `PR ${n}`, author: alex, state: "OPEN", isDraft: false, requested: false, additions: 1, deletions: 1, checks: { total: 1, failed: 0, running: 0 }, agent: { findings: 1, openHigh: 0, open: 0 }, viewerReview: null, viewerLastReview: null, sinceReview: null, reviewCounts: { approvals: 0, changesRequested: 0 }, reviewDecision: null, mergeStateStatus: null, mergedAt: null, closedAt: null, ...extra });
  const list = [
    row(1, { viewerReview: "APPROVED", viewerLastReview: { state: "APPROVED", at: ago(2), commit: "a" }, sinceReview: { newCommits: true, updated: true }, reviewCounts: { approvals: 2, changesRequested: 0 } }),
    row(2, { isDraft: true, requested: true, viewerReview: "APPROVED", viewerLastReview: { state: "COMMENTED", at: ago(0.2), commit: "b" }, sinceReview: { newCommits: false, updated: true }, reviewCounts: { approvals: 1, changesRequested: 0 } }),
    row(3, { mergeStateStatus: "DIRTY", viewerReview: "CHANGES_REQUESTED", viewerLastReview: { state: "CHANGES_REQUESTED", at: ago(1), commit: "c" }, reviewCounts: { approvals: 0, changesRequested: 1 } }),
    row(4, { state: "MERGED", mergedAt: ago(3), viewerReview: "APPROVED", viewerLastReview: { state: "APPROVED", at: ago(4), commit: "d" }, sinceReview: { newCommits: true, updated: true } }),
    row(5, { state: "CLOSED", closedAt: ago(3), viewerLastReview: { state: "COMMENTED", at: ago(4), commit: "e" } }),
    row(6, {}),
    row(7, { viewerReview: "DISMISSED", viewerLastReview: { state: "DISMISSED", at: ago(1), commit: "f" } }),
  ];
  const groups = [
    { id: "reviewed", label: "You reviewed", description: "", collapsed: false, keys: ["acme/web#1", "acme/web#2", "acme/web#3", "acme/web#6", "acme/web#7"] },
    { id: "closed", label: "Recently merged or closed", description: "", collapsed: false, keys: ["acme/web#4", "acme/web#5"] },
  ];
  const html = openPage({ live: { list, groups, grouping: { by: "relationship", sort: "risk" }, startView: "inbox" } }).html();
  const rows = Object.fromEntries([...html.matchAll(/data-key="acme\/web#(\d+)"[\s\S]*?<\/button><\/li>/g)].map((m) => [m[1], flat(m[0].replace(/^[^>]*>/, ""))]));
  like(rows[1], /PR 1 #1 · You approved 2d ago · new commits since · Agent findings decided Review · 2 approvals/);
  like(rows[2], /PR 2 Draft #2 · You approved, then commented 5h ago · re-requested · updated since/);
  like(rows[2], /Review · 1 approval/);
  like(rows[3], /PR 3 Conflicts #3 · You requested changes 1d ago · Agent findings decided Review · changes requested by 1/);
  like(rows[4], /PR 4 Merged #4 · You approved 4d ago · Agent findings decided Merged 3 days ago/, "no hints once merged");
  like(rows[5], /PR 5 Closed #5 · You commented 4d ago · Agent findings decided Closed 3 days ago/);
  like(rows[6], /PR 6 #6 · Agent findings decided Review · no approvals yet/);
  like(rows[7], /PR 7 #7 · Your review was dismissed 1d ago/);
  unlike(html, /review required/);
  like(html, /<h2 class="eyebrow">Recently merged or closed<\/h2>/);
});
