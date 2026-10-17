import assert from "node:assert/strict";
import { test } from "node:test";

import { prChange, reviewCounts, sinceReview, viewerLastReviewFrom } from "../src/review-status.ts";

const node = (login: string | null, state: string, submittedAt: string | null, oid: string | null = "c1") => ({
  author: login ? { login } : null,
  state,
  submittedAt,
  commit: oid ? { oid } : null,
});

test("viewerLastReviewFrom: your newest submitted review of any state; pending ones and other people's don't count", () => {
  const reviews = [
    node("lee", "APPROVED", "2026-10-09T00:00:00Z"),
    node("armin", "APPROVED", "2026-10-05T00:00:00Z", "c1"),
    node("Armin", "COMMENTED", "2026-10-07T00:00:00Z", "c2"),
    node("armin", "PENDING", null, "c3"),
    node(null, "COMMENTED", "2026-10-10T00:00:00Z"),
  ];
  assert.deepEqual(viewerLastReviewFrom(reviews, "armin"), { state: "COMMENTED", at: "2026-10-07T00:00:00Z", commit: "c2" });
  assert.deepEqual(viewerLastReviewFrom([node("armin", "DISMISSED", "2026-10-05T00:00:00Z")], "armin"), { state: "DISMISSED", at: "2026-10-05T00:00:00Z", commit: "c1" });
  assert.deepEqual(viewerLastReviewFrom([node("armin", "CHANGES_REQUESTED", "2026-10-05T00:00:00Z", null)], "armin"), { state: "CHANGES_REQUESTED", at: "2026-10-05T00:00:00Z", commit: null }, "a review without a commit");
  assert.equal(viewerLastReviewFrom(reviews, "sam"), null, "not among the reviewers");
  assert.equal(viewerLastReviewFrom(reviews, null), null);
  // The detail's normalized reviews (login and commit as a string) work too.
  assert.deepEqual(viewerLastReviewFrom([{ login: "armin", state: "APPROVED", submittedAt: "2026-10-05T00:00:00Z", commit: "c9" }], "armin"), { state: "APPROVED", at: "2026-10-05T00:00:00Z", commit: "c9" });
});

test("sinceReview: new commits when the head moved, updated when GitHub changed more than a minute after the review", () => {
  const review = { state: "APPROVED" as const, at: "2026-10-05T12:00:00Z", commit: "c1" };
  assert.deepEqual(sinceReview(review, { headRefOid: "c1", updatedAt: "2026-10-05T12:00:40Z" }), { newCommits: false, updated: false }, "the review itself bumps updatedAt");
  assert.deepEqual(sinceReview(review, { headRefOid: "c1", updatedAt: "2026-10-05T13:00:00Z" }), { newCommits: false, updated: true });
  assert.deepEqual(sinceReview(review, { headRefOid: "c2", updatedAt: "2026-10-06T00:00:00Z" }), { newCommits: true, updated: true });
  assert.deepEqual(sinceReview({ ...review, commit: null }, { headRefOid: "c2", updatedAt: "2026-10-05T12:00:00Z" }), { newCommits: false, updated: false }, "without a commit, commits can't be compared");
  assert.equal(sinceReview(null, { headRefOid: "c1", updatedAt: "2026-10-06T00:00:00Z" }), undefined);
});

test("reviewCounts: approvals and change requests; dismissed reviews and comments don't count", () => {
  assert.deepEqual(reviewCounts([{ state: "APPROVED" }, { state: "APPROVED" }, { state: "CHANGES_REQUESTED" }, { state: "DISMISSED" }, { state: "COMMENTED" }]), { approvals: 2, changesRequested: 1 });
  assert.deepEqual(reviewCounts(undefined), { approvals: 0, changesRequested: 0 });
});

test("prChange: what the page shows against the list's latest summary", () => {
  const shown = { state: "OPEN", headRefOid: "h1", updatedAt: "2026-10-10T12:00:00Z" };
  const now = (over: Partial<{ state: string; headRefOid: string; updatedAt: string }>) => ({ state: "OPEN", headRefOid: "h1", updatedAt: "2026-10-10T12:00:00Z", ...over });
  assert.equal(prChange(shown, now({})), null, "nothing changed");
  assert.equal(prChange(shown, now({ headRefOid: "h0", updatedAt: "2026-10-10T11:00:00Z" })), null, "a summary fetched before the page was built doesn't count");
  const merged = prChange(shown, now({ state: "MERGED", updatedAt: "2026-10-10T13:00:00Z" }))!;
  assert.equal(merged.kind, "merged");
  assert.deepEqual([merged.stateChanged, merged.newCommits, merged.updated], [true, false, true]);
  assert.deepEqual(merged.was, { state: "OPEN", head: "h1", updatedAt: "2026-10-10T12:00:00Z" });
  assert.equal(prChange(shown, now({ state: "CLOSED", updatedAt: "2026-10-10T13:00:00Z" }))?.kind, "closed");
  assert.equal(prChange({ ...shown, state: "CLOSED" }, now({ updatedAt: "2026-10-10T13:00:00Z" }))?.kind, "reopened");
  const pushed = prChange(shown, now({ headRefOid: "h2", updatedAt: "2026-10-10T12:05:00Z" }))!;
  assert.deepEqual([pushed.kind, pushed.head, pushed.newCommits], ["commits", "h2", true]);
  assert.equal(prChange(shown, now({ updatedAt: "2026-10-10T12:00:01Z" }))?.kind, "updated");
  assert.equal(prChange(null, now({})), null);
  assert.equal(prChange(shown, null), null);
});
