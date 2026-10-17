// What Diffline needs on this computer, and whether it's there: git, the GitHub CLI signed in, and an agent CLI. The
// extension turns the result into context keys for the sidebar's welcome view and the walkthrough, a notification on
// activation, and the Check Setup report. No VS Code here, so the tests run it with a fake runner.

import { HARNESS_IDS, HARNESS_NAME, harnessVersion, type HarnessId } from "../agents/harness.ts";
import { run, type RunOptions, type RunResult } from "./exec.ts";

/** Runs a program without a shell, like exec's run: rejects with an error whose `code` is "ENOENT" when it isn't installed. */
export type SetupRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

export type GhAuth = "signedIn" | "signedOut" | "unknown";

export interface SetupReport {
  /** git's version, or null when it isn't found. */
  git: string | null;
  /** gh's version, or null when it isn't found. */
  gh: string | null;
  /** Whether gh is signed in; "unknown" when gh isn't found, didn't answer in time, or couldn't reach GitHub. */
  ghAuth: GhAuth;
  /** Each agent CLI's version line, or null when it isn't found. */
  harnesses: Record<HarnessId, string | null>;
  /** The default harness (diffline.harness). */
  defaultHarness: HarnessId;
}

/**
 * What's missing, in the order to fix it. `defaultHarness`: an agent CLI is installed, but not the default one, so agents
 * on the default would fail.
 */
export type SetupIssue = "git" | "gh" | "ghAuth" | "harness" | "defaultHarness";

const TIMEOUT_MS = 10_000;
/** gh auth status checks each token with GitHub, so it gets longer. */
const AUTH_TIMEOUT_MS = 15_000;
/** gh never prompts or checks for updates here. */
const GH_ENV: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };

/** The first line a `--version` printed, or null when the program isn't there or failed. */
async function version(runner: SetupRunner, command: string, options: RunOptions): Promise<string | null> {
  try {
    const res = await runner(command, ["--version"], options);
    if (res.code !== 0 || res.killed) return null;
    return (res.stdout.trim() || res.stderr.trim()).split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Reads `gh auth status`. Its output and exit code changed over the years: before 2.40 it printed to stderr and exited 1
 * when any host had a problem; later versions list each account (✓ Logged in to github.com account me, X Failed to log in
 * to …) and still exit 1 when one of them fails. Any working account counts as signed in, since that's what gh uses. A
 * network failure is unknown, not signed out. The output is only matched here, never logged or shown: it can name a
 * token's source and, in old versions, part of the token.
 */
export function parseGhAuthStatus(res: Pick<RunResult, "code" | "stdout" | "stderr" | "killed">): GhAuth {
  if (res.killed) return "unknown";
  const text = `${res.stdout}\n${res.stderr}`;
  const loggedIn = /(?:✓|^|\s)Logged in to \S+ (?:as|account) /m.test(text);
  const notLoggedIn = /not logged in(?:to)? any/i.test(text);
  if (res.code === 0) return notLoggedIn && !loggedIn ? "signedOut" : "signedIn";
  if (loggedIn) return "signedIn";
  if (/dial tcp|no such host|timed? ?out|connection (?:refused|reset)|network is unreachable|TLS handshake|could not resolve host|\bEOF\b/i.test(text)) return "unknown";
  return "signedOut";
}

async function ghAuthStatus(runner: SetupRunner): Promise<GhAuth> {
  try {
    return parseGhAuthStatus(await runner("gh", ["auth", "status"], { env: GH_ENV, timeoutMs: AUTH_TIMEOUT_MS }));
  } catch {
    return "unknown";
  }
}

let defaultRunner: SetupRunner = run;

/** Replace how the check runs programs (the extension's tests use a fake). Pass null to restore exec's run. */
export function setSetupRunner(next: SetupRunner | null): void {
  defaultRunner = next ?? run;
}

export interface SetupOptions {
  /** The command each agent CLI runs as (diffline.<id>.path, else its id). */
  harnesses: Record<HarnessId, { command: string }>;
  defaultHarness: HarnessId;
  /** Stands in for exec's run (tests). */
  runner?: SetupRunner;
}

/** Look for everything at once. Every check has a timeout, and none prompts, signs in or spends tokens. */
export async function checkSetup(opts: SetupOptions): Promise<SetupReport> {
  const runner = opts.runner ?? defaultRunner;
  const [git, gh, ...found] = await Promise.all([
    version(runner, "git", { timeoutMs: TIMEOUT_MS }).then((v) => v && v.replace(/^git version /, "")),
    version(runner, "gh", { env: GH_ENV, timeoutMs: TIMEOUT_MS }).then((v) => v && v.replace(/^gh version /, "")),
    ...HARNESS_IDS.map((id) => harnessVersion(opts.harnesses[id], runner)),
  ]);
  // Asked only when gh is there, after its version: a missing gh can't be signed in.
  const ghAuth = gh ? await ghAuthStatus(runner) : "unknown";
  const harnesses = Object.fromEntries(HARNESS_IDS.map((id, i) => [id, found[i]])) as Record<HarnessId, string | null>;
  return { git, gh, ghAuth, harnesses, defaultHarness: opts.defaultHarness };
}

export function setupIssues(r: SetupReport): SetupIssue[] {
  const issues: SetupIssue[] = [];
  if (!r.git) issues.push("git");
  if (!r.gh) issues.push("gh");
  else if (r.ghAuth === "signedOut") issues.push("ghAuth");
  const installed = HARNESS_IDS.filter((id) => r.harnesses[id]);
  if (!installed.length) issues.push("harness");
  else if (!r.harnesses[r.defaultHarness]) issues.push("defaultHarness");
  return issues;
}

/** Context keys for the sidebar's welcome view and the walkthrough (package.json), all false until the first check. */
export function setupContext(r: SetupReport): Record<string, boolean> {
  const issues = setupIssues(r);
  return {
    "diffline.setup.checked": true,
    "diffline.setup.gitMissing": issues.includes("git"),
    "diffline.setup.ghMissing": issues.includes("gh"),
    "diffline.setup.ghSignedOut": issues.includes("ghAuth"),
    "diffline.setup.noHarness": issues.includes("harness"),
    "diffline.setup.defaultHarnessMissing": issues.includes("defaultHarness"),
    "diffline.setup.incomplete": issues.length > 0,
  };
}

const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const orList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** One sentence naming what's missing, for the notification. Empty when nothing is. */
export function setupMessage(r: SetupReport): string {
  const issues = setupIssues(r);
  if (!issues.length) return "";
  const parts: string[] = [];
  const install = [
    issues.includes("git") ? "git" : "",
    issues.includes("gh") ? "the GitHub CLI (gh)" : "",
    issues.includes("harness") ? "an agent CLI (Claude Code, Codex or Pi)" : "",
  ].filter(Boolean);
  if (install.length) parts.push(`install ${andList(install)}`);
  if (issues.includes("ghAuth")) parts.push("sign in to the GitHub CLI");
  if (issues.includes("defaultHarness")) {
    const others = HARNESS_IDS.filter((id) => r.harnesses[id]).map((id) => HARNESS_NAME[id]);
    parts.push(`choose an agent CLI you have (${orList(others)}): the default, ${HARNESS_NAME[r.defaultHarness]}, isn't installed`);
  }
  return `Diffline isn't set up yet: ${parts.join(", then ")}.`;
}

/** Identifies a set of issues, so the notification shows once per set per session. */
export const issuesKey = (issues: SetupIssue[]) => [...issues].sort().join(",");

/* ---------- How to install and sign in ---------- */

export type SetupTool = "git" | "gh" | HarnessId;
export type SetupPlatform = "mac" | "windows" | "linux";

export const platformOf = (p: NodeJS.Platform = process.platform): SetupPlatform => (p === "darwin" ? "mac" : p === "win32" ? "windows" : "linux");

export interface ToolHelp {
  name: string;
  /** The official install page. */
  url: string;
  /** The install command per platform, from the tool's own docs; null where the page is the way (Linux distributions differ). */
  install: Record<SetupPlatform, string | null>;
  /** What to type in a terminal to sign in, and what to do once it's typed. */
  signIn?: { command: string; steps: string };
}

// Checked against each tool's install docs: git-scm.com/install, cli.github.com and github.com/cli/cli/docs,
// code.claude.com/docs/en/setup, github.com/openai/codex (README) and github.com/earendil-works/pi (README).
export const TOOL_HELP: Record<SetupTool, ToolHelp> = {
  git: {
    name: "git",
    url: "https://git-scm.com/install/",
    install: { mac: "brew install git", windows: "winget install --id Git.Git -e --source winget", linux: null },
  },
  gh: {
    name: "GitHub CLI (gh)",
    url: "https://cli.github.com",
    install: { mac: "brew install gh", windows: "winget install --id GitHub.cli --source winget", linux: null },
    signIn: { command: "gh auth login", steps: "Press Enter in the terminal and follow gh's steps." },
  },
  claude: {
    name: HARNESS_NAME.claude,
    url: "https://code.claude.com/docs/en/setup",
    install: { mac: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex", linux: "curl -fsSL https://claude.ai/install.sh | bash" },
    signIn: { command: "claude", steps: "Press Enter in the terminal and follow the browser prompts to log in." },
  },
  codex: {
    name: HARNESS_NAME.codex,
    url: "https://github.com/openai/codex",
    install: {
      mac: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      windows: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      linux: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    },
    signIn: { command: "codex", steps: "Press Enter in the terminal and choose Sign in with ChatGPT." },
  },
  pi: {
    name: HARNESS_NAME.pi,
    url: "https://pi.dev",
    install: { mac: "curl -fsSL https://pi.dev/install.sh | sh", windows: 'powershell -c "irm https://pi.dev/install.ps1 | iex"', linux: "curl -fsSL https://pi.dev/install.sh | sh" },
    signIn: { command: "pi", steps: "Press Enter in the terminal, then type /login and pick your model provider." },
  },
};

/** How to install a tool here: its command, else its page. */
export function installHint(tool: SetupTool, platform: SetupPlatform = platformOf()): string {
  const help = TOOL_HELP[tool];
  const command = help.install[platform];
  return command ? `Install: ${command} (or see ${help.url})` : `Install it from ${help.url}`;
}

/**
 * What a terminal should get to start a CLI: its configured command when that's a plain path, else its name, since a
 * path with spaces needs quoting that differs between zsh, bash and PowerShell.
 */
export function terminalCommand(command: string, fallback: string): string {
  return /^[\w./~:\\-]+$/.test(command) ? command : fallback;
}
