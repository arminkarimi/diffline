import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeAccessArgs } from "../src/agents/harness.ts";
import { agentEnv } from "../src/core/exec.ts";
import { Repos } from "../src/core/repos.ts";

test("claudeAccessArgs: file tools only, reads limited to the checkout and run folder, no repository settings or hooks", () => {
  const args = claudeAccessArgs("/tmp/tree", ["/tmp/run"]);
  const tools = args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowedTools"));
  assert.deepEqual(tools, ["Read", "Grep", "Glob"], "no Bash: even read-only git commands take options that write or run programs");
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir"));
  assert.deepEqual(allowed, ["Read(//tmp/tree/**)", "Read(//tmp/run/**)"], "Grep and Glob aren't allowed outright, so they stay inside the folders too");
  assert.ok(!args.some((a) => /Bash/.test(a)));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user");
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), { disableAllHooks: true });
  assert.deepEqual(args.slice(args.indexOf("--add-dir")), ["--add-dir", "/tmp/run"]);
});

test("agentEnv: keeps what CLIs need to run and sign in, drops other secrets", () => {
  const env = agentEnv({
    PATH: "/bin",
    HOME: "/Users/me",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "a",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CODEX_HOME: "/c",
    OPENAI_API_KEY: "o",
    HTTPS_PROXY: "http://proxy",
    GH_TOKEN: "ghp_secret",
    GITHUB_TOKEN: "x",
    AWS_SECRET_ACCESS_KEY: "y",
    NPM_TOKEN: "z",
    DATABASE_URL: "postgres://u:p@h/db",
  });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CODEX_HOME", "HOME", "HTTPS_PROXY", "LANG", "OPENAI_API_KEY", "PATH"]);
});

test("exportFiles: writes files at a commit under their paths, skipping ones that would leave the folder", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diffline-export-"));
  const repo = path.join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  execFileSync("mkdir", ["-p", path.join(repo, "src")]);
  await writeFile(path.join(repo, "src", "a.ts"), "const café = \"naïve ✓\";\n");
  await writeFile(path.join(repo, "b.md"), "# B\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  const commit = git("rev-parse", "HEAD");
  const repos = new Repos({ storage: dir, configured: () => ({}), workspaceDirs: () => [], log: () => undefined });
  const out = path.join(dir, "base");
  const n = await repos.exportFiles(repo, commit, ["src/a.ts", "b.md", "missing.ts", "../escape.txt", "src/../../escape2.txt"], out);
  assert.equal(n, 2);
  assert.equal(await readFile(path.join(out, "src", "a.ts"), "utf8"), "const café = \"naïve ✓\";\n", "byte-exact, non-ASCII included");
  assert.equal(await readFile(path.join(out, "b.md"), "utf8"), "# B\n");
  await assert.rejects(readFile(path.join(dir, "escape.txt")));
});
