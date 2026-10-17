// How the last agent review relates to the pull request now, for the row, its hover and the Run button's question.

import type { AgentReviewInput, PullRequestInput } from "./types.ts";

/**
 * How the last agent review relates to the pull request now. "current": it reviewed the head commit. "behind": commits
 * landed since. `activity`: the pull request changed on GitHub after the review (description, comments, reviews,
 * labels), which can change what the agents would say even on the same commit.
 */
export interface Freshness {
  state: "none" | "current" | "behind";
  commit?: string;
  ranAt?: string;
  activity: boolean;
}

/** GitHub's updatedAt can trail the run by a few seconds without anything new; ignore that much. */
const ACTIVITY_SLACK_MS = 60_000;

export function reviewFreshness(agent: Pick<AgentReviewInput, "commit" | "ranAt"> | null, summary: Pick<PullRequestInput, "headRefOid" | "updatedAt"> | null): Freshness {
  if (!agent) return { state: "none", activity: false };
  const base = { commit: agent.commit, ranAt: agent.ranAt };
  if (!summary) return { state: "current", ...base, activity: false };
  if (summary.headRefOid !== agent.commit) return { state: "behind", ...base, activity: true };
  const ran = Date.parse(agent.ranAt);
  const updated = Date.parse(summary.updatedAt);
  return { state: "current", ...base, activity: Number.isFinite(ran) && Number.isFinite(updated) && updated > ran + ACTIVITY_SLACK_MS };
}
