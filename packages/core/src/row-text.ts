// The words on a sidebar row and in its hover: your review and what changed since, the pull request's state, approvals,
// and the agents' status.

import { reviewFreshness } from "./freshness.ts";
import { reviewCounts } from "./review-status.ts";
import { RISK_WORD } from "./risk.ts";
import { timeAgo } from "./time.ts";
import type { PullRequestEntry, PullRequestInput, Risk } from "./types.ts";

/** "just now", "5m ago", "5h ago", "2d ago": short, for the row. */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const isOpen = (s: Pick<PullRequestInput, "state"> | null | undefined) => !s?.state || s.state === "OPEN";
const hasConflicts = (s: Pick<PullRequestInput, "mergeStateStatus"> | null | undefined) => s?.mergeStateStatus === "DIRTY";
const OPINION: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes" };
const DID: Record<string, string> = { ...OPINION, COMMENTED: "commented", DISMISSED: "dismissed" };

/**
 * What you did last, from your latest review: "approved", "commented", or "approved, then commented" when a comment
 * (a reply to a thread is one) came after your approval or change request, which still stands on GitHub.
 */
function didWords(s: Pick<PullRequestInput, "viewerReview" | "viewerLastReview">): string {
  const last = s.viewerLastReview;
  if (!last) return OPINION[s.viewerReview || ""] || "";
  const before = OPINION[s.viewerReview || ""];
  if (last.state === "COMMENTED" && before) return `${before}, then commented`;
  return DID[last.state] || "";
}

type ReviewFields = Pick<PullRequestInput, "state" | "own" | "requested" | "viewerReview" | "viewerLastReview" | "sinceReview">;

/**
 * Your review on the row: "you approved 2d ago · new commits", "you commented 5h ago · updated since",
 * "re-requested · you requested changes 1d ago". Empty when you haven't reviewed it, and on your own pull requests
 * (replying to their review threads makes comment reviews that aren't reviews). Hints only while it's open.
 */
export function reviewDescription(s: ReviewFields | null | undefined, now = Date.now()): string {
  if (!s || s.own) return "";
  const words = didWords(s);
  if (!words) return "";
  const last = s.viewerLastReview;
  const parts: string[] = [];
  const open = isOpen(s);
  if (open && s.requested) parts.push("re-requested");
  const subject = last?.state === "DISMISSED" ? "your review was dismissed" : `you ${words}`;
  parts.push(`${subject}${last ? ` ${shortAgo(last.at, now)}` : ""}`.trim());
  if (open && s.sinceReview?.newCommits) parts.push("new commits");
  else if (open && s.sinceReview?.updated) parts.push("updated since");
  return parts.join(" · ");
}

/** "merged", "closed", or for an open one "draft" and "conflicts" as they apply. */
export function stateWords(s: Pick<PullRequestInput, "state" | "isDraft" | "mergeStateStatus"> | null | undefined): string[] {
  if (!s) return [];
  if (s.state === "MERGED") return ["merged"];
  if (s.state === "CLOSED") return ["closed"];
  return [s.isDraft ? "draft" : "", hasConflicts(s) ? "conflicts" : ""].filter(Boolean);
}

/** A short agent status for the row, and whether the agents are behind the head. */
export function agentStatus(r: PullRequestEntry, now = Date.now()): { text: string; behind: boolean } {
  const run = r.run;
  const head = r.summary?.headRefOid;
  const behind = !!r.agent && !!head && r.agent.commit !== head;
  switch (run.state) {
    case "waiting": {
      const secs = Math.max(0, Math.round(((run.dueAt || now) - now) / 1000));
      return { text: secs ? `agents in ${secs < 60 ? `${secs}s` : `${Math.ceil(secs / 60)}m`}` : "agents starting", behind };
    }
    case "queued":
      return { text: "agents queued", behind };
    case "running": {
      const states = Object.values(run.progress?.agents || {});
      const done = states.filter((a) => a && (a.state === "done" || a.state === "failed")).length;
      const total = states.filter((a) => a && a.state !== "skipped").length;
      return { text: total ? `agents ${done}/${total}` : "agents starting", behind };
    }
    case "elsewhere":
      return { text: "agents running in another window", behind };
    case "held": {
      const why = run.hold === "approved-ask" ? "approved, agents wait for your choice" : run.hold === "approved-skip" ? "approved, agents skipped" : "large, press Run for agents";
      return { text: `${why}${r.agent ? `; ${r.agent.findings.length} findings${behind ? ", behind" : ""}` : ""}`, behind };
    }
    case "failed":
      return { text: "agents failed", behind };
  }
  if (!r.agent) return { text: "", behind: false };
  const n = r.agent.findings.length;
  const findings = `${n} finding${n === 1 ? "" : "s"}`;
  // "behind": commits landed since the agents ran (said in full in the hover), so it isn't read as since your review.
  return { text: behind ? `agents: ${findings}, behind` : `✓ agents: ${findings}`, behind };
}

const BUSY = new Set(["waiting", "queued", "running", "elsewhere"]);

/**
 * The row's description. Open: why (repository view), risk, agents, draft, conflicts, your review, repository. Merged or
 * closed: the state and your review, without risk or agent findings (nothing is left to review), unless agents are
 * running on it.
 */
export function rowDescription(r: PullRequestEntry, row: { risk: Risk | null; tag?: string; inRepoGroup?: boolean }, now = Date.now()): string {
  const s = r.summary;
  const open = isOpen(s);
  const agents = agentStatus(r, now).text;
  return [
    row.tag || "",
    open ? "" : stateWords(s)[0] || "",
    open && row.risk ? `${row.risk.score} ${RISK_WORD[row.risk.level].toLowerCase()}` : "",
    open || BUSY.has(r.run.state) ? agents : "",
    ...(open ? stateWords(s) : []),
    reviewDescription(s, now),
    row.inRepoGroup ? "" : r.key.name,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "2 approvals · changes requested by 1", "1 approval", "No approvals yet". */
export function approvalsLine(s: Pick<PullRequestInput, "reviewCounts" | "latestReviews">): string {
  const c = s.reviewCounts || reviewCounts(s.latestReviews);
  const parts = [c.approvals ? `${c.approvals} approval${c.approvals === 1 ? "" : "s"}` : "", c.changesRequested ? `changes requested by ${c.changesRequested}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No approvals yet";
}

/** The pull request's state for the hover: "Open", "Open, draft · conflicts with main", "Merged 2 days ago", "Closed 3 days ago without merging". */
export function stateLine(s: Pick<PullRequestInput, "state" | "isDraft" | "mergeStateStatus" | "mergedAt" | "closedAt" | "baseRefName">, now = Date.now()): string {
  if (s.state === "MERGED") return `Merged${s.mergedAt ? ` ${timeAgo(s.mergedAt, now)}` : ""}`;
  if (s.state === "CLOSED") return `Closed${s.closedAt ? ` ${timeAgo(s.closedAt, now)}` : ""} without merging`;
  return `Open${s.isDraft ? ", draft" : ""}${hasConflicts(s) ? ` · conflicts with ${s.baseRefName || "its base branch"}` : ""}`;
}

/**
 * Your review for the hover: "Your review: approved 2 days ago at abc1234 · since then: new commits" (or "updated on
 * GitHub", or "nothing new since"), "Your review is requested again." after it when re-requested, "You haven't reviewed
 * it yet." Nothing on your own pull requests.
 */
export function yourReviewLines(s: ReviewFields | null | undefined, now = Date.now()): string[] {
  if (!s || s.own) return [];
  const last = s.viewerLastReview;
  const words = didWords(s);
  if (!words) return last === null ? ["You haven't reviewed it yet."] : [];
  let line = `Your review: ${words}`;
  if (last) line += ` ${timeAgo(last.at, now)}${last.commit ? ` at ${last.commit.slice(0, 7)}` : ""}`;
  if (last && isOpen(s)) {
    line += s.sinceReview?.newCommits ? " · since then: new commits" : s.sinceReview?.updated ? " · since then: updated on GitHub" : " · nothing new since";
  }
  return isOpen(s) && s.requested ? [line, "Your review is requested again."] : [line];
}

/** The agents' review in the hover, said as since the agents ran so it isn't taken for since your review. */
export function agentLines(r: PullRequestEntry, now = Date.now()): string[] {
  const fresh = reviewFreshness(r.agent, r.summary);
  if (fresh.state === "none") return ["No agent review yet."];
  const n = r.agent!.findings.length;
  return [
    `Agents reviewed ${fresh.commit?.slice(0, 7)} ${timeAgo(fresh.ranAt, now)}: ${n} finding${n === 1 ? "" : "s"}.`,
    fresh.state === "behind"
      ? "New commits since the agents ran: Run reviews the latest."
      : fresh.activity
        ? "Updated on GitHub since the agents ran (description, comments or reviews): Run starts a fresh review."
        : "Nothing has changed since the agents ran: Run asks before reviewing again.",
  ];
}
