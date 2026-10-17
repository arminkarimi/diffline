// How the pull request list (the sidebar, and the page's list) groups and orders pull requests.

import type { GroupEntry, ListReason as Reason } from "./types.ts";

export type GroupBy = "relationship" | "repository";
export type SortBy = "risk" | "created" | "updated";
export interface SidebarConfig {
  groupBy: GroupBy;
  sortBy: SortBy;
  /** How many pull requests you could review to show at the bottom. */
  othersLimit: number;
}

/** Relationship groups, most specific first: a pull request goes in the first one it fits. */
const RELATIONSHIP: Array<{ id: string; label: string; reason: Reason; search?: string }> = [
  { id: "requested", label: "Review requested from you", reason: "review-requested", search: "direct" },
  { id: "assigned", label: "Assigned to you", reason: "assigned", search: "assigned" },
  { id: "reviewed", label: "You reviewed", reason: "reviewed", search: "reviewed" },
  { id: "owner", label: "You're a code owner", reason: "code-owner" },
  { id: "team", label: "Your teams' requests", reason: "team-requested", search: "team" },
  { id: "authored", label: "Your pull requests", reason: "authored", search: "authored" },
  { id: "watched", label: "Watched", reason: "watched", search: "watched" },
  { id: "pinned", label: "Opened here", reason: "pinned" },
];

/**
 * Merged and closed pull requests (the recently-closed search, or pinned ones), whatever else they're listed for: the
 * last group, after Others you could review, since there's nothing left to review.
 */
const CLOSED = { id: "closed", label: "Recently merged or closed", reason: "recently-closed" as Reason, search: "closed" };

/** Merged or closed on GitHub. */
export const isClosed = (r: GroupEntry) => r.summary?.state === "MERGED" || r.summary?.state === "CLOSED";

/** Short words for why a row is listed, shown in the repository view. */
const TAG: Partial<Record<Reason, string>> = {
  "review-requested": "requested",
  assigned: "assigned",
  reviewed: "you reviewed",
  "code-owner": "code owner",
  "team-requested": "team",
  authored: "yours",
  watched: "watched",
};

export const WHY: Record<Reason, string> = {
  "review-requested": "your review is requested",
  assigned: "it's assigned to you",
  reviewed: "you reviewed it and it's still open",
  "code-owner": "you or your team own files it changes",
  "team-requested": "one of your teams is requested",
  authored: "it's yours",
  watched: "you watch the repository",
  pinned: "you opened it here",
  "recently-closed": "it was merged or closed recently and you reviewed it or wrote it",
  other: "it's in one of your repositories and needs a review",
};

/** Listed only because you could review it. */
export const isOther = (r: GroupEntry) => !r.pinned && !!r.summary && r.summary.reasons.every((x) => x === "other");

/** What sorting needs from a row. */
export interface SortableRow {
  record: GroupEntry;
  risk: { score: number } | null;
}

export function compareRows<T extends SortableRow>(sortBy: SortBy): (a: T, b: T) => number {
  const updated = (a: T, b: T) => (b.record.summary?.updatedAt || "").localeCompare(a.record.summary?.updatedAt || "");
  if (sortBy === "created") return (a, b) => (b.record.summary?.createdAt || "").localeCompare(a.record.summary?.createdAt || "") || updated(a, b);
  if (sortBy === "updated") return updated;
  return (a, b) => (b.risk?.score ?? -1) - (a.risk?.score ?? -1) || updated(a, b);
}

/** The first relationship group a pull request fits, or null. Merged and closed ones go in Recently merged or closed. */
export function relationshipOf(r: GroupEntry): (typeof RELATIONSHIP)[number] | null {
  if (isClosed(r)) return CLOSED;
  return reasonGroup(r);
}

/** The first relationship group a pull request's reasons fit, whatever its state. */
function reasonGroup(r: GroupEntry): (typeof RELATIONSHIP)[number] | null {
  const reasons = r.summary?.reasons || [];
  return RELATIONSHIP.find((g) => (g.reason === "pinned" ? r.pinned : reasons.includes(g.reason))) || null;
}

/** A row as grouping needs it: the record, its risk, and (in the repository view) why it's listed. */
export interface GroupRow extends SortableRow {
  tag?: string;
  inRepoGroup?: boolean;
}

export interface RowGroup<T extends GroupRow> {
  id: string;
  label: string;
  description: string;
  rows: T[];
  collapsed?: boolean;
}

/**
 * The groups the sidebar and the page's list show: by relationship or by repository, each sorted, and at the
 * bottom the top pull requests you could review. `totals` says how many each search found (for "12 of 99").
 */
export function buildGroups<T extends GroupRow>(rows: T[], cfg: SidebarConfig, totals: Record<string, { shown: number; total: number }> = {}): RowGroup<T>[] {
  const sort = compareRows<T>(cfg.sortBy);
  const listed = rows.filter((r) => !isOther(r.record) && (r.record.pinned || relationshipOf(r.record)));
  const groups: RowGroup<T>[] = [];
  if (cfg.groupBy === "repository") {
    const byRepo = new Map<string, T[]>();
    for (const row of listed) {
      const repo = `${row.record.key.owner}/${row.record.key.name}`;
      // Merged and closed ones stay in their repository; the row says merged or closed, and the tag still says why.
      const rel = reasonGroup(row.record);
      row.tag = rel ? TAG[rel.reason] : undefined;
      row.inRepoGroup = true;
      byRepo.set(repo, [...(byRepo.get(repo) || []), row]);
    }
    for (const [repo, list] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
      groups.push({ id: `repo:${repo.toLowerCase()}`, label: repo.split("/")[1], description: `${repo.split("/")[0]} · ${list.length}`, rows: list.sort(sort) });
    }
  } else {
    for (const g of RELATIONSHIP) {
      const list = listed.filter((row) => relationshipOf(row.record)?.id === g.id).sort(sort);
      if (!list.length) continue;
      const t = g.search ? totals[g.search] : undefined;
      const description = t && t.total > t.shown ? `${list.length} of ${t.total}` : String(list.length);
      groups.push({ id: g.id, label: g.label, description, rows: list, collapsed: g.id === "team" && list.length > 12 });
    }
  }
  const others = rows.filter((r) => isOther(r.record)).sort(sort).slice(0, Math.max(0, cfg.othersLimit));
  if (others.length) groups.push({ id: "others", label: "Others you could review", description: `top ${others.length}`, rows: others });
  if (cfg.groupBy !== "repository") {
    // Most recently updated first, whatever the sort: risk means little once it's merged. Folded when long, as team requests are.
    const closed = listed.filter((row) => isClosed(row.record)).sort(compareRows<T>("updated"));
    const t = totals[CLOSED.search];
    const description = t && t.total > t.shown ? `${closed.length} of ${t.total}` : String(closed.length);
    if (closed.length) groups.push({ id: CLOSED.id, label: CLOSED.label, description, rows: closed, collapsed: closed.length > 12 });
  }
  return groups;
}

export const SORT_WORDS: Record<SortBy, string> = { risk: "riskiest first", created: "newest first", updated: "recently updated" };
