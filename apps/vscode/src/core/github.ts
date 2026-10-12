// The GitHub layer: everything goes through the GitHub CLI (`gh`). It fetches pull requests
// with one GraphQL query, normalizes them into the shapes the page (packages/review-ui/app.js)
// reads, parses git remotes, and posts reviews. Field names and order are part of that contract.

import { CODEOWNERS_PATHS } from "./codeowners.ts";
import { run, type RunResult } from "./exec.ts";
import { prKeyString } from "./types.ts";
import type {
  Check,
  Person,
  PrKey,
  PullRequest,
  PullRequestDetail,
  PullRequestSummary,
  PushPayload,
  PushResult,
  PushStep,
  Thread,
} from "./types.ts";

/* ---------- Queries ---------- */

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login name }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number title body url state isDraft createdAt
      author { login ... on User { name } }
      baseRefName headRefName baseRefOid headRefOid
      reviewDecision mergeStateStatus
      labels(first: 20) { nodes { name } }
      reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login name } ... on Team { slug name } } } }
      latestOpinionatedReviews(first: 30) { nodes { author { login ... on User { name } } state submittedAt } }
      reviews(last: 60) { nodes { author { login ... on User { name } } state submittedAt body commit { oid } } }
      comments(last: 60) { nodes { author { login ... on User { name } } body createdAt url } }
      files(first: 100) { nodes { path viewerViewedState } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 60) { nodes { id databaseId author { login ... on User { name } } body createdAt url } }
        }
      }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state description targetUrl }
        } } } } }
      }
    }
  }
}
`;

const RESOLVE = "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }";
const UNRESOLVE = "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }";

/**
 * The pull request fields the list needs, shared by every search and pinned lookup.
 * Kept cheap on purpose: GitHub stops a query after about 10 seconds (gh reports HTTP 502/504), and a
 * search of 50 pull requests runs past that with mergeStateStatus or every check context listed.
 * reviewDecision and files added 2-3 seconds more, so they're left out too: checks come as counts by
 * state, merge state as `mergeable` (conflicts or not), and files from fetchPullRequestFiles when needed.
 */
const SUMMARY_FRAGMENT = `
fragment DifflineSummary on PullRequest {
  number title url createdAt updatedAt state isDraft
  author { login ... on User { name } }
  repository { nameWithOwner }
  baseRefName headRefName headRefOid
  mergeable
  additions deletions changedFiles
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } } } }
  latestOpinionatedReviews(first: 30) { nodes { author { login } state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts {
    checkRunCount statusContextCount
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
  } } } } }
}
`;

/* ---------- Running gh ---------- */

export type GhErrorKind = "missing" | "auth" | "notFound" | "rateLimit" | "other";

export class GhError extends Error {
  readonly kind: GhErrorKind;
  /** gh's exit code, or null when gh couldn't start. */
  readonly exitCode: number | null;
  readonly stderr: string;
  /** The parsed JSON gh printed before failing. For GraphQL this can hold partial `data` next to `errors`. */
  readonly response: any;
  constructor(message: string, kind: GhErrorKind, exitCode: number | null = null, stderr = "", response: any = undefined) {
    super(message);
    this.name = "GhError";
    this.kind = kind;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.response = response;
  }
}

/** Runs gh with these arguments. Rejects with an error whose `code` is "ENOENT" when gh isn't installed. */
export type GhRunner = (args: string[], input?: string) => Promise<RunResult>;

const GH_TIMEOUT_MS = 60_000;

const defaultRunner: GhRunner = (args, input) =>
  run("gh", args, {
    input,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    timeoutMs: GH_TIMEOUT_MS,
  });

let runner: GhRunner = defaultRunner;

/** Replace how gh is run (tests use a fake). Pass null to restore the real gh. */
export function setGhRunner(next: GhRunner | null): void {
  runner = next ?? defaultRunner;
}

/** Which kind of failure gh's exit code, stderr and (for GraphQL) response body describe. */
export function classifyGhError(exitCode: number | null, stderr: string, response?: any): GhErrorKind {
  const types: string[] = Array.isArray(response?.errors) ? response.errors.map((e: any) => String(e?.type ?? "")) : [];
  if (
    exitCode === 4 ||
    /gh auth login|HTTP 401|Bad credentials|authentication required|not logged in|requires authentication|SAML enforcement|token (?:has )?(?:expired|been revoked)/i.test(stderr)
  ) {
    return "auth";
  }
  if (types.includes("RATE_LIMITED") || /rate limit|HTTP 429|abuse detection|submitted too quickly/i.test(stderr)) return "rateLimit";
  if (types.includes("NOT_FOUND") || /HTTP 404|Could not resolve to|\bNot Found\b/i.test(stderr)) return "notFound";
  return "other";
}

/** Run the GitHub CLI and parse its JSON output (empty output is {}). Throws GhError on failure. */
export async function gh(args: string[], input?: string): Promise<any> {
  let result: RunResult;
  try {
    result = await runner(args, input);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new GhError("The GitHub CLI (gh) isn't installed or isn't on the PATH. Install it from https://cli.github.com.", "missing");
    }
    throw new GhError(`Couldn't run gh: ${(err as Error)?.message ?? err}`, "other");
  }
  const stderr = result.stderr.trim();
  if (result.killed) {
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} took too long and was stopped.`, "other", result.code, stderr);
  }
  if (result.code !== 0) {
    let response: any;
    try {
      response = result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
    } catch {
      response = undefined;
    }
    const message = stderr || `gh ${args.slice(0, 2).join(" ")} failed`;
    throw new GhError(message, classifyGhError(result.code, stderr, response), result.code, stderr, response);
  }
  if (!result.stdout.trim()) return {};
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GhError(`gh ${args.slice(0, 2).join(" ")} returned output that isn't JSON.`, "other", result.code, stderr);
  }
}

/** Run a GraphQL query and return its `data`. Strings are sent with -f, numbers with -F (typed). */
export async function graphql(query: string, variables: Record<string, string | number> = {}): Promise<any> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const out = await gh(args);
  if (!out?.data && Array.isArray(out?.errors) && out.errors.length) {
    const message = String(out.errors[0]?.message ?? "GitHub returned an error.");
    throw new GhError(message, classifyGhError(0, message, out), 0, "", out);
  }
  return out?.data ?? {};
}

/* ---------- Normalizing ---------- */

const nodes = (connection: any): any[] => (connection?.nodes ?? []).map((n: any) => n ?? {});

function person(node: any): Person {
  return { login: node?.login ?? null, name: node?.name || null };
}

/** CheckRun and StatusContext as the page shows them (status COMPLETED/IN_PROGRESS, conclusion when done). */
function checkFromContext(c: any): Check | null {
  if (c.__typename === "CheckRun") {
    return { name: c.name ?? null, status: c.status ?? null, conclusion: c.conclusion ?? null, url: c.detailsUrl ?? null };
  }
  if (c.__typename === "StatusContext") {
    const state = c.state ?? null;
    const done = state === "SUCCESS" || state === "FAILURE" || state === "ERROR";
    return {
      name: c.context ?? null,
      status: done ? "COMPLETED" : "IN_PROGRESS",
      conclusion: done ? state : null,
      url: c.targetUrl ?? null,
      description: c.description ?? null,
    };
  }
  return null;
}

function rollupContexts(pr: any): any[] {
  const commitNodes = nodes(pr.commits);
  const rollup = commitNodes.length ? (commitNodes[0].commit?.statusCheckRollup ?? {}) : {};
  return nodes(rollup.contexts);
}

const checkDone = (c: { status: string | null }) => c.status === "COMPLETED";
const checkGood = (c: { conclusion: string | null }) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED";

/** Check counts as the list shows them (Session.summary): failed = done and not good, running = not done. */
export function countChecks(checks: Array<{ status: string | null; conclusion: string | null }>): { total: number; failed: number; running: number } {
  return {
    total: checks.length,
    failed: checks.filter((c) => checkDone(c) && !checkGood(c)).length,
    running: checks.filter((c) => !checkDone(c)).length,
  };
}

/** The pure part of fetchPullRequest: GraphQL `data` for PR_QUERY to what the page expects (normalize_github). */
export function normalizePullRequest(data: any): PullRequestDetail {
  const viewer = person(data?.viewer);
  const repo = data?.repository ?? {};
  const pr = repo.pullRequest ?? {};
  if (!repo.pullRequest || !Object.keys(pr).length) {
    throw new Error("GitHub didn't return this pull request. Check the number and your access.");
  }

  const requests: PullRequest["reviewRequests"] = [];
  for (const node of nodes(pr.reviewRequests)) {
    const r = node.requestedReviewer ?? {};
    if (r.__typename === "Team") requests.push({ team: r.slug ?? undefined, name: r.name ?? null });
    else if (r.login) requests.push({ login: r.login, name: r.name ?? null });
  }

  const latest: PullRequest["latestReviews"] = nodes(pr.latestOpinionatedReviews).map((n) => ({
    ...person(n.author),
    state: n.state ?? null,
    submittedAt: n.submittedAt ?? null,
  }));
  const reviews: PullRequest["reviews"] = nodes(pr.reviews)
    .filter((n) => n.state !== "PENDING")
    .map((n) => ({
      ...person(n.author),
      state: n.state ?? null,
      submittedAt: n.submittedAt ?? null,
      body: n.body || "",
      commit: n.commit?.oid ?? null,
    }));
  let lastReview: (typeof reviews)[number] | null = null;
  for (const r of reviews) {
    if (!r.login || r.login !== viewer.login || !r.submittedAt) continue;
    if (!lastReview || r.submittedAt > (lastReview.submittedAt as string)) lastReview = r;
  }

  const checks: Check[] = [];
  for (const c of rollupContexts(pr)) {
    const check = checkFromContext(c);
    if (check) checks.push(check);
  }

  const threads: Thread[] = nodes(pr.reviewThreads).map((t) => ({
    id: t.id ?? null,
    resolved: Boolean(t.isResolved),
    outdated: Boolean(t.isOutdated),
    path: t.path ?? null,
    line: t.line ?? null,
    startLine: t.startLine ?? null,
    side: t.diffSide || "RIGHT",
    comments: nodes(t.comments).map((c) => ({
      id: c.id ?? null,
      dbId: c.databaseId ?? null,
      ...person(c.author),
      body: c.body || "",
      createdAt: c.createdAt ?? null,
      url: c.url ?? null,
    })),
  }));

  const normalized: PullRequest = {
    title: pr.title ?? null,
    body: pr.body || "",
    url: pr.url ?? null,
    state: pr.state ?? null,
    isDraft: Boolean(pr.isDraft),
    createdAt: pr.createdAt ?? null,
    author: person(pr.author),
    baseRefName: pr.baseRefName ?? null,
    headRefName: pr.headRefName ?? null,
    baseRefOid: pr.baseRefOid ?? null,
    headRefOid: pr.headRefOid ?? null,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    labels: nodes(pr.labels).map((n) => n.name ?? null),
    reviewRequests: requests,
    latestReviews: latest,
    reviews,
    comments: nodes(pr.comments).map((n) => ({
      ...person(n.author),
      body: n.body || "",
      createdAt: n.createdAt ?? null,
      url: n.url ?? null,
    })),
    viewedFiles: nodes(pr.files)
      .filter((n) => n.viewerViewedState === "VIEWED")
      .map((n) => n.path),
    checks,
    lastReview: lastReview ? { submittedAt: lastReview.submittedAt as string, commit: lastReview.commit } : null,
  };
  return { viewer, pr: normalized, threads };
}

/* ---------- Reading ---------- */

export async function getViewer(): Promise<Person> {
  const data = await graphql("query { viewer { login name } }", {});
  return person(data.viewer);
}

/** One GraphQL call: the pull request, its reviews, threads and checks. */
export async function fetchPullRequest(key: PrKey): Promise<PullRequestDetail> {
  const data = await graphql(PR_QUERY, { owner: key.owner, name: key.name, number: key.number });
  return normalizePullRequest(data);
}

export interface SearchOptions {
  /** Open pull requests that request your review by name. */
  direct: boolean;
  /** Open pull requests that request your review only through a team. */
  team: boolean;
  /** Open pull requests assigned to you. */
  assigned?: boolean;
  /** Open pull requests, not yours, that you've reviewed. */
  reviewed?: boolean;
  authored: boolean;
  /** Watched repositories, as owner/name: every open pull request in them. */
  repositories: string[];
  /** Pull requests to include whatever their state. */
  pinned: PrKey[];
}

export type SearchKind = "direct" | "team" | "assigned" | "reviewed" | "authored" | "watched";

export interface SearchResult {
  viewer: Person;
  items: PullRequestSummary[];
  /** Per search: how many pull requests came back and how many match. Watched sums every repository. */
  totals: Record<SearchKind, { shown: number; total: number }>;
  rateLimit?: { remaining: number; resetAt: string; cost?: number };
  /** Parts of the query GitHub couldn't answer (a pinned pull request that's gone, say). The rest still loaded. */
  errors?: string[];
}

type Reason = PullRequestSummary["reasons"][number];

/** One aliased part of the search query and why its results are in the list. */
export interface SearchSource {
  alias: string;
  reason: Reason;
  kind: "search" | "pinned";
  search?: SearchKind;
  label: string;
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const SEARCHES = {
  direct: "is:pr is:open user-review-requested:@me archived:false sort:updated-desc",
  team: "is:pr is:open review-requested:@me -user-review-requested:@me archived:false sort:updated-desc",
  assigned: "is:pr is:open assignee:@me archived:false sort:updated-desc",
  reviewed: "is:pr is:open reviewed-by:@me -author:@me archived:false sort:updated-desc",
  authored: "is:pr is:open author:@me archived:false sort:updated-desc",
  watched: (repo: string) => `repo:${repo} is:pr is:open archived:false sort:updated-desc`,
};

/** Build the single GraphQL request behind searchPullRequests. Pure, for tests. */
export function buildSearchQuery(opts: SearchOptions, pageSize = 50): { query: string; variables: Record<string, string | number>; sources: SearchSource[] } {
  const sources: SearchSource[] = [];
  const variables: Record<string, string | number> = {};
  const decls: string[] = [];
  const parts: string[] = [];
  const search = (alias: string, kind: SearchKind, reason: Reason, q: string, label: string) => {
    decls.push(`$${alias}: String!`);
    variables[alias] = q;
    parts.push(`${alias}: search(type: ISSUE, query: $${alias}, first: ${pageSize}) { issueCount nodes { ...DifflineSummary } }`);
    sources.push({ alias, reason, kind: "search", search: kind, label });
  };
  if (opts.direct) search("direct", "direct", "review-requested", SEARCHES.direct, "review requested");
  if (opts.team) search("team", "team", "team-requested", SEARCHES.team, "team review requested");
  if (opts.assigned) search("assigned", "assigned", "assigned", SEARCHES.assigned, "assigned");
  if (opts.reviewed) search("reviewed", "reviewed", "reviewed", SEARCHES.reviewed, "reviewed by you");
  if (opts.authored) search("authored", "authored", "authored", SEARCHES.authored, "authored");
  const seenRepos = new Set<string>();
  for (const repo of opts.repositories) {
    const name = repo.trim();
    if (!REPO_NAME.test(name) || seenRepos.has(name.toLowerCase())) continue;
    seenRepos.add(name.toLowerCase());
    search(`watched${seenRepos.size - 1}`, "watched", "watched", SEARCHES.watched(name), name);
  }
  const seenPinned = new Set<string>();
  for (const key of opts.pinned) {
    const id = `${key.owner}/${key.name}#${key.number}`.toLowerCase();
    if (seenPinned.has(id)) continue;
    seenPinned.add(id);
    const alias = `pinned${seenPinned.size - 1}`;
    decls.push(`$${alias}Owner: String!`, `$${alias}Name: String!`, `$${alias}Number: Int!`);
    variables[`${alias}Owner`] = key.owner;
    variables[`${alias}Name`] = key.name;
    variables[`${alias}Number`] = key.number;
    parts.push(`${alias}: repository(owner: $${alias}Owner, name: $${alias}Name) { pullRequest(number: $${alias}Number) { ...DifflineSummary } }`);
    sources.push({ alias, reason: "pinned", kind: "pinned", label: `${key.owner}/${key.name}#${key.number}` });
  }
  const header = decls.length ? `query(${decls.join(", ")})` : "query";
  const body = ["viewer { login name }", "rateLimit { remaining resetAt cost }", ...parts].join("\n  ");
  const query = `${header} {\n  ${body}\n}\n${parts.length ? SUMMARY_FRAGMENT : ""}`;
  return { query, variables, sources };
}

// Check-run states as GitHub counts them: a finished run under its conclusion, an unfinished one under its status.
const RUN_GOOD = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const RUN_RUNNING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
// Commit statuses: SUCCESS/FAILURE/ERROR are done (as in normalize_github), EXPECTED/PENDING are running.
const STATUS_RUNNING = new Set(["EXPECTED", "PENDING"]);

/**
 * Check counts from statusCheckRollup.contexts' counts by state, with the same rules as countChecks:
 * done = COMPLETED, good = SUCCESS/NEUTRAL/SKIPPED, so a completed run with any other conclusion is failed.
 */
export function countCheckStates(contexts: any): { total: number; failed: number; running: number } {
  let total = 0;
  let failed = 0;
  let running = 0;
  for (const { state, count } of contexts?.checkRunCountsByState ?? []) {
    total += count;
    if (RUN_RUNNING.has(state)) running += count;
    else if (!RUN_GOOD.has(state)) failed += count;
  }
  for (const { state, count } of contexts?.statusContextCountsByState ?? []) {
    total += count;
    if (STATUS_RUNNING.has(state)) running += count;
    else if (state !== "SUCCESS") failed += count;
  }
  return { total, failed, running };
}

/** One pull request node (DifflineSummary) as a list item, from the viewer's point of view. */
function summarizePullRequest(node: any, viewerLogin: string | null, reasons: Reason[]): PullRequestSummary {
  const commit = nodes(node.commits)[0]?.commit;
  const mine = nodes(node.latestOpinionatedReviews).filter((r) => viewerLogin && r.author?.login === viewerLogin);
  return {
    repo: node.repository?.nameWithOwner ?? null,
    number: node.number,
    title: node.title ?? null,
    url: node.url ?? null,
    author: person(node.author),
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    state: node.state ?? null,
    isDraft: Boolean(node.isDraft),
    baseRefName: node.baseRefName ?? null,
    headRefName: node.headRefName ?? null,
    headRefOid: node.headRefOid ?? null,
    reviewDecision: node.reviewDecision ?? null, // not in the list query (see SUMMARY_FRAGMENT)
    // The list can't afford mergeStateStatus (see SUMMARY_FRAGMENT). Conflicts are DIRTY, as GitHub reports them;
    // anything else is unknown here and comes with fetchPullRequest.
    mergeStateStatus: node.mergeStateStatus ?? (node.mergeable === "CONFLICTING" ? "DIRTY" : null),
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    files: nodes(node.files).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })), // empty: see fetchPullRequestFiles
    checks: countCheckStates(commit?.statusCheckRollup?.contexts),
    requested: Boolean(viewerLogin) && nodes(node.reviewRequests).some((r) => r.requestedReviewer?.login === viewerLogin),
    own: Boolean(viewerLogin) && node.author?.login === viewerLogin,
    viewerReview: mine.length ? (mine[0].state ?? null) : null,
    latestReviews: nodes(node.latestOpinionatedReviews).map((r) => ({ login: r.author?.login ?? null, state: r.state ?? null })),
    reasons: [...reasons],
  };
}

const isPullRequest = (node: any) => Boolean(node) && typeof node.number === "number" && Boolean(node.repository?.nameWithOwner);

/**
 * Merge the aliased results into one list: a pull request found by several parts appears once with every
 * reason. Also counts, per search, how many came back against how many match (issueCount).
 */
export function mergeSearchResults(data: any, sources: SearchSource[]): { viewer: Person; items: PullRequestSummary[]; totals: SearchResult["totals"] } {
  const viewer = person(data?.viewer);
  const byKey = new Map<string, PullRequestSummary>();
  const totals: SearchResult["totals"] = {
    direct: { shown: 0, total: 0 },
    team: { shown: 0, total: 0 },
    assigned: { shown: 0, total: 0 },
    reviewed: { shown: 0, total: 0 },
    authored: { shown: 0, total: 0 },
    watched: { shown: 0, total: 0 },
  };
  const add = (node: any, reason: Reason) => {
    const key = `${String(node.repository.nameWithOwner).toLowerCase()}#${node.number}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    byKey.set(key, summarizePullRequest(node, viewer.login, [reason]));
  };
  for (const source of sources) {
    const part = data?.[source.alias];
    if (source.kind === "search") {
      const found = ((part?.nodes ?? []) as any[]).filter(isPullRequest);
      if (source.search) {
        totals[source.search].shown += found.length;
        totals[source.search].total += typeof part?.issueCount === "number" ? part.issueCount : found.length;
      }
      for (const node of found) add(node, source.reason);
    } else if (isPullRequest(part?.pullRequest)) {
      add(part.pullRequest, source.reason);
    }
  }
  return { viewer, items: [...byKey.values()], totals };
}

/** GitHub gives up on a query after about 10 seconds and gh reports HTTP 502 or 504. */
const isGitHubTimeout = (err: unknown) => err instanceof GhError && err.kind === "other" && /HTTP 50[234]\b/.test(err.message);

/**
 * The list in one GraphQL request: review requests (by name and through a team), your own pull requests,
 * watched repositories and pinned pull requests (open or not). Searches are newest-updated first; items keep
 * the order they were first found in. reviewDecision isn't fetched (null) and files are empty: see
 * SUMMARY_FRAGMENT and fetchPullRequestFiles. If GitHub times out, the request is sent once more with 20 per
 * search, and `errors` says so.
 */
export async function searchPullRequests(opts: SearchOptions): Promise<SearchResult> {
  try {
    return await searchOnce(opts, 50);
  } catch (err) {
    if (!isGitHubTimeout(err)) throw err;
    const result = await searchOnce(opts, 20);
    const note = "GitHub timed out on the full list, so each search shows its first 20 pull requests.";
    return { ...result, errors: [note, ...(result.errors ?? [])] };
  }
}

/**
 * Run an aliased query whose aliases may fail on their own (a pull request that's gone, say).
 * Returns the data plus one message per failed alias; anything else that fails throws.
 */
async function graphqlParts(query: string, variables: Record<string, string | number>, labels: Map<string, string>): Promise<{ data: any; errors?: string[] }> {
  try {
    return { data: await graphql(query, variables) };
  } catch (err) {
    const response = err instanceof GhError ? err.response : undefined;
    const partial = response?.data;
    const errs: any[] = Array.isArray(response?.errors) ? response.errors : [];
    const onlyParts = partial && errs.length > 0 && errs.every((e) => labels.has(e?.path?.[0]));
    if (!onlyParts) throw err;
    return {
      data: partial,
      errors: errs.map((e) => `${labels.get(e.path[0])}: ${e.message ?? "GitHub returned an error."}`),
    };
  }
}

async function searchOnce(opts: SearchOptions, pageSize: number): Promise<SearchResult> {
  const { query, variables, sources } = buildSearchQuery(opts, pageSize);
  const { data, errors } = await graphqlParts(query, variables, new Map(sources.map((s) => [s.alias, s.label])));
  if (!data?.viewer) throw new GhError("GitHub didn't say who you are. Check `gh auth status`.", "auth");
  const { viewer, items, totals } = mergeSearchResults(data, sources);
  const rl = data.rateLimit;
  return {
    viewer,
    items,
    totals,
    ...(rl ? { rateLimit: { remaining: rl.remaining, resetAt: rl.resetAt, cost: rl.cost } } : {}),
    ...(errors ? { errors } : {}),
  };
}

/* ---------- Pull requests you could review, your teams, CODEOWNERS ---------- */

/** Open, ready pull requests nobody asked you about and nobody has approved yet. */
const REVIEWABLE = "is:pr is:open draft:false archived:false -author:@me -review-requested:@me -assignee:@me -review:approved sort:updated-desc";
/** GitHub rejects search queries longer than 256 characters, so repositories are split across searches. */
const MAX_QUERY = 256;

/** The searches for reviewable pull requests in these repositories, each within GitHub's query length. Pure. */
export function reviewableQueries(repos: string[]): string[] {
  const queries: string[] = [];
  let current = REVIEWABLE;
  for (const repo of [...new Set(repos.filter((r) => REPO_NAME.test(r)).map((r) => r.toLowerCase()))]) {
    const part = ` repo:${repo}`;
    if (current !== REVIEWABLE && current.length + part.length > MAX_QUERY) {
      queries.push(current);
      current = REVIEWABLE;
    }
    current += part;
  }
  if (current !== REVIEWABLE) queries.push(current);
  return queries;
}

/** Open pull requests in your repositories that you could review: not yours, not requested from you, not approved. */
export async function searchReviewable(repos: string[], perSearch = 20): Promise<{ items: PullRequestSummary[]; errors?: string[] }> {
  const queries = reviewableQueries(repos).slice(0, 4);
  if (!queries.length) return { items: [] };
  const sources: SearchSource[] = queries.map((_, i) => ({ alias: `others${i}`, reason: "other", kind: "search", label: "pull requests you could review" }));
  const variables: Record<string, string | number> = {};
  queries.forEach((q, i) => (variables[`others${i}`] = q));
  const query =
    `query(${queries.map((_, i) => `$others${i}: String!`).join(", ")}) {\n  viewer { login name }\n  ` +
    queries.map((_, i) => `others${i}: search(type: ISSUE, query: $others${i}, first: ${perSearch}) { issueCount nodes { ...DifflineSummary } }`).join("\n  ") +
    `\n}\n${SUMMARY_FRAGMENT}`;
  const { data, errors } = await graphqlParts(query, variables, new Map(sources.map((s) => [s.alias, s.label])));
  const { items } = mergeSearchResults(data, sources);
  return { items, ...(errors ? { errors } : {}) };
}

/** The teams you're in, as "org/slug", across your organizations. Needs the read:org scope, which gh asks for. */
export async function fetchViewerTeams(login: string): Promise<string[]> {
  const data = await graphql(
    `query($login: String!) { viewer { organizations(first: 50) { nodes { login teams(first: 100, userLogins: [$login]) { nodes { slug } } } } } }`,
    { login },
  );
  return nodes(data?.viewer?.organizations).flatMap((org) => nodes(org.teams).map((t) => `${org.login}/${t.slug}`.toLowerCase()));
}

/** Pull requests (or repositories) per aliased query. */
const FILES_PER_QUERY = 20;

/** Each repository's CODEOWNERS text from its default branch (the first of GitHub's three places), or null. */
export async function fetchCodeowners(repos: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const unique = [...new Set(repos.filter((r) => REPO_NAME.test(r)).map((r) => r.toLowerCase()))];
  for (let start = 0; start < unique.length; start += FILES_PER_QUERY) {
    const chunk = unique.slice(start, start + FILES_PER_QUERY);
    const decls: string[] = [];
    const parts: string[] = [];
    const variables: Record<string, string | number> = {};
    const labels = new Map<string, string>();
    chunk.forEach((repo, i) => {
      const [owner, name] = repo.split("/");
      decls.push(`$r${i}Owner: String!`, `$r${i}Name: String!`);
      variables[`r${i}Owner`] = owner;
      variables[`r${i}Name`] = name;
      const files = CODEOWNERS_PATHS.map((p, j) => `f${j}: object(expression: "HEAD:${p}") { ... on Blob { text } }`).join(" ");
      parts.push(`r${i}: repository(owner: $r${i}Owner, name: $r${i}Name) { ${files} }`);
      labels.set(`r${i}`, repo);
    });
    const { data } = await graphqlParts(`query(${decls.join(", ")}) {\n  ${parts.join("\n  ")}\n}`, variables, labels);
    chunk.forEach((repo, i) => {
      const r = data?.[`r${i}`];
      if (!r) return;
      const text = CODEOWNERS_PATHS.map((_, j) => r[`f${j}`]?.text).find((t) => typeof t === "string");
      result.set(repo, text ?? null);
    });
  }
  return result;
}

/**
 * Changed files with line counts (first 100 per pull request) for the list's risk scores, fetched lazily.
 * One aliased GraphQL query per 20 pull requests. Keyed by prKeyString ("owner/name#number", as given);
 * a pull request GitHub can't find is left out.
 */
export async function fetchPullRequestFiles(keys: PrKey[]): Promise<Map<string, Array<{ path: string; additions: number; deletions: number }>>> {
  const result = new Map<string, Array<{ path: string; additions: number; deletions: number }>>();
  const unique = [...new Map(keys.map((k) => [prKeyString(k), k])).values()];
  for (let start = 0; start < unique.length; start += FILES_PER_QUERY) {
    const chunk = unique.slice(start, start + FILES_PER_QUERY);
    const decls: string[] = [];
    const parts: string[] = [];
    const variables: Record<string, string | number> = {};
    const labels = new Map<string, string>();
    chunk.forEach((key, i) => {
      const alias = `pr${i}`;
      decls.push(`$${alias}Owner: String!`, `$${alias}Name: String!`, `$${alias}Number: Int!`);
      variables[`${alias}Owner`] = key.owner;
      variables[`${alias}Name`] = key.name;
      variables[`${alias}Number`] = key.number;
      parts.push(`${alias}: repository(owner: $${alias}Owner, name: $${alias}Name) { pullRequest(number: $${alias}Number) { files(first: 100) { nodes { path additions deletions } } } }`);
      labels.set(alias, prKeyString(key));
    });
    const { data } = await graphqlParts(`query(${decls.join(", ")}) {\n  ${parts.join("\n  ")}\n}`, variables, labels);
    chunk.forEach((key, i) => {
      const pr = data?.[`pr${i}`]?.pullRequest;
      if (!pr) return;
      result.set(prKeyString(key), nodes(pr.files).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })));
    });
  }
  return result;
}

/* ---------- Posting (Session.push) ---------- */

function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\s*[-+]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  throw new Error("A reply is missing the comment it answers.");
}

/**
 * Post a review, replies and thread resolutions. With dry, returns what would be sent and sends nothing.
 * Stops after a failed review step so replies and resolutions don't go out without it.
 */
export async function pushReview(key: PrKey, headSha: string, viewerLogin: string | null, payload: PushPayload, dry: boolean): Promise<PushResult> {
  const p: any = payload ?? {};
  const event = p.event;
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    throw new Error("Pick a decision: comment, approve or request changes.");
  }
  const body = String(p.body || "").trim();
  const comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }> = [];
  for (const raw of p.comments || []) {
    const c = raw ?? {};
    const side = c.side === "LEFT" || c.side === "RIGHT" ? c.side : "RIGHT";
    if (!c.path || !Number.isInteger(c.line) || !String(c.body || "").trim()) {
      throw new Error("A comment is missing its file, line or text.");
    }
    comments.push({ path: c.path, line: c.line, side, body: c.body });
  }
  const replies = ((p.replies || []) as any[])
    .filter((r) => String(r?.body || "").trim())
    .map((r) => ({ comment_id: toInt(r.comment_id), body: String(r.body) }));
  const resolve = ((p.resolve || []) as unknown[]).map((t) => String(t));
  const unresolve = ((p.unresolve || []) as unknown[]).map((t) => String(t));
  if (event === "REQUEST_CHANGES" && !body) {
    throw new Error("GitHub needs a summary when you request changes.");
  }

  const base = `repos/${key.owner}/${key.name}/pulls/${key.number}`;
  const steps: PushStep[] = [];
  if (event !== "COMMENT" || body || comments.length) {
    const review: Record<string, unknown> = { commit_id: headSha, event, comments };
    if (body) review.body = body;
    else if (event === "COMMENT") review.body = `Left ${comments.length} comment${comments.length !== 1 ? "s" : ""}.`;
    steps.push({ kind: "review", request: `POST ${base}/reviews`, json: review });
  }
  for (const r of replies) steps.push({ kind: "reply", request: `POST ${base}/comments/${r.comment_id}/replies`, json: { body: r.body } });
  for (const t of resolve) steps.push({ kind: "resolve", request: "GraphQL resolveReviewThread", thread: t });
  for (const t of unresolve) steps.push({ kind: "unresolve", request: "GraphQL unresolveReviewThread", thread: t });
  if (!steps.length) throw new Error("There's nothing to post yet.");
  if (dry) return { dry: true, as: viewerLogin, steps };

  const results: Extract<PushResult, { dry: false }>["results"] = [];
  for (const step of steps) {
    try {
      if (step.kind === "review" || step.kind === "reply") {
        const path = step.request.split(" ").slice(1).join(" ");
        const out = await gh(["api", "--method", "POST", path, "--input", "-"], JSON.stringify(step.json));
        results.push({ kind: step.kind, ok: true, url: out?.html_url ?? undefined });
      } else {
        await graphql(step.kind === "resolve" ? RESOLVE : UNRESOLVE, { id: step.thread as string });
        results.push({ kind: step.kind, ok: true });
      }
    } catch (err) {
      results.push({ kind: step.kind, ok: false, error: err instanceof Error ? err.message : String(err) });
      if (step.kind === "review") break; // don't post replies or resolve threads if the review itself failed
    }
  }
  return { dry: false, results };
}

/* ---------- Remotes ---------- */

/** owner and name from a GitHub remote URL (https or ssh), or null. */
export function parseRemote(url: string): { owner: string; name: string } | null {
  const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return match ? { owner: match[1], name: match[2] } : null;
}
