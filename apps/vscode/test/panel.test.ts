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
  await new Promise((r) => setTimeout(r, 60));
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(log.file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
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
