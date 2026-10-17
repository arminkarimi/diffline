// The reviewer's own review of a pull request, what changed since, and how the pull request changed while its page was
// open. Shared by the list, the page's rows, the sidebar (row-text.ts) and the review panel.

import type { PullRequestInput, ViewerLastReview } from "./types.ts";

const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

/** GitHub's updatedAt can trail a review by a few seconds without anything new; ignore that much. */
export const SINCE_REVIEW_SLACK_MS = 60_000;

/**
 * The viewer's latest submitted review from GitHub's review nodes (latestReviews in the list, reviews in the detail):
 * approved, changes requested, commented (a reply to a thread counts) or dismissed. Pending reviews don't count.
 */
export function viewerLastReviewFrom(
  reviews: ReadonlyArray<{ author?: { login?: string | null } | null; login?: string | null; state?: string | null; submittedAt?: string | null; commit?: { oid?: string | null } | string | null }>,
  viewerLogin: string | null,
): ViewerLastReview | null {
  if (!viewerLogin) return null;
  let last: ViewerLastReview | null = null;
  for (const r of reviews) {
    const login = r.author?.login ?? r.login ?? null;
    if (!login || login.toLowerCase() !== viewerLogin.toLowerCase()) continue;
    if (!r.state || !REVIEW_STATES.has(r.state) || !r.submittedAt) continue;
    if (last && r.submittedAt <= last.at) continue;
    const commit = typeof r.commit === "string" ? r.commit : (r.commit?.oid ?? null);
    last = { state: r.state as ViewerLastReview["state"], at: r.submittedAt, commit };
  }
  return last;
}

/**
 * What changed since the viewer's review: new commits (the head isn't the commit reviewed) and updated (GitHub's
 * updatedAt is more than a minute after the review, a hint that comments, reviews or the description changed). A review
 * without a commit can't say whether commits landed, so newCommits is false then.
 */
export function sinceReview(review: ViewerLastReview | null | undefined, pr: { headRefOid?: string | null; updatedAt?: string | null }): { newCommits: boolean; updated: boolean } | undefined {
  if (!review) return undefined;
  const at = Date.parse(review.at);
  const updated = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN;
  return {
    newCommits: !!review.commit && !!pr.headRefOid && review.commit !== pr.headRefOid,
    updated: Number.isFinite(at) && Number.isFinite(updated) && updated > at + SINCE_REVIEW_SLACK_MS,
  };
}

/** Approvals and change requests among each reviewer's latest approval-or-change-request (dismissed ones don't count). */
export function reviewCounts(latest: ReadonlyArray<{ state?: string | null }> | null | undefined): { approvals: number; changesRequested: number } {
  const list = latest || [];
  return { approvals: list.filter((r) => r.state === "APPROVED").length, changesRequested: list.filter((r) => r.state === "CHANGES_REQUESTED").length };
}

/** A pull request as the open page showed it, or as the list now has it. */
export interface PrSnapshot {
  state?: string | null;
  headRefOid?: string | null;
  updatedAt?: string | null;
}

/**
 * How the open pull request changed on GitHub since its page was built (the "host-pr-changed" message): merged, closed or
 * reopened, new commits, or otherwise updated (comments, reviews, the description). `kind` is the most important change.
 */
export interface PrChange {
  kind: "merged" | "closed" | "reopened" | "commits" | "updated";
  state: string | null;
  head: string | null;
  updatedAt: string | null;
  stateChanged: boolean;
  newCommits: boolean;
  updated: boolean;
  /** What the page showed. */
  was: { state: string | null; head: string | null; updatedAt: string | null };
}

/**
 * The change between what the page shows and the list's latest summary, or null when nothing changed. Every change
 * moves GitHub's updatedAt forward, so a summary not newer than the page (fetched before it) never counts.
 */
export function prChange(shown: PrSnapshot | null | undefined, now: Pick<PullRequestInput, "state" | "headRefOid" | "updatedAt"> | null | undefined): PrChange | null {
  if (!shown || !now) return null;
  const shownAt = shown.updatedAt ? Date.parse(shown.updatedAt) : NaN;
  const nowAt = now.updatedAt ? Date.parse(now.updatedAt) : NaN;
  if (Number.isFinite(shownAt) && Number.isFinite(nowAt) && nowAt <= shownAt) return null;
  const stateChanged = !!shown.state && !!now.state && shown.state !== now.state;
  const newCommits = !!shown.headRefOid && !!now.headRefOid && shown.headRefOid !== now.headRefOid;
  const updated = Number.isFinite(shownAt) && Number.isFinite(nowAt) && nowAt > shownAt;
  const kind: PrChange["kind"] | null = stateChanged
    ? now.state === "MERGED"
      ? "merged"
      : now.state === "CLOSED"
        ? "closed"
        : "reopened"
    : newCommits
      ? "commits"
      : updated
        ? "updated"
        : null;
  if (!kind) return null;
  return {
    kind,
    state: now.state ?? null,
    head: now.headRefOid ?? null,
    updatedAt: now.updatedAt ?? null,
    stateChanged,
    newCommits,
    updated,
    was: { state: shown.state ?? null, head: shown.headRefOid ?? null, updatedAt: shown.updatedAt ?? null },
  };
}
