import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildReviewData, ExportError, parsePatch } from "../src/core/diff.ts";
import { ensureSampleRepo } from "./fixtures/make-sample-repo.ts";

const SAMPLE = ensureSampleRepo();

const patch = (...lines: string[]) => lines.join("\n") + "\n";

test("parsePatch: a modified file with several hunks", () => {
  const files = parsePatch(patch(
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@ export function a() {",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10,2 +10,3 @@",
    " ten",
    "+ten and a half",
    " eleven",
  ));
  assert.equal(files.length, 1);
  const [f] = files;
  assert.deepEqual({ path: f.path, oldPath: f.oldPath, status: f.status, similarity: f.similarity, binary: f.binary }, {
    path: "src/a.ts", oldPath: "src/a.ts", status: "modified", similarity: null, binary: false,
  });
  assert.equal(f.hunks.length, 2);
  assert.deepEqual(f.hunks[0], {
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: "export function a() {",
    lines: [[" ", 1, 1, "one"], ["-", 2, null, "two"], ["+", null, 2, "TWO"], [" ", 3, 3, "three"]],
  });
  assert.deepEqual(f.hunks[1].lines, [[" ", 10, 10, "ten"], ["+", null, 11, "ten and a half"], [" ", 11, 12, "eleven"]]);
  assert.equal(f.hunks[1].section, "");
});

test("parsePatch: renames keep the old path and similarity", () => {
  const [f] = parsePatch(patch(
    "diff --git a/src/utils/currency.ts b/src/lib/money.ts",
    "similarity index 70%",
    "rename from src/utils/currency.ts",
    "rename to src/lib/money.ts",
    "index 1111111..2222222 100644",
    "--- a/src/utils/currency.ts",
    "+++ b/src/lib/money.ts",
    "@@ -1 +1,2 @@",
    " keep",
    "+added",
  ));
  assert.equal(f.status, "renamed");
  assert.equal(f.path, "src/lib/money.ts");
  assert.equal(f.oldPath, "src/utils/currency.ts");
  assert.equal(f.similarity, 70);
  // A missing count in the hunk header means one line.
  assert.deepEqual([f.hunks[0].oldLines, f.hunks[0].newLines], [1, 2]);
  assert.deepEqual(f.hunks[0].lines, [[" ", 1, 1, "keep"], ["+", null, 2, "added"]]);
});

test("parsePatch: pure renames, binary, new and deleted files", () => {
  const files = parsePatch(patch(
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/added.sql b/added.sql",
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    "+++ b/added.sql",
    "@@ -0,0 +1,2 @@",
    "+create table x;",
    "+drop table y;",
    "diff --git a/gone.rs b/gone.rs",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/gone.rs",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-fn main() {}",
  ));
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary, f.hunks.length]), [
    ["new.txt", "renamed", false, 0],
    ["logo.png", "modified", true, 0],
    ["added.sql", "added", false, 1],
    ["gone.rs", "deleted", false, 1],
  ]);
  assert.deepEqual(files[2].hunks[0].lines, [["+", null, 1, "create table x;"], ["+", null, 2, "drop table y;"]]);
  assert.deepEqual(files[3].hunks[0].lines, [["-", 1, null, "fn main() {}"]]);
});

test("parsePatch: '\\ No newline at end of file' is skipped, inside and after a hunk", () => {
  const [f, g] = parsePatch(patch(
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    " same",
    "-old end",
    "\\ No newline at end of file",
    "+new end",
    "\\ No newline at end of file",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ));
  assert.deepEqual(f.hunks[0].lines, [[" ", 1, 1, "same"], ["-", 2, null, "old end"], ["+", null, 2, "new end"]]);
  assert.deepEqual(g.hunks[0].lines, [["-", 1, null, "x"], ["+", null, 1, "y"]]);
});

test("parsePatch: an empty context line still counts", () => {
  const [f] = parsePatch(patch(
    "diff --git a/a.txt b/a.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "",
    "-c",
    "+C",
  ));
  assert.deepEqual(f.hunks[0].lines, [[" ", 1, 1, "a"], [" ", 2, 2, ""], ["-", 3, null, "c"], ["+", null, 3, "C"]]);
});

test("buildReviewData: sample-repo main...feature/promo-codes since last-review", async () => {
  const data = await buildReviewData(SAMPLE, "main", "feature/promo-codes", "last-review");
  assert.equal(data.version, 1);
  assert.match(data.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  assert.equal(data.repo, "sample-repo");
  assert.equal(data.base.ref, "main");
  assert.equal(data.head.ref, "feature/promo-codes");
  assert.equal(data.head.short, data.head.sha.slice(0, 7));
  assert.equal(data.mergeBase, data.base.sha);
  assert.equal(data.commits.length, 5);
  assert.deepEqual(data.since && { ref: data.since.ref, index: data.since.index }, { ref: "last-review", index: 2 });
  assert.deepEqual(Object.keys(data.workspace), [".github/CODEOWNERS"]);

  const byPath = new Map(data.files.map((f) => [f.path, f]));
  assert.equal(data.files.length, 13);

  const money = byPath.get("src/lib/money.ts")!;
  assert.deepEqual([money.status, money.oldPath, money.similarity], ["renamed", "src/utils/currency.ts", 70]);

  const lock = byPath.get("package-lock.json")!;
  assert.equal(lock.generated, true);
  assert.equal(lock.content, undefined);
  assert.deepEqual(lock.deps, {
    manager: "npm",
    added: [{ name: "zod", dev: false, direct: true, requested: true, version: "3.23.8" }],
    removed: [],
    updated: [{ name: "typescript", dev: true, direct: true, requested: false, from: "5.6.2", to: "5.6.3" }],
  });

  const promo = byPath.get("src/promotions/promo.ts")!;
  assert.equal(promo.status, "added");
  assert.equal(promo.oldPath, null);
  assert.deepEqual(promo.tests, { path: "src/promotions/promo.test.ts", changed: true });
  assert.equal(promo.content!.length, promo.additions);

  const cart = byPath.get("src/cart/cart.ts")!;
  assert.deepEqual(cart.tests, { path: "src/cart/cart.test.ts", changed: false });
  assert.deepEqual(cart.hunks.map((h) => h.fresh), [false, false, false]);

  // Every added line names a commit in the range; context and deletions are -1.
  for (const f of data.files) {
    for (const h of f.hunks) {
      for (const [kind, , , , commit, fresh] of h.lines) {
        if (kind === "+") assert.ok(commit >= 0 && commit < data.commits.length, `${f.path}: commit ${commit}`);
        else assert.equal(commit, -1);
        if (fresh) assert.ok(h.fresh);
      }
    }
  }
  // Lines from the commits after last-review (index 2) are the fresh ones.
  const field = byPath.get("web/components/PromoCodeField.tsx")!;
  assert.ok(field.hunks[0].lines.every(([kind, , , , commit, fresh]) => kind !== "+" || (commit === 4 && fresh === 1)));
});

test("buildReviewData: a bad ref is an ExportError", async () => {
  await assert.rejects(buildReviewData(SAMPLE, "no-such-branch", "main"), (e: unknown) => {
    assert.ok(e instanceof ExportError);
    assert.match((e as Error).message, /^git rev-parse --verify no-such-branch\^\{commit\} failed:/);
    return true;
  });
});

test("buildReviewData: an unknown since is ignored", async () => {
  const data = await buildReviewData(SAMPLE, "main", "feature/promo-codes", "no-such-ref");
  assert.equal(data.since, null);
  assert.ok(data.files.every((f) => f.hunks.every((h) => !h.fresh && h.lines.every((l) => l[5] === 0))));
});

test("buildReviewData: sample-repo output matches test/fixtures/review-data.json", async () => {
  const expected = JSON.parse(readFileSync(new URL("./fixtures/review-data.json", import.meta.url), "utf8"));
  const actual = JSON.parse(JSON.stringify(await buildReviewData(SAMPLE, "main", "feature/promo-codes", "last-review")));
  delete actual.generatedAt;
  // Strings, not deepEqual: key order has to match too.
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});
