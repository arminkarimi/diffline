// End-to-end check of the agent pipeline without VS Code: load a real pull request, run the agents through the
// Claude Code CLI (or Codex), validate, and print the agent file summary.
//   node scripts/e2e-agents.ts owner/name#123 [--clone /path] [--harness claude|codex] [--model sonnet]
//     [--agents guide,correctness] [--agent-harness guide=codex,correctness=claude]

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DIFFLINE_HOME ||= await mkdtemp(path.join(os.tmpdir(), "diffline-home-"));

const { ensureSettings, loadSettings } = await import("../src/agents/settings.ts");
const { runReview } = await import("../src/agents/review.ts");
const { formatTokens } = await import("../src/agents/harness.ts");
const { Semaphore } = await import("../src/core/limit.ts");
const { Repos } = await import("../src/core/repos.ts");
const { Store } = await import("../src/core/store.ts");
const { DifflineService, parseKey } = await import("../src/core/service.ts");

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const key = parseKey(args[0] || "");
if (!key) throw new Error("Pass a pull request as owner/name#number");
const clone = opt("clone");
const harnessId = (opt("harness") || "claude") as "claude" | "codex";
const harnesses = {
  default: harnessId,
  claude: { id: "claude" as const, command: "claude", model: harnessId === "claude" ? opt("model") || "sonnet" : "sonnet", extraArgs: [] },
  codex: { id: "codex" as const, command: "codex", model: harnessId === "codex" ? opt("model") || "" : "", extraArgs: [] },
};
const enabled = (opt("agents") || "guide,architecture,correctness,tests,security").split(",") as Array<"guide" | "architecture" | "correctness" | "tests" | "security">;

const storage = await mkdtemp(path.join(os.tmpdir(), "diffline-e2e-"));
const store = new Store(storage);
await store.init();
const repos = new Repos({ storage, configured: () => (clone ? { [`${key.owner}/${key.name}`]: clone } : {}), workspaceDirs: () => [], log: (l) => console.log("  repos:", l) });
const memory = new Map<string, unknown>();
const service = new DifflineService({
  store,
  repos,
  memory: { get: (k, f) => (memory.has(k) ? (memory.get(k) as any) : f), update: async (k, v) => void memory.set(k, v) },
  config: () => ({
    watch: { direct: true, team: false, assigned: false, reviewed: false, codeOwners: false, others: false, authored: true, repositories: [], pollSeconds: 60 },
    agents: { autoRun: false, enabled, maxParallel: 5, quietPeriodSeconds: 0, maxAutomaticRuns: 0, skipDrafts: true, timeoutMinutes: 20, autoRunMaxFiles: 100, autoRunMaxLines: 5000 },
    harnesses,
    sidebar: { groupBy: "relationship", sortBy: "risk", othersLimit: 10 },
  }),
  log: (l) => console.log("  service:", l),
});

await ensureSettings();
const { settings } = await loadSettings();
for (const pair of (opt("agent-harness") || "").split(",").filter(Boolean)) {
  const [id, h] = pair.split("=") as [keyof typeof settings.agents, "claude" | "codex"];
  settings.agents[id].harness = h;
}
let t = Date.now();
const { data, detail, clonePath } = await service.loadData(key);
// As the extension does: agents work in a checkout of the head made for this run, with the changed files as they were.
const runDir = await store.newRunDir(key, data.head.sha);
const tree = await repos.reviewTree(key.owner, key.name, { number: key.number, head: data.head.sha, base: detail.pr.baseRefOid, baseRefName: detail.pr.baseRefName });
const baseDir = path.join(runDir, "base");
const exported = await repos.exportFiles(clonePath, data.mergeBase, data.files.filter((f) => f.status !== "added" && !f.binary).map((f) => f.oldPath || f.path), baseDir);
console.log(`Checkout at ${tree.path}; ${exported} files as they were in ${baseDir}`);
console.log(`Loaded ${args[0]}: ${data.files.length} files, head ${data.head.short}, in ${Date.now() - t} ms (clone ${clonePath})`);

t = Date.now();
let last = "";
const result = await runReview({
  key: args[0],
  repoPath: tree.path,
  baseDir: exported ? baseDir : null,
  data,
  detail,
  harnesses,
  settings,
  enabled,
  runDir,
  timeoutMs: 20 * 60_000,
  limiter: new Semaphore(5),
  onProgress: (p) => {
    const line = Object.entries(p.agents).map(([id, a]) => `${id}:${a?.state}${a?.ms ? `(${Math.round(a.ms / 1000)}s)` : ""}`).join(" ");
    if (line !== last) console.log(`  [${Math.round((Date.now() - t) / 1000)}s] ${line}`);
    last = line;
  },
});
const f = result.file;
console.log(`\nDone in ${Math.round(result.ms / 1000)}s${result.costUsd !== null ? `, $${result.costUsd.toFixed(2)} (Claude agents)` : ""}${result.tokens ? `, ${formatTokens(result.tokens)}` : ""}`);
if (result.failed.length) console.log(`Failed: ${result.failed.map((x) => `${x.agent} (${x.kind || "failed"}): ${x.error}`).join("; ")}`);
console.log(`Lede: ${f.lede}`);
console.log(`Description (${f.description?.kind}): ${f.description?.items.map((i) => `${i.rule}=${i.status}`).join(", ")}`);
console.log(`Chapters: ${f.plan?.chapters.map((c) => `${c.title} [${c.files.length}]`).join(" | ")}`);
console.log(`Diagrams: ${(f.diagrams || []).map((d) => `${d.title} (${d.nodes.length} nodes)`).join(" | ") || "none"}`);
console.log(`Findings (${f.findings.length}):`);
for (const x of f.findings) console.log(`  ${x.id} ${x.severity}/${x.label} [${x.agent}] ${x.title} — ${x.path}`);
console.log(`Checked: ${f.checked.length}`);
console.log(`Failed: ${JSON.stringify(result.failed)}`);
console.log(`Dropped: ${JSON.stringify(result.problems.dropped)}`);
console.log(`Repaired: ${JSON.stringify(result.problems.repaired)}`);
console.log(`Agent file: ${path.join(storage, "runs")}`);
await tree.remove();
