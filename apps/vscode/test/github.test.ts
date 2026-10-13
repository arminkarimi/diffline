import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  GhError,
  buildSearchQuery,
  classifyGhError,
  closedSince,
  countCheckStates,
  countChecks,
  fetchPullRequest,
  fetchPullRequestFiles,
  gh,
  graphql,
  mergeSearchResults,
  normalizePullRequest,
  parseRemote,
  pushReview,
  searchPullRequests,
  setGhRunner,
  type GhRunner,
} from "../src/core/github.ts";
import type { PrKey, PushPayload } from "../src/core/types.ts";

afterEach(() => setGhRunner(null));

const KEY = { owner: "Acme", name: "web", number: 9944 };
const HEAD = "a".repeat(40);

/** A runner that answers from a function and records every call. */
function fakeRunner(answer: (args: string[], input?: string) => { code?: number; stdout?: string; stderr?: string } | Error) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: GhRunner = async (args, input) => {
    calls.push({ args, input });
    const a = answer(args, input);
    if (a instanceof Error) throw a;
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "", killed: false };
  };
  return { runner, calls };
}

/* ---------- normalizePullRequest ---------- */

const user = (login: string, name: string | null = null) => ({ login, name });

function prFixture() {
  return {
    viewer: { login: "armin", name: "Armin K" },
    repository: {
      defaultBranchRef: { name: "main" },
      pullRequest: {
        number: 9944,
        title: "Add risk scoring",
        body: null,
        url: "https://github.com/Acme/web/pull/9944",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-05T08:00:00Z",
        mergedAt: null,
        closedAt: null,
        mergedBy: null,
        author: user("dana", "Dana P"),
        baseRefName: "main",
        headRefName: "dana/risk",
        baseRefOid: "b".repeat(40),
        headRefOid: HEAD,
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BLOCKED",
        labels: { nodes: [{ name: "feature" }, { name: "backend" }] },
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: "User", login: "armin", name: "Armin K" } },
            { requestedReviewer: { __typename: "Team", slug: "web-platform", name: "Web Platform" } },
            { requestedReviewer: { __typename: "Mannequin" } },
          ],
        },
        latestOpinionatedReviews: {
          nodes: [{ author: user("lee", ""), state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T09:00:00Z" }],
        },
        reviews: {
          nodes: [
            { author: user("armin", "Armin K"), state: "COMMENTED", submittedAt: "2026-10-02T08:00:00Z", body: "first", commit: { oid: "c1" } },
            { author: user("armin", "Armin K"), state: "COMMENTED", submittedAt: "2026-10-03T08:00:00Z", body: "second", commit: { oid: "c2" } },
            { author: user("armin", "Armin K"), state: "PENDING", submittedAt: null, body: "draft", commit: { oid: "c3" } },
            { author: user("lee"), state: "CHANGES_REQUESTED", submittedAt: "2026-10-04T08:00:00Z", body: null, commit: null },
            { author: null, state: "COMMENTED", submittedAt: "2026-10-05T08:00:00Z", body: "ghost", commit: { oid: "c4" } },
          ],
        },
        comments: { nodes: [{ author: user("dana", "Dana P"), body: "ping", createdAt: "2026-10-02T00:00:00Z", url: "https://x/c1" }] },
        files: {
          nodes: [
            { path: "src/risk.ts", viewerViewedState: "VIEWED" },
            { path: "src/risk.test.ts", viewerViewedState: "UNVIEWED" },
            { path: "README.md", viewerViewedState: "DISMISSED" },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_1",
              isResolved: true,
              isOutdated: false,
              path: "src/risk.ts",
              line: 12,
              startLine: 10,
              diffSide: "LEFT",
              comments: { nodes: [{ id: "PRRC_1", databaseId: 111, author: user("lee", "Lee"), body: "why?", createdAt: "2026-10-02T09:00:00Z", url: "https://x/r1" }] },
            },
            { id: "PRRT_2", isResolved: false, isOutdated: true, path: "src/a.ts", line: null, startLine: null, diffSide: null, comments: { nodes: [] } },
          ],
        },
        commits: {
          nodes: [
            {
              commit: {
                oid: HEAD,
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    nodes: [
                      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/build" },
                      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
                      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING", description: "Waiting", targetUrl: "https://ci/legacy" },
                      { __typename: "StatusContext", context: "ci/deploy", state: "ERROR", description: "Boom", targetUrl: null },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

test("normalizePullRequest matches normalize_github", () => {
  const { viewer, pr, threads } = normalizePullRequest(prFixture());
  assert.deepEqual(viewer, { login: "armin", name: "Armin K" });
  assert.equal(pr.body, "");
  assert.equal(pr.defaultBranch, "main");
  assert.deepEqual(pr.labels, ["feature", "backend"]);
  assert.deepEqual(pr.author, { login: "dana", name: "Dana P" });

  // Users keep login, teams become { team, name }, anything else is dropped.
  assert.deepEqual(pr.reviewRequests, [
    { login: "armin", name: "Armin K" },
    { team: "web-platform", name: "Web Platform" },
  ]);
  // Empty names become null, as person() does.
  assert.deepEqual(pr.latestReviews, [{ login: "lee", name: null, state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T09:00:00Z" }]);

  // Pending reviews are dropped; missing authors become null people.
  assert.equal(pr.reviews.length, 4);
  assert.ok(pr.reviews.every((r) => r.state !== "PENDING"));
  assert.deepEqual(pr.reviews[2], { login: "lee", name: null, state: "CHANGES_REQUESTED", submittedAt: "2026-10-04T08:00:00Z", body: "", commit: null });
  assert.deepEqual(pr.reviews[3].login, null);

  // The viewer's latest submitted review, not anyone else's and not the pending one.
  assert.deepEqual(pr.lastReview, { submittedAt: "2026-10-03T08:00:00Z", commit: "c2", state: "COMMENTED" });
  assert.equal(pr.updatedAt, "2026-10-05T08:00:00Z");
  assert.deepEqual([pr.mergedAt, pr.mergedBy, pr.closedAt], [null, null, null]);

  assert.deepEqual(pr.viewedFiles, ["src/risk.ts"]);
  assert.deepEqual(pr.comments, [{ login: "dana", name: "Dana P", body: "ping", createdAt: "2026-10-02T00:00:00Z", url: "https://x/c1" }]);

  assert.deepEqual(pr.checks, [
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci/build" },
    { name: "lint", status: "IN_PROGRESS", conclusion: null, url: null },
    { name: "ci/legacy", status: "IN_PROGRESS", conclusion: null, url: "https://ci/legacy", description: "Waiting" },
    { name: "ci/deploy", status: "COMPLETED", conclusion: "ERROR", url: null, description: "Boom" },
  ]);

  assert.deepEqual(threads, [
    {
      id: "PRRT_1",
      resolved: true,
      outdated: false,
      path: "src/risk.ts",
      line: 12,
      startLine: 10,
      side: "LEFT",
      comments: [{ id: "PRRC_1", dbId: 111, login: "lee", name: "Lee", body: "why?", createdAt: "2026-10-02T09:00:00Z", url: "https://x/r1" }],
    },
    { id: "PRRT_2", resolved: false, outdated: true, path: "src/a.ts", line: null, startLine: null, side: "RIGHT", comments: [] },
  ]);

  // The key order is part of the page's format, so JSON output stays the same.
  assert.deepEqual(Object.keys(pr), [
    "title", "body", "url", "state", "isDraft", "createdAt", "updatedAt", "mergedAt", "mergedBy", "closedAt", "author", "baseRefName", "headRefName", "baseRefOid", "headRefOid",
    "defaultBranch", "reviewDecision", "mergeStateStatus", "labels", "reviewRequests", "latestReviews", "reviews", "comments",
    "viewedFiles", "checks", "lastReview",
  ]);
});

test("normalizePullRequest: no review from the viewer, no commits", () => {
  const data: any = prFixture();
  data.viewer = { login: "someone-else", name: null };
  data.repository.pullRequest.commits = { nodes: [] };
  const { pr } = normalizePullRequest(data);
  assert.equal(pr.lastReview, null);
  assert.deepEqual(pr.checks, []);
});

test("normalizePullRequest: missing pull request", () => {
  assert.throws(() => normalizePullRequest({ viewer: { login: "a" }, repository: { pullRequest: null } }), /GitHub didn't return this pull request/);
  assert.throws(() => normalizePullRequest({}), /GitHub didn't return this pull request/);
});

test("fetchPullRequest sends one graphql call with typed number", async () => {
  const { runner, calls } = fakeRunner(() => ({ stdout: JSON.stringify({ data: prFixture() }) }));
  setGhRunner(runner);
  const detail = await fetchPullRequest(KEY);
  assert.equal(detail.pr.title, "Add risk scoring");
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 3), ["api", "graphql", "-f"]);
  assert.ok(args[3].startsWith("query="));
  assert.deepEqual(args.slice(4), ["-f", "owner=Acme", "-f", "name=web", "-F", "number=9944"]);
});

/* ---------- Search ---------- */

function summaryNode(repo: string, number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    state: "OPEN",
    isDraft: false,
    author: { login: "dana", name: "Dana" },
    repository: { nameWithOwner: repo },
    baseRefName: "main",
    headRefName: `b${number}`,
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [] },
    ...extra,
  };
}

const ALL = { direct: true, team: true, authored: true, repositories: [] as string[], pinned: [] as PrKey[] };

test("buildSearchQuery: one request with aliases, variables and one fragment", () => {
  const { query, variables, sources } = buildSearchQuery({
    ...ALL,
    repositories: ["Acme/web", "acme/WEB", "not a repo", "Acme/api"],
    pinned: [KEY, { ...KEY }, { owner: "Acme", name: "api", number: 3809 }],
  });
  assert.deepEqual(
    sources.map((s) => [s.alias, s.reason, s.search]),
    [
      ["direct", "review-requested", "direct"],
      ["team", "team-requested", "team"],
      ["authored", "authored", "authored"],
      ["watched0", "watched", "watched"],
      ["watched1", "watched", "watched"],
      ["pinned0", "pinned", undefined],
      ["pinned1", "pinned", undefined],
    ],
  );
  assert.equal(variables.direct, "is:pr is:open user-review-requested:@me archived:false sort:updated-desc");
  assert.equal(variables.team, "is:pr is:open review-requested:@me -user-review-requested:@me archived:false sort:updated-desc");
  assert.equal(variables.authored, "is:pr is:open author:@me archived:false sort:updated-desc");
  assert.equal(variables.watched0, "repo:Acme/web is:pr is:open archived:false sort:updated-desc");
  assert.equal(variables.watched1, "repo:Acme/api is:pr is:open archived:false sort:updated-desc");
  assert.equal(variables.pinned1Number, 3809);
  assert.equal(query.match(/fragment DifflineSummary/g)?.length, 1);
  assert.match(query, /rateLimit \{ remaining resetAt cost \}/);
  assert.match(query, /team: search\(type: ISSUE, query: \$team, first: 50\) \{ issueCount nodes/);
  assert.match(query, /pinned0: repository\(owner: \$pinned0Owner, name: \$pinned0Name\) \{ pullRequest\(number: \$pinned0Number\)/);
  // The list query stays cheap: no reviewDecision, files, mergeStateStatus or listed check contexts.
  assert.doesNotMatch(query, /reviewDecision|files\(|mergeStateStatus|contexts\(first/);
  // Nothing user-supplied is spliced into the query text.
  assert.doesNotMatch(query, /Acme/);
});

test("buildSearchQuery with nothing to search still asks for the viewer", () => {
  const { query, sources } = buildSearchQuery({ direct: false, team: false, authored: false, repositories: [], pinned: [] });
  assert.equal(sources.length, 0);
  assert.match(query, /^query \{/);
  assert.doesNotMatch(query, /fragment/);
});

test("mergeSearchResults dedupes across searches, keeps every reason and counts totals", () => {
  const { sources } = buildSearchQuery({ ...ALL, repositories: ["Acme/web", "Acme/other"], pinned: [KEY] });
  const requestedNode = summaryNode("Acme/web", 9944, {
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "armin" } }, { requestedReviewer: { __typename: "Team" } }] },
    latestOpinionatedReviews: { nodes: [{ author: { login: "lee" }, state: "APPROVED" }, { author: { login: "armin" }, state: "COMMENTED" }] },
    mergeable: "CONFLICTING",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                checkRunCount: 5,
                statusContextCount: 3,
                checkRunCountsByState: [
                  { state: "SUCCESS", count: 1 },
                  { state: "SKIPPED", count: 1 },
                  { state: "FAILURE", count: 1 },
                  { state: "QUEUED", count: 1 },
                  { state: "IN_PROGRESS", count: 0 },
                  { state: "CANCELLED", count: 1 },
                ],
                statusContextCountsByState: [
                  { state: "PENDING", count: 1 },
                  { state: "ERROR", count: 1 },
                  { state: "SUCCESS", count: 1 },
                  { state: "EXPECTED", count: 0 },
                ],
              },
            },
          },
        },
      ],
    },
  });
  const mine = summaryNode("Acme/web", 10, { author: { login: "armin", name: "Armin" } });
  const teamOnly = summaryNode("Acme/web", 12, { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team" } }] } });
  const data = {
    viewer: { login: "armin", name: "Armin" },
    direct: { issueCount: 1, nodes: [requestedNode] },
    team: { issueCount: 99, nodes: [teamOnly] },
    authored: { issueCount: 1, nodes: [mine, {}] }, // {} is a non-pull-request search hit
    watched0: { issueCount: 80, nodes: [summaryNode("acme/web", 9944), mine, summaryNode("Acme/web", 11)] },
    watched1: { issueCount: 0, nodes: [] },
    pinned0: { pullRequest: summaryNode("Acme/web", 9944, { state: "MERGED" }) },
  };
  const { viewer, items, totals } = mergeSearchResults(data, sources);
  assert.equal(viewer.login, "armin");
  assert.deepEqual(
    items.map((i) => [i.number, i.reasons]),
    [
      [9944, ["review-requested", "watched", "pinned"]],
      [12, ["team-requested"]],
      [10, ["authored", "watched"]],
      [11, ["watched"]],
    ],
  );
  assert.deepEqual(totals, {
    direct: { shown: 1, total: 1 },
    team: { shown: 1, total: 99 },
    assigned: { shown: 0, total: 0 },
    reviewed: { shown: 0, total: 0 },
    authored: { shown: 1, total: 1 },
    watched: { shown: 3, total: 80 },
    closed: { shown: 0, total: 0 },
  });
  const first = items[0];
  assert.equal(first.requested, true);
  assert.equal(first.viewerReview, "COMMENTED");
  assert.deepEqual(first.latestReviews, [{ login: "lee", state: "APPROVED" }, { login: "armin", state: "COMMENTED" }]); // for approvedBy
  assert.equal(first.own, false);
  assert.equal(first.state, "OPEN"); // the first sighting wins
  assert.deepEqual(first.checks, { total: 8, failed: 3, running: 2 });
  assert.equal(first.mergeStateStatus, "DIRTY"); // conflicts; anything else is unknown in the list
  assert.equal(first.reviewDecision, null); // not in the list query
  assert.deepEqual(first.files, []); // fetchPullRequestFiles fills these in
  assert.equal(first.repo, "Acme/web");
  assert.equal(items[1].requested, false); // through a team only
  assert.equal(items[2].own, true);
  assert.equal(items[2].requested, false);
  assert.equal(items[2].viewerReview, null);
  assert.deepEqual(items[3].checks, { total: 0, failed: 0, running: 0 });
  assert.equal(items[3].mergeStateStatus, null);
});

test("mergeSearchResults: searches that didn't run count as 0 of 0", () => {
  const { sources } = buildSearchQuery({ direct: true, team: false, authored: false, repositories: [], pinned: [] });
  const { totals } = mergeSearchResults({ viewer: { login: "armin" }, direct: { issueCount: 2, nodes: [summaryNode("o/n", 1)] } }, sources);
  assert.deepEqual(totals, { direct: { shown: 1, total: 2 }, team: { shown: 0, total: 0 }, assigned: { shown: 0, total: 0 }, reviewed: { shown: 0, total: 0 }, authored: { shown: 0, total: 0 }, watched: { shown: 0, total: 0 }, closed: { shown: 0, total: 0 } });
});

test("buildSearchQuery: your latest review only in the searches you're in; team and watched stay lean", () => {
  const { query } = buildSearchQuery({ ...ALL, assigned: true, reviewed: true, repositories: ["Acme/web"], pinned: [KEY] });
  for (const alias of ["direct", "assigned", "reviewed", "authored"]) assert.match(query, new RegExp(`${alias}: search\\([^\\n]*\\.\\.\\.DifflineMine`));
  assert.match(query, /team: search\([^\n]*\.\.\.DifflineSummary \}/);
  assert.match(query, /watched0: search\([^\n]*\.\.\.DifflineSummary \}/);
  assert.match(query, /pinned0: [^\n]*\.\.\.DifflineMine/);
  assert.match(query, /fragment DifflineMine on PullRequest \{\n  \.\.\.DifflineSummary\n  latestReviews\(first: 30\) \{ nodes \{ author \{ login \} state submittedAt commit \{ oid \} \} \}/);
  assert.match(query, /latestOpinionatedReviews\(first: 30\)/, "approvals still come from opinionated reviews");
  assert.match(query, /mergedAt closedAt/);
  // GraphQL rejects unused fragments: team and watched alone don't send DifflineMine.
  assert.doesNotMatch(buildSearchQuery({ direct: false, team: true, authored: false, repositories: ["Acme/web"], pinned: [] }).query, /DifflineMine/);
});

test("buildSearchQuery: recently closed pull requests you reviewed or wrote, since a date, 20 each", () => {
  const now = new Date("2026-10-13T09:00:00Z");
  assert.equal(closedSince(7, now), "2026-10-06");
  const { query, variables, sources } = buildSearchQuery({ direct: false, team: false, authored: false, repositories: [], pinned: [], closed: { days: 7, authored: true } }, 50, now);
  assert.deepEqual(sources.map((s) => [s.alias, s.reason, s.search]), [
    ["closedReviewed", "recently-closed", "closed"],
    ["closedAuthored", "recently-closed", "closed"],
  ]);
  assert.equal(variables.closedReviewed, "is:pr is:closed reviewed-by:@me -author:@me closed:>=2026-10-06 archived:false sort:updated-desc");
  assert.equal(variables.closedAuthored, "is:pr is:closed author:@me closed:>=2026-10-06 archived:false sort:updated-desc");
  assert.match(query, /closedReviewed: search\(type: ISSUE, query: \$closedReviewed, first: 20\) \{ issueCount nodes \{ \.\.\.DifflineMine/);
  assert.equal(buildSearchQuery({ direct: false, team: false, authored: false, repositories: [], pinned: [], closed: { days: 7, authored: false } }, 50, now).sources.length, 1, "yours only when your own pull requests are listed");
  assert.equal(buildSearchQuery({ direct: false, team: false, authored: false, repositories: [], pinned: [], closed: { days: 0, authored: true } }).sources.length, 0, "0 days turns it off");
  assert.match(buildSearchQuery({ direct: false, team: false, authored: false, repositories: [], pinned: [], closed: { days: 3, authored: false } }, 10, now).query, /first: 10\)/, "the timeout retry's smaller pages apply");
});

test("mergeSearchResults: your latest review of any state, what changed since, approvals, merged and closed times", () => {
  const { sources } = buildSearchQuery({ ...ALL, team: false, reviewed: true, repositories: ["Acme/web"], pinned: [{ owner: "Acme", name: "web", number: 6 }] });
  const reviews = (...nodes: unknown[]) => ({ latestReviews: { nodes } });
  const data = {
    viewer: { login: "armin", name: "Armin" },
    direct: {
      issueCount: 3,
      nodes: [
        // Approved, then replied to a thread (a comment review) on an older head; GitHub changed since.
        summaryNode("Acme/web", 1, {
          updatedAt: "2026-10-09T00:00:00Z",
          latestOpinionatedReviews: { nodes: [{ author: { login: "armin" }, state: "APPROVED" }, { author: { login: "lee" }, state: "APPROVED" }, { author: { login: "sam" }, state: "CHANGES_REQUESTED" }] },
          ...reviews({ author: { login: "lee" }, state: "APPROVED", submittedAt: "2026-10-08T00:00:00Z", commit: { oid: HEAD } }, { author: { login: "armin" }, state: "COMMENTED", submittedAt: "2026-10-07T00:00:00Z", commit: { oid: "old" } }),
        }),
        // Dismissed, with no commit; nothing since.
        summaryNode("Acme/web", 2, {
          updatedAt: "2026-10-07T00:00:30Z",
          latestOpinionatedReviews: { nodes: [{ author: { login: "armin" }, state: "DISMISSED" }] },
          ...reviews({ author: { login: "armin" }, state: "DISMISSED", submittedAt: "2026-10-07T00:00:00Z", commit: null }),
        }),
        // Reviewers, but not you.
        summaryNode("Acme/web", 3, reviews({ author: { login: "lee" }, state: "COMMENTED", submittedAt: "2026-10-07T00:00:00Z", commit: { oid: HEAD } })),
      ],
    },
    reviewed: { issueCount: 0, nodes: [] },
    authored: { issueCount: 0, nodes: [] },
    // Watched repositories don't ask for reviews; the same pull request pinned does.
    watched0: { issueCount: 2, nodes: [summaryNode("Acme/web", 5), summaryNode("Acme/web", 6)] },
    pinned0: { pullRequest: summaryNode("Acme/web", 6, { state: "MERGED", mergedAt: "2026-10-08T00:00:00Z", closedAt: "2026-10-08T00:00:00Z", ...reviews({ author: { login: "armin" }, state: "APPROVED", submittedAt: "2026-10-06T00:00:00Z", commit: { oid: HEAD } }) }) },
  };
  const { items } = mergeSearchResults(data, sources);
  const by = new Map(items.map((i) => [i.number, i]));
  const one = by.get(1)!;
  assert.equal(one.viewerReview, "APPROVED", "your approval still stands");
  assert.deepEqual(one.viewerLastReview, { state: "COMMENTED", at: "2026-10-07T00:00:00Z", commit: "old" });
  assert.deepEqual(one.sinceReview, { newCommits: true, updated: true });
  assert.deepEqual(one.reviewCounts, { approvals: 2, changesRequested: 1 });
  assert.deepEqual([one.mergedAt, one.closedAt], [null, null]);
  const two = by.get(2)!;
  assert.deepEqual(two.viewerLastReview, { state: "DISMISSED", at: "2026-10-07T00:00:00Z", commit: null });
  assert.deepEqual(two.sinceReview, { newCommits: false, updated: false });
  assert.deepEqual(two.reviewCounts, { approvals: 0, changesRequested: 0 });
  assert.equal(by.get(3)!.viewerLastReview, null, "fetched, and you haven't reviewed it");
  assert.equal(by.get(3)!.sinceReview, undefined);
  assert.equal("viewerLastReview" in by.get(5)!, false, "a watched repository's search doesn't know");
  const six = by.get(6)!;
  assert.deepEqual(six.reasons, ["watched", "pinned"]);
  assert.equal(six.state, "OPEN", "the first sighting wins");
  assert.deepEqual(six.viewerLastReview, { state: "APPROVED", at: "2026-10-06T00:00:00Z", commit: HEAD }, "but your review comes from the pinned lookup");
});

test("searchPullRequests: one call; a missing pinned pull request doesn't sink the list", async () => {
  const body = {
    data: {
      viewer: { login: "armin", name: "Armin" },
      rateLimit: { remaining: 4900, resetAt: "2026-10-10T23:00:00Z", cost: 2 },
      direct: { issueCount: 1, nodes: [summaryNode("Acme/web", 1)] },
      pinned0: null,
      pinned1: { pullRequest: summaryNode("Acme/web", 1, { state: "CLOSED" }) },
    },
    errors: [{ type: "NOT_FOUND", path: ["pinned0"], message: "Could not resolve to a Repository with the name 'x/gone'." }],
  };
  const { runner, calls } = fakeRunner(() => ({ code: 1, stdout: JSON.stringify(body), stderr: "gh: Could not resolve to a Repository with the name 'x/gone'." }));
  setGhRunner(runner);
  const result = await searchPullRequests({
    direct: true,
    team: false,
    authored: false,
    repositories: [],
    pinned: [{ owner: "x", name: "gone", number: 1 }, { owner: "Acme", name: "web", number: 1 }],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.items.map((i) => [i.number, i.reasons]), [[1, ["review-requested", "pinned"]]]);
  assert.deepEqual(result.totals.direct, { shown: 1, total: 1 });
  assert.deepEqual(result.rateLimit, { remaining: 4900, resetAt: "2026-10-10T23:00:00Z", cost: 2 });
  assert.deepEqual(result.errors, ["x/gone#1: Could not resolve to a Repository with the name 'x/gone'."]);
});

test("searchPullRequests: failures outside a search part still throw", async () => {
  const body = { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] };
  setGhRunner(fakeRunner(() => ({ code: 1, stdout: JSON.stringify(body), stderr: "gh: API rate limit exceeded for user ID 1." })).runner);
  await assert.rejects(searchPullRequests(ALL), (e: unknown) => e instanceof GhError && e.kind === "rateLimit");
});

test("countCheckStates (list) agrees with countChecks over normalized checks (detail)", () => {
  const { pr } = normalizePullRequest(prFixture());
  // build ok, lint in progress, ci/legacy pending, ci/deploy error
  assert.deepEqual(countChecks(pr.checks), { total: 4, failed: 1, running: 2 });
  assert.deepEqual(
    countCheckStates({
      checkRunCountsByState: [{ state: "SUCCESS", count: 1 }, { state: "IN_PROGRESS", count: 1 }],
      statusContextCountsByState: [{ state: "PENDING", count: 1 }, { state: "ERROR", count: 1 }],
    }),
    { total: 4, failed: 1, running: 2 },
  );
  assert.deepEqual(countCheckStates(undefined), { total: 0, failed: 0, running: 0 });
});

test("searchPullRequests retries once with smaller pages when GitHub times out", async () => {
  const ok = { data: { viewer: { login: "armin" }, rateLimit: { remaining: 1, resetAt: "t", cost: 1 }, direct: { issueCount: 30, nodes: [summaryNode("o/n", 1)] } } };
  const { runner, calls } = fakeRunner((args) =>
    args.some((a) => a.includes("first: 50")) ? { code: 1, stderr: "gh: HTTP 502" } : { stdout: JSON.stringify(ok) },
  );
  setGhRunner(runner);
  const result = await searchPullRequests({ ...ALL, team: false, authored: false });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.some((a) => a.includes("first: 20")));
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.totals.direct, { shown: 1, total: 30 });
  assert.match(result.errors?.[0] ?? "", /timed out/);

  // Other failures aren't retried.
  const auth = fakeRunner(() => ({ code: 1, stderr: "gh: Bad credentials (HTTP 401)" }));
  setGhRunner(auth.runner);
  await assert.rejects(searchPullRequests(ALL), (e: unknown) => e instanceof GhError && e.kind === "auth");
  assert.equal(auth.calls.length, 1);
});

test("fetchPullRequestFiles: one aliased query per 20, keyed by owner/name#number, missing ones left out", async () => {
  const keys = Array.from({ length: 23 }, (_, i) => ({ owner: "o", name: "n", number: i + 1 }));
  keys.push({ owner: "o", name: "n", number: 1 }); // duplicate
  const { runner, calls } = fakeRunner((args) => {
    const vars = Object.fromEntries(args.filter((a) => /^pr\d+(Owner|Name|Number)=/.test(a)).map((a) => a.split("=")));
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const [k, v] of Object.entries(vars)) {
      if (!k.endsWith("Number")) continue;
      const alias = k.slice(0, -"Number".length);
      if (v === "5") {
        data[alias] = { pullRequest: null };
        errors.push({ type: "NOT_FOUND", path: [alias, "pullRequest"], message: "Could not resolve to a PullRequest with the number of 5." });
      } else {
        data[alias] = { pullRequest: { files: { nodes: [{ path: `f${v}.ts`, additions: Number(v), deletions: 1 }] } } };
      }
    }
    return errors.length ? { code: 1, stdout: JSON.stringify({ data, errors }), stderr: "gh: Could not resolve" } : { stdout: JSON.stringify({ data }) };
  });
  setGhRunner(runner);
  const files = await fetchPullRequestFiles(keys);
  assert.equal(calls.length, 2);
  assert.equal(files.size, 22);
  assert.equal(files.has("o/n#5"), false);
  assert.deepEqual(files.get("o/n#23"), [{ path: "f23.ts", additions: 23, deletions: 1 }]);
  assert.match(calls[0].args[3], /pr19: repository\(owner: \$pr19Owner, name: \$pr19Name\) \{ pullRequest\(number: \$pr19Number\) \{ files\(first: 100\)/);
  assert.equal(await fetchPullRequestFiles([]).then((m) => m.size), 0);
});

/* ---------- pushReview ---------- */

const push = (payload: unknown, dry = true) => pushReview(KEY, HEAD, "armin", payload as PushPayload, dry);
const BASE = "repos/Acme/web/pulls/9944";

test("pushReview dry run lists every step in order", async () => {
  const result = await push({
    event: "APPROVE",
    body: "  Looks good  ",
    comments: [
      { path: "a.ts", line: 3, body: "nit", side: "LEFT" },
      { path: "b.ts", line: 9, body: "why?", side: "MIDDLE" },
    ],
    replies: [{ comment_id: "111", body: "done" }, { comment_id: 222, body: "   " }],
    resolve: ["PRRT_1"],
    unresolve: ["PRRT_2"],
  });
  assert.deepEqual(result, {
    dry: true,
    as: "armin",
    steps: [
      {
        kind: "review",
        request: `POST ${BASE}/reviews`,
        json: {
          commit_id: HEAD,
          event: "APPROVE",
          comments: [
            { path: "a.ts", line: 3, side: "LEFT", body: "nit" },
            { path: "b.ts", line: 9, side: "RIGHT", body: "why?" },
          ],
          body: "Looks good",
        },
      },
      { kind: "reply", request: `POST ${BASE}/comments/111/replies`, json: { body: "done" } },
      { kind: "resolve", request: "GraphQL resolveReviewThread", thread: "PRRT_1" },
      { kind: "unresolve", request: "GraphQL unresolveReviewThread", thread: "PRRT_2" },
    ],
  });
});

test("pushReview: COMMENT without a body gets the default summary", async () => {
  const one = await push({ event: "COMMENT", comments: [{ path: "a.ts", line: 1, body: "x" }] });
  assert.equal(one.dry && (one.steps[0].json as any).body, "Left 1 comment.");
  const two = await push({ event: "COMMENT", comments: [{ path: "a.ts", line: 1, body: "x" }, { path: "a.ts", line: 2, body: "y" }] });
  assert.equal(two.dry && (two.steps[0].json as any).body, "Left 2 comments.");
});

test("pushReview: COMMENT with only replies or resolutions skips the review", async () => {
  const result = await push({ event: "COMMENT", body: " ", resolve: ["PRRT_9"] });
  assert.deepEqual(result.dry && result.steps.map((s) => s.kind), ["resolve"]);
});

test("pushReview: APPROVE alone has no body", async () => {
  const result = await push({ event: "APPROVE" });
  assert.deepEqual(result.dry && result.steps[0].json, { commit_id: HEAD, event: "APPROVE", comments: [] });
});

test("pushReview validation errors", async () => {
  await assert.rejects(push({ event: "MERGE" }), { message: "Pick a decision: comment, approve or request changes." });
  await assert.rejects(push({}), { message: "Pick a decision: comment, approve or request changes." });
  await assert.rejects(push({ event: "COMMENT", comments: [{ path: "a.ts", line: "3", body: "x" }] }), { message: "A comment is missing its file, line or text." });
  await assert.rejects(push({ event: "COMMENT", comments: [{ path: "", line: 3, body: "x" }] }), { message: "A comment is missing its file, line or text." });
  await assert.rejects(push({ event: "COMMENT", comments: [{ path: "a.ts", line: 3, body: "  " }] }), { message: "A comment is missing its file, line or text." });
  await assert.rejects(push({ event: "REQUEST_CHANGES", body: "   " }), { message: "GitHub needs a summary when you request changes." });
  await assert.rejects(push({ event: "COMMENT" }), { message: "There's nothing to post yet." });
  await assert.rejects(push({ event: "COMMENT", body: "", replies: [{ comment_id: 1, body: " " }] }), { message: "There's nothing to post yet." });
});

test("pushReview (fake gh): stops after a failed review", async () => {
  const { runner, calls } = fakeRunner(() => ({ code: 1, stdout: '{"message":"Unprocessable Entity"}', stderr: "gh: Unprocessable Entity (HTTP 422)" }));
  setGhRunner(runner);
  const result = await push({ event: "APPROVE", replies: [{ comment_id: 1, body: "x" }], resolve: ["T"] }, false);
  assert.deepEqual(result, { dry: false, results: [{ kind: "review", ok: false, error: "gh: Unprocessable Entity (HTTP 422)" }] });
  assert.equal(calls.length, 1);
});

test("pushReview (fake gh): sends each step and keeps going after a failed reply", async () => {
  const { runner, calls } = fakeRunner((args) => {
    if (args.includes(`${BASE}/reviews`)) return { stdout: '{"html_url":"https://github.com/r/1"}' };
    if (args.some((a) => a.endsWith("/replies"))) return { code: 1, stderr: "gh: Not Found (HTTP 404)" };
    return { stdout: '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}' };
  });
  setGhRunner(runner);
  const result = await push({ event: "COMMENT", body: "hi", replies: [{ comment_id: 5, body: "x" }], resolve: ["PRRT_1"] }, false);
  assert.deepEqual(result, {
    dry: false,
    results: [
      { kind: "review", ok: true, url: "https://github.com/r/1" },
      { kind: "reply", ok: false, error: "gh: Not Found (HTTP 404)" },
      { kind: "resolve", ok: true },
    ],
  });
  assert.deepEqual(calls[0].args, ["api", "--method", "POST", `${BASE}/reviews`, "--input", "-"]);
  assert.deepEqual(JSON.parse(calls[0].input as string), { commit_id: HEAD, event: "COMMENT", comments: [], body: "hi" });
  assert.deepEqual(calls[2].args.slice(-2), ["-f", "id=PRRT_1"]);
});

/* ---------- GhError ---------- */

async function failWith(code: number, stderr: string, stdout = ""): Promise<GhError> {
  setGhRunner(fakeRunner(() => ({ code, stderr, stdout })).runner);
  try {
    await gh(["api", "user"]);
  } catch (e) {
    assert.ok(e instanceof GhError);
    return e;
  }
  assert.fail("expected gh to throw");
}

test("GhError classification from real gh output", async () => {
  const notLoggedIn = "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.";
  assert.equal((await failWith(4, notLoggedIn)).kind, "auth");
  assert.equal((await failWith(1, "gh: Bad credentials (HTTP 401)", '{"message":"Bad credentials","status":"401"}')).kind, "auth");
  assert.equal((await failWith(1, "gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (HTTP 403)")).kind, "auth");
  assert.equal((await failWith(1, "gh: Not Found (HTTP 404)", '{"message":"Not Found","status":"404"}')).kind, "notFound");
  const missingPr = '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"],"message":"Could not resolve to a PullRequest with the number of 99999999."}]}';
  const e = await failWith(1, "gh: Could not resolve to a PullRequest with the number of 99999999.", missingPr);
  assert.equal(e.kind, "notFound");
  assert.equal(e.message, "gh: Could not resolve to a PullRequest with the number of 99999999.");
  assert.equal(e.response.data.repository.pullRequest, null);
  assert.equal((await failWith(1, "gh: API rate limit exceeded for user ID 1234. (HTTP 403)")).kind, "rateLimit");
  assert.equal((await failWith(1, "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)")).kind, "rateLimit");
  assert.equal((await failWith(1, "gh: was submitted too quickly (HTTP 429)")).kind, "rateLimit");
  assert.equal((await failWith(1, "gh: Unprocessable Entity (HTTP 422)")).kind, "other");
  assert.equal((await failWith(1, "")).message, "gh api user failed");
});

test("GhError: gh not installed", async () => {
  const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  setGhRunner(fakeRunner(() => enoent).runner);
  await assert.rejects(gh(["api", "user"]), (e: unknown) => e instanceof GhError && e.kind === "missing" && e.exitCode === null);
});

test("classifyGhError uses GraphQL error types", () => {
  assert.equal(classifyGhError(1, "gh: something", { errors: [{ type: "RATE_LIMITED" }] }), "rateLimit");
  assert.equal(classifyGhError(1, "gh: something", { errors: [{ type: "NOT_FOUND" }] }), "notFound");
  assert.equal(classifyGhError(1, "gh: something", { errors: [{ type: "FORBIDDEN" }] }), "other");
});

test("gh parses JSON; empty output is {}", async () => {
  setGhRunner(fakeRunner(() => ({ stdout: "" })).runner);
  assert.deepEqual(await gh(["api", "x"]), {});
  setGhRunner(fakeRunner(() => ({ stdout: '{"a":1}' })).runner);
  assert.deepEqual(await gh(["api", "x"]), { a: 1 });
  setGhRunner(fakeRunner(() => ({ stdout: "nope" })).runner);
  await assert.rejects(gh(["api", "x"]), (e: unknown) => e instanceof GhError && e.kind === "other");
});

test("graphql returns data and throws on a data-less error body", async () => {
  setGhRunner(fakeRunner(() => ({ stdout: '{"data":{"viewer":{"login":"armin"}}}' })).runner);
  assert.deepEqual(await graphql("query { viewer { login } }", {}), { viewer: { login: "armin" } });
  setGhRunner(fakeRunner(() => ({ stdout: '{"errors":[{"type":"NOT_FOUND","message":"gone"}]}' })).runner);
  await assert.rejects(graphql("query { x }", {}), (e: unknown) => e instanceof GhError && e.kind === "notFound" && e.message === "gone");
});

/* ---------- parseRemote ---------- */

test("parseRemote", () => {
  assert.deepEqual(parseRemote("git@github.com:Acme/web.git"), { owner: "Acme", name: "web" });
  assert.deepEqual(parseRemote("https://github.com/Acme/api"), { owner: "Acme", name: "api" });
  assert.deepEqual(parseRemote("https://github.com/Acme/api.git/\n"), { owner: "Acme", name: "api" });
  assert.deepEqual(parseRemote("ssh://git@github.com/o/n.git"), { owner: "o", name: "n" });
  assert.equal(parseRemote("https://gitlab.com/o/n.git"), null);
  assert.equal(parseRemote(""), null);
});

test("reviewableQueries: excludes yours, your requests and approved ones, and splits repositories under 256 characters", async () => {
  const { reviewableQueries } = await import("../src/core/github.ts");
  assert.deepEqual(reviewableQueries([]), []);
  const one = reviewableQueries(["Acme/api", "acme/API", "not a repo"]);
  assert.equal(one.length, 1);
  assert.match(one[0], /-author:@me -review-requested:@me -assignee:@me -review:approved/);
  assert.match(one[0], /draft:false/);
  assert.equal(one[0].match(/repo:/g)?.length, 1, "repositories are deduplicated, case-insensitively");
  const many = reviewableQueries(Array.from({ length: 12 }, (_, i) => `acme/repository-number-${i}`));
  assert.ok(many.length > 1);
  for (const q of many) assert.ok(q.length <= 256, `${q.length} characters`);
  assert.equal(many.join(" ").match(/repo:/g)?.length, 12, "every repository is searched once");
});
