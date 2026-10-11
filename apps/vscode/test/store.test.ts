import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Store } from "../src/core/store.ts";

test("Store: saves made at once all succeed and land in the order they were made", async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), "diffline-store-")));
  await store.init();
  const key = { owner: "o", name: "r", number: 1 };
  // Newer saves are smaller, so a save that overtook another would leave the older, longer state behind.
  const saves = Array.from({ length: 30 }, (_, i) => ({ reviewedIds: Array.from({ length: 30 - i }, (_, j) => `file-${j}`), n: i }));
  await Promise.all(saves.map((s) => store.writeState(key, s)));
  assert.deepEqual(await store.readState(key), saves[saves.length - 1]);
  assert.deepEqual(await readdir(path.join(store.root, "state")), ["o__r__1.json"], "no temporary files left behind");
});

test("readJson: a damaged file is kept as .damaged before anything overwrites it", async () => {
  const { mkdtemp, readFile, writeFile, stat } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Store } = await import("../src/core/store.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-store-"));
  const store = new Store(path.join(root, "storage"));
  await store.init();
  assert.equal((await stat(path.join(root, "storage"))).mode & 0o777, 0o700, "only the user can read the storage folder");
  const file = path.join(root, "storage", "state", "x.json");
  await writeFile(file, '{"drafts": [', "utf8");
  assert.equal(await store.readJson(file), null);
  assert.equal(await readFile(`${file}.damaged`, "utf8"), '{"drafts": [');
  assert.equal(await store.readJson(path.join(root, "missing.json")), null);
});
