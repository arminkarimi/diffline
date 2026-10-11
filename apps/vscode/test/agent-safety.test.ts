import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeAccessArgs } from "../src/agents/harness.ts";
import { agentEnv, piEnv } from "../src/core/exec.ts";
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

test("piEnv: agentEnv plus Pi's settings and its providers' credentials, never GitHub's tokens or other keys; always offline", () => {
  const env = piEnv({
    PATH: "/bin",
    HOME: "/Users/me",
    ANTHROPIC_API_KEY: "a",
    ANTHROPIC_OAUTH_TOKEN: "ao",
    OPENAI_API_KEY: "o",
    GEMINI_API_KEY: "g",
    MISTRAL_API_KEY: "m",
    AWS_PROFILE: "p",
    AWS_SECRET_ACCESS_KEY: "y",
    AZURE_OPENAI_API_KEY: "az",
    GOOGLE_CLOUD_PROJECT: "gp",
    CLOUDFLARE_ACCOUNT_ID: "cf",
    VERTEX_LOCATION: "us",
    GOOGLE_CLIENT_SECRET: "gs",
    AZURE_CLIENT_SECRET: "as",
    STRIPE_API_KEY: "sk",
    COPILOT_GITHUB_TOKEN: "c",
    PI_CODING_AGENT_DIR: "/pi",
    PI_OFFLINE: "0",
    PI_TELEMETRY: "1",
    GH_TOKEN: "ghp_secret",
    GITHUB_TOKEN: "x",
    GH_ENTERPRISE_TOKEN: "e",
    GITHUB_API_KEY: "k",
    GH_API_KEY: "k2",
    NPM_TOKEN: "z",
    DATABASE_URL: "postgres://u:p@h/db",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "AWS_PROFILE",
    "AWS_SECRET_ACCESS_KEY",
    "AZURE_OPENAI_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "HOME",
    "MISTRAL_API_KEY",
    "OPENAI_API_KEY",
    "PATH",
    "PI_CODING_AGENT_DIR",
    "PI_OFFLINE",
    "PI_SKIP_VERSION_CHECK",
    "PI_TELEMETRY",
  ]);
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(env.PI_TELEMETRY, "0");
  assert.equal(agentEnv({ GEMINI_API_KEY: "g", PI_CODING_AGENT_DIR: "/pi", AWS_PROFILE: "p" }).GEMINI_API_KEY, undefined, "Claude and Codex don't get Pi's extras");
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
