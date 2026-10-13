import assert from "node:assert/strict";
import { test } from "node:test";

import { compareRows, isOther, relationshipOf } from "../src/core/grouping.ts";
import type { PrRecord } from "../src/core/service.ts";

const rec = (reasons: string[], extra: Partial<{ createdAt: string; updatedAt: string; pinned: boolean }> = {}): PrRecord =>
  ({
    key: { owner: "o", name: "r", number: 1 },
    pinned: !!extra.pinned,
    agent: null,
    run: { state: "idle" },
    summary: { reasons, createdAt: extra.createdAt || "2026-10-01T00:00:00Z", updatedAt: extra.updatedAt || "2026-10-01T00:00:00Z" },
  }) as unknown as PrRecord;

test("relationshipOf: the most specific group wins", () => {
  assert.equal(relationshipOf(rec(["team-requested", "review-requested"]))?.id, "requested");
  assert.equal(relationshipOf(rec(["team-requested", "code-owner"]))?.id, "owner", "a code owner beats a plain team request");
  assert.equal(relationshipOf(rec(["other", "code-owner"]))?.id, "owner", "owning files lifts a pull request out of Others");
  assert.equal(relationshipOf(rec(["assigned", "authored"]))?.id, "assigned");
  assert.equal(relationshipOf(rec(["team-requested", "code-owner", "reviewed"]))?.id, "reviewed", "once you've reviewed it, that's what matters");
  assert.equal(relationshipOf(rec(["reviewed", "review-requested"]))?.id, "requested", "a re-requested review moves it back up");
  assert.equal(relationshipOf(rec([], { pinned: true }))?.id, "pinned");
  assert.equal(relationshipOf(rec(["other"])), null);
});

test("isOther: listed only because you could review it", () => {
  assert.equal(isOther(rec(["other"])), true);
  assert.equal(isOther(rec(["other", "code-owner"])), false);
  assert.equal(isOther(rec(["other"], { pinned: true })), false);
});

test("compareRows: risk, newest created, recently updated", () => {
  const a = { record: rec([], { createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" }), risk: { score: 20 } };
  const b = { record: rec([], { createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }), risk: { score: 70 } };
  const c = { record: rec([], { createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }), risk: null };
  const order = (by: "risk" | "created" | "updated") => [a, b, c].sort(compareRows(by)).map((x) => x.risk?.score ?? "none");
  assert.deepEqual(order("risk"), [70, 20, "none"]);
  assert.deepEqual(order("created"), ["none", 20, 70]);
  assert.deepEqual(order("updated"), [70, 20, "none"]);
});

test("buildGroups: relationship groups in order, totals, folded team requests, top others at the bottom", async () => {
  const { buildGroups } = await import("../src/core/grouping.ts");
  const row = (n: number, reasons: string[], score: number, repo = "r") => {
    const record = rec(reasons);
    (record as any).key = { owner: "o", name: repo, number: n };
    return { record, risk: { score } };
  };
  const rows = [
    row(1, ["team-requested"], 10),
    row(2, ["review-requested"], 50),
    ...Array.from({ length: 14 }, (_, i) => row(10 + i, ["team-requested"], i)),
    row(3, ["authored"], 5),
    ...Array.from({ length: 12 }, (_, i) => row(40 + i, ["other"], i)),
  ];
  const groups = buildGroups(rows, { groupBy: "relationship", sortBy: "risk", othersLimit: 10 }, { team: { shown: 15, total: 99 } });
  assert.deepEqual(groups.map((g) => g.id), ["requested", "team", "authored", "others"]);
  const team = groups.find((g) => g.id === "team")!;
  assert.equal(team.description, "15 of 99");
  assert.equal(team.collapsed, true, "a long team group starts folded");
  assert.equal(team.rows[0].risk.score, 13, "riskiest first");
  const others = groups.at(-1)!;
  assert.equal(others.rows.length, 10);
  assert.equal(others.rows[0].risk.score, 11);
  assert.equal(buildGroups(rows, { groupBy: "relationship", sortBy: "risk", othersLimit: 0 }).some((g) => g.id === "others"), false);
});

test("buildGroups: by repository, each row tagged with why it's listed; others stay at the bottom", async () => {
  const { buildGroups } = await import("../src/core/grouping.ts");
  const row = (n: number, reasons: string[], repo: string) => {
    const record = rec(reasons);
    (record as any).key = { owner: "o", name: repo, number: n };
    return { record, risk: { score: n } as { score: number }, tag: undefined as string | undefined };
  };
  const groups = buildGroups(
    [row(1, ["review-requested"], "web"), row(2, ["authored"], "api"), row(3, ["team-requested", "code-owner"], "web"), row(4, ["other"], "api")],
    { groupBy: "repository", sortBy: "risk", othersLimit: 10 },
  );
  assert.deepEqual(groups.map((g) => g.label), ["api", "web", "Others you could review"]);
  assert.deepEqual(groups[1].rows.map((r) => r.tag), ["code owner", "requested"]);
  assert.equal(groups[0].description, "o · 1");
});

test("buildGroups: merged and closed pull requests go last, in Recently merged or closed, newest update first", async () => {
  const { buildGroups } = await import("../src/core/grouping.ts");
  const row = (n: number, reasons: string[], state: string, updatedAt: string, pinned = false) => {
    const record = rec(reasons, { updatedAt, pinned });
    (record as any).key = { owner: "o", name: "r", number: n };
    (record as any).summary.state = state;
    return { record, risk: { score: n } };
  };
  const rows = [
    row(1, ["review-requested"], "OPEN", "2026-10-05T00:00:00Z"),
    row(2, ["recently-closed"], "MERGED", "2026-10-04T00:00:00Z"),
    row(3, ["recently-closed"], "CLOSED", "2026-10-06T00:00:00Z"),
    row(4, [], "MERGED", "2026-10-01T00:00:00Z", true), // opened here, merged since
    row(5, ["other"], "OPEN", "2026-10-05T00:00:00Z"),
  ];
  const groups = buildGroups(rows, { groupBy: "relationship", sortBy: "risk", othersLimit: 10 }, { closed: { shown: 2, total: 9 } });
  assert.deepEqual(groups.map((g) => g.id), ["requested", "others", "closed"]);
  const closed = groups.at(-1)!;
  assert.equal(closed.label, "Recently merged or closed");
  assert.deepEqual(closed.rows.map((r) => r.record.key.number), [3, 2, 4]);
  assert.equal(closed.description, "3 of 9");
  assert.equal(closed.collapsed, false, "folded only when long");
  assert.equal(relationshipOf(rows[3].record)?.id, "closed", "a merged pull request opened here");

  // By repository they stay in their repository, tagged with why they're listed.
  const byRepo = buildGroups(rows, { groupBy: "repository", sortBy: "risk", othersLimit: 10 });
  assert.deepEqual(byRepo.map((g) => g.id), ["repo:o/r", "others"]);
  assert.deepEqual(byRepo[0].rows.map((r) => r.record.key.number), [4, 3, 2, 1]);
  assert.deepEqual(byRepo[0].rows.map((r) => (r as { tag?: string }).tag), [undefined, undefined, undefined, "requested"]);
});
