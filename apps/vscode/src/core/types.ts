// Shapes shared by the extension host and the Diffline page (packages/review-ui/app.js).
// The page reads ReviewData as window.REVIEW_DATA and LiveData as window.DIFFLINE_LIVE.

/* ---------- Review data: the diff, built from local git ---------- */

/** One diff line: [type, old line, new line, text, commit index, changed since last review (0/1)]. */
export type DiffLine = [" " | "+" | "-", number | null, number | null, string, number, 0 | 1];

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
  /** Whether anything in this hunk changed since the reviewer's last review. */
  fresh: boolean;
}

export interface NpmDep {
  name: string;
  dev: boolean;
  direct: boolean;
  requested: boolean;
  version?: string;
  from?: string;
  to?: string;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed";
  similarity: number | null;
  binary: boolean;
  hunks: Hunk[];
  lang: string;
  generated: boolean;
  additions: number;
  deletions: number;
  /** The file at head, line by line, when it's small enough to expand context. */
  content?: string[];
  /** The source file's test file, and whether this pull request changed it. */
  tests: { path: string; changed: boolean } | null;
  deps?: { manager: "npm"; added: NpmDep[]; removed: NpmDep[]; updated: NpmDep[] };
}

export interface Commit {
  sha: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export interface RefInfo {
  ref: string;
  sha: string;
  short: string;
}

export interface ReviewData {
  version: 1;
  generatedAt: string;
  repo: string;
  base: RefInfo;
  head: RefInfo;
  mergeBase: string;
  since: (RefInfo & { index: number }) | null;
  commits: Commit[];
  files: DiffFile[];
  workspace: Record<string, string>;
}

/* ---------- GitHub: what the page shows around the diff ---------- */

export interface Person {
  login: string | null;
  name: string | null;
}

export interface Check {
  name: string | null;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  description?: string | null;
}

export interface ThreadComment extends Person {
  id: string;
  dbId: number | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface Thread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  comments: ThreadComment[];
}

/** The pull request as the page expects it (normalizePullRequest in github.ts). */
export interface PullRequest {
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  /** When anything on GitHub last changed, so the extension can tell the page about changes since it was built. */
  updatedAt: string | null;
  /** Set once merged or closed (a merged pull request has both). */
  mergedAt: string | null;
  mergedBy: Person | null;
  closedAt: string | null;
  author: Person;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  defaultBranch: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  /** The pull request's size, so the page can say it while the diff loads. Missing in details cached by older versions. */
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  labels: string[];
  reviewRequests: Array<{ login?: string; team?: string; name: string | null }>;
  latestReviews: Array<Person & { state: string; submittedAt: string | null }>;
  reviews: Array<Person & { state: string; submittedAt: string | null; body: string; commit: string | null }>;
  comments: Array<Person & { body: string; createdAt: string; url: string }>;
  viewedFiles: string[];
  checks: Check[];
  /** The viewer's newest submitted review of any state (state missing in pages saved by older versions). */
  lastReview: { submittedAt: string; commit: string | null; state?: ViewerLastReview["state"] } | null;
}

export interface PullRequestDetail {
  viewer: Person;
  pr: PullRequest;
  threads: Thread[];
}

/** The viewer's latest submitted review of a pull request (a reply to a review thread is a COMMENTED review). */
export interface ViewerLastReview {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  /** submittedAt */
  at: string;
  /** The commit the review was on; null when GitHub doesn't say. */
  commit: string | null;
}

/** A pull request in the list: cheap to fetch for many at once (one GraphQL search). */
export interface PullRequestSummary {
  repo: string; // owner/name
  number: number;
  title: string;
  url: string;
  author: Person;
  createdAt: string;
  updatedAt: string;
  state: string;
  isDraft: boolean;
  /** Set once merged or closed. Missing in lists saved by older versions. */
  mergedAt?: string | null;
  closedAt?: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Changed files with line counts (first 100), so risk can be scored before the diff is built. */
  files: Array<{ path: string; additions: number; deletions: number }>;
  checks: { total: number; failed: number; running: number };
  requested: boolean;
  own: boolean;
  /** Your latest approval or change request (latestOpinionatedReviews): APPROVED, CHANGES_REQUESTED or DISMISSED. */
  viewerReview: string | null;
  /**
   * Your latest review of any state, with when and on which commit. null: you haven't reviewed it. Missing: not fetched,
   * because only the searches you're involved in ask for it (review requests, assigned, reviewed, yours, opened here,
   * recently closed); team requests, watched repositories and others leave it out to keep those searches fast.
   */
  viewerLastReview?: ViewerLastReview | null;
  /** What changed since viewerLastReview (review-status.ts sinceReview). Missing when there's no review to compare. */
  sinceReview?: { newCommits: boolean; updated: boolean };
  /** Approvals and change requests among reviewers' latest opinionated reviews; the list has no reviewDecision. */
  reviewCounts?: { approvals: number; changesRequested: number };
  /** Each reviewer's latest approval or change request (latestOpinionatedReviews). Missing in lists saved by older versions. */
  latestReviews?: Array<{ login: string | null; state: string | null }>;
  /**
   * Why it's listed. "code-owner" (you or your team own changed files) is added after the search, from CODEOWNERS;
   * "other" is an open pull request in one of your repositories that nobody asked you to review. "reviewed": open,
   * not yours, and you've reviewed it (GitHub drops you from the requested reviewers once you do). "recently-closed":
   * merged or closed in the last diffline.watch.recentlyClosedDays days, and you reviewed it or wrote it.
   */
  reasons: Array<"review-requested" | "team-requested" | "assigned" | "reviewed" | "code-owner" | "authored" | "watched" | "pinned" | "recently-closed" | "other">;
}

/* ---------- Agent review: agents/<owner>__<repo>__<pr>.json in the extension's storage (store.ts) ---------- */

/** An agent's id from agents.yml: "guide", a built-in reviewer such as "security", or one the user added. */
export type AgentId = string;

export interface AgentInfo {
  id: string;
  name: string;
  short: string;
  focus: string;
  /** What the agent ran with. Agent files from before these were recorded don't have them. */
  harness?: string;
  /** The model the harness reported, else the configured one; null when neither is known. */
  model?: string | null;
  /** Pi only: the thinking level, null for Pi's default. */
  thinking?: string | null;
  /** The first 12 hex of a SHA-256 of the agent's focus and instructions, so a change of instructions shows later. */
  instructions?: string;
}

export interface Ref {
  path: string;
  match: string;
  end?: string;
  lines?: number;
}

export interface FindingStep {
  path?: string;
  match: string;
  text: string;
}

export interface Finding {
  /** "<agent>-<8 hex>" from the agent and the line it's on, stable across runs (validate.ts findingId). Older files: "f1", "f2", …. */
  id: string;
  agent: string;
  severity: "high" | "medium" | "low";
  confidence: "High confidence" | "Worth asking" | "Minor";
  label: "blocking" | "question" | "nit" | "suggestion";
  path: string;
  match: string;
  title: string;
  body: string;
  steps?: FindingStep[];
  fix?: { text: string };
  comment: string;
  followups?: string[];
}

export interface CheckedNote {
  agent: string;
  path?: string;
  text: string;
}

export interface Chapter {
  title: string;
  note: string;
  source: { kind: "commits" | "description" | "auto"; text: string };
  files: string[];
  quiet: boolean;
}

export interface DescriptionItem {
  rule: string;
  status: "covered" | "partly" | "missing" | "none";
  quote?: string;
  note?: string;
  ask?: string;
  refs?: Ref[];
}

export interface DiagramNode {
  id: string;
  label: string;
  detail?: string;
  kind?: "step" | "actor" | "data";
  change?: "added" | "changed" | "removed";
  before?: { label?: string; detail?: string };
  refs?: Ref[];
  findings?: string[];
}

export interface Diagram {
  id: string;
  title: string;
  short: string;
  summary: string;
  nodes: DiagramNode[];
  edges: Array<{ from: string; to: string; label?: string; change?: "added" | "changed" | "removed" }>;
}

export interface AgentFile {
  version: 1;
  agent: string;
  ranAt: string;
  commit: string;
  lede: string;
  agents: AgentInfo[];
  plan?: { chapters: Chapter[]; reasons: string[] };
  findings: Finding[];
  checked: CheckedNote[];
  description?: { kind: "feature" | "fix"; why: string; items: DescriptionItem[] };
  diagrams?: Diagram[];
}

/* ---------- Local review state: state/<owner>__<repo>__<pr>.json in the extension's storage (store.ts) ---------- */

/** Owned by the page; the extension stores it and reads a few counts for the list. */
export type ReviewState = Record<string, unknown> & {
  drafts?: unknown[];
  reviewedIds?: string[];
  /**
   * Finding id → the decision: "accepted" (with the draft it became, gone from drafts once posted) or "dismissed" (with
   * the reason). `run` is the agent file's ranAt it was made on (missing on older decisions).
   */
  findings?: Record<string, { state?: string; run?: string; title?: string; reason?: string; draft?: string }>;
  /** Description rule → the reviewer's decision on a gap: asked (posted once a review with it went out) or skipped. */
  desc?: Record<string, { state?: string; reason?: string; posted?: boolean }>;
};

/**
 * Whether the saved state decided a finding. Positional ids from before ids were stable ("f1", "f2", …) count only
 * when the decision names the run it was made on, which older decisions don't.
 */
export function decided(state: { findings?: Record<string, { state?: string; run?: string }> } | null, id: string, ranAt: string | undefined): boolean {
  const d = state?.findings?.[id];
  if (!d || !d.state) return false;
  return !/^f\d+$/.test(id) || (!!d.run && d.run === ranAt);
}

/* ---------- The page's live data (window.DIFFLINE_LIVE) ---------- */

/** One row of the page's inbox. */
export interface ListItem {
  number: number;
  repo: string;
  key: string;
  href: string;
  loaded: boolean;
  error: string | null;
  title: string | null;
  author: Person | null;
  createdAt: string | null;
  state: string | null;
  isDraft: boolean | null;
  /** Set once merged or closed. */
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  headRefOid: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  defaultBranch: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  additions?: number;
  deletions?: number;
  files?: number;
  hunks?: number;
  weight?: number;
  reviewed: number;
  drafts: number;
  checks: { total: number; failed: number; running: number };
  agent: { findings: number; openHigh: number; open: number } | null;
  description: { kind: string; gaps: number; rules: number } | null;
  /** Your review is requested by name. With viewerLastReview set, it's requested again. */
  requested: boolean;
  /** Your latest approval or change request (APPROVED, CHANGES_REQUESTED or DISMISSED), as before. */
  viewerReview: string | null;
  /** Your latest review of any state; null when you haven't reviewed it or the list doesn't know (see PullRequestSummary). */
  viewerLastReview: ViewerLastReview | null;
  /** What changed since viewerLastReview; null without one. */
  sinceReview: { newCommits: boolean; updated: boolean } | null;
  /** Approvals and change requests, for when reviewDecision isn't known (the list doesn't fetch it). */
  reviewCounts: { approvals: number; changesRequested: number };
  own: boolean;
  stackedOnPr?: number;
  riskInput: RiskInput;
}

export interface LiveData {
  repo: string;
  number: number;
  url: string;
  github: boolean;
  githubError: string | null;
  viewer: Person | null;
  pr: PullRequest;
  threads: Thread[];
  loadedAt: string;
  token: string;
  api: string;
  agent: AgentFile | null;
  state: ReviewState | null;
  list: ListItem[];
  /** The list's groups, in the sidebar's order; without them the page shows the list ungrouped. */
  groups?: Array<{ id: string; label: string; description: string; collapsed: boolean; keys: string[] }>;
  grouping?: { by: "relationship" | "repository"; sort: "risk" | "created" | "updated" };
  /** "inbox" opens the page on its list (the sidebar's Home); "metrics" on the review metrics report. */
  startView?: "inbox" | "metrics";
  /** Why an automatic agent run is held back (a large or approved pull request), when one is. */
  runNote?: string;
}

/* ---------- Risk (computeRisk in app.js) ---------- */

export interface RiskInput {
  files: Array<{ path: string; additions: number; deletions: number; generated?: boolean; tests?: { path: string; changed: boolean } | null }>;
  findings: Array<{ severity: string; state: string }>;
  checks: { total: number; failed: number; running: number };
}

export interface Risk {
  score: number;
  level: "low" | "medium" | "high";
  factors: Array<{ id: string; label: string; detail: string; p: number; points: number; files?: string[] }>;
  lines: number;
}

/* ---------- Posting a review ---------- */

export interface PushPayload {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
  comments?: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; body: string }>;
  replies?: Array<{ comment_id: number; body: string }>;
  resolve?: string[];
  unresolve?: string[];
}

export interface PushStep {
  kind: "review" | "reply" | "resolve" | "unresolve";
  request: string;
  json?: unknown;
  thread?: string;
}

export type PushResult =
  | { dry: true; as: string | null; steps: PushStep[] }
  | { dry: false; results: Array<{ kind: PushStep["kind"]; ok: boolean; url?: string; error?: string }> };

/* ---------- Identity ---------- */

export interface PrKey {
  owner: string;
  name: string;
  number: number;
}

export const prKeyString = (k: PrKey): string => `${k.owner}/${k.name}#${k.number}`;
export const prSlug = (k: PrKey): string => `${k.owner}__${k.name}__${k.number}`;
