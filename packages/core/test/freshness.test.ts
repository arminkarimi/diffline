import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewFreshness } from "../src/freshness.ts";
import { timeAgo } from "../src/time.ts";

const agent = { commit: "abc", ranAt: "2026-10-10T12:00:00Z", findings: [], description: null };

test("reviewFreshness: no review, a review of the head, and one of an older commit", () => {
  assert.deepEqual(reviewFreshness(null, { headRefOid: "abc", updatedAt: "2026-10-10T12:00:00Z" }), { state: "none", activity: false });
  assert.deepEqual(reviewFreshness(agent, { headRefOid: "abc", updatedAt: "2026-10-10T11:00:00Z" }), {
    state: "current",
    commit: "abc",
    ranAt: agent.ranAt,
    activity: false,
  });
  const behind = reviewFreshness(agent, { headRefOid: "def", updatedAt: "2026-10-10T13:00:00Z" });
  assert.equal(behind.state, "behind");
  assert.equal(behind.activity, true, "new commits always count as new activity");
});

test("reviewFreshness: activity on GitHub after the run counts, a few seconds of lag doesn't", () => {
  assert.equal(reviewFreshness(agent, { headRefOid: "abc", updatedAt: "2026-10-10T12:00:30Z" }).activity, false);
  assert.equal(reviewFreshness(agent, { headRefOid: "abc", updatedAt: "2026-10-10T12:05:00Z" }).activity, true);
  assert.equal(reviewFreshness(agent, null).state, "current", "without a summary, the review is taken as current");
  assert.equal(reviewFreshness({ ...agent, ranAt: "not a date" }, { headRefOid: "abc", updatedAt: "2026-10-10T12:05:00Z" }).activity, false);
});

test("timeAgo", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(timeAgo("2026-10-10T11:59:50Z", now), "just now");
  assert.equal(timeAgo("2026-10-10T11:59:00Z", now), "1 minute ago");
  assert.equal(timeAgo("2026-10-10T09:00:00Z", now), "3 hours ago");
  assert.equal(timeAgo("2026-10-07T12:00:00Z", now), "3 days ago");
  assert.equal(timeAgo(undefined, now), "earlier");
});
