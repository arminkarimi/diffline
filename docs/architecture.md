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
                             │   ├─ MetricsLog (core/metrics-log.ts)─┼───► metrics/events.jsonl
                             │   ├─ metrics report (core/metrics.ts) │     (global storage)
                             │   └─ runReview (agents/review.ts) ────┼───► claude / codex / pi
                             └───────────────────────────────────────┘
```

## Source layout

| Folder | What's in it |
| --- | --- |
| `src/extension.ts` | Activation: wires the pieces together, registers commands, reads settings. |
| `src/core/` | Everything that doesn't need VS Code: the service, GitHub, clones, diffs, storage, locks, risk, grouping, review metrics. Testable with plain Node. |
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
6. Always writes a run event to the [review metrics](#review-metrics), removes the checkout and releases the lock, even when the run fails or is stopped.

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

`src/agents/schema.ts` holds the JSON Schemas each agent must return: one for the guide, one for reviewers, one for the briefing's opening line. Every property is required, with nullable values, which the structured output of Claude Code and Codex accepts. Pi has no structured output option, so a Pi agent's prompt ends with the schema and asks for only a JSON object.

### Running a review

`runReview()` in `src/agents/review.ts`:

1. Picks the agents to run (`selectAgents`): enabled in `agents.yml`, allowed by `diffline.agents.enabled`, not every file skipped, a `runs-when` match, and room for findings.
2. Runs them in parallel, at most `diffline.agents.maxParallel` at once across all pull requests (a shared `Semaphore` in `src/core/limit.ts`). A missing or signed-out CLI fails only the agents that use it.
3. Validates and assembles the outputs into one agent file.
4. Runs the lede, a short call that writes the briefing's opening line from the findings. It uses the guide's harness, and falls back to a written summary.
5. Writes `usage.json` with each agent's harness, model, time, tokens and cost.

### Harnesses

`src/agents/harness.ts` runs one prompt through a CLI, headless, and returns its JSON output with token counts (and cost, for Claude Code and Pi). Claude Code and Codex agents get the review checkout as their working folder and the run folder to read. Pi agents get an empty folder instead (see below).

**Claude Code** runs with `-p`, `--json-schema`, `--no-session-persistence` and `--permission-mode dontAsk`. `claudeAccessArgs()` limits it to the `Read`, `Grep` and `Glob` tools, with `Read` allowed only inside the checkout and the run folder. Anything else is refused. It has no shell, because even "read-only" git commands take options that write files or run programs. Only the user's own settings load (`--setting-sources user`), with every hook off. MCP servers and slash commands are off.

**Codex** runs `codex exec` with `--sandbox read-only`, `--ephemeral` and `--ignore-user-config`, so `~/.codex/config.toml` (MCP servers, plugins, hooks, notify commands) doesn't apply. Features a read-only review has no use for, such as connectors, plugins, memories, sub-agents and browser use, are turned off. Sign-in still works, because it lives in Codex's auth file.

**Pi** runs with `--mode json --offline --no-session --tools read,grep,find,ls --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`, plus `--no-approve` (Pi 0.79 and later: a folder's project files are ignored) and `--no-mcp` (1.0.4 and later: no MCP servers connect) when the installed version has them, then `--model` and `--thinking` when set, then `diffline.pi.extraArgs`. In Pi 1.x, `--no-extensions` also turns off Pi's built-in MCP, tool search and codemode extensions. The prompt goes on stdin. Pi gets only its read, grep, find and ls tools, which can't write files or run commands. Extensions, skills, prompt templates, themes and context files (`AGENTS.md`, `CLAUDE.md`) are off, no session is saved, and offline mode skips update checks, telemetry and package installs. Offline, Pi won't download the ripgrep and fd its grep and find tools use, so without them those tools fail and the agent still has read and ls.

Pi's working folder is never the checkout. Pi always reads `.pi/settings.json` in its working folder, and no flag turns that off; that file can install packages and run commands when Pi starts, and `.pi/SYSTEM.md` would replace the prompt. So each Pi agent runs in an empty folder in the run folder (`pi-<agent id>/`), created before the run and removed after. The prompt gives the checkout's and the base files' absolute paths and asks for repository-relative paths in the answer; paths that still start with the checkout's path are made relative before validation. Like Codex's read-only sandbox, Pi's read tools aren't limited to one folder.

`--model` comes from the agent's `model:` in `agents.yml`, else `diffline.pi.model`, in Pi's syntax (`provider/id`, optionally with `:level`). `--thinking` comes from `diffline.pi.thinking`, validated by Diffline because Pi ignores a bad value, and isn't passed when the agent's own model ends with `:level`. With neither, Pi uses its own defaults, which is safe because the empty folder has no project settings. **Choose Pi model…** lists the signed-in models with `pi --list-models`, run the same way: from an empty folder, offline, with the same `--no-` flags.

`--mode json` prints events as JSON lines. The answer is the text of the last `message_end` event from the assistant, parsed as JSON. A non-zero exit, or a last assistant message whose `stopReason` is `error` or `aborted`, fails the agent with Pi's error ("No API key found" and "No models available" are sign-in errors). A reply cut off at the length limit, or no assistant message, is bad output. Tokens and cost are summed over every assistant message's `usage`, and the reported model is the one Pi used for the last message.

All three get a minimal environment (`agentEnv()` in `src/core/exec.ts`): what the CLI needs to run, sign in and reach its provider, without the user's other tokens and keys such as `GH_TOKEN`. Pi also gets (`piEnv()`) its own `PI_` variables and the variables its built-in providers read, named one by one (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `AWS_` for Bedrock, `AZURE_OPENAI_`, Google Cloud's and the like), so other keys in the environment stay out. Never `GH_` or `GITHUB_` tokens: Pi's GitHub Copilot provider signs in with `/login` only. A custom provider in Pi's `models.json` that reads its key from another variable should store the key with Pi instead. `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK` and `PI_TELEMETRY` are always set to keep it offline. An agent that runs past `diffline.agents.timeoutMinutes` is stopped. Commands run without a shell.

### Validation

`src/agents/validate.ts` turns raw outputs into an agent file the page can trust:

- `AnchorIndex` finds diff lines by their text, the way the page resolves them. It repairs small mistakes (a path with `a/` or `./`, a different case, collapsed whitespace, a line named in the wrong file when the text is unique elsewhere). Anchors that don't resolve to an added or context line are dropped and logged.
- Values from fixed sets (severity, confidence, label, change) fall back to a default when they're not in the set, because the page uses several of them in class names.
- Findings below an agent's minimum confidence, or over its limit, are dropped.
- Chapters cover every changed file once. Files the guide left out go into a last chapter.
- Description quotes must appear in the description, and the description check has one item per rule.
- Diagram edges must join real nodes.
- Findings are sorted by severity, then agent order, and get [ids that survive a re-run](#finding-ids).

## The review page

The page is `packages/review-ui` (`index.html`, `app.js`, `styles.css`), plain HTML, CSS and JavaScript with no build step. `esbuild.mjs` copies it into `media/ui`, which is what the `.vsix` ships.

`src/vscode/panel.ts` hosts it in one webview panel, for one pull request at a time. `retainContextWhenHidden` keeps the page's state when the tab is hidden. To open a pull request, the panel shows a loading page, renders from the cached GitHub detail when there is one, then checks GitHub and re-renders only if something changed.

`src/vscode/page.ts` builds the HTML from `index.html`:

- The review data and live data are inlined as `window.REVIEW_DATA` and `window.DIFFLINE_LIVE`, through `scriptJson()`, which escapes `<` and the line separators that would end a script or a string.
- A Content Security Policy allows only the extension's own files, and scripts only with a per-page nonce. The page loads nothing remote.
- `hostShim()` defines `window.DIFFLINE_HOST`, the page's bridge to the extension.

### Host bridge

The page calls `DIFFLINE_HOST.api(method, path, body)`, `reload()`, `open(target)`, `runAgents()`, and for the [review metrics](#review-metrics) `metrics(m)`, `metricsReport(o)` and `metricsExport(o)`. Each becomes a message that names the pull request the page was built for, so a save sent while another pull request loads still goes to its own. Request ids are unique per page, so a late answer can't settle a request from a newer page.

| Message from the page | What the extension does |
| --- | --- |
| `api` `PUT /state` | Saves drafts, reviewed marks and decisions (`Store.writeState`). |
| `api` `POST /push?dry=1` | Checks the review and returns the requests it would send. |
| `api` `POST /push` | Checks the review and posts it (`checkPush`, then `pushReview`). |
| `api` `POST /refresh` | Fetches the pull request again and rebuilds the diff. |
| `reload` | Reloads the page, if it's still the current one. |
| `open` | Opens another pull request in the panel. |
| `runAgents` | Runs the `diffline.runAgents` command, so it asks first when nothing changed. |
| `metrics` | Appends what the reviewer did to the review metrics log (`DifflineService.metrics`). No answer. |
| `metricsReport` | Returns the report for a period and grouping (`DifflineService.metricsReport`). |
| `metricsExport` | Writes the period's events as JSON or finding outcomes as CSV where the reviewer picks, through a save dialog. |

The extension answers `api`, `metricsReport` and `metricsExport` messages with `api-result`. It sends `host-view` to switch the page to its list (Home) with fresh groups, or to the review metrics.

### Sidebar

`src/vscode/tree.ts` draws the sidebar from the service's records. `src/core/grouping.ts` groups and sorts them, and the page's list uses the same groups. `src/core/risk.ts` is a port of `computeRisk` in `packages/review-ui/app.js`, so the sidebar shows the same score as the page. Change both together.

## Review metrics

The extension keeps a log of what the reviewer does with agent findings and description checks, each review they post, and each agent run, and adds it up into a report (**Diffline: Show Review Metrics**). The log is on by default (`diffline.metrics.enabled`), stays in the extension's global storage, and is never sent anywhere. It holds no code, diff, finding body or comment text: a finding's title is the one text field.

```
 Review page (webview)                          Extension host (Node)
┌──────────────────────────────┐
│ Add to my review, Dismiss,   │ DIFFLINE_HOST.metrics    ┌──────────────────────────────┐
│ Copy, Undo, Ask, Skip,       ├─────────────────────────►│ ReviewPanel (vscode/panel.ts)│
│ Post now                     │ { head, run, events }    └──────────────┬───────────────┘
└──────────────────────────────┘                                         ▼
                                                          ┌──────────────────────────────┐
                                                          │ DifflineService.metrics()    │
                                                          └──────────────┬───────────────┘
                                                                         ▼
 agents/<slug>.json ── finding, agent and rule details ─► ┌──────────────────────────────┐
                                                          │ MetricsLog                   │
 runAgents(), however the run ends ── recordRun() ──────► │ (core/metrics-log.ts)        │
                                                          │ checks and enriches events,  │
                                                          │ sets round and newPush,      │
                                                          │ appends in arrival order     │
                                                          └──────────────┬───────────────┘
                                                                         ▼
                                                            metrics/events.jsonl (0600)
                                                                         │ read
                                                                         ▼
┌──────────────────────────────┐ metricsReport            ┌──────────────────────────────┐
│ #metrics page                ├─────────────────────────►│ parseEvents(), aggregate()   │
│ (Show Review Metrics,        │◄─────────────────────────┤ (core/metrics.ts)            │
│ or Review metrics on Home)   │ report                   └──────────────────────────────┘
│                              │ metricsExport
│ Export CSV / Export JSON     ├────────────────────────► exportText() ──► save dialog
└──────────────────────────────┘
```

### Finding ids

A decision has to stay with its finding when the agents run again, so ids come from what a finding is about, not its place in the list. `findingId()` in `src/agents/validate.ts` makes `<agent>-<hash>`: the first 8 hex digits of a SHA-256 of the file's path, a newline, and the full text of the diff line the finding is anchored to, with whitespace collapsed. It hashes the anchored line, not the agent's `match`, which can quote more or less of the line from one run to the next. When the same agent flags the same line on a later run, the finding gets the same id, however it's worded. `assignIds()` gives a second finding from the same agent on the same line `-2`, a third `-3`, in the sorted order. Ids are letters, digits and dashes only, because the page puts them in HTML ids and attributes.

The page saves each decision in the review state (`state/<slug>.json`) under the finding's id, with the run it was made on (the agent file's `ranAt`) and the finding's title. A decision from an earlier run whose finding came back shows as decided, "on an earlier run". Decisions on findings that aren't in the current run stay in the state and aren't shown.

Ids used to be positional (`f1`, `f2`, …), so an old decision on one can't be tied to a finding after a re-run. A decision on an id like that counts only when it records the current run, which decisions from before this change don't: their findings show as open. `decided()` in `src/core/service.ts` and `validDecision` in `packages/review-ui/app.js` apply the same rule. A draft whose `fromFinding` is such an id loses the link.

### What an agent ran with

Each entry of the agent file's `agents` (`AgentInfo`) records what that agent ran with, from `runConfig()` in `src/agents/review.ts`:

| Field | What it holds |
| --- | --- |
| `harness` | `claude`, `codex` or `pi`. |
| `model` | The model the harness reported, else the configured one, else `null`. |
| `thinking` | Pi only: the thinking level, `null` for Pi's default. Left out for other harnesses. |
| `instructions` | The first 12 hex digits of a SHA-256 of the agent's focus and instructions (`instructionsHash()`), so a change of instructions shows in the report. |

Agent files from before these fields still load.

### The log

`MetricsLog` in `src/core/metrics-log.ts` writes `metrics/events.jsonl` in the global storage: one JSON object per line, appended, never rewritten. The folder is created readable by the user's account only, and the file is written and kept at mode 0600. Only the extension writes it. When `diffline.metrics.enabled` is off, nothing is written; **Diffline: Delete Review Metrics** (`diffline.deleteMetrics`) asks first, then deletes the file.

The page reports what happened with `DIFFLINE_HOST.metrics({ head, run, events })`: finding events name the finding by id, description events name the rule, and a review event carries its counts. The extension takes messages one at a time, in the order they arrive, so lines keep that order. For each message it reads the pull request's current agent file and builds the lines (`buildEvents()`): it checks each event, adds the finding's details (agent, severity, confidence, label, path, title) and the agent's run configuration from the agent file, and leaves out events that don't match it, logging how many. For a posted finding the page sends the posted text; the extension compares it with the text the draft started from and keeps only the result, `edit`. `left-open` is written once per pull request, run and finding. A review's `round` and `newPush` come from the earlier lines for its pull request, read from the file the first time they're needed.

Every line has `v` (1, the schema version), `at` (when, ISO 8601), `pr` (`owner/name#123`), `head` (the commit the page showed), `run` (the agent file's `ranAt` the reviewer saw, or the run that just finished; `null` without one), `kind` and `action`. The rest depends on the kind:

| `kind` | `action` | Other fields |
| --- | --- | --- |
| `finding` | `added`, `dismissed`, `copied`, `undone`, `posted`, `left-open` | `finding`: `id`, `agent`, `severity`, `confidence`, `label`, `path`, `title`. `agent`: `id`, `harness`, `model`, `thinking` (Pi), `instructions`. `reason`: the dismiss reason, or for `undone` what was undone. `edit` (posted only): how much the text was reworded, 0 (as the agent wrote it) to 1 (rewritten), the word-level edit distance over the longer text's length. |
| `description` | `asked`, `skipped`, `undone` | `rule`, `descKind` (`feature` or `fix`), `agent` (the guide), `reason`: the skip reason, or for `undone` what was undone. |
| `review` | `submitted` | `review`: `event` (`approve`, `changes` or `comment`), `own` (the reviewer wrote the pull request), `comments` (inline comments and replies posted), `fromFindings` (of those, drafts from findings), `reviewed` and `hunks` (hunks marked reviewed, of all), `agents` (an agent review existed), `activeMs` (time the page was focused and in use for this pull request since it opened or the last review posted; a minute without input counts as idle), `round` (1 for the first review of the pull request in the log), `newPush` (the head differs from the previous review's). |
| `run` | `finished`, `failed`, `cancelled` | `trigger` (`auto` or `manual`), `ms`, and `agents`: per agent, including the lede, `id`, `harness`, `model`, `thinking` (Pi), `instructions` (`null` for the lede), `ms`, `tokens` (`input`, `cachedInput`, `output`, or `null`), `costUsd` (`null` when the harness doesn't report it), `findings`, and `failed` (`missing`, `auth`, `timeout`, `cancelled`, `failed` or `badOutput`) when it failed. |

When each is written: `added` when a finding goes into the review (**Add to my review**, or a composer draft from it), `dismissed` with its reason, `copied`, `undone` when a decision is taken back, and, when a review posts, `posted` for each draft from a finding and `left-open` for each finding of the current run still undecided, then one `review` event. Description rules log `asked`, `skipped` and `undone`. `runAgents()` writes a `run` event after every run that got past its checks, however it ends.

A dismissed finding, on one line in the file:

```json
{"v":1,"at":"2026-10-11T14:02:31.512Z","pr":"acme/web#123","head":"4f2a9c0d1e8b7a6f5c4d3e2b1a0f9e8d7c6b5a49","run":"2026-10-11T13:55:04.120Z","kind":"finding","action":"dismissed","reason":"Intended","finding":{"id":"correctness-3f9a1c2e","agent":"correctness","severity":"medium","confidence":"Worth asking","label":"question","path":"src/cart/total.ts","title":"Discount applied before tax"},"agent":{"id":"correctness","harness":"claude","model":"sonnet","instructions":"8c1d0e7b2a94"}}
```

### The report

**Diffline: Show Review Metrics** (`diffline.showMetrics`), or **Review metrics** on Home, switches the review page to its `#metrics` route. The page asks for the numbers with `metricsReport({ days, groupBy })`: the period is 7, 30 or 90 days, or all time, and the agent tables group by agent, harness, model or thinking level. `DifflineService.metricsReport()` reads the log once queued writes have landed, and `src/core/metrics.ts`, a pure module with its own tests, adds it up:

- `parseEvents()` reads each line. Damaged lines, other versions and kinds it doesn't know are counted and skipped.
- **Outcomes.** `findingOutcomes()` takes each finding's last event per pull request and finding id: the last event wins. `added`, `posted` and `copied` make it useful, `dismissed` dismissed (with the reason), `left-open` ignored, and `undone` undecided. Decided findings are the useful, dismissed and ignored ones. A finding counts in the period its last event falls in. A group with fewer than 10 decided findings says "too few to tell" instead of percentages.
- **Agent findings**: the outcomes by group, severity by confidence, rewording (the median `edit` of posted findings), description rules asked and skipped with the skip reasons, each group's findings, and, for an agent whose instructions hash or model changed in the period, its latest setup against the one before.
- **Your reviews**: `review` events per ISO week by decision, with the median active time, coverage (`reviewed / hunks`), later rounds, new pushes, and comments split into the reviewer's own and those from findings.
- **Agent runs**: per group, runs, failures by kind, median duration, tokens, cost, and cost per useful finding: the cost of the runs that reported one, over the useful findings from those runs (matched by pull request, run and agent). Codex reports no cost, so its runs count as missing.

The page draws the result. **Export** asks for `metricsExport({ format, days })`: `exportText()` returns the period's raw events as JSON (`{ v, exportedAt, since, events }`) or one CSV row per finding outcome (date, pull request, finding id, agent, harness, model, thinking, severity, confidence, outcome, reason, edit), with cells that start with `=`, `+`, `-` or `@` prefixed so spreadsheets don't run them. The panel writes the file where the reviewer picks, at mode 0600.

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
| `metrics/events.jsonl` | The review metrics log, append-only, readable by the user's account only (0600). See [Review metrics](#review-metrics). |

JSON files are written to a temporary file and renamed, and writes to one file are queued, so an older save never lands after a newer one. A file that doesn't parse is set aside as `<file>.damaged`.

`globalState` holds the last list (`lastList`), pull requests opened by hand (`pinned`) and automatic run counts (`autoRuns`). Agent settings are in `~/.diffline`.

## Security model

Diffline reads pull requests written by other people, and hands them to agents that can read files. The design assumes a pull request may contain text written to steer the agents (prompt injection).

**What agents can do.** Read the review checkout of the head and the run folder (the diff, and the changed files as they were). Claude Code agents can only read, search and list files in those folders. Codex agents can run commands only inside its read-only sandbox. Pi agents can only read, search and list files, but, like Codex's sandbox, not only in those folders.

**What agents can't do.** Write files, change the user's clone (they never see it), run a shell (Claude Code, Pi), use MCP servers, hooks, plugins, Pi's extensions and skills, or the repository's own agent settings (Pi runs outside the checkout, so a repository's `.pi` folder never loads), read the user's other tokens from the environment, or post anything. Their output is only suggestions on the page.

**Before anything is shown.** Validation drops anchors that aren't in the diff and replaces values outside their allowed sets. The page escapes agent text.

**Before anything is posted.** Only the user posts, with **Post now**. `checkPush()` in `src/core/service.ts` checks that every reply and thread resolution is for a thread on this pull request, and refuses a review that contains what looks like a private key, a token, an API key or a URL with a password (`src/core/secrets.ts`). `pushReview()` checks the decision and every comment's file, line and text.

**Settings from a workspace.** The settings that choose which programs run and where clones are (`diffline.claude.path`, `diffline.codex.path`, `diffline.pi.path`, their `extraArgs`, `diffline.clones`) are machine-scoped and restricted in untrusted workspaces, so a repository's `.vscode/settings.json` can't change them.

**Names from outside.** `parseKey()` accepts only owner and repository names GitHub allows, so a pull request key can't reach outside Diffline's folders. `exportFiles()` skips paths that would leave the run folder.

**The webview.** No remote scripts, styles, fonts or images, and scripts only with the page's nonce. Diffline has no telemetry. The review metrics log is a local file that only the user's account can read, and it's never sent anywhere.
