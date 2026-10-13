import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// The tree imports vscode, which only exists inside VS Code: map it to a small fake.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") return { url: new URL("./fake-vscode.ts", import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});
const { PullRequestTree } = await import("../src/vscode/tree.ts");

const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const service = { on() {}, off() {} } as any;
/** Markdown without the escaping backslashes, to read. */
const plain = (md: any) => String(md.value).replace(/\\(.)/g, "$1");

function row(summary: Record<string, unknown>, agent: unknown = null) {
  return {
    kind: "pr" as const,
    risk: { score: 30, level: "medium" as const, factors: [], lines: 12 },
    record: {
      key: { owner: "acme", name: "web", number: 123 },
      pinned: false,
      agent,
      run: { state: "idle" },
      summary: {
        repo: "acme/web", number: 123, title: "Add risk scoring", url: "", author: { login: "lee", name: null },
        createdAt: ago(200), updatedAt: ago(1), state: "OPEN", isDraft: false, mergedAt: null, closedAt: null,
        baseRefName: "main", headRefName: "lee/risk", headRefOid: HEAD, reviewDecision: null, mergeStateStatus: null,
        additions: 10, deletions: 2, changedFiles: 1, files: [], checks: { total: 0, failed: 0, running: 0 },
        requested: false, own: false, viewerReview: null, viewerLastReview: null, reviewCounts: { approvals: 0, changesRequested: 0 }, latestReviews: [],
        reasons: ["reviewed"], ...summary,
      },
    },
  };
}

test("tree: a row says your review, what changed since, approvals and the agents' freshness in their own words", () => {
  const tree = new PullRequestTree(service);
  const node = row(
    {
      viewerReview: "APPROVED",
      viewerLastReview: { state: "APPROVED", at: ago(49), commit: OLD },
      sinceReview: { newCommits: true, updated: true },
      requested: true,
      mergeStateStatus: "DIRTY",
      reviewCounts: { approvals: 2, changesRequested: 1 },
    },
    { commit: OLD, ranAt: ago(50), findings: [{ id: "x", severity: "low" }], description: null },
  );
  const item = tree.getTreeItem(node as any);
  assert.equal(item.description, "30 medium · agents: 1 finding, behind · conflicts · re-requested · you approved 2d ago · new commits · web");
  const tip = plain(item.tooltip);
  assert.match(tip, /Open · conflicts with main {2}\n2 approvals · changes requested by 1 {2}\nYour review: approved 2 days ago at bbbbbbb · since then: new commits {2}\nYour review is requested again\. {2}\n/);
  assert.match(tip, /Agents reviewed bbbbbbb 2 days ago: 1 finding\. {2}\nNew commits since the agents ran: Run reviews the latest\./);
  tree.dispose();
});

test("tree: merged and closed rows, a never-reviewed row, and the Recently merged or closed group", () => {
  const tree = new PullRequestTree(service);
  const merged = tree.getTreeItem(row({ state: "MERGED", mergedAt: ago(30), viewerLastReview: { state: "COMMENTED", at: ago(72), commit: HEAD } }) as any);
  assert.equal(merged.description, "merged · you commented 3d ago · web");
  assert.match(plain(merged.tooltip), /Merged 1 day ago {2}\nNo approvals yet {2}\nYour review: commented 3 days ago at aaaaaaa {2}\n/);
  const closed = tree.getTreeItem(row({ state: "CLOSED", closedAt: ago(80) }) as any);
  assert.equal(closed.description, "closed · web");
  assert.match(plain(closed.tooltip), /Closed 3 days ago without merging {2}\nNo approvals yet {2}\nYou haven't reviewed it yet\./);
  const fresh = tree.getTreeItem(row({ isDraft: true }) as any);
  assert.equal(fresh.description, "30 medium · draft · web");
  assert.match(plain(fresh.tooltip), /No agent review yet\./);
  const group = tree.getTreeItem({ kind: "group", id: "closed", label: "Recently merged or closed", description: "2", rows: [] } as any);
  assert.equal(group.label, "Recently merged or closed");
  assert.match(String(group.tooltip), /merged or closed recently \(diffline\.watch\.recentlyClosedDays\)/);
  tree.dispose();
});
