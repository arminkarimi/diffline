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
