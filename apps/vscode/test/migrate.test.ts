import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { adoptOldStorage, oldStorageDir } from "../src/core/migrate.ts";

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-migrate-"));
  const storage = path.join(root, "diffline.diffline");
  const old = oldStorageDir(storage);
  await mkdir(path.join(old, "state"), { recursive: true });
  await writeFile(path.join(old, "state", "o__r__1.json"), '{"drafts":[]}', "utf8");
  return { root, storage, old };
}

test("adoptOldStorage: the old ID's folder sits next to the new one", () => {
  assert.equal(oldStorageDir("/g/globalStorage/diffline.diffline"), path.join("/g/globalStorage", "arminkarimi.diffline"));
});

test("adoptOldStorage: moves the old storage when the old extension is gone", async () => {
  const { storage, old } = await folders();
  assert.equal(await adoptOldStorage(storage, false), "moved");
  assert.equal(await readFile(path.join(storage, "state", "o__r__1.json"), "utf8"), '{"drafts":[]}');
  assert.deepEqual(await readdir(old).catch(() => "gone"), "gone");
});

test("adoptOldStorage: copies while the old extension is installed, and leaves its folder alone", async () => {
  const { storage, old } = await folders();
  await mkdir(storage); // VS Code may have made the new folder already, empty
  assert.equal(await adoptOldStorage(storage, true), "copied");
  assert.deepEqual(await readdir(path.join(storage, "state")), ["o__r__1.json"]);
  assert.deepEqual(await readdir(path.join(old, "state")), ["o__r__1.json"]);
});

test("adoptOldStorage: a copy is refreshed while the old extension is installed, then moved once it's gone", async () => {
  const { storage, old } = await folders();
  assert.equal(await adoptOldStorage(storage, true), "copied");
  await writeFile(path.join(old, "state", "o__r__2.json"), "{}", "utf8"); // the old extension kept working
  assert.equal(await adoptOldStorage(storage, true), "copied");
  assert.deepEqual((await readdir(path.join(storage, "state"))).sort(), ["o__r__1.json", "o__r__2.json"]);
  await writeFile(path.join(old, "state", "o__r__3.json"), "{}", "utf8");
  assert.equal(await adoptOldStorage(storage, false), "moved");
  assert.deepEqual((await readdir(path.join(storage, "state"))).sort(), ["o__r__1.json", "o__r__2.json", "o__r__3.json"]);
  assert.deepEqual((await readdir(storage)).filter((f) => f.startsWith(".")), [], "no copy mark left");
  assert.equal(await adoptOldStorage(storage, false), "none");
});

test("adoptOldStorage: keeps the copy when the old folder disappears with the old extension", async () => {
  const { storage, old } = await folders();
  assert.equal(await adoptOldStorage(storage, true), "copied");
  const { rm } = await import("node:fs/promises");
  await rm(old, { recursive: true });
  assert.equal(await adoptOldStorage(storage, false), "none");
  assert.deepEqual(await readdir(storage), ["state"], "the copy stays and its mark is gone");
});

test("adoptOldStorage: never touches storage that already has something, and runs once", async () => {
  const { storage } = await folders();
  await mkdir(path.join(storage, "state"), { recursive: true });
  await writeFile(path.join(storage, "state", "mine.json"), "{}", "utf8");
  assert.equal(await adoptOldStorage(storage, false), "none");
  assert.deepEqual(await readdir(path.join(storage, "state")), ["mine.json"]);
});

test("adoptOldStorage: nothing to do without old storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffline-migrate-"));
  assert.equal(await adoptOldStorage(path.join(root, "diffline.diffline"), false), "none");
});
