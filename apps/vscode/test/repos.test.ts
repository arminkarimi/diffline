// Repos against real git: a pull request's head fetched early, and ensureCommits after it, which mustn't fetch again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Repos } from "../src/core/repos.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

/** A remote with main and a pull request head (refs/pull/7/head) on no branch, and a clone that has main only. */
async function remoteWithPullRequest() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-repos-"));
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "init", "-q", work);
  await writeFile(path.join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", remote, "main");
  await writeFile(path.join(work, "a.txt"), "two\n");
  git(work, "commit", "-q", "-am", "change");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", remote, `${head}:refs/pull/7/head`);
  const clone = path.join(dir, "clone.git");
  git(dir, "clone", "-q", "--bare", "--no-local", remote, clone); // --no-local: only what main reaches
  return { dir, clone, base, head };
}

test("Repos: a head fetched early is there for ensureCommits, which checks the exact commits without fetching again", async () => {
  const { dir, clone, base, head } = await remoteWithPullRequest();
  const logs: string[] = [];
  const repos = new Repos({ storage: dir, configured: () => ({}), workspaceDirs: () => [], log: (l) => logs.push(l) });
  const c = { path: clone, remote: "origin", managed: false };
  assert.equal(await repos.hasCommit(clone, head), false);

  // Started together, as opening by link does: ensureCommits waits for the early fetch, then finds the commits.
  const early = repos.fetchHead(c, 7);
  const ensured = repos.ensureCommits(c, { number: 7, head, base, baseRefName: "main" });
  assert.equal(await early, true);
  assert.deepEqual(await ensured, { fetched: false });
  assert.equal(logs.filter((l) => l.startsWith("Fetching")).length, 1, logs.join("\n"));
  assert.match(logs[0], /^Fetching pull request #7's head early into /);

  // A head that isn't there (pushed since) is still fetched by ensureCommits; a failed early fetch is just false.
  assert.equal(await repos.fetchHead(c, 99), false);
  await assert.rejects(repos.ensureCommits(c, { number: 8, head: "f".repeat(40), base, baseRefName: "main" }), /Couldn't fetch pull request #8/);
});
