# Architecture

How the VS Code extension works. Paths are relative to `apps/vscode/` unless they start with `packages/`.

```
 VS Code                      Extension host (Node)                          Outside
┌─────────────┐   messages   ┌───────────────────────────────────────┐
│ Review page │◄────────────►│ ReviewPanel (vscode/panel.ts)         │
│ (webview)   │              │        │                              │
└─────────────┘              │        ▼                              │     gh ──► GitHub
┌─────────────┐              │ DifflineService (core/service.ts) ────┼───► git ─► local clones
│ Sidebar     │◄─────────────│   ├─ Repos (core/repos.ts)            │
│ (tree view) │              │   ├─ Store (core/store.ts)            │
└─────────────┘              │   ├─ Locks (core/locks.ts)            │
                             │   └─ runReview (agents/review.ts) ────┼───► claude / codex
                             └───────────────────────────────────────┘
```

## Source layout

| Folder | What's in it |
| --- | --- |
| `src/extension.ts` | Activation: wires the pieces together, registers commands, reads settings. |
| `src/core/` | Everything that doesn't need VS Code: the service, GitHub, clones, diffs, storage, locks, risk, grouping. Testable with plain Node. |
| `src/agents/` | Agent settings, prompts, output schemas, the harnesses, running a review, and validating its output. |
| `src/vscode/` | The VS Code surfaces: the review panel, the page builder, the sidebar tree. |
| `test/` | Unit tests (`node --test`). `fake-vscode.ts` stands in for the `vscode` module. |
| `test-vscode/smoke.cjs` | A smoke test that runs inside a real VS Code (see [CONTRIBUTING.md](../CONTRIBUTING.md)). |
| `scripts/` | Developer scripts: GitHub smoke checks, an end-to-end agent run, the page in a browser, the VS Code smoke test. |
| `esbuild.mjs` | Bundles `src/extension.ts` to `dist/extension.cjs` and copies `packages/review-ui` into `media/ui`. |

## Activation

The extension activates on `onStartupFinished` (`package.json`). `activate()` in `src/extension.ts`:

1. Creates the output channel (**Diffline: Show Agent Log**), the `Store` in the extension's global storage, and `Repos`.
2. Creates `DifflineService`, giving it the store, repos, VS Code's `globalState` as its memory, and a function that reads the current settings (`readConfig`).
3. Creates the `ReviewPanel` and the `PullRequestTree` sidebar, the status bar item, and the commands.
4. Writes the default agent settings to `~/.diffline` on first run (`ensureSettings` in `src/agents/settings.ts`).
5. Calls `service.start()`, which cleans up review checkouts left by windows that closed mid-run, refreshes from GitHub, and starts the timers.

Settings changes go to `service.configChanged()`. Changes to what's watched, the agents or clones also trigger a refresh. Grouping and sorting changes only redraw.

## DifflineService

`src/core/service.ts` is the core. It keeps one record per pull request (`PrRecord`: its summary from GitHub, whether it was opened by hand, the last agent review, the run state) and emits `change` when anything changes. The sidebar and status bar listen to it.

### Polling GitHub

Every `diffline.watch.pollSeconds` (60 by default, at least 15), `refresh()` runs one GraphQL search through `gh` (`searchPullRequests` in `src/core/github.ts`). It covers review requests to you by name, assignments, pull requests you reviewed, your own, watched repositories, and ones you opened by hand. Concurrent refreshes share one request. The last list is saved in `globalState`, so it shows at once on the next start.

Pull requests that leave every search are dropped, unless they were opened by hand or their agents are running.

### Background searches

Once the list shows, `refreshExtras()` runs the slower work, each step best effort:

- **Team requests**, which can run to a hundred pull requests and make GitHub's search slow.
- **Others you could review** (`searchReviewable`): open, ready pull requests in your repositories that aren't yours, weren't requested from you, and aren't approved.
- **Changed files** for rows the search returned without them, 20 pull requests per query, cached by head commit. The risk score needs them.
- **Code owners** (`markCodeOwned`): your teams and each repository's `CODEOWNERS` (from the default branch, in GitHub's three locations), both cached for an hour. `src/core/codeowners.ts` matches paths with GitHub's rules: the last matching line wins.

After a refresh, `warmUp()` builds the diffs of up to 10 pull requests that request your review or were opened by hand, so opening them is quick.

### Locks across windows

Every VS Code window runs its own extension host. `src/core/locks.ts` keeps locks as files in `<storage>/locks/`, shared by all windows on the machine. A lock holds its owner's process id and a heartbeat (every 30 seconds). It's free once that process is gone or the heartbeat is more than 90 seconds old. `link()` creates a lock with its content in one step and fails if another window got there first.

Two kinds of lock:

- `leader`: the window that holds it starts automatic runs, so all windows share one limit on parallel agents.
- `run-<owner>__<name>__<number>`: held while a pull request's agents run. Other windows show that run as "running in another window".

### Automatic runs

`scheduleAutomaticRuns()` runs after each refresh, in the leader window only, when `diffline.agents.autoRun` is on. A pull request gets a run when it requests your review by name, is open, isn't a draft (with `skipDrafts`), the agents haven't reviewed its head, it's under the automatic-run limit, and it's not over the file or line limit. Too-large pull requests are marked `held`.

A scheduled run waits until the quiet period after the head was first seen has passed. A 10-second timer starts the runs that are due. Automatic run counts per pull request are kept in `globalState`.

### A run

`runAgents()`:

1. Takes the pull request's run lock, or marks it as running elsewhere.
2. Loads the pull request and builds its diff (`loadData`). An automatic run checks again whether another window already reviewed this head.
3. Loads the agent settings.
4. Makes a run folder (`Store.newRunDir`), a checkout of the head (`Repos.reviewTree`), and a copy of the changed files as they were at the merge base (`Repos.exportFiles`, into `<run>/base`).
5. Calls `runReview()` and saves the result as the pull request's agent file.
6. Always removes the checkout and releases the lock, even when the run fails or is stopped.

**Stop** aborts the run's `AbortController`, which kills the agent processes.

## Repos

`src/core/repos.ts` finds a clone for each repository and makes sure a pull request's commits are in it. It looks in this order:

1. The clone set for that repository in `diffline.clones`.
2. Workspace folders with a git remote that points at the repository.
3. A managed clone in `<storage>/clones/<owner>__<name>`, created on first use: bare, partial (`--filter=blob:none`, so no file contents until needed), no tags.

`ensureCommits()` fetches only what's missing: GitHub's `refs/pull/<n>/head`, and the base commit by id (or the base branch if the server refuses). Fetches never touch the checked-out branch. Git operations on one clone run one at a time.

The managed clone keeps the `gh auth git-credential` helper in its own config, for `github.com` only, because a partial clone downloads file contents later, when a command first needs them. An empty generic helper keeps the user's own credential helpers out. Git runs with `GIT_TERMINAL_PROMPT=0` and SSH in batch mode, so it fails instead of waiting for input (`GIT_ENV` in `src/core/exec.ts`).

**Review checkouts.** `reviewTree()` adds a detached worktree of the head under `<storage>/trees/`, always from the managed clone, never the user's. Folder names start with the window's process id, so `cleanTrees()` can tell which ones are abandoned.

## Building the diff

`buildReviewData()` in `src/core/diff.ts` turns a base and head into `ReviewData` (`src/core/types.ts`), the shape the page reads:

- The three-dot diff (`base...head`) with rename detection, the commits from the merge base to the head, and the files in the head's tree.
- `git blame` from the merge base for files with added lines, so each added line knows its commit. Up to 8 run at once.
- File contents through one `git cat-file --batch` process: each changed file at the head (up to 3,000 lines, for context), npm lockfiles and their `package.json` before and after (for the package summary), and a few repository files the page reads.
- A test hint per source file: its test file, and whether it changed.
- With `since` (the commit of your last review on GitHub), the lines and hunks that are new since then.

Built data is cached in the store by head and `since`, so reopening a pull request is instant. The service shares builds in progress, so opening a pull request that's being warmed up waits for that build.

## GitHub

`src/core/github.ts` talks to GitHub only through the `gh` CLI: `gh api graphql` for searches, pull request details, files, teams and `CODEOWNERS`, and `gh api` for posting. Prompts and update notices are off, and each call has a 60-second timeout. Errors are classified as missing, auth, not found, rate limit or other, so the sidebar can say what's wrong. `setGhRunner()` lets tests replace `gh` with a fake.

`pushReview()` posts one review (with its line comments and decision) on the given commit, then replies, then thread resolutions through GraphQL. If the review fails, it stops before the replies and resolutions. With `dry`, it returns the requests and sends nothing.

## Agents

### Settings

`src/agents/settings.ts` reads `~/.diffline/agents.yml` and `~/.diffline/agents/<id>.md` (`DIFFLINE_HOME` overrides the folder, which the tests and scripts use). Anything missing or invalid falls back to the default in `src/agents/defaults.ts`, and the problems are listed in the log. Settings are read at the start of each run, so edits apply to the next one.

The guide is special: it checks the description, sets the reading order and draws the flow. Every other agent, built in or added, is a reviewer.

### Prompts and schemas

`src/agents/prompts.ts` builds each agent's prompt: its name, focus and instructions, the pull request's title, description and review threads, the diff, and the rules for naming lines. A diff over 160,000 characters goes to `<run>/diff.patch` for the agent to read instead. Each agent's `skip` patterns leave files out of its diff.

`src/agents/schema.ts` holds the JSON Schemas each agent must return: one for the guide, one for reviewers, one for the briefing's opening line. Every property is required, with nullable values, which both CLIs' structured output accepts.

### Running a review

`runReview()` in `src/agents/review.ts`:

1. Picks the agents to run (`selectAgents`): enabled in `agents.yml`, allowed by `diffline.agents.enabled`, not every file skipped, a `runs-when` match, and room for findings.
2. Runs them in parallel, at most `diffline.agents.maxParallel` at once across all pull requests (a shared `Semaphore` in `src/core/limit.ts`). A missing or signed-out CLI fails only the agents that use it.
3. Validates and assembles the outputs into one agent file.
4. Runs the lede, a short call that writes the briefing's opening line from the findings. It uses the guide's harness, and falls back to a written summary.
5. Writes `usage.json` with each agent's harness, model, time, tokens and cost.

### Harnesses

`src/agents/harness.ts` runs one prompt through a CLI, headless, and returns its JSON output with token counts (and cost, for Claude Code). Each agent gets the review checkout as its working folder and the run folder to read.

**Claude Code** runs with `-p`, `--json-schema`, `--no-session-persistence` and `--permission-mode dontAsk`. `claudeAccessArgs()` limits it to the `Read`, `Grep` and `Glob` tools, with `Read` allowed only inside the checkout and the run folder. Anything else is refused. It has no shell, because even "read-only" git commands take options that write files or run programs. Only the user's own settings load (`--setting-sources user`), with every hook off. MCP servers and slash commands are off.

**Codex** runs `codex exec` with `--sandbox read-only`, `--ephemeral` and `--ignore-user-config`, so `~/.codex/config.toml` (MCP servers, plugins, hooks, notify commands) doesn't apply. Features a read-only review has no use for, such as connectors, plugins, memories, sub-agents and browser use, are turned off. Sign-in still works, because it lives in Codex's auth file.

Both get a minimal environment (`agentEnv()` in `src/core/exec.ts`): what the CLI needs to run, sign in and reach its provider, without the user's other tokens and keys such as `GH_TOKEN`. An agent that runs past `diffline.agents.timeoutMinutes` is stopped. Commands run without a shell.

### Validation

`src/agents/validate.ts` turns raw outputs into an agent file the page can trust:

- `AnchorIndex` finds diff lines by their text, the way the page resolves them. It repairs small mistakes (a path with `a/` or `./`, a different case, collapsed whitespace, a line named in the wrong file when the text is unique elsewhere). Anchors that don't resolve to an added or context line are dropped and logged.
- Values from fixed sets (severity, confidence, label, change) fall back to a default when they're not in the set, because the page uses several of them in class names.
- Findings below an agent's minimum confidence, or over its limit, are dropped.
- Chapters cover every changed file once. Files the guide left out go into a last chapter.
- Description quotes must appear in the description, and the description check has one item per rule.
- Diagram edges must join real nodes.

## The review page

The page is `packages/review-ui` (`index.html`, `app.js`, `styles.css`), plain HTML, CSS and JavaScript with no build step. `esbuild.mjs` copies it into `media/ui`, which is what the `.vsix` ships.

`src/vscode/panel.ts` hosts it in one webview panel, for one pull request at a time. `retainContextWhenHidden` keeps the page's state when the tab is hidden. To open a pull request, the panel shows a loading page, renders from the cached GitHub detail when there is one, then checks GitHub and re-renders only if something changed.

`src/vscode/page.ts` builds the HTML from `index.html`:

- The review data and live data are inlined as `window.REVIEW_DATA` and `window.DIFFLINE_LIVE`, through `scriptJson()`, which escapes `<` and the line separators that would end a script or a string.
- A Content Security Policy allows only the extension's own files, and scripts only with a per-page nonce. The page loads nothing remote.
- `hostShim()` defines `window.DIFFLINE_HOST`, the page's bridge to the extension.

### Host bridge

The page calls `DIFFLINE_HOST.api(method, path, body)`, `reload()`, `open(target)` and `runAgents()`. Each becomes a message that names the pull request the page was built for, so a save sent while another pull request loads still goes to its own. Request ids are unique per page, so a late answer can't settle a request from a newer page.

| Message from the page | What the extension does |
| --- | --- |
| `api` `PUT /state` | Saves drafts, reviewed marks and decisions (`Store.writeState`). |
| `api` `POST /push?dry=1` | Checks the review and returns the requests it would send. |
| `api` `POST /push` | Checks the review and posts it (`checkPush`, then `pushReview`). |
| `api` `POST /refresh` | Fetches the pull request again and rebuilds the diff. |
| `reload` | Reloads the page, if it's still the current one. |
| `open` | Opens another pull request in the panel. |
| `runAgents` | Runs the `diffline.runAgents` command, so it asks first when nothing changed. |

The extension answers `api` messages with `api-result`. It sends `host-view` to switch the page to its list (Home) with fresh groups.

### Sidebar

`src/vscode/tree.ts` draws the sidebar from the service's records. `src/core/grouping.ts` groups and sorts them, and the page's list uses the same groups. `src/core/risk.ts` is a port of `computeRisk` in `packages/review-ui/app.js`, so the sidebar shows the same score as the page. Change both together.

## Storage

The extension's global storage (on macOS, `~/Library/Application Support/Code/User/globalStorage/arminkarimi.diffline/`) is created readable by the user's account only. `<slug>` is `<owner>__<name>__<number>`.

| Path | What's in it |
| --- | --- |
| `state/<slug>.json` | The page's review state: drafts, reviewed marks, reading order, finding and description decisions. |
| `agents/<slug>.json` | The latest agent review. |
| `cache/<slug>/<head>[-<since>].json` | Built review data. The newest 4 per pull request are kept. |
| `runs/<slug>/<head>-<time>/` | One folder per run: each agent's prompt, raw output and log, `run.log`, `diff.patch`, `base/`, `agent-file.json` and `usage.json`. The newest 6 per pull request are kept. |
| `clones/<owner>__<name>/` | Managed partial clones. |
| `trees/` | Review checkouts, removed after each run. |
| `locks/` | Locks shared by VS Code windows. |

JSON files are written to a temporary file and renamed, and writes to one file are queued, so an older save never lands after a newer one. A file that doesn't parse is set aside as `<file>.damaged`.

`globalState` holds the last list (`lastList`), pull requests opened by hand (`pinned`) and automatic run counts (`autoRuns`). Agent settings are in `~/.diffline`.

## Security model

Diffline reads pull requests written by other people, and hands them to agents that can read files. The design assumes a pull request may contain text written to steer the agents (prompt injection).

**What agents can do.** Read the review checkout of the head and the run folder (the diff, and the changed files as they were). Claude Code agents can only read, search and list files in those folders. Codex agents can run commands only inside its read-only sandbox.

**What agents can't do.** Write files, change the user's clone (they never see it), run a shell (Claude Code), use MCP servers, hooks, plugins or the repository's own agent settings, read the user's other tokens from the environment, or post anything. Their output is only suggestions on the page.

**Before anything is shown.** Validation drops anchors that aren't in the diff and replaces values outside their allowed sets. The page escapes agent text.

**Before anything is posted.** Only the user posts, with **Post now**. `checkPush()` in `src/core/service.ts` checks that every reply and thread resolution is for a thread on this pull request, and refuses a review that contains what looks like a private key, a token, an API key or a URL with a password (`src/core/secrets.ts`). `pushReview()` checks the decision and every comment's file, line and text.

**Settings from a workspace.** The settings that choose which programs run and where clones are (`diffline.claude.path`, `diffline.codex.path`, their `extraArgs`, `diffline.clones`) are machine-scoped and restricted in untrusted workspaces, so a repository's `.vscode/settings.json` can't change them.

**Names from outside.** `parseKey()` accepts only owner and repository names GitHub allows, so a pull request key can't reach outside Diffline's folders. `exportFiles()` skips paths that would leave the run folder.

**The webview.** No remote scripts, styles, fonts or images, and scripts only with the page's nonce. Diffline has no telemetry.
