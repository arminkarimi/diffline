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
const { setSetupRunner } = await import("../src/core/setup.ts");
const { activate } = await import("../src/extension.ts");

const here = path.dirname(fileURLToPath(import.meta.url));

/** What the setup check finds: "command args" → its output; anything else isn't installed. */
type Programs = Record<string, string>;
const EVERYTHING: Programs = {
  "git --version": "git version 2.50.1",
  "gh --version": "gh version 2.88.1 (2026-03-12)",
  "gh auth status": "github.com\n  ✓ Logged in to github.com account me (keyring)\n",
  "claude --version": "2.1.211 (Claude Code)",
};
function installed(programs: Programs) {
  setSetupRunner(async (command, args) => {
    const out = programs[[command, ...args].join(" ")];
    if (out === undefined) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    return { code: 0, stdout: out, stderr: "", killed: false };
  });
}

/** The last value the extension gave each setup context key. */
function setupKeys(): Record<string, unknown> {
  const keys: Record<string, unknown> = {};
  for (const [cmd, key, value] of fake.executed) if (cmd === "setContext" && String(key).startsWith("diffline.setup.")) keys[key as string] = value;
  return keys;
}

/** Activate with a fake gh that answers every query with an empty list, recording what was asked. */
async function start(opts: { programs?: Programs; memory?: Map<string, unknown> } = {}) {
  installed(opts.programs ?? EVERYTHING);
  const queries: string[] = [];
  setGhRunner(async (args) => {
    queries.push(args.find((a) => a.startsWith("query="))?.slice(6) ?? args.join(" "));
    return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me", name: null }, rateLimit: { remaining: 5000, resetAt: "", cost: 1 } } }), stderr: "", killed: false };
  });
  // Only the main search runs in the background, so every other request is the test's.
  for (const [k, v] of Object.entries({ "diffline.watch.teamRequests": false, "diffline.watch.othersToReview": false, "diffline.watch.recentlyClosedDays": 0, "diffline.watch.codeOwners": false, "diffline.agents.autoRun": false })) fake.settings.set(k, v);
  const memory = opts.memory ?? new Map<string, unknown>();
  const context = {
    subscriptions: [] as Array<{ dispose(): unknown }>,
    globalStorageUri: { fsPath: await mkdtemp(path.join(os.tmpdir(), "diffline-ext-")) },
    globalState: { get: (k: string, f: unknown) => (memory.has(k) ? memory.get(k) : f), update: async (k: string, v: unknown) => void memory.set(k, v) },
    extension: { packageJSON: { version: "0.0.0-test" } },
    extensionUri: { fsPath: path.join(here, "..") },
  };
  const api = (await activate(context as any))!;
  await api.service.refresh();
  await api.setupCheck;
  // The review panel isn't under test here: record what it was asked to open.
  const opened: string[] = [];
  api.panel.show = async (key: { owner: string; name: string; number: number }) => void opened.push(`${key.owner}/${key.name}#${key.number}`);
  queries.length = 0;
  const stop = () => {
    for (const d of context.subscriptions) d.dispose();
    setGhRunner(null);
    setSetupRunner(null);
  };
  return { api, opened, queries, stop, memory };
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

/* Setup: the check on activation, its context keys and its notification. */

const setupWarnings = () => fake.shown.filter(([kind, text]) => kind === "warning" && text.startsWith("Diffline isn't set up yet"));

test("setup: gh missing sets its context key and notifies once, with Set up opening the walkthrough at its step", async () => {
  fake.shown.length = 0;
  fake.executed.length = 0;
  fake.answers.push({ match: /^Diffline isn't set up yet/, answer: "Set up" });
  const programs = Object.fromEntries(Object.entries(EVERYTHING).filter(([k]) => !k.startsWith("gh ")));
  const { api, stop } = await start({ programs });
  try {
    await settle();
    const keys = setupKeys();
    assert.equal(keys["diffline.setup.checked"], true);
    assert.equal(keys["diffline.setup.ghMissing"], true);
    assert.equal(keys["diffline.setup.ghSignedOut"], false, "a missing gh isn't also signed out");
    assert.equal(keys["diffline.setup.incomplete"], true);
    assert.deepEqual(setupWarnings().map(([, text]) => text), ["Diffline isn't set up yet: install the GitHub CLI (gh)."]);
    assert.deepEqual(setupWarnings()[0][2], ["Set up", "Not now", "Don't show again"]);
    assert.deepEqual(
      fake.executed.find(([cmd]) => cmd === "workbench.action.openWalkthrough"),
      ["workbench.action.openWalkthrough", { category: "diffline.diffline#getStarted", step: "githubCli" }, false],
    );

    // gh fails to run while polling: the check runs again, but the same missing set isn't announced twice.
    const checks = fake.executed.filter(([cmd, key]) => cmd === "setContext" && key === "diffline.setup.checked").length;
    setGhRunner(async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    });
    await api.service.refresh().catch(() => undefined);
    await settle();
    assert.equal(api.service.lastErrorKind, "missing");
    assert.ok(fake.executed.filter(([cmd, key]) => cmd === "setContext" && key === "diffline.setup.checked").length > checks, "checked again");
    assert.equal(setupWarnings().length, 1);

    // Installed now: Check again clears the key and says so.
    installed(EVERYTHING);
    await fake.registered.get("diffline.setup.checkAgain")!();
    assert.equal(setupKeys()["diffline.setup.ghMissing"], false);
    assert.equal(setupKeys()["diffline.setup.incomplete"], false);
    assert.equal(fake.shown.at(-1)![1], "Diffline has everything it needs.");
  } finally {
    stop();
  }
});

test("setup: with everything there, no notification and every problem key is off", async () => {
  fake.shown.length = 0;
  fake.executed.length = 0;
  const { stop } = await start();
  try {
    await settle();
    assert.deepEqual(setupWarnings(), []);
    const keys = setupKeys();
    for (const k of ["gitMissing", "ghMissing", "ghSignedOut", "noHarness", "defaultHarnessMissing", "incomplete"]) assert.equal(keys[`diffline.setup.${k}`], false, k);
    assert.equal(keys["diffline.setup.checked"], true);
  } finally {
    stop();
  }
});

test("setup: Don't show again lasts across sessions, for any missing set", async () => {
  fake.shown.length = 0;
  const memory = new Map<string, unknown>();
  fake.answers.push({ match: /^Diffline isn't set up yet/, answer: "Don't show again" });
  const first = await start({ programs: { "git --version": "git version 2.50.1", "gh --version": "gh version 2.88.1", "gh auth status": "✓ Logged in to github.com account me" }, memory });
  await settle();
  first.stop();
  assert.equal(setupWarnings().length, 1);
  assert.equal(memory.get("diffline.setup.dontShow"), true);

  // A new session, missing something else too: still quiet, but the welcome view's keys are set.
  fake.executed.length = 0;
  const second = await start({ programs: { "git --version": "git version 2.50.1" }, memory });
  try {
    await settle();
    assert.equal(setupWarnings().length, 1);
    assert.equal(setupKeys()["diffline.setup.ghMissing"], true);
    assert.equal(setupKeys()["diffline.setup.noHarness"], true);
  } finally {
    second.stop();
  }
});

test("setup: a missing agent CLI's failure offers Set up; Sign in types the command without pressing Enter", async () => {
  const { api, stop } = await start();
  try {
    fake.answers.push({ match: /^Agents failed on #7/, answer: "Set up" });
    fake.executed.length = 0;
    api.service.emit("runFailed", { owner: "acme", name: "web", number: 7 }, "The Codex CLI wasn't found.", "missing");
    await settle();
    assert.deepEqual(fake.shown.find(([, text]) => text.startsWith("Agents failed on #7"))?.[2], ["Choose harnesses", "Set up", "Show log"]);
    assert.deepEqual(fake.executed.find(([cmd]) => cmd === "workbench.action.openWalkthrough")?.[1], { category: "diffline.diffline#getStarted", step: "agentCli" });

    await fake.registered.get("diffline.setup.signIn")!("gh");
    const terminal = fake.terminals.at(-1)!;
    assert.deepEqual(terminal.sent, [["gh auth login", false]]);
    assert.ok(terminal.shown);
    fake.settings.set("diffline.pi.path", "/My Tools/pi");
    await fake.registered.get("diffline.setup.signIn")!("pi");
    assert.deepEqual(fake.terminals.at(-1)!.sent, [["pi", false]], "a path with spaces types the plain name");
    fake.settings.delete("diffline.pi.path");
  } finally {
    stop();
  }
});

test("package.json: the walkthrough's steps tick off on the setup keys, and every welcome view and step command exists", async () => {
  const pkg = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8"));
  const [walkthrough] = pkg.contributes.walkthroughs;
  assert.equal(walkthrough.id, "getStarted");
  assert.deepEqual(walkthrough.steps.map((s: { id: string }) => s.id), ["git", "githubCli", "signIn", "agentCli", "harness", "openPullRequest"]);
  for (const step of walkthrough.steps) {
    assert.ok(step.completionEvents.length, step.id);
    const media = path.join(here, "..", step.media.markdown);
    assert.ok((await readFile(media, "utf8")).length < 4000, `${step.media.markdown} is small`);
  }
  const ids = new Set([...pkg.contributes.commands.map((c: { command: string }) => c.command), "workbench.view.extension.diffline"]);
  const text = [...pkg.contributes.viewsWelcome.map((w: { contents: string }) => w.contents), ...walkthrough.steps.map((s: { description: string }) => s.description)].join("\n");
  for (const [, id] of text.matchAll(/\(command:([\w.]+)/g)) assert.ok(ids.has(id), `${id} is a command`);
  for (const id of ["diffline.checkSetup", "diffline.getStarted", "diffline.setup.checkAgain", "diffline.setup.signIn"]) assert.ok(fake.registered.has(id), `${id} is registered`);
  assert.match(await readFile(path.join(here, "..", ".vscodeignore"), "utf8"), /^!media\/walkthrough\/\*\.md$/m);
});
