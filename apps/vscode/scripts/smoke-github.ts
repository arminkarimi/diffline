// Read-only smoke test of the GitHub layer against real GitHub. Sends no mutations.
// Run: node scripts/smoke-github.ts owner/name#123 [owner/name#456 ...]   (pull requests your gh account can read)

import { GhError, fetchPullRequest, fetchPullRequestFiles, getViewer, graphql, searchPullRequests, type SearchOptions } from "../src/core/github.ts";
import { prKeyString, type PrKey } from "../src/core/types.ts";

const PINNED: PrKey[] = process.argv.slice(2).map((arg) => {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(arg);
  if (!m) throw new Error(`Expected owner/name#number, got "${arg}"`);
  return { owner: m[1], name: m[2], number: Number(m[3]) };
});
if (!PINNED.length) throw new Error("Pass one or more pull requests to check, as owner/name#number.");

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`  ${label}: ${Math.round(performance.now() - start)} ms`);
  }
}

const rateLimit = async () => (await graphql("query { rateLimit { remaining resetAt cost } }", {})).rateLimit;

async function main() {
  const before = await rateLimit();
  console.log(`Rate limit before: ${before.remaining} remaining (resets ${before.resetAt})`);

  console.log("\ngetViewer");
  const viewer = await timed("getViewer", getViewer);
  console.log(`  viewer: ${viewer.login} (${viewer.name ?? "no name"})`);

  for (const key of PINNED) {
    console.log(`\nfetchPullRequest ${prKeyString(key)}`);
    try {
      const { pr, threads } = await timed("fetchPullRequest", () => fetchPullRequest(key));
      const comments = threads.reduce((n, t) => n + t.comments.length, 0);
      console.log(`  "${pr.title}" ${pr.state}${pr.isDraft ? " (draft)" : ""} by ${pr.author.login}, ${pr.baseRefName} <- ${pr.headRefName}`);
      console.log(
        `  reviewRequests ${pr.reviewRequests.length}, latestReviews ${pr.latestReviews.length}, reviews ${pr.reviews.length}, ` +
          `comments ${pr.comments.length}, threads ${threads.length} (${threads.filter((t) => !t.resolved).length} open, ${comments} comments), ` +
          `checks ${pr.checks.length}, viewedFiles ${pr.viewedFiles.length}, labels ${pr.labels.length}`,
      );
      console.log(`  reviewDecision ${pr.reviewDecision}, mergeState ${pr.mergeStateStatus}, lastReview ${pr.lastReview ? `${pr.lastReview.submittedAt} @ ${pr.lastReview.commit?.slice(0, 7)}` : "none"}`);
    } catch (err) {
      console.log(`  failed: ${err instanceof GhError ? `[${err.kind}] ` : ""}${(err as Error).message}`);
    }
  }

  const runs: Array<[string, SearchOptions]> = [
    ["default: direct + team + authored + 2 pinned", { direct: true, team: true, authored: true, repositories: [], pinned: PINNED }],
    ["direct + authored + 2 pinned", { direct: true, team: false, authored: true, repositories: [], pinned: PINNED }],
  ];
  let firstItems: PrKey[] = [];
  for (const [label, opts] of runs) {
    console.log(`\nsearchPullRequests (${label})`);
    const result = await timed("searchPullRequests", () => searchPullRequests(opts));
    const count = (reason: string) => result.items.filter((i) => i.reasons.includes(reason as never)).length;
    console.log(`  viewer ${result.viewer.login}; ${result.items.length} pull requests`);
    console.log(
      `  reasons: review-requested ${count("review-requested")}, team-requested ${count("team-requested")}, authored ${count("authored")}, ` +
        `pinned ${count("pinned")}, in several lists ${result.items.filter((i) => i.reasons.length > 1).length}`,
    );
    console.log(`  totals: ${Object.entries(result.totals).map(([k, t]) => `${k} ${t.shown}/${t.total}`).join(", ")}`);
    console.log(`  requested of you directly ${result.items.filter((i) => i.requested).length}, your own ${result.items.filter((i) => i.own).length}`);
    for (const i of result.items.slice(0, 5)) {
      console.log(
        `   - ${i.repo}#${i.number} ${i.state}${i.isDraft ? " draft" : ""} [${i.reasons.join(", ")}] updated ${i.updatedAt} +${i.additions}/-${i.deletions} ` +
          `${i.changedFiles} files, checks ${i.checks.total}/${i.checks.failed} failed/${i.checks.running} running, merge ${i.mergeStateStatus}, viewerReview ${i.viewerReview}`,
      );
    }
    if (result.items.length > 5) console.log(`   … ${result.items.length - 5} more`);
    if (result.errors?.length) console.log(`  errors: ${result.errors.join("; ")}`);
    console.log(`  search query cost: ${result.rateLimit?.cost} point(s); ${result.rateLimit?.remaining} remaining after it`);
    if (!firstItems.length) {
      firstItems = result.items.slice(0, 20).map((i) => {
        const [owner, name] = i.repo.split("/");
        return { owner, name, number: i.number };
      });
    }
  }

  console.log(`\nfetchPullRequestFiles (${firstItems.length} pull requests from the default list)`);
  const files = await timed("fetchPullRequestFiles", () => fetchPullRequestFiles(firstItems));
  const counts = [...files.values()].map((f) => f.length);
  console.log(`  ${files.size} pull requests, ${counts.reduce((a, b) => a + b, 0)} files (most in one: ${Math.max(0, ...counts)})`);

  const after = await rateLimit();
  console.log(`\nRate limit after: ${after.remaining} remaining; this run used ${before.remaining - after.remaining} point(s), including the two rate-limit checks`);
}

main().catch((err) => {
  console.error(err instanceof GhError ? `[${err.kind}] ${err.message}` : err);
  process.exit(1);
});
