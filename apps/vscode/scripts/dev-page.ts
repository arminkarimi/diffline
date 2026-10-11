// Builds the review page for a real pull request the way the VS Code panel does, but with a stand-in for VS Code's
// webview messaging, so the page can be checked in a browser. Writes .dev/index.html next to copies of media/ui.
//   node scripts/dev-page.ts owner/name#123 --clone /path [--agent agent-file.json]

import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Repos } = await import("../src/core/repos.ts");
const { Store } = await import("../src/core/store.ts");
const { DifflineService, parseKey } = await import("../src/core/service.ts");
const { hostShim, scriptJson } = await import("../src/vscode/page.ts");
const { prKeyString } = await import("../src/core/types.ts");

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
const key = parseKey(args[0] || "");
if (!key) throw new Error("Pass owner/name#number");
const storage = await mkdtemp(path.join(os.tmpdir(), "diffline-dev-"));
const store = new Store(storage);
await store.init();
const clone = opt("clone");
const repos = new Repos({ storage, configured: () => (clone ? { [`${key.owner}/${key.name}`]: clone } : {}), workspaceDirs: () => [], log: console.log });
const memory = new Map<string, unknown>();
const service = new DifflineService({
  store, repos,
  memory: { get: (k, f) => (memory.has(k) ? (memory.get(k) as any) : f), update: async (k, v) => void memory.set(k, v) },
  config: () => ({ watch: { direct: true, team: false, assigned: false, reviewed: false, codeOwners: false, others: false, authored: true, repositories: [], pollSeconds: 60 }, agents: { autoRun: false, enabled: ["guide"], maxParallel: 1, quietPeriodSeconds: 0, maxAutomaticRuns: 0, skipDrafts: true, timeoutMinutes: 1, autoRunMaxFiles: 100, autoRunMaxLines: 5000 }, sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 }, harnesses: { default: "claude", claude: { id: "claude", command: "claude", model: "sonnet", extraArgs: [] }, codex: { id: "codex", command: "codex", model: "", extraArgs: [] } } }),
  log: console.log,
});
if (opt("agent")) await store.writeAgent(key, JSON.parse(await readFile(opt("agent")!, "utf8")));
const t = Date.now();
// --list loads the real list from GitHub first, as the sidebar has it; --home starts the page on the list.
if (args.includes("--list")) {
  const base = (service as any).config;
  (service as any).config = () => ({ ...base(), watch: { direct: true, team: true, assigned: true, reviewed: true, codeOwners: true, others: true, authored: true, repositories: [], pollSeconds: 60 } });
  (service as any).warmUp = async () => {};
  await service.refresh();
  while ((service as any).extrasRunning) await new Promise((r) => setTimeout(r, 200));
}
const { data, live } = await service.loadReview(key, { home: args.includes("--home") });
console.log(`loadReview took ${Date.now() - t} ms`);

const out = path.join(root, ".dev");
await mkdir(out, { recursive: true });
for (const f of ["app.js", "styles.css"]) await cp(path.join(root, "media", "ui", f), path.join(out, f));
const shim = `window.__posted = [];
window.acquireVsCodeApi = () => ({ postMessage(m) {
  window.__posted.push(m);
  if (m.type === "api") setTimeout(() => window.postMessage({ type: "api-result", id: m.id, ok: true, data: m.path.startsWith("/push") ? { dry: true, as: "you", steps: [] } : { ok: true } }, "*"), 10);
} });`;
const html = (await readFile(path.join(root, "media", "ui", "index.html"), "utf8")).replace(
  '<script src="review-data.js"></script>',
  () => `<script>${shim}\n${hostShim(prKeyString(key))}\nwindow.REVIEW_DATA = ${scriptJson(data)};\nwindow.DIFFLINE_LIVE = ${scriptJson(live)};</script>`,
);
await writeFile(path.join(out, "index.html"), html, "utf8");
console.log(`Wrote ${path.join(out, "index.html")}: ${data.files.length} files, ${live.list.length} list items, agent ${live.agent ? "yes" : "no"}`);
