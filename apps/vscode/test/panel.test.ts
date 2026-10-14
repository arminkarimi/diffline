import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// ReviewPanel imports vscode, which only exists inside VS Code: map it to a small fake.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") return { url: new URL("./fake-vscode.ts", import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});
const fake = await import("./fake-vscode.ts");
const { ReviewPanel } = await import("../src/vscode/panel.ts");
const { prKeyString } = await import("../src/core/types.ts");

type Key = { owner: string; name: string; number: number };
const A: Key = { owner: "o", name: "r", number: 1 };
const B: Key = { owner: "o", name: "r", number: 2 };

async function extensionDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-panel-"));
  await mkdir(path.join(dir, "media", "ui"), { recursive: true });
  await writeFile(
    path.join(dir, "media", "ui", "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><script src="review-data.js"></script><script src="app.js"></script></body></html>`,
  );
  return fake.Uri.file(dir);
}

const review = (key: Key, home = false) => ({
  data: { head: { sha: "h" }, files: [] },
  live: { pr: { title: `PR ${key.number}` }, threads: [], agent: null, ...(home ? { startView: "inbox" } : {}) },
});

function fakeService(load: (key: Key, opts: { cached?: boolean; home?: boolean }) => Promise<any>, cached = true) {
  const calls: Array<{ key: string; method: string; path: string }> = [];
  const loads: Array<{ key: string; home: boolean }> = [];
  const service = {
    get: () => undefined,
    hasCachedDetail: () => cached,
    loadReview: (key: Key, opts: { cached?: boolean; home?: boolean } = {}) => {
      loads.push({ key: prKeyString(key), home: !!opts.home });
      return load(key, opts);
    },
    // The same load in the two parts the panel opens with: the page around the diff, then the diff.
    loadStaged: (key: Key, opts: { cached?: boolean; home?: boolean } = {}) => {
      loads.push({ key: prKeyString(key), home: !!opts.home });
      const p = load(key, opts);
      const first = p.then((r: any) => ({ live: r.live, detail: { pr: r.live.pr } }));
      const data = p.then((r: any) => r.data);
      first.catch(() => undefined);
      data.catch(() => undefined);
      return { first, data };
    },
    api: async (key: Key, method: string, apiPath: string) => {
      calls.push({ key: prKeyString(key), method, path: apiPath });
      return { ok: true };
    },
    pageGroups: async () => [{ id: "requested", label: "Requested", description: "2", collapsed: false, keys: [prKeyString(A), prKeyString(B)] }],
    listItems: async () => [],
    grouping: () => ({ by: "relationship", sort: "risk" }),
  };
  return { service, calls, loads };
}

/** Run the page's inline script the way the webview would, and return what it posts to the extension. */
function runPage(html: string) {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, "the page has its data script");
  const sent: any[] = [];
  const window: Record<string, any> = { addEventListener() {}, dispatchEvent() {} };
  vm.runInNewContext(script[1], { window, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => sent.push(m) }), CustomEvent: class {} });
  return { host: window.DIFFLINE_HOST, sent };
}

const settle = () => new Promise((r) => setImmediate(r));

test("ReviewPanel: a page's saves go to its own pull request while another one loads", async () => {
  // #2's first load waits until the test lets it finish; the check with GitHub after it answers at once.
  let finishB: ((v: unknown) => void) | null = null;
  const { service, calls } = fakeService((key) =>
    key.number === B.number && !finishB ? new Promise((r) => (finishB = r)) : Promise.resolve(review(key)),
  );
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  const page = runPage(webview.html);

  // The reviewer marks a file in #1 and picks #2 before the page's delayed save goes out: #1's page is still up.
  void page.host.api("PUT", "/state", { reviewedIds: ["a.ts"] });
  const opening = panel.show(B);
  webview.receive(page.sent[0]);
  await settle();
  assert.deepEqual(calls, [{ key: "o/r#1", method: "PUT", path: "/state" }]);
  assert.equal(webview.posted.at(-1).id, page.sent[0].id, "the answer goes back to the request");

  finishB!(review(B));
  await opening;
  const pageB = runPage(webview.html);
  assert.notEqual(pageB.host, page.host);
  void pageB.host.api("PUT", "/state", {});
  webview.receive(pageB.sent[0]);
  await settle();
  assert.equal(calls.at(-1)?.key, "o/r#2");
  assert.notEqual(pageB.sent[0].id, page.sent[0].id, "request ids differ between pages");
  panel.dispose();
});

test("ReviewPanel: Home after a review failed to load opens the list", async () => {
  let fail = true;
  const { service, loads } = fakeService(async (key, opts) => {
    if (fail) throw new Error("GitHub is down.");
    return review(key, opts.home);
  }, false);
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.show(B);
  const webview = fake.created.at(-1)!.webview;
  assert.match(webview.html, /didn't load\. GitHub is down\./);

  fail = false;
  await panel.showHome();
  assert.deepEqual(loads.at(-1), { key: "o/r#1", home: true }, "loads the list with its first pull request behind it");
  assert.match(webview.html, /"startView":"inbox"/);
  panel.dispose();
});

test("ReviewPanel: a new grouping or order reaches an open page without opening the list", async () => {
  const { service } = fakeService(async (key, opts) => review(key, opts.home));
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.refreshList(); // nothing open yet: returns without sending

  await panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  const before = webview.posted.length;
  (service as any).grouping = () => ({ by: "repository", sort: "created" });
  await panel.refreshList();
  const sent = webview.posted.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "host-list", "not host-view, which would switch the page to its list");
  assert.deepEqual(sent[0].grouping, { by: "repository", sort: "created" });
  assert.equal(sent[0].groups[0].keys.length, 2);
  panel.dispose();
});

test("ReviewPanel: the page's metrics reach the log through the extension, in the order they were sent", async () => {
  const { MetricsLog } = await import("../src/core/metrics-log.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-panel-metrics-"));
  const log = new MetricsLog(dir, { enabled: () => true });
  const agent = {
    version: 1, agent: "Diffline (claude)", ranAt: "2026-10-11T09:00:00.000Z", commit: "c".repeat(40), lede: "", checked: [],
    agents: [{ id: "tests", name: "Tests agent", short: "Tests", focus: "f", harness: "claude", model: "sonnet", instructions: "0123456789ab" }],
    findings: [{ id: "tests-1a2b3c4d", agent: "tests", severity: "medium", confidence: "Worth asking", label: "question", path: "a.ts", match: "x", title: "No test for x", body: "b", comment: "c" }],
  };
  const seen: Array<{ key: string; type: string }> = [];
  const { service } = fakeService(async (key) => review(key));
  // Slow agent-file reads: a later message mustn't overtake an earlier one.
  let delay = 20;
  (service as any).metrics = (key: Key, m: any) => {
    seen.push({ key: prKeyString(key), type: m.type });
    const wait = (delay -= 5);
    return log.record(key, m, () => new Promise((r) => setTimeout(() => r(agent as any), Math.max(0, wait))));
  };
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  const page = runPage(webview.html);
  const before = page.sent.length;
  page.host.metrics({ head: "c".repeat(40), run: agent.ranAt, events: [{ kind: "finding", action: "added", finding: "tests-1a2b3c4d" }] });
  page.host.metrics({ head: "c".repeat(40), run: agent.ranAt, events: [{ kind: "finding", action: "undone", finding: "tests-1a2b3c4d", reason: "added" }] });
  page.host.metrics({ head: "c".repeat(40), run: agent.ranAt, events: [{ kind: "finding", action: "dismissed", finding: "tests-1a2b3c4d", reason: "Intended" }] });
  for (const m of page.sent.slice(before)) webview.receive(m);
  assert.deepEqual(page.sent.slice(before).map((m) => m.type), ["metrics", "metrics", "metrics"]);
  assert.deepEqual(seen, [{ key: "o/r#1", type: "metrics" }, { key: "o/r#1", type: "metrics" }, { key: "o/r#1", type: "metrics" }]);
  // The panel hands each message on asynchronously; wait until all three are written (read() waits for queued writes).
  let text = "";
  for (const until = Date.now() + 2000; Date.now() < until; await new Promise((r) => setTimeout(r, 10))) {
    text = await log.read();
    if (text.trim().split("\n").length >= 3) break;
  }
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.action), ["added", "undone", "dismissed"]);
  assert.equal(lines[0].pr, "o/r#1");
  assert.deepEqual(lines[0].agent, { id: "tests", harness: "claude", model: "sonnet", instructions: "0123456789ab" });
  panel.dispose();
});

test("ReviewPanel: Show Review Metrics opens the page on its report, or switches an open page to it", async () => {
  const views: Array<string | undefined> = [];
  const { service, loads } = fakeService(async (key, opts: any) => {
    views.push(opts.view);
    return { ...review(key, opts.home), live: { ...review(key, opts.home).live, ...(opts.view ? { startView: opts.view } : {}) } };
  });
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.showMetrics();
  const webview = fake.created.at(-1)!.webview;
  assert.deepEqual(loads.at(-1), { key: "o/r#1", home: true }, "the first pull request behind it, as Home does");
  assert.equal(views.at(-1), "metrics");
  assert.match(webview.html, /"startView":"metrics"/);
  assert.equal(fake.created.at(-1)!.title, "Diffline: review metrics");

  // A reload keeps the report; with a page on screen, the command switches it without loading.
  await panel.reload();
  assert.equal(views.at(-1), "metrics");
  const before = loads.length;
  await panel.showMetrics();
  assert.equal(loads.length, before);
  assert.deepEqual(webview.posted.at(-1), { type: "host-view", view: "metrics" });
  panel.dispose();
});

test("ReviewPanel: the page asks for the metrics report and exports, and gets answers to the same request", async () => {
  const { service } = fakeService(async (key) => review(key));
  const asked: any[] = [];
  (service as any).metricsReport = async (o: any) => { asked.push(o); return { enabled: true, days: o.days, report: { total: 0 } }; };
  (service as any).metricsExport = async (format: string) => ({ text: format === "csv" ? "date\r\n" : "{}\n", name: `diffline-x.${format}`, events: 3 });
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  const page = runPage(webview.html);

  void page.host.metricsReport({ days: 90, groupBy: "model" });
  const req = page.sent.at(-1);
  assert.deepEqual({ type: req.type, key: req.key, days: req.days, groupBy: req.groupBy }, { type: "metricsReport", key: "o/r#1", days: 90, groupBy: "model" });
  webview.receive(req);
  await settle();
  assert.deepEqual(asked, [{ days: 90, groupBy: "model" }]);
  assert.deepEqual(webview.posted.at(-1), { type: "api-result", id: req.id, ok: true, data: { enabled: true, days: 90, report: { total: 0 } } });

  // Export: the extension writes the file where the save dialog says; cancelling writes nothing.
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-export-"));
  fake.saveDialog.answer = { fsPath: path.join(dir, "out.csv") };
  void page.host.metricsExport({ format: "csv", days: null });
  const ex = page.sent.at(-1);
  assert.equal(ex.type, "metricsExport");
  webview.receive(ex);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(webview.posted.at(-1), { type: "api-result", id: ex.id, ok: true, data: { saved: path.join(dir, "out.csv"), events: 3 } });
  const { readFile, stat } = await import("node:fs/promises");
  assert.equal(await readFile(path.join(dir, "out.csv"), "utf8"), "date\r\n");
  assert.equal((await stat(path.join(dir, "out.csv"))).mode & 0o777, 0o600);
  assert.deepEqual(fake.saveDialog.opened.at(-1).filters, { CSV: ["csv"] });

  fake.saveDialog.answer = undefined;
  void page.host.metricsExport({ format: "json", days: 7 });
  webview.receive(page.sent.at(-1));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(webview.posted.at(-1).data, { saved: null, events: 3 });

  // A failure reaches the page as an error.
  (service as any).metricsReport = async () => { throw new Error("disk on fire"); };
  void page.host.metricsReport({ days: 7, groupBy: "agent" });
  webview.receive(page.sent.at(-1));
  await settle();
  assert.deepEqual(webview.posted.at(-1), { type: "api-result", id: page.sent.at(-1).id, ok: false, error: "disk on fire" });
  panel.dispose();
});

test("ReviewPanel: the page asks for the agent review as Markdown; the extension copies or saves it", async () => {
  const { service } = fakeService((key) => Promise.resolve(review(key)));
  const asked: Array<{ key: string; openOnly: boolean }> = [];
  (service as any).agentReviewMarkdown = async (key: Key, opts: { openOnly?: boolean }) => {
    asked.push({ key: prKeyString(key), openOnly: !!opts.openOnly });
    return { markdown: opts.openOnly ? "# open\n" : "# all of it\n", findings: opts.openOnly ? 1 : 3, total: 3, name: "o-r-1-agent-review.md" };
  };
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  const page = runPage(webview.html);

  void page.host.agentMarkdown({ mode: "copy" });
  const req = page.sent.at(-1);
  assert.deepEqual({ type: req.type, key: req.key, mode: req.mode }, { type: "agentMarkdown", key: "o/r#1", mode: "copy" });
  webview.receive(req);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.env.clipboard.text, "# all of it\n");
  assert.deepEqual(webview.posted.at(-1), { type: "api-result", id: req.id, ok: true, data: { chars: 12, findings: 3, total: 3, copied: true, saved: null } });

  void page.host.agentMarkdown({ mode: "open" });
  webview.receive(page.sent.at(-1));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.env.clipboard.text, "# open\n");
  assert.equal(webview.posted.at(-1).data.findings, 1);

  // Save: written where the save dialog says, readable only by the user; the clipboard is left alone.
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-agent-md-"));
  fake.saveDialog.answer = { fsPath: path.join(dir, "review.md") };
  void page.host.agentMarkdown({ mode: "save" });
  webview.receive(page.sent.at(-1));
  await new Promise((r) => setTimeout(r, 20));
  const { readFile, stat } = await import("node:fs/promises");
  assert.equal(await readFile(path.join(dir, "review.md"), "utf8"), "# all of it\n");
  assert.equal((await stat(path.join(dir, "review.md"))).mode & 0o777, 0o600);
  assert.deepEqual(fake.saveDialog.opened.at(-1).filters, { Markdown: ["md"] });
  assert.match(fake.saveDialog.opened.at(-1).defaultUri.fsPath, /o-r-1-agent-review\.md$/);
  assert.deepEqual(webview.posted.at(-1).data, { chars: 12, findings: 3, total: 3, copied: false, saved: path.join(dir, "review.md") });
  assert.equal(fake.env.clipboard.text, "# open\n");

  fake.saveDialog.answer = undefined;
  void page.host.agentMarkdown({ mode: "save" });
  webview.receive(page.sent.at(-1));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(webview.posted.at(-1).data.saved, null);

  // An unknown mode copies everything; a failure reaches the page as an error.
  void page.host.agentMarkdown({ mode: "rm -rf" });
  webview.receive(page.sent.at(-1));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked.map((a) => a.openOnly), [false, true, false, false, false]);
  (service as any).agentReviewMarkdown = async () => { throw new Error("o/r#1 has no agent review yet."); };
  void page.host.agentMarkdown({ mode: "copy" });
  webview.receive(page.sent.at(-1));
  await settle();
  assert.deepEqual(webview.posted.at(-1), { type: "api-result", id: page.sent.at(-1).id, ok: false, error: "o/r#1 has no agent review yet." });
  panel.dispose();
});

test("ReviewPanel: the open pull request changing on GitHub is told to its page once per change, never from a stale list", async () => {
  const shownPr = { title: "PR 1", state: "OPEN", headRefOid: "h1", updatedAt: "2026-10-10T12:00:00Z" };
  let summary: any = { state: "OPEN", headRefOid: "h1", updatedAt: "2026-10-10T12:00:00Z" };
  const { service } = fakeService(async (key) => ({ data: { head: { sha: "h" }, files: [] }, live: { pr: key.number === 1 ? shownPr : { title: "PR 2" }, threads: [], agent: null } }));
  (service as any).get = (key: Key) => (key.number === 1 ? { summary } : undefined);
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  await panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  const notices = () => webview.posted.filter((m) => m.type === "host-pr-changed");

  assert.equal(panel.noticeChange(A), false, "nothing changed");
  summary = { state: "OPEN", headRefOid: "h0", updatedAt: "2026-10-10T11:00:00Z" };
  assert.equal(panel.noticeChange(A), false, "a list fetched before the page doesn't count");
  summary = { state: "OPEN", headRefOid: "h2", updatedAt: "2026-10-10T12:05:00Z" };
  assert.equal(panel.noticeChange(B), false, "another pull request");
  assert.equal(panel.noticeChange(A), true);
  assert.equal(panel.noticeChange(A), false, "told once");
  summary = { state: "MERGED", headRefOid: "h2", updatedAt: "2026-10-10T13:00:00Z" };
  assert.equal(panel.noticeChange(), true);
  assert.deepEqual(
    notices().map((m) => [m.key, m.change.kind, m.change.head, m.change.newCommits, m.change.was.head]),
    [
      ["o/r#1", "commits", "h2", true, "h1"],
      ["o/r#1", "merged", "h2", true, "h1"],
    ],
  );

  // A reload shows the latest, so there's nothing to tell until it changes again.
  Object.assign(shownPr, summary);
  await panel.reload();
  assert.equal(panel.noticeChange(A), false);
  panel.dispose();
  assert.equal(panel.noticeChange(A), false, "no page");
});

test("hostShim: the page hears host-pr-changed as a diffline-host event", async () => {
  const { hostShim } = await import("../src/vscode/page.ts");
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const events: any[] = [];
  const window: Record<string, any> = { addEventListener: (_: string, fn: any) => listeners.push(fn), dispatchEvent: (e: any) => events.push(e) };
  class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail: unknown }) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  vm.runInNewContext(hostShim("o/r#1"), { window, acquireVsCodeApi: () => ({ postMessage() {} }), CustomEvent });
  const message = { type: "host-pr-changed", key: "o/r#1", change: { kind: "merged" } };
  for (const fn of listeners) fn({ data: message });
  assert.deepEqual(events.map((e) => [e.type, e.detail]), [["diffline-host", message]]);
});

/* ---------- Opening in two parts: the page around the diff first, the diff when it's built ---------- */

/** A service whose diff the test hands over (or fails) when it wants, after the page's part. */
function stagedService() {
  const { service } = fakeService(async (key) => review(key), false);
  let finish: { resolve: (d: unknown) => void; reject: (e: Error) => void } | null = null;
  (service as any).loadStaged = (key: Key) => {
    const live = { pr: { title: `PR ${key.number}`, baseRefName: "main", baseRefOid: "b".repeat(40), headRefName: "topic", headRefOid: "c".repeat(40), changedFiles: 3 }, threads: [], agent: null };
    const data = new Promise((resolve, reject) => (finish = { resolve, reject }));
    data.catch(() => undefined);
    return { first: Promise.resolve({ live, detail: { pr: live.pr } }), data };
  };
  (service as any).listItems = async () => [{ key: "o/r#1", loaded: true }];
  return { service, finish: () => finish! };
}

/** What the page would say once it has drawn: its load comes from the shim the panel built it with. */
function drew(webview: InstanceType<typeof fake.FakeWebview>, stage: "page" | "changes", ms = { start: 5, render: 7 }) {
  const load = Number(/const load = (\d+);/.exec(webview.html)?.[1]);
  webview.receive({ type: "rendered", key: "o/r#1", load, stage, ms });
}

const until = async (fn: () => unknown, what: string) => {
  for (const end = Date.now() + 2000; Date.now() < end; await new Promise((r) => setTimeout(r, 5))) if (fn()) return;
  assert.fail(`timed out waiting for ${what}`);
};

test("ReviewPanel: a diff that isn't ready opens the page without it, then goes to the drawn page; one log line times both", async () => {
  const { service, finish } = stagedService();
  const logs: string[] = [];
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, (l) => logs.push(l));
  const opening = panel.show(A);
  const webview = () => fake.created.at(-1)!.webview;
  await until(() => webview().html.includes("window.REVIEW_DATA"), "the page without the diff");
  const page = runPage(webview().html);
  assert.equal(page.host && typeof page.host.rendered, "function");
  assert.match(webview().html, /"pending":true/);
  assert.match(webview().html, /"head":\{"ref":"topic","sha":"c{40}","short":"ccccccc"\}/);
  assert.equal(panel.key && prKeyString(panel.key), "o/r#1");

  // The diff is ready before the page has drawn: it waits for the page, which listens once it has.
  finish().resolve({ head: { sha: "c".repeat(40) }, files: [{ path: "a.ts" }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(webview().posted.filter((m) => m.type === "host-data").length, 0);
  drew(webview(), "page");
  await opening;
  const sent = webview().posted.filter((m) => m.type === "host-data");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data.files, [{ path: "a.ts" }]);
  assert.deepEqual(sent[0].list, [{ key: "o/r#1", loaded: true }], "with the list as it is now that the diff is built");
  assert.ok(Array.isArray(sent[0].groups));

  drew(webview(), "changes", { start: 900, render: 40 });
  await until(() => panel.timings.length, "the timing");
  const t = panel.timings.at(-1)!;
  assert.equal(t.staged, true);
  assert.deepEqual(t.changesMarks, { start: 900, render: 40 });
  assert.match(logs.at(-1)!, /^Opened o\/r#1 in \d+ ms: the page in \d+ ms \(detail \d+ ms, page \d+ ms, rendered \d+ ms\), the changes in \d+ ms \(diff \d+ ms, rendered \d+ ms\)$/);
  panel.dispose();
});

test("ReviewPanel: a diff that fails tells the page why; one ready with the detail opens in one page unless the pull request is large", async () => {
  const { service, finish } = stagedService();
  const logs: string[] = [];
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, (l) => logs.push(l));
  const opening = panel.show(A);
  const webview = () => fake.created.at(-1)!.webview;
  await until(() => webview().html.includes('"pending":true'), "the page without the diff");
  finish().reject(new Error("Couldn't fetch pull request #1"));
  drew(webview(), "page");
  await opening;
  assert.deepEqual(webview().posted.filter((m) => m.type === "host-data"), [{ type: "host-data", error: "Couldn't fetch pull request #1" }]);
  assert.ok(logs.includes("Couldn't load the changes of o/r#1: Couldn't fetch pull request #1"));
  assert.match(logs.at(-1)!, /^Opened o\/r#1: the page in \d+ ms \(.*\); the changes didn't load$/);

  // Ready at once (the usual fake): one page with the diff in it, nothing sent after.
  const { service: ready } = fakeService(async (key) => review(key), false);
  const logs2: string[] = [];
  const panel2 = new ReviewPanel((await extensionDir()) as any, ready as any, (l) => logs2.push(l));
  await panel2.show(A);
  const w2 = fake.created.at(-1)!.webview;
  assert.doesNotMatch(w2.html, /"pending":true/);
  assert.equal(w2.posted.filter((m) => m.type === "host-data").length, 0);
  drew(w2, "page", { start: 300, render: 120 });
  await until(() => panel2.timings.length, "the timing");
  assert.match(logs2.at(-1)!, /^Opened o\/r#1 in \d+ ms \(data \d+ ms, page \d+ ms, rendered \d+ ms\)$/);
  assert.deepEqual(panel2.timings.at(-1)!.pageMarks, { start: 300, render: 120 });

  // Ready at once but large: the page still comes first, and the diff after it has drawn.
  const { service: big } = fakeService(async (key) => ({ ...review(key), live: { ...review(key).live, pr: { title: "Big", additions: 1500, deletions: 500 } } }), false);
  const panel3 = new ReviewPanel((await extensionDir()) as any, big as any, () => undefined);
  const opening3 = panel3.show(A);
  const w3 = () => fake.created.at(-1)!.webview;
  await until(() => w3().html.includes('"pending":true'), "the page without the diff");
  drew(w3(), "page");
  await opening3;
  assert.equal(w3().posted.filter((m) => m.type === "host-data").length, 1);
  panel.dispose();
  panel2.dispose();
  panel3.dispose();
});

test("ReviewPanel: a diff for a page that was replaced meanwhile isn't sent", async () => {
  const { service, finish } = stagedService();
  const panel = new ReviewPanel((await extensionDir()) as any, service as any, () => undefined);
  const opening = panel.show(A);
  const webview = fake.created.at(-1)!.webview;
  await until(() => webview.html.includes('"pending":true'), "the page without the diff");
  const first = finish();
  drew(webview, "page");
  const again = panel.show(A); // a reload, say: a new page
  first.resolve({ head: { sha: "x" }, files: [] });
  await opening;
  assert.equal(webview.posted.filter((m) => m.type === "host-data").length, 0);
  await until(() => /const load = 2;/.test(webview.html), "the new page");
  finish().resolve({ head: { sha: "x" }, files: [] });
  drew(webview, "page");
  await again;
  assert.equal(webview.posted.filter((m) => m.type === "host-data").length, 1, "only the new page's");
  panel.dispose();
});

test("openedLine: the log line's formats", async () => {
  const { openedLine } = await import("../src/vscode/panel.ts");
  const base = { key: "acme/web#123", load: 1 };
  assert.equal(openedLine({ ...base, cached: false, staged: false, data: 1150, page: 1170, shown: 1210 }), "Opened acme/web#123 in 1210 ms (data 1150 ms, page 20 ms, rendered 40 ms)");
  assert.equal(
    openedLine({ ...base, cached: true, staged: true, detail: 870, page: 890, shown: 980, diff: 1900, sent: 1910, changes: 4210 }),
    "Opened acme/web#123 in 4210 ms: the page in 980 ms (detail 870 ms, page 20 ms, rendered 90 ms), the changes in 4210 ms (diff 1900 ms, rendered 2300 ms) (from cache)",
  );
  assert.equal(openedLine({ ...base, cached: false, staged: false, data: 1150, page: 1170 }), "Opened acme/web#123 in ? ms (data 1150 ms, page 20 ms, rendered ? ms)", "a page that didn't say it drew");
});

test("hostShim: the diff reaches the page as a diffline-host event; the page's rendered message names its load", async () => {
  const { hostShim } = await import("../src/vscode/page.ts");
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const events: any[] = [];
  const sent: any[] = [];
  const window: Record<string, any> = { addEventListener: (_: string, fn: any) => listeners.push(fn), dispatchEvent: (e: any) => events.push(e.detail) };
  vm.runInNewContext(hostShim("o/r#1", 7), { window, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => sent.push(m) }), CustomEvent: class { detail: unknown; constructor(_t: string, init: { detail: unknown }) { this.detail = init.detail; } } });
  const message = { type: "host-data", data: { files: [] }, list: [] };
  for (const fn of listeners) fn({ data: message });
  assert.deepEqual(events, [message]);
  window.DIFFLINE_HOST.rendered({ stage: "changes", ms: { start: 1, render: 2 } });
  window.DIFFLINE_HOST.rendered({ stage: "error", error: "x".repeat(500) });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { type: "rendered", key: "o/r#1", load: 7, stage: "changes", ms: { start: 1, render: 2 } });
  assert.equal(sent[1].error.length, 300, "an error is cut short");
});
