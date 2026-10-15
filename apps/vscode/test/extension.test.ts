// The extension's activation with a fake VS Code (fake-vscode.ts) and a fake gh: opening a pull request by link, from the
// Open a Pull Request… command (with a link on the clipboard) or a Diffline link, and copying a review's link.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") return { url: new URL("./fake-vscode.ts", import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});
process.env.DIFFLINE_HOME = await mkdtemp(path.join(os.tmpdir(), "diffline-ext-home-"));
const fake = await import("./fake-vscode.ts");
const { setGhRunner } = await import("../src/core/github.ts");
const { activate } = await import("../src/extension.ts");

const here = path.dirname(fileURLToPath(import.meta.url));

/** Activate with a fake gh that answers every query with an empty list, recording what was asked. */
async function start() {
  const queries: string[] = [];
  setGhRunner(async (args) => {
    queries.push(args.find((a) => a.startsWith("query="))?.slice(6) ?? args.join(" "));
    return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me", name: null }, rateLimit: { remaining: 5000, resetAt: "", cost: 1 } } }), stderr: "", killed: false };
  });
  // Only the main search runs in the background, so every other request is the test's.
  for (const [k, v] of Object.entries({ "diffline.watch.teamRequests": false, "diffline.watch.othersToReview": false, "diffline.watch.recentlyClosedDays": 0, "diffline.watch.codeOwners": false, "diffline.agents.autoRun": false })) fake.settings.set(k, v);
  const memory = new Map<string, unknown>();
  const context = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    globalStorageUri: { fsPath: await mkdtemp(path.join(os.tmpdir(), "diffline-ext-")) },
    globalState: { get: (k: string, f: unknown) => (memory.has(k) ? memory.get(k) : f), update: async (k: string, v: unknown) => void memory.set(k, v) },
    extension: { packageJSON: { version: "0.0.0-test" } },
    extensionUri: { fsPath: path.join(here, "..") },
  };
  const api = (await activate(context as any))!;
  await api.service.refresh();
  // The review panel isn't under test here: record what it was asked to open.
  const opened: string[] = [];
  api.panel.show = async (key: { owner: string; name: string; number: number }) => void opened.push(`${key.owner}/${key.name}#${key.number}`);
  queries.length = 0;
  const stop = () => {
    for (const d of context.subscriptions) d.dispose();
    setGhRunner(null);
  };
  return { api, opened, queries, stop };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("Open a Pull Request…: a link on the clipboard is filled in; opening pins it without searching the list again", async () => {
  const { api, opened, queries, stop } = await start();
  try {
    const run = fake.registered.get("diffline.openPullRequest")!;
    fake.env.clipboard.text = "https://github.com/acme/web/pull/123/files\n";
    fake.inputBox.answer = undefined;
    await run();
    const box = fake.inputBox.opened.at(-1);
    assert.equal(box.value, "https://github.com/acme/web/pull/123");
    assert.deepEqual(box.valueSelection, [0, box.value.length], "selected, so typing replaces it");
    assert.match(box.prompt, /from your clipboard/);
    assert.deepEqual(opened, [], "dismissed: nothing opens");

    // Other text on the clipboard isn't offered.
    fake.env.clipboard.text = "lunch at noon?";
    await run();
    assert.equal(fake.inputBox.opened.at(-1).value, undefined);

    fake.inputBox.answer = "acme/web#123";
    await run();
    await settle();
    assert.deepEqual(opened, ["acme/web#123"]);
    assert.equal(api.service.get({ owner: "acme", name: "web", number: 123 })?.pinned, true, "it joins the sidebar");
    assert.deepEqual(queries, [], "no search of the whole list (the review fetches its own pull request)");

    // A key given to the command opens it without asking.
    await run("acme/web#5");
    assert.deepEqual(opened, ["acme/web#123", "acme/web#5"]);
  } finally {
    stop();
  }
});

test("Diffline links: a good link opens its pull request; a bad one says why and opens nothing; agents never run", async () => {
  const { api, opened, queries, stop } = await start();
  try {
    const handler = fake.uriHandlers.at(-1)!;
    await handler.handleUri({ path: "/open", query: "pr=acme/web#7", fragment: "" });
    await handler.handleUri({ path: "/open", query: "pr=acme/web", fragment: "8" });
    await handler.handleUri({ path: "/open", query: "url=https://github.com/acme/web/pull/9", fragment: "" });
    assert.deepEqual(opened, ["acme/web#7", "acme/web#8", "acme/web#9"]);

    const warnings = fake.shown.length;
    await handler.handleUri({ path: "/open", query: "url=https://evil.example/acme/web/pull/1", fragment: "" });
    await handler.handleUri({ path: "/runAgents", query: "pr=acme/web#7", fragment: "" });
    assert.deepEqual(opened, ["acme/web#7", "acme/web#8", "acme/web#9"]);
    assert.deepEqual(fake.shown.slice(warnings).map(([kind, text]) => [kind, text.split(".")[0]]), [
      ["warning", "Diffline: That link doesn't name a GitHub pull request"],
      ["warning", "Diffline: That link isn't one Diffline knows"],
    ]);
    await settle();
    assert.deepEqual(queries, []);
    assert.ok(api.service.all().every((r) => r.run.state === "idle"), "no agent run started or waiting");
  } finally {
    stop();
  }
});

test("Copy Link to This Review: a link in the editor's scheme that opens the review", async () => {
  const { stop } = await start();
  try {
    await fake.registered.get("diffline.copyLink")!("acme/web#7");
    assert.equal(fake.env.clipboard.text, "vscode://diffline.diffline/open?pr=acme/web%237");
    assert.match(fake.shown.at(-1)![1], /^Copied a link that opens acme\/web#7 in Diffline: vscode:\/\//);
  } finally {
    stop();
  }
});

test("package.json: activates on links, and Open a Pull Request… has its shortcut", async () => {
  const pkg = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8"));
  assert.ok(pkg.activationEvents.includes("onUri"));
  assert.deepEqual(pkg.contributes.keybindings, [{ command: "diffline.openPullRequest", key: "ctrl+shift+alt+p", mac: "cmd+alt+shift+p" }]);
  assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === "diffline.copyLink"));
});

test("activate: waits while the old arminkarimi.diffline is installed, with a copy of its storage", async () => {
  const { mkdir, writeFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-ext-old-"));
  const storage = path.join(root, "diffline.diffline");
  await mkdir(path.join(root, "arminkarimi.diffline", "state"), { recursive: true });
  await writeFile(path.join(root, "arminkarimi.diffline", "state", "o__r__1.json"), "{}", "utf8");
  fake.installed.add("arminkarimi.diffline");
  const handlers = fake.uriHandlers.length;
  fake.shown.length = 0;
  try {
    const context = { subscriptions: [], globalStorageUri: { fsPath: storage }, globalState: { get: (_k: string, f: unknown) => f, update: async () => undefined }, extension: { packageJSON: { version: "0.0.0-test" } }, extensionUri: { fsPath: path.join(here, "..") } };
    assert.equal(await activate(context as any), undefined);
    assert.equal(fake.uriHandlers.length, handlers, "nothing registered");
    assert.match(fake.shown.find(([kind]) => kind === "warning")?.[1] ?? "", /arminkarimi\.diffline\) is still installed/);
    assert.deepEqual(await readdir(path.join(storage, "state")), ["o__r__1.json"]);
  } finally {
    fake.installed.delete("arminkarimi.diffline");
  }
});
