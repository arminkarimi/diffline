# Architecture

How the VS Code extension works. Paths are relative to `apps/vscode/` unless they start with `packages/`. Modules named `@diffline/core/…` are in `packages/core/src/` (see [Product rules](#product-rules)).

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
                             │                                       │
                             │ @diffline/core (packages/core): the   │
                             │   product rules the service, sidebar  │
                             │   and panel call; pure functions      │
                             └───────────────────────────────────────┘
```

## Source layout

| Folder | What's in it |
| --- | --- |
| `src/extension.ts` | Activation: wires the pieces together, registers commands, reads settings. |
| `src/core/` | Everything that doesn't need VS Code: the service, GitHub, clones, diffs, storage, locks, review metrics, the agent review export, the setup check. Testable with plain Node. |
| `src/agents/` | Agent settings, prompts, output schemas, the harnesses, running a review, and validating its output. |
| `src/vscode/` | The VS Code surfaces: the review panel, the page builder, the sidebar tree. |
| `test/` | Unit tests (`node --test`). `fake-vscode.ts` stands in for the `vscode` module. |
| `test-vscode/` | Code that runs inside a real VS Code: the smoke test (`smoke.cjs`, see [CONTRIBUTING.md](../CONTRIBUTING.md)) and the open timing (`open-timing.cjs`, see [Timing an open](#timing-an-open)). |
| `scripts/` | Developer scripts: GitHub smoke checks, an end-to-end agent run, the page in a browser, the VS Code smoke test, timing an open. |
| `esbuild.mjs` | Bundles `src/extension.ts`, with the `@diffline/core` modules it imports, to `dist/extension.cjs`, and copies `packages/review-ui` into `media/ui`. |
| `packages/core/` | The product rules: grouping, review status, risk, `CODEOWNERS`, row wording, relative times. See [Product rules](#product-rules). |

## Product rules

`packages/core` holds the rules that decide what the extension shows, as pure functions with tests of their own:

| Module | What it decides |
| --- | --- |
| `grouping` | The list's groups (the sidebar, and the page's list): by relationship or by repository, the sort, and Others you could review. |
| `review-status` | The viewer's last review, what changed since (`sinceReview`), approval counts, and how a pull request changed while its page was open (`prChange`). |
| `freshness` | Whether the last agent review is current, behind, or older than activity on GitHub (`reviewFreshness`). |
| `risk` | The risk score, a port of `computeRisk` in `packages/review-ui/app.js`. |
| `codeowners` | Parsing `CODEOWNERS` and matching paths with GitHub's rules. |
| `row-text` | A row's description and hover. |
| `time` | Relative times. |

The rule for what goes there: pure functions over the core's own input types (`packages/core/src/types.ts`), with no GitHub client, storage, UI or editor APIs. The inputs are the smallest shapes the rules read, and each consumer maps its own data into them. The extension doesn't need to map anything: `PrKey`, `ViewerLastReview`, `Risk` and `RiskInput` in `src/core/types.ts` are the core's types, and the richer `PullRequestSummary` and `PrRecord` are passed as they are, so `npm run typecheck` fails if they stop fitting the core's `PullRequestInput` and `PullRequestEntry`. What touches the service's state, such as `DifflineService.riskInput()` or `freshness()`, stays in the extension and calls the core.

The extension depends on `"@diffline/core": "*"`, which npm links to the workspace (`node_modules/@diffline/core` → `packages/core`). The package's `exports` map each subpath (`@diffline/core/grouping`) to its `.ts` file. Node follows the link to the real path, so it strips the types as it does for the extension's own files (it refuses to for files under `node_modules`); TypeScript checks the core's files as part of the extension's program; esbuild bundles them into `dist/extension.cjs`. Nothing from `packages/core` goes into the `.vsix` but the bundle.

## Activation

The extension activates on `onStartupFinished`, and on `onUri` so that a [link](#links) can start it (`package.json`). `activate()` in `src/extension.ts`:

1. Creates the output channel (**Diffline: Show Agent Log**), the `Store` in the extension's global storage, and `Repos`.
2. Creates `DifflineService`, giving it the store, repos, VS Code's `globalState` as its memory, and a function that reads the current settings (`readConfig`).
3. Creates the `ReviewPanel` and the `PullRequestTree` sidebar, the status bar item, and the commands.
4. Writes the default agent settings to `~/.diffline` on first run (`ensureSettings` in `src/agents/settings.ts`).
5. Calls `service.start()`, which cleans up review checkouts left by windows that closed mid-run, refreshes from GitHub, and starts the timers.
6. Checks the setup (`checkSetup` in `src/core/setup.ts`): `git --version`, `gh --version`, `gh auth status` and each harness's `--version`, in parallel, each with a timeout, without a shell. It sets the `diffline.setup.*` context keys (`gitMissing`, `ghMissing`, `ghSignedOut`, `noHarness`, `defaultHarnessMissing`, `incomplete`, `checked`) that the sidebar's welcome view and the **Get started with Diffline** walkthrough (`contributes.walkthroughs`) follow, and shows one notification for what's missing. The notification shows once per set of problems per session, and not at all after **Don't show again** (`diffline.setup.dontShow` in `globalState`). `gh auth status` is only matched, never logged: any working account counts as signed in, and a network failure is unknown rather than signed out. The agent CLIs are checked for being installed only; signing in is left to them.

The check runs again on **Refresh**, **Check again**, after the harness picker closes, when `diffline.harness` or a CLI's path changes, and when the service's `lastErrorKind` becomes or stops being `missing` or `auth`. Checks run one at a time; asks during one share the next.

Settings changes go to `service.configChanged()`. Changes to the agents or clones also trigger a refresh, and changes to what's watched (`diffline.watch.*`) a full one, background searches included (see [Background searches](#background-searches)). Grouping and sorting changes only redraw.

## DifflineService

`src/core/service.ts` is the core. It keeps one record per pull request (`PrRecord`: its summary from GitHub, whether it was opened by hand, the last agent review, the run state) and emits `change` when anything changes. The sidebar and status bar listen to it.

### Polling GitHub

Every `diffline.watch.pollSeconds` (60 by default, at least 15), `refresh()` runs one GraphQL search through `gh` (`searchPullRequests` in `src/core/github.ts`). It covers review requests to you by name, assignments, pull requests you reviewed, your own, watched repositories, and ones you opened by hand. Concurrent refreshes share one request. The list shows as soon as it answers, and `refresh()` resolves then: the other parts of the list run on their own schedule (below). The last list and its group counts are saved in `globalState`, so they show at once on the next start, background groups included.

Each pull request comes back as a summary (`SUMMARY_FRAGMENT`): state, draft, dates (`updatedAt`, `mergedAt`, `closedAt`), head, mergeability, requested reviewers, check counts, and `latestOpinionatedReviews` (each reviewer's latest approval or change request), from which the summary takes `viewerReview` and the approval counts. GitHub stops a query at about 10 seconds, so the list leaves out what's slow to compute: `reviewDecision` isn't fetched, and the viewer's latest review of any state, with its time and commit, is fetched only in the searches the viewer is involved in (review requested, assigned, reviewed, authored, opened by hand, recently closed), through a second fragment, `DifflineMine`, that adds `latestReviews`. Team requests and watched repositories are the large searches, so they stay on the plain fragment: measured on 50 pull requests, `latestReviews` added about 0.6 to 2 seconds to a search. From the viewer's review, `sinceReview()` in `@diffline/core/review-status` derives `newCommits` (the head isn't the commit reviewed) and `updated` (`updatedAt` more than a minute after the review: comments, reviews or the description changed). Where the review isn't fetched, `viewerLastReview` is missing and rows fall back to `viewerReview`.

**Recently merged or closed.** With `diffline.watch.recentlyClosedDays` above 0 (3 by default), `searchClosed()` runs two more searches, up to 20 pull requests each: closed ones you reviewed and, with `diffline.watch.authored`, ones you wrote, closed within those days. They go as a request of their own (`refreshClosed()`), because inside the main search they made it about twice as slow, and the list doesn't wait for it. It's sent after the main search's list shows at start, then every 10 minutes, and right away when a pull request leaves the main search. Such a pull request may have just merged, so it keeps its row until the closed search says whether it merged or closed; then it moves under **Recently merged or closed** or goes. When the search answers, `applyClosed()` merges its rows into the list and the list changes; one the main search also found (pinned, say) keeps both reasons. A failed closed search keeps the last ones found. Their rows go in the last group, **Recently merged or closed**, and their changed files aren't fetched.

Pull requests that leave every search are dropped, unless they were opened by hand or their agents are running.

### Background searches

The slower searches stay out of the main one, so they don't hold up the list. When each runs is set by `REFRESH_TIMING` in `src/core/service.ts`. `refreshExtras()` runs two of them, each best effort:

- **Team requests**, which can run to a hundred pull requests and make GitHub's search slow.
- **Others you could review** (`searchReviewable`): open, ready pull requests in your repositories that aren't yours, weren't requested from you, and aren't approved.

They first load about 5 seconds after the first list shows, so they don't compete with it, then every 5 minutes. After each main search, `runBackground()` starts whatever is due: recently closed ones every 10 minutes, these every 5. The checks happen at each poll, so with a long poll interval a search runs at the first poll after it's due. A manual refresh (the sidebar's **Refresh**, `refresh({ full: true })`) and a change to a `diffline.watch` setting run the main search, recently closed ones, team requests and others at once. Refresh's progress indicator covers the main list; the rest fills in as it answers.

While a background search hasn't answered, its rows and group counts (`totals`, such as "12 of 40") stay as they were, at startup the last session's, so a group doesn't empty and fill again.

After every main search and every load of team requests and others, `followUp()` fills in what open rows need, one pass at a time:

- **Changed files** for open rows the search returned without them, 20 pull requests per query, cached by head commit. The risk score needs them.
- **Code owners** (`markCodeOwned`): your teams and each repository's `CODEOWNERS` (from the default branch, in GitHub's three locations), both cached for an hour. `@diffline/core/codeowners` matches paths with GitHub's rules: the last matching line wins.

After a refresh, `warmUp()` builds the diffs of up to 10 pull requests that request your review or were opened by hand, so opening them is quick.

### Locks across windows

Every VS Code window runs its own extension host. `src/core/locks.ts` keeps locks as files in `<storage>/locks/`, shared by all windows on the machine. A lock holds its owner's process id and a heartbeat (every 30 seconds). It's free once that process is gone or the heartbeat is more than 90 seconds old. `link()` creates a lock with its content in one step and fails if another window got there first.

Two kinds of lock:

- `leader`: the window that holds it starts automatic runs, so all windows share one limit on parallel agents.
- `run-<owner>__<name>__<number>`: held while a pull request's agents run. Other windows show that run as "running in another window".

### Automatic runs

`scheduleAutomaticRuns()` runs after each refresh, in the leader window only, when `diffline.agents.autoRun` is on. A pull request gets a run when it requests your review by name, is open, isn't a draft (with `skipDrafts`), the agents haven't reviewed its head, it's under the automatic-run limit, and it's not over the file or line limit. Too-large pull requests are marked `held` (`hold: "large"`), and approved ones can be held too (below).

A scheduled run waits until the quiet period after the head was first seen has passed. A 10-second timer starts the runs that are due. Automatic run counts per pull request are kept in `globalState`.

**Approved pull requests.** After the size check, `holdApproved()` asks `approvedBy()` (and `isApproved()`) in `src/core/service.ts`, which read the summary's `latestReviews`: each reviewer's latest approval or change request, from `latestOpinionatedReviews` in the list query. A pull request is approved when at least one is `APPROVED` and none is `CHANGES_REQUESTED`; dismissed reviews and comments don't count. GitHub's overall `reviewDecision` isn't fetched, because it slows the search. `diffline.agents.approvedPullRequests` decides what happens: `run` schedules the run as on any pull request, `skip` marks it `held` with `hold: "approved-skip"`, and `ask` (the default) marks it `held` with `hold: "approved-ask"`, unless the choice remembered for the pull request says skip or run. The hold's note shows on the sidebar row and, as `LiveData.runNote`, on the page. Each held head is logged once as a [`skipped` run event](#the-log).

Choices are kept in `globalState` under `approvedRuns`, by lowercase pull request key: `choice` (`skip` or `run`), `asked` (the head last asked about), `logged` (the head whose skipped run was logged) and `at`. `at` is touched at most once a day while the pull request is listed and approved, and entries untouched for 90 days are dropped when the map is saved.

The service emits `approvedHeld` with the pull requests to ask about, once per head. The extension queues them and shows one notification at a time. For one pull request it offers **Skip this PR**, **Run anyway** or **Always skip approved**, which sets the setting to `skip` globally; dismissing it leaves the run held. For several, one notification offers **Review them** (a multi-select quick pick of the ones to run) or **Always skip approved**. Pull requests held while a notification is open wait for it, and ones that changed meanwhile (run by hand, no longer approved, setting changed) are dropped. **Skip this PR** and **Run anyway** call `chooseForApproved()`, which saves the choice, schedules again, and for **Run anyway** starts the run.

After each refresh, `offerStops()` emits `approvedWhileRunning` once per run for a queued or running run in this window whose pull request is approved now but wasn't when the run started (`approvedAtStart`), unless the setting is `run`. The extension offers **Stop** or **Let them finish**; **Stop** cancels the run if it's still the one it asked about. The `diffline.runAgents` command, after its check for an unchanged pull request, asks for a modal confirm on an approved pull request unless the setting is `run`.

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

`ensureCommits()` fetches only what's missing: GitHub's `refs/pull/<n>/head`, and the base commit by id (or the base branch if the server refuses). It checks again once it's its turn on the clone, so a fetch that ran meanwhile, such as `fetchHead()` when a pull request [opens](#the-early-fetch), counts. Fetches never touch the checked-out branch. Git operations on one clone run one at a time.

The managed clone keeps the `gh auth git-credential` helper in its own config, for `github.com` only, because a partial clone downloads file contents later, when a command first needs them. An empty generic helper keeps the user's own credential helpers out. Git runs with `GIT_TERMINAL_PROMPT=0` and SSH in batch mode, so it fails instead of waiting for input (`GIT_ENV` in `src/core/exec.ts`).

**Review checkouts.** `reviewTree()` adds a detached worktree of the head under `<storage>/trees/`, always from the managed clone, never the user's. Folder names start with the window's process id, so `cleanTrees()` can tell which ones are abandoned.

## Building the diff

`buildReviewData()` in `src/core/diff.ts` turns a base and head into `ReviewData` (`src/core/types.ts`), the shape the page reads:

- The three-dot diff (`base...head`) with rename detection, the commits from the merge base to the head, and the files in the head's tree.
- `git blame` from the merge base for files with added lines, so each added line knows its commit. Up to 8 run at once.
- File contents through one `git cat-file --batch` process: each changed file at the head (up to 3,000 lines, for context), npm lockfiles and their `package.json` before and after (for the package summary), and a few repository files the page reads.
- A test hint per source file: its test file, and whether it changed.
- With `since` (the commit of your last review on GitHub), the lines and hunks that are new since then.

`since` is the commit of the viewer's newest submitted review of any state (approved, changes requested, commented or dismissed), when it isn't the head and the clone has it. The page counts "New to you" from it:

- **Never reviewed**: no `since`, and every hunk not marked reviewed counts as new.
- **Branch rewritten** (the reviewed commit isn't among the pull request's commits): the welcome note says so rather than counting commits. While the clone has the commit, the diff against it still marks the lines that differ, so a rebase that didn't touch the pull request's lines marks nothing. Without it there's nothing to compare with, and every hunk not marked reviewed counts as new.

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

`src/vscode/panel.ts` hosts it in one webview panel, for one pull request at a time. `retainContextWhenHidden` keeps the page's state when the tab is hidden. To open a pull request, the panel shows a loading page, then the page in one or two stages (see [Opening a pull request](#opening-a-pull-request)). When it opened from a cached GitHub detail, it then checks GitHub and re-renders only if something changed.

`src/vscode/page.ts` builds the HTML from `index.html`:

- The review data and live data are inlined as `window.REVIEW_DATA` and `window.DIFFLINE_LIVE`, through `scriptJson()`, which escapes `<` and the line separators that would end a script or a string.
- A Content Security Policy allows only the extension's own files, and scripts only with a per-page nonce. The page loads nothing remote.
- `hostShim()` defines `window.DIFFLINE_HOST`, the page's bridge to the extension.

### Host bridge

The page calls `DIFFLINE_HOST.api(method, path, body)`, `reload()`, `open(target)`, `runAgents()`, for the [review metrics](#review-metrics) `metrics(m)`, `metricsReport(o)` and `metricsExport(o)`, and for the [agent review export](#agent-review-export) `agentMarkdown(o)`, and `rendered(o)` for [timing an open](#timing-an-open). Each becomes a message that names the pull request the page was built for, so a save sent while another pull request loads still goes to its own. Request ids are unique per page, so a late answer can't settle a request from a newer page.

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
| `agentMarkdown` | Copies the agent review as Markdown, or saves it through a save dialog (`exportAgentReview`), and returns its size. |
| `rendered` | The page drew a stage (`page` or `changes`) with its own timings, or hit an error (`error`, which is logged). Feeds the open's log line. No answer. |

The extension answers `api`, `metricsReport`, `metricsExport` and `agentMarkdown` messages with `api-result`. It sends `host-view` to switch the page to its list (Home) with fresh groups, or to the review metrics; `host-pr-changed` when the open pull request changed on GitHub (below); and `host-data` with the diff for a page that opened without it ([Two stages](#two-stages)).

### Changes while a page is open

The page isn't rebuilt when GitHub changes, so the reader keeps their place. After each main search and each background search, the service emits `pullRequestChanged` for every row whose state, head or `updatedAt` moved. `extension.ts` passes it to `ReviewPanel.noticeChange()`, which compares the list's summary with what the page on screen was built from (`prChange()` in `@diffline/core/review-status`; a summary not newer than the page never counts) and posts `{ type: "host-pr-changed", key, change }` once per distinct change. `change.kind` is the most important one: `merged`, `closed`, `reopened`, `commits` or `updated`. The page shows one notice bar with **Refresh**, which saves, sends `POST /refresh` and reloads. A notice that the pull request was merged or closed also makes **Post now** ask first. A pull request that leaves every search (merged, and neither reviewed nor written by the viewer) loses its row, so no notice comes for it.

### Sidebar

`src/vscode/tree.ts` draws the sidebar from the service's records. `@diffline/core/grouping` groups and sorts them, and the page's list uses the same groups. Merged and closed pull requests go in **Recently merged or closed**, last, when grouped by relationship, and stay in their repository when grouped by repository. `@diffline/core/row-text` writes a row's description and hover: your review and what changed since, the state, approvals, and the agents' status, said as since the agents ran. `@diffline/core/risk` is a port of `computeRisk` in `packages/review-ui/app.js`, so the sidebar shows the same score as the page. Change both together; `packages/core/test/risk.test.ts` checks they agree.

A row's context value is `pr.<state>` (`idle`, `running` or `elsewhere`), then `.agent` when the pull request has an agent review and `.pinned` when it was opened by hand. `package.json` shows the row's menu entries by matching it.

## Opening a pull request

**Open a Pull Request…** (`diffline.openPullRequest`) and a link both call `openLink()` in `src/extension.ts`: `service.pin(key)`, then `panel.show(key)`. Neither refreshes the list or runs agents. Without a pull request as its argument, the command reads the clipboard with `clipboardPullRequest()` (`src/core/links.ts`), which takes a GitHub pull request link, `owner/name#123` or a Diffline link standing alone, and starts the input box with its GitHub link, selected. Its keybinding (`package.json`) is `cmd+alt+shift+p` on macOS and `ctrl+shift+alt+p` elsewhere, which VS Code's default keybindings leave free.

```
 Extension host                                                        Review page (webview)
 ReviewPanel.show()
   ├─ "Loading acme/web#123…"
   ├─ DifflineService.loadStaged()
   │    ├─ prefetch(): git fetch refs/pull/<n>/head ─┐ side by side
   │    ├─ detail(): gh ──► GitHub ──────────────────┘
   │    ├─ first: the detail, then liveData()
   │    └─ data: loadData() once the detail is in
   ├─ first ─► page with pendingReviewData() ─────────────────────────► "Loading the changes…"
   │                                         ◄────────────────────────  rendered { stage: "page" }
   ├─ data ──► host-data { data, list, groups } ──────────────────────► start("changes"): drawn in place
   │                                         ◄────────────────────────  rendered { stage: "changes" }
   └─ log: Opened acme/web#123 in … ms: the page in … ms (…), the changes in … ms (…)
```

### Links

The URI handler (`registerUriHandler` in `src/extension.ts`) takes `<scheme>://diffline.diffline/open?pr=owner/name%23123` or `?url=<GitHub pull request link>`, where `<scheme>` is the editor's own (`vscode.env.uriScheme`: `vscode`, `vscode-insiders`, `cursor`). VS Code asks the user before it first hands a link from outside the editor to the extension. `parseOpenLink()` in `src/core/links.ts`, a pure module with its own tests, checks the parts VS Code passes, decoded. A link can come from anywhere, so it's strict:

- The path is `/open`, and the query at most 2,000 characters.
- Exactly one of `pr` and `url`.
- `url`: `http` or `https` on `github.com` or `www.github.com`, with no user, password or port, and a path `/<owner>/<name>/pull/<n>`, optionally followed by a tab such as `/files`.
- `pr`: `owner/name#<n>`. An unescaped `#` starts the URI's fragment, so a fragment of digits completes a `pr` that has none.
- Names `parseKey()` accepts, and a number of 1 to 9 digits that isn't 0.

A refused link logs "Didn't open a link: …" and shows a warning that says why and gives both formats. An accepted one logs "Opening owner/name#123 from a link" and calls `openLink()`. `reviewLink()` builds the `?pr=` link that **Copy Link to This Review** (`diffline.copyLink`) copies, with the editor's scheme.

### Without a list refresh

Opening doesn't run a search, and the sidebar's state (refreshing, rate limited, empty) never holds it up. `pin()` adds the pull request to the records opened by hand, and `detail()`, which the open needs anyway, gives a pinned record that no search has listed a summary of its own: `summaryFromDetail()` makes one from the detail (title, state, size, checks, the viewer's review; no changed files) and the service emits `change`, so the row fills in. The next regular refresh replaces it with the search's.

### Two stages

`ReviewPanel.show()` gets two promises from `DifflineService.loadStaged()`: `first`, the detail and everything the page shows around the diff (`liveData()`: the agent review, the saved state, the list), and `data`, the diff (`loadData()`, once the detail says which head and base). `loadStaged()` also starts [the early fetch](#the-early-fetch). When `first` is in:

- A diff that's ready, or gets ready within `DIFF_GRACE_MS` (150 ms), goes in the page, which opens in one stage.
- Otherwise, and always for a pull request with at least `STAGE_LINES` (2,000) changed lines (GitHub's additions plus deletions), the page is built with `pendingReviewData()` from `src/vscode/page.ts`: no files, `pending: true`, and the head and base from the detail. Drawing a large diff takes seconds, and the rest of the page needn't wait for it.

Once that page says it drew (`rendered`, stage `page`) and the diff is built, the panel fetches a fresh list and posts `{ type: "host-data", data, list, groups }`. If the diff fails, it logs "Couldn't load the changes of owner/name#123: <reason>" and posts `{ type: "host-data", error }`.

In `packages/review-ui/app.js`, each start of the page runs `boot()` with an `AbortController` signal that owns its listeners and timers. `host-data` with the diff sets `window.REVIEW_DATA` and calls `start("changes")`, which ends the boot before and boots again in the same document: the review state object carries over, the tab is in the address's hash, and the scroll position is put back. Nothing reloads, and nothing saved is lost. With an error, the page shows "The changes didn't load" with the reason and **Try again**, which refreshes like the notice bar's **Refresh**.

While the page waits for the diff (`PENDING` in `app.js`):

- The Changes and Map tabs show a "Loading the changes…" card, Changes with the briefing above it. The header shows GitHub's file count, additions and deletions, and no risk score.
- The briefing counts the findings without listing them, since they sit on diff lines. The Discussion tab counts the threads on lines without listing them.
- Actions that need the diff (`NEEDS_DIFF`: Finish review, Next, Guide, Comments, the file palette, jumps to findings and the briefing, the tour, the risk breakdown) show a toast instead. Of the keys, only 1 to 4 and `?` work.
- `save()` leaves the reviewed marks, draft places and reading order as they were saved.

### The early fetch

`loadStaged()` starts `DifflineService.prefetch()` beside the detail query. It resolves the clone (a repository's first open clones it here) and, unless the head already known from an earlier detail or the list is in the clone, calls `Repos.fetchHead()`. That fetches `refs/pull/<n>/head` under the clone's lock, into the same ref in Diffline's own clone and into `FETCH_HEAD` in the user's, and logs "Fetching pull request #123's head early into <clone>". Correctness doesn't depend on it: `ensureCommits()` still checks the exact head and base from the detail, and since it checks again once it holds the clone's lock, it finds what the early fetch brought instead of fetching it again. A failed early fetch is logged and ignored. On a small pull request whose head wasn't in the clone, the diff was ready about 0.5 s sooner.

### Timing an open

Each page knows which load of the panel built it (`hostShim(key, load)`), so a report from an older page doesn't count. After each stage the page lays itself out and calls `DIFFLINE_HOST.rendered({ stage, ms })` with its `performance.now()` marks: when it started (for the first stage, once the HTML and its inline data were parsed) and how long building its model, drawing and laying out took. It reports right after layout rather than after the next frame, so a hidden panel still counts. The panel waits up to 60 seconds for each stage, then writes "?" for its time. `openedLine()` in `src/vscode/panel.ts` writes the log line:

```
Opened acme/web#123 in 1210 ms (data 1150 ms, page 20 ms, rendered 40 ms)
Opened acme/web#123 in 4210 ms: the page in 980 ms (detail 870 ms, page 20 ms, rendered 90 ms), the changes in 4210 ms (diff 1900 ms, rendered 2300 ms)
Opened acme/web#123: the page in 980 ms (detail 870 ms, page 20 ms, rendered 90 ms); the changes didn't load
```

`data`, `detail`, `diff`, "the page in" and "the changes in" count from the open; `page` and `rendered` are durations. The page's total can include up to 150 ms waiting for a diff that was nearly ready. " (from cache)" ends the line when the open used a detail fetched earlier. A page error logs "The page for acme/web#123 hit an error: <message>". `ReviewPanel.timings` keeps the last 20 opens for the measuring script.

`scripts/open-timing.sh` measures opens in a real VS Code. It starts one with a throwaway profile that lists only the pull request in `DIFFLINE_SMOKE_PR` and runs no agents, and `test-vscode/open-timing.cjs` opens that pull request by link: once cold, then `DIFFLINE_TIMING_RUNS` times (2 by default) with the diff cached on disk, and as many with the detail cached too, printing each open's timing. `DIFFLINE_TIMING_SEED` copies a bare clone in as Diffline's own, so nothing clones, and `DIFFLINE_TIMING_LOG=1` adds the extension's fetch and build lines with the repository's name left out. Like the smoke test, it runs on macOS.

Measured on a large pull request (about 30 files and 130,000 diff lines), the page shows in about 1 s instead of 4 to 8 s, and drawing the changes takes about 3 s after the diff is built: most of each open is now in the webview (about 0.5 s moving and parsing the page data, the rest laying out the Changes HTML).

## Agent review export

**Copy for an agent** on the page and **Diffline: Copy Agent Review as Markdown** (`diffline.copyAgentReview`) turn a pull request's agent review into Markdown for another agent. The extension builds it, because it has the agent file, the diff and the saved review state; the page only asks.

`src/core/review-markdown.ts` is a pure module with its own tests. `reviewMarkdown()` takes the pull request, the agent file, the review data and the review state, and returns the Markdown with the number of findings in it and in the review. Its sections, in order, leaving out empty ones: a title, a note for the receiving agent, Git references (repository, pull request, branches, the reviewed commit and merge base, and the commands to fetch and check it out), Summary, Description check, Findings, Checked and fine, Reading order, Flows (each diagram as a Mermaid `flowchart`, labels escaped by `mermaidText()`), and a footer with the version and date.

- **Which diff.** Line numbers are in the commit the agents reviewed (the agent file's `commit`), not the pull request's current head. `DifflineService.agentReviewMarkdown()` uses the current diff when the head hasn't moved, else review data cached for that commit (`Store.findReviewData()`), else builds it from the clone and caches it. Without that commit, no diff is passed, and findings keep their path and the agent's quote without a line number. When the head moved on, the Git references name it and say everything refers to the reviewed commit.
- **Lines.** `resolveLine()` finds a `path` and `match` the way the page does, with `AnchorIndex`'s repairs as a fallback. Added and context lines get their number in the reviewed commit and a permalink at it; removed lines get their number at the merge base and a permalink there, marked "(removed line, base side)".
- **Statuses.** `findingStatus()` reads the saved state with the same rule as `decided()`: open, added to my review (its draft is still pending), posted, or dismissed with the reason. Open only (`openOnly`) leaves out dismissed findings and those in the review.
- **Safety.** Agent text stays Markdown, but `safeMarkdown()` demotes headings below the finding's, and `codeBlock()` and `code()` use fences longer than any run of backticks inside.

The page calls `DIFFLINE_HOST.agentMarkdown({ mode })` with `copy`, `open` (open findings only) or `save`, after saving a state change that's still waiting, since the extension reads the saved decisions. `exportAgentReview()` in `src/vscode/panel.ts` copies with `vscode.env.clipboard`, or writes the file the save dialog picks at mode 0600, and answers with the character and finding counts for the page's toast. The command takes the sidebar row's pull request or the open review's, else offers a quick pick of the pull requests with an agent review; it copies every finding, and its notification offers **Save as Markdown…**. The Markdown goes nowhere else.

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

Ids used to be positional (`f1`, `f2`, …), so an old decision on one can't be tied to a finding after a re-run. A decision on an id like that counts only when it records the current run, which decisions from before this change don't: their findings show as open. `decided()` in `src/core/types.ts` and `validDecision` in `packages/review-ui/app.js` apply the same rule. A draft whose `fromFinding` is such an id loses the link.

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
| `run` | `skipped` | An automatic run that didn't start: `reason` (`approved`), `trigger` (`auto`), `agents` (empty). `run` is `null`. |

When each is written: `added` when a finding goes into the review (**Add to my review**, or a composer draft from it), `dismissed` with its reason, `copied`, `undone` when a decision is taken back, and, when a review posts, `posted` for each draft from a finding and `left-open` for each finding of the current run still undecided, then one `review` event. Description rules log `asked`, `skipped` and `undone`. `runAgents()` writes a `run` event after every run that got past its checks, however it ends. Scheduling writes a `skipped` run event (`recordSkippedRun()`) once per pull request and head when it holds an automatic run because the pull request is approved.

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
- **Agent runs**: per group, runs, failures by kind, median duration, tokens, cost, and cost per useful finding: the cost of the runs that reported one, over the useful findings from those runs (matched by pull request, run and agent). Codex reports no cost, so its runs count as missing. `skipped` run events aren't runs: they're counted apart as `skippedApproved`, which the page shows as "Skipped (approved)".

The page draws the result. **Export** asks for `metricsExport({ format, days })`: `exportText()` returns the period's raw events as JSON (`{ v, exportedAt, since, events }`) or one CSV row per finding outcome (date, pull request, finding id, agent, harness, model, thinking, severity, confidence, outcome, reason, edit), with cells that start with `=`, `+`, `-` or `@` prefixed so spreadsheets don't run them. The panel writes the file where the reviewer picks, at mode 0600.

## Storage

The extension's global storage (on macOS, `~/Library/Application Support/Code/User/globalStorage/diffline.diffline/`) is created readable by the user's account only. `<slug>` is `<owner>__<name>__<number>`.

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

`globalState` holds the last list and its group counts (`lastList`, `lastTotals`), pull requests opened by hand (`pinned`), automatic run counts (`autoRuns`) and the choices about approved pull requests (`approvedRuns`, see [Automatic runs](#automatic-runs)). Agent settings are in `~/.diffline`.

## Security model

Diffline reads pull requests written by other people, and hands them to agents that can read files. The design assumes a pull request may contain text written to steer the agents (prompt injection).

**What agents can do.** Read the review checkout of the head and the run folder (the diff, and the changed files as they were). Claude Code agents can only read, search and list files in those folders. Codex agents can run commands only inside its read-only sandbox. Pi agents can only read, search and list files, but, like Codex's sandbox, not only in those folders.

**What agents can't do.** Write files, change the user's clone (they never see it), run a shell (Claude Code, Pi), use MCP servers, hooks, plugins, Pi's extensions and skills, or the repository's own agent settings (Pi runs outside the checkout, so a repository's `.pi` folder never loads), read the user's other tokens from the environment, or post anything. Their output is only suggestions on the page.

**Before anything is shown.** Validation drops anchors that aren't in the diff and replaces values outside their allowed sets. The page escapes agent text.

**Before anything is posted.** Only the user posts, with **Post now**. `checkPush()` in `src/core/service.ts` checks that every reply and thread resolution is for a thread on this pull request, and refuses a review that contains what looks like a private key, a token, an API key or a URL with a password (`src/core/secrets.ts`). `pushReview()` checks the decision and every comment's file, line and text.

**Settings from a workspace.** The settings that choose which programs run and where clones are (`diffline.claude.path`, `diffline.codex.path`, `diffline.pi.path`, their `extraArgs`, `diffline.clones`) are machine-scoped and restricted in untrusted workspaces, so a repository's `.vscode/settings.json` can't change them.

**Names from outside.** `parseKey()` accepts only owner and repository names GitHub allows, so a pull request key can't reach outside Diffline's folders. `exportFiles()` skips paths that would leave the run folder.

**The webview.** No remote scripts, styles, fonts or images, and scripts only with the page's nonce. Diffline has no telemetry. The review metrics log is a local file that only the user's account can read, and it's never sent anywhere.
