// What the rules in this package read: the smallest shapes they need, not a whole data model. Each consumer maps its
// own data into these. Where a function reads less, it takes a Pick of them, so a caller passes only that.

/** A pull request: owner/name#number. */
export interface PrKey {
  owner: string;
  name: string;
  number: number;
}

/**
 * Why a pull request is listed. "code-owner": you or your team own files it changes (from CODEOWNERS). "other": an
 * open pull request in one of your repositories that nobody asked you to review. "reviewed": open, not yours, and
 * you've reviewed it. "pinned": opened by hand. "recently-closed": merged or closed lately, and you reviewed it or
 * wrote it.
 */
export type ListReason =
  | "review-requested"
  | "team-requested"
  | "assigned"
  | "reviewed"
  | "code-owner"
  | "authored"
  | "watched"
  | "pinned"
  | "recently-closed"
  | "other";

/** The viewer's latest submitted review of a pull request (a reply to a review thread is a COMMENTED review). */
export interface ViewerLastReview {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  /** submittedAt */
  at: string;
  /** The commit the review was on; null when GitHub doesn't say. */
  commit: string | null;
}

/** A pull request as the list knows it, from GitHub. */
export interface PullRequestInput {
  /** OPEN, MERGED or CLOSED. */
  state: string;
  isDraft: boolean;
  createdAt: string;
  /** When anything on GitHub last changed. */
  updatedAt: string;
  headRefOid: string;
  baseRefName: string;
  /** DIRTY means conflicts with the base branch. */
  mergeStateStatus: string | null;
  /** Set once merged or closed. */
  mergedAt?: string | null;
  closedAt?: string | null;
  /** Your review is requested by name. */
  requested: boolean;
  /** You wrote it. */
  own: boolean;
  /** Your latest approval or change request: APPROVED, CHANGES_REQUESTED or DISMISSED. */
  viewerReview: string | null;
  /** Your latest review of any state. null: you haven't reviewed it. Missing: not known. */
  viewerLastReview?: ViewerLastReview | null;
  /** What changed since viewerLastReview (sinceReview in review-status.ts). Missing when there's no review to compare. */
  sinceReview?: { newCommits: boolean; updated: boolean };
  /** Approvals and change requests among reviewers' latest approval-or-change-request. */
  reviewCounts?: { approvals: number; changesRequested: number };
  /** Each reviewer's latest approval or change request, for when reviewCounts is missing. */
  latestReviews?: ReadonlyArray<{ state: string | null }>;
  reasons: ListReason[];
}

/**
 * Where the agents' run for a pull request is. "elsewhere": another window is running them. "held": an automatic run
 * waits for you (too large, or approved).
 */
export type RunState = "idle" | "waiting" | "queued" | "running" | "elsewhere" | "held" | "done" | "failed" | "cancelled";

/** The agents' run, as a row describes it. */
export interface AgentRunInput {
  state: RunState;
  /** When a waiting automatic run starts. */
  dueAt?: number;
  /** Each agent's state while the run goes; skipped ones aren't counted. */
  progress?: { agents: Partial<Record<string, { state: string }>> };
  /** What holds an automatic run back: too large, or approved (runs skipped, or waiting for your choice). */
  hold?: "large" | "approved-skip" | "approved-ask";
}

/** The last agent review: the commit it reviewed, when it ran, and its findings (only counted here). */
export interface AgentReviewInput {
  commit: string;
  ranAt: string;
  findings: ReadonlyArray<unknown>;
}

/** A pull request in the list, with what's known about it besides GitHub: pinned, the agents' review and run. */
export interface PullRequestEntry {
  key: PrKey;
  /** null until the list has fetched it. */
  summary: PullRequestInput | null;
  /** Opened by hand. */
  pinned: boolean;
  agent: AgentReviewInput | null;
  run: AgentRunInput;
}

/** What grouping and sorting read of a listed pull request. */
export interface GroupEntry {
  key: Pick<PrKey, "owner" | "name">;
  summary: Pick<PullRequestInput, "state" | "reasons" | "createdAt" | "updatedAt"> | null;
  pinned: boolean;
}

/* ---------- Risk (computeRisk in risk.ts, and in packages/review-ui/app.js) ---------- */

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
