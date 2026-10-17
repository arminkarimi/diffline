// The setup check (src/core/setup.ts) with a fake runner: what's found, gh's sign-in across versions, and what's missing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSetup, installHint, issuesKey, parseGhAuthStatus, setupContext, setupIssues, setupMessage, terminalCommand, type SetupRunner } from "../src/core/setup.ts";

type Answer = { code?: number; stdout?: string; stderr?: string; killed?: boolean } | "missing";

/** Answers each "command args…" from the table; anything else isn't installed. Records what ran and with which options. */
function fake(table: Record<string, Answer>) {
  const ran: Array<{ line: string; options: any }> = [];
  const runner: SetupRunner = async (command, args, options) => {
    const line = [command, ...args].join(" ");
    ran.push({ line, options });
    const a = table[line] ?? "missing";
    if (a === "missing") throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "", killed: a.killed ?? false };
  };
  return { runner, ran };
}

const harnesses = { claude: { command: "claude" }, codex: { command: "codex" }, pi: { command: "pi" } };
const everything: Record<string, Answer> = {
  "git --version": { stdout: "git version 2.50.1 (Apple Git-155)\n" },
  "gh --version": { stdout: "gh version 2.88.1 (2026-03-12)\nhttps://github.com/cli/cli/releases/tag/v2.88.1\n" },
  "gh auth status": { stdout: "github.com\n  ✓ Logged in to github.com account me (keyring)\n  - Active account: true\n  - Token: gho_************************************\n" },
  "claude --version": { stdout: "2.1.211 (Claude Code)\n" },
};

test("checkSetup: versions of what's there, with timeouts; gh never prompts, and never shows its token", async () => {
  const { runner, ran } = fake(everything);
  const r = await checkSetup({ harnesses, defaultHarness: "claude", runner });
  assert.deepEqual(r, { git: "2.50.1 (Apple Git-155)", gh: "2.88.1 (2026-03-12)", ghAuth: "signedIn", harnesses: { claude: "2.1.211 (Claude Code)", codex: null, pi: null }, defaultHarness: "claude" });
  assert.deepEqual(setupIssues(r), []);
  assert.equal(setupMessage(r), "");
  for (const { line, options } of ran) {
    assert.ok(options?.timeoutMs > 0 && options.timeoutMs <= 15_000, `${line} has a timeout`);
    assert.ok(!line.includes("--show-token") && !line.includes(" -t"), line);
    if (line.startsWith("gh ")) assert.equal(options.env.GH_PROMPT_DISABLED, "1");
  }
  assert.deepEqual(ran.map((r) => r.line).sort(), ["claude --version", "codex --version", "gh --version", "gh auth status", "git --version", "pi --version"]);
});

test("checkSetup: the configured path runs, and a version printed to stderr counts (Pi)", async () => {
  const { runner, ran } = fake({ ...everything, "/opt/pi/bin/pi --version": { stderr: "1.3.0\n" } });
  const r = await checkSetup({ harnesses: { ...harnesses, pi: { command: "/opt/pi/bin/pi" } }, defaultHarness: "pi", runner });
  assert.equal(r.harnesses.pi, "1.3.0");
  assert.ok(ran.some((x) => x.line === "/opt/pi/bin/pi --version"));
});

test("checkSetup: nothing installed; gh isn't asked about sign-in", async () => {
  const { runner, ran } = fake({});
  const r = await checkSetup({ harnesses, defaultHarness: "claude", runner });
  assert.deepEqual(setupIssues(r), ["git", "gh", "harness"]);
  assert.ok(!ran.some((x) => x.line === "gh auth status"));
  assert.equal(setupMessage(r), "Diffline isn't set up yet: install git, the GitHub CLI (gh) and an agent CLI (Claude Code, Codex or Pi).");
  assert.deepEqual(setupContext(r), {
    "diffline.setup.checked": true,
    "diffline.setup.gitMissing": true,
    "diffline.setup.ghMissing": true,
    "diffline.setup.ghSignedOut": false,
    "diffline.setup.noHarness": true,
    "diffline.setup.defaultHarnessMissing": false,
    "diffline.setup.incomplete": true,
  });
});

test("checkSetup: a version that fails or hangs counts as not found", async () => {
  const { runner } = fake({ ...everything, "git --version": { code: 1, stderr: "xcrun: error: invalid active developer path" }, "claude --version": { killed: true, code: 143 } });
  const r = await checkSetup({ harnesses, defaultHarness: "claude", runner });
  assert.equal(r.git, null);
  assert.equal(r.harnesses.claude, null);
  assert.deepEqual(setupIssues(r), ["git", "harness"]);
});

test("setupIssues: signed out, and a default harness that isn't installed while another is", async () => {
  const { runner } = fake({ ...everything, "gh auth status": { code: 1, stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n" }, "claude --version": "missing", "codex --version": { stdout: "codex-cli 0.130.0\n" } });
  const r = await checkSetup({ harnesses, defaultHarness: "claude", runner });
  assert.deepEqual(setupIssues(r), ["ghAuth", "defaultHarness"]);
  assert.equal(setupMessage(r), "Diffline isn't set up yet: sign in to the GitHub CLI, then choose an agent CLI you have (Codex CLI): the default, Claude Code CLI, isn't installed.");
  const keys = setupContext(r);
  assert.equal(keys["diffline.setup.ghSignedOut"], true);
  assert.equal(keys["diffline.setup.defaultHarnessMissing"], true);
  assert.equal(keys["diffline.setup.noHarness"], false);
  assert.equal(issuesKey(["harness", "gh"]), issuesKey(["gh", "harness"]));
});

test("parseGhAuthStatus: across gh versions", () => {
  const status = (code: number, stdout: string, stderr = "", killed = false) => parseGhAuthStatus({ code, stdout, stderr, killed });
  // gh 2.40 and later, one account.
  assert.equal(status(0, "github.com\n  ✓ Logged in to github.com account me (keyring)\n  - Active account: true\n"), "signedIn");
  // Before 2.40: on stderr, "as".
  assert.equal(status(0, "", "github.com\n  ✓ Logged in to github.com as me (/Users/me/.config/gh/hosts.yml)\n  ✓ Token: *******************\n"), "signedIn");
  // Not signed in, old and new wording.
  assert.equal(status(1, "", "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n"), "signedOut");
  assert.equal(status(1, "", "You are not logged into any GitHub hosts. To log in, run: gh auth login\n"), "signedOut");
  // An expired token.
  assert.equal(status(1, "", "github.com\n  X Failed to log in to github.com account me (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n  - To re-authenticate, run: gh auth login -h github.com\n"), "signedOut");
  // One account fails, another works: gh exits 1, but there's a working sign-in.
  assert.equal(status(1, "", "github.com\n  ✓ Logged in to github.com account me (keyring)\n  - Active account: true\nghe.example.com\n  X Failed to log in to ghe.example.com account me (default)\n"), "signedIn");
  // Offline or slow: don't say signed out.
  assert.equal(status(1, "", "github.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n  - error connecting to api.github.com: dial tcp: lookup api.github.com: no such host\n"), "unknown");
  assert.equal(status(143, "", "", true), "unknown");
});

test("installHint and terminalCommand", () => {
  assert.equal(installHint("gh", "mac"), "Install: brew install gh (or see https://cli.github.com)");
  assert.equal(installHint("gh", "windows"), "Install: winget install --id GitHub.cli --source winget (or see https://cli.github.com)");
  assert.equal(installHint("gh", "linux"), "Install it from https://cli.github.com");
  assert.equal(terminalCommand("claude", "claude"), "claude");
  assert.equal(terminalCommand("/Users/me/.local/bin/claude", "claude"), "/Users/me/.local/bin/claude");
  assert.equal(terminalCommand("C:\\Users\\me\\bin\\pi.exe", "pi"), "C:\\Users\\me\\bin\\pi.exe");
  assert.equal(terminalCommand("/Applications/My Tools/codex", "codex"), "codex", "a path with spaces would need quoting");
  assert.equal(terminalCommand("codex; rm -rf ~", "codex"), "codex");
});
