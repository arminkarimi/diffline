import assert from "node:assert/strict";
import { test } from "node:test";

import { agentLines, agentStatus, approvalsLine, reviewDescription, rowDescription, shortAgo, stateLine, stateWords, yourReviewLines } from "../src/row-text.ts";
import type { PullRequestEntry, PullRequestInput } from "../src/types.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function summary(over: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    baseRefName: "main",
    headRefOid: HEAD,
    mergeStateStatus: null,
    requested: false,
    own: false,
    viewerReview: null,
    viewerLastReview: null,
    reviewCounts: { approvals: 0, changesRequested: 0 },
    latestReviews: [],
    reasons: ["reviewed"],
    ...over,
  };
}

const reviewed = (state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED", at: string, commit: string | null, since?: { newCommits: boolean; updated: boolean }) => ({
  viewerReview: state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED" ? state : null,
  viewerLastReview: { state, at, commit },
  ...(since ? { sinceReview: since } : {}),
});

const record = (s: PullRequestInput | null, over: Partial<PullRequestEntry> = {}): PullRequestEntry => ({
  key: { owner: "acme", name: "web", number: 123 },
  summary: s,
  pinned: false,
  agent: null,
  run: { state: "idle" },
  ...over,
});

test("shortAgo", () => {
  assert.equal(shortAgo("2026-10-13T11:59:50Z", NOW), "just now");
  assert.equal(shortAgo("2026-10-13T11:55:00Z", NOW), "5m ago");
  assert.equal(shortAgo("2026-10-13T07:00:00Z", NOW), "5h ago");
  assert.equal(shortAgo("2026-10-11T12:00:00Z", NOW), "2d ago");
  assert.equal(shortAgo(null, NOW), "");
});

test("reviewDescription: your review with its age and what changed since; nothing when you haven't reviewed", () => {
  const d = (over: Partial<PullRequestInput>) => reviewDescription(summary(over), NOW);
  assert.equal(d(reviewed("APPROVED", "2026-10-11T12:00:00Z", OLD, { newCommits: true, updated: true })), "you approved 2d ago · new commits");
  assert.equal(d(reviewed("COMMENTED", "2026-10-13T07:00:00Z", HEAD, { newCommits: false, updated: true })), "you commented 5h ago · updated since");
  assert.equal(d(reviewed("CHANGES_REQUESTED", "2026-10-12T12:00:00Z", HEAD, { newCommits: false, updated: false })), "you requested changes 1d ago");
  assert.equal(d(reviewed("DISMISSED", "2026-10-12T12:00:00Z", null, { newCommits: false, updated: false })), "your review was dismissed 1d ago");
  assert.equal(d({ ...reviewed("APPROVED", "2026-10-10T12:00:00Z", HEAD), requested: true }), "re-requested · you approved 3d ago");
  // Approved, then replied to a thread: the approval still stands.
  assert.equal(d({ viewerReview: "APPROVED", viewerLastReview: { state: "COMMENTED", at: "2026-10-12T12:00:00Z", commit: HEAD } }), "you approved, then commented 1d ago");
  assert.equal(d({}), "", "never reviewed");
  assert.equal(d({ viewerLastReview: undefined, viewerReview: "APPROVED" }), "you approved", "not fetched (watched): your approval, without an age");
  assert.equal(d({ ...reviewed("COMMENTED", "2026-10-12T12:00:00Z", HEAD), own: true }), "", "replies on your own pull request aren't reviews");
  assert.equal(d({ ...reviewed("APPROVED", "2026-10-11T12:00:00Z", OLD, { newCommits: true, updated: true }), state: "MERGED", requested: true }), "you approved 2d ago", "no hints once merged");
});

test("stateWords and stateLine: merged, closed, draft, conflicts", () => {
  assert.deepEqual(stateWords(summary({ state: "MERGED" })), ["merged"]);
  assert.deepEqual(stateWords(summary({ state: "CLOSED" })), ["closed"]);
  assert.deepEqual(stateWords(summary({ isDraft: true, mergeStateStatus: "DIRTY" })), ["draft", "conflicts"]);
  assert.deepEqual(stateWords(summary()), []);
  assert.equal(stateLine(summary(), NOW), "Open");
  assert.equal(stateLine(summary({ isDraft: true, mergeStateStatus: "DIRTY" }), NOW), "Open, draft · conflicts with main");
  assert.equal(stateLine(summary({ state: "MERGED", mergedAt: "2026-10-12T12:00:00Z" }), NOW), "Merged 1 day ago");
  assert.equal(stateLine(summary({ state: "CLOSED", closedAt: "2026-10-10T12:00:00Z" }), NOW), "Closed 3 days ago without merging");
});

test("approvalsLine: counts without reviewDecision", () => {
  assert.equal(approvalsLine(summary({ reviewCounts: { approvals: 2, changesRequested: 1 } })), "2 approvals · changes requested by 1");
  assert.equal(approvalsLine(summary({ reviewCounts: { approvals: 1, changesRequested: 0 } })), "1 approval");
  assert.equal(approvalsLine(summary()), "No approvals yet");
  // Lists saved by older versions have latestReviews only.
  assert.equal(approvalsLine(summary({ reviewCounts: undefined, latestReviews: [{ state: "APPROVED" }] })), "1 approval");
});

test("yourReviewLines: state, date, commit and what changed since; re-requested; never reviewed", () => {
  const lines = (over: Partial<PullRequestInput>) => yourReviewLines(summary(over), NOW);
  assert.deepEqual(lines(reviewed("APPROVED", "2026-10-11T12:00:00Z", OLD, { newCommits: true, updated: true })), ["Your review: approved 2 days ago at bbbbbbb · since then: new commits"]);
  assert.deepEqual(lines(reviewed("COMMENTED", "2026-10-13T07:00:00Z", HEAD, { newCommits: false, updated: true })), ["Your review: commented 5 hours ago at aaaaaaa · since then: updated on GitHub"]);
  assert.deepEqual(lines(reviewed("CHANGES_REQUESTED", "2026-10-13T07:00:00Z", null, { newCommits: false, updated: false })), ["Your review: requested changes 5 hours ago · nothing new since"]);
  assert.deepEqual(lines({ ...reviewed("APPROVED", "2026-10-10T12:00:00Z", HEAD, { newCommits: false, updated: false }), requested: true }), [
    "Your review: approved 3 days ago at aaaaaaa · nothing new since",
    "Your review is requested again.",
  ]);
  assert.deepEqual(lines(reviewed("DISMISSED", "2026-10-10T12:00:00Z", HEAD)), ["Your review: dismissed 3 days ago at aaaaaaa · nothing new since"]);
  assert.deepEqual(lines({ ...reviewed("APPROVED", "2026-10-10T12:00:00Z", HEAD), state: "MERGED" }), ["Your review: approved 3 days ago at aaaaaaa"]);
  assert.deepEqual(lines({}), ["You haven't reviewed it yet."]);
  assert.deepEqual(lines({ viewerLastReview: undefined }), [], "not known for this row");
  assert.deepEqual(lines({ own: true }), []);
});

test("agentStatus and agentLines: freshness says since the agents ran, not since your review", () => {
  const agent = { commit: OLD, ranAt: "2026-10-12T12:00:00Z", findings: [{ id: "a", severity: "high" }, { id: "b", severity: "low" }], description: null };
  const behind = record(summary(), { agent });
  assert.equal(agentStatus(behind, NOW).text, "agents: 2 findings, behind");
  assert.deepEqual(agentLines(behind, NOW), ["Agents reviewed bbbbbbb 1 day ago: 2 findings.", "New commits since the agents ran: Run reviews the latest."]);
  const current = record(summary({ updatedAt: "2026-10-12T12:30:00Z" }), { agent: { ...agent, commit: HEAD } });
  assert.equal(agentStatus(current, NOW).text, "✓ agents: 2 findings");
  assert.equal(agentLines(current, NOW)[1], "Updated on GitHub since the agents ran (description, comments or reviews): Run starts a fresh review.");
  const quiet = record(summary({ updatedAt: "2026-10-12T11:00:00Z" }), { agent: { ...agent, commit: HEAD } });
  assert.equal(agentLines(quiet, NOW)[1], "Nothing has changed since the agents ran: Run asks before reviewing again.");
  assert.deepEqual(agentLines(record(summary()), NOW), ["No agent review yet."]);
});

test("rowDescription: open rows keep risk and agents; merged and closed ones say so and drop them", () => {
  const risk = { score: 42, level: "medium" as const, factors: [], lines: 12 };
  const agent = { commit: HEAD, ranAt: "2026-10-12T12:00:00Z", findings: [], description: null };
  const open = record(summary({ ...reviewed("APPROVED", "2026-10-11T12:00:00Z", OLD, { newCommits: true, updated: true }), isDraft: true, mergeStateStatus: "DIRTY" }), { agent });
  assert.equal(rowDescription(open, { risk }, NOW), "42 medium · ✓ agents: 0 findings · draft · conflicts · you approved 2d ago · new commits · web");
  const merged = record(summary({ ...reviewed("APPROVED", "2026-10-11T12:00:00Z", HEAD), state: "MERGED" }), { agent });
  assert.equal(rowDescription(merged, { risk }, NOW), "merged · you approved 2d ago · web");
  assert.equal(rowDescription(record(summary({ state: "CLOSED" })), { risk, tag: "you reviewed", inRepoGroup: true }, NOW), "you reviewed · closed");
  const requested = record(summary({ ...reviewed("COMMENTED", "2026-10-10T12:00:00Z", HEAD), requested: true }));
  assert.equal(rowDescription(requested, { risk: null }, NOW), "re-requested · you commented 3d ago · web");
});
