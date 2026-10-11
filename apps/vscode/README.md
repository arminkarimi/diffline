# Diffline for VS Code

Review GitHub pull requests in VS Code with agents that run on your computer. When a pull request asks for your review, Diffline's agents check its description, set a reading order, draw the flow it changes and look for problems. You review in the Diffline page, add comments or adopt the agents' wording, and post your review to GitHub. Nothing reaches GitHub until you press **Post now**.

This is a preview. Expect rough edges, and check the log (**Diffline: Show Agent Log**) when something looks wrong.

Every feature is described in [Features](https://github.com/arminkarimi/diffline/blob/main/docs/features.md).

## What you need

- **VS Code** 1.95 or later.
- **GitHub CLI** ([cli.github.com](https://cli.github.com)), signed in: `gh auth login`. Diffline reads pull requests and posts reviews through it.
- **git**.
- **An agent harness**: the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) or the [Codex CLI](https://github.com/openai/codex) (`codex`), installed and signed in. Use one or both: **Diffline: Choose Agent Harnesses…** sets the default and, if you like, a different one per agent.

## Install

Diffline isn't on the Marketplace yet. Install the `.vsix` file, from a [release](https://github.com/arminkarimi/diffline/releases) or built with `npm run package` (see [Development](#development)):

- In VS Code: open the Extensions view, then **…** → **Install from VSIX…**, and pick `diffline-0.1.0.vsix`.
- Or in a terminal: `code --install-extension diffline-0.1.0.vsix`.

Reload the window if VS Code asks. To update, install the newer `.vsix` the same way. To remove Diffline, uninstall it from the Extensions view; `~/.diffline` stays until you delete it.

## First run

1. Click the Diffline icon in the activity bar. The sidebar lists your open pull requests within a few seconds. If it stays empty, see [Troubleshooting](#troubleshooting).
2. Diffline writes its default agent settings to `~/.diffline` and says so. **Customize** opens them; you can leave them as they are.
3. Run **Diffline: Choose Agent Harnesses…**. It shows which CLIs it found and their versions. Pick Claude Code or Codex as the default.
4. Pick a pull request to open its review. Press Run (the sparkle button on its row) to start the agents on it.

Automatic runs are on by default. About two minutes after Diffline first starts, the agents begin on every open pull request that requests your review by name. If you'd rather start each run yourself, turn off `diffline.agents.autoRun` in those two minutes, or before you install.

## How it works

1. **The sidebar** (the Diffline icon in the activity bar) lists open pull requests. By default they're grouped by how they concern you, each pull request in the first group it fits:

   | Group | What's in it |
   |---|---|
   | Review requested from you | Your review is requested by name |
   | Assigned to you | You're an assignee |
   | You reviewed | Still open, not yours, and you've reviewed it. GitHub takes you off the requested reviewers once you review, so this is where a pull request goes after your review until it merges, or until your review is requested again. Rows say "you approved" or "you requested changes" |
   | You're a code owner | It changes files that you or one of your teams own in the repository's `CODEOWNERS` (read from the default branch) |
   | Your teams' requests | A review is requested from one of your teams. Collapsed when it's long |
   | Your pull requests | You opened it |
   | Watched | Every open pull request in the repositories in `diffline.watch.repositories` |
   | Opened here | Ones you opened with **Open Pull Request…** |
   | Others you could review | At the bottom: the top 10 open, ready pull requests in your repositories that aren't yours, weren't requested from you or your teams, and aren't approved yet. Your repositories are the ones in the groups above |

   **Home**, the house button in the title bar, opens the review page on its list of pull requests, with the same groups, order and **Others you could review** as the sidebar. With a review already open, the page switches to its list at once. Pick a row to open that review; the back arrow returns to the list.

   The title bar also has two buttons. **Group** switches between this and one group per repository, where each row says why it's listed (requested, assigned, code owner, team, yours, watched). **Sort** orders each group by risk (riskiest first, the default), newest created, or most recently updated. The view's subtitle shows the current choice. Each row shows the risk score (the same 0–100 score as the page), the agent status, and a Run or Stop button. Hover for the risk factors and the last agent review. The icon's color is the risk; its shape says whether the agents reviewed the pull request:

   | Icon | Meaning | Row text |
   |---|---|---|
   | filled check | The agents reviewed the latest commit | `✓ agents: 3 findings` |
   | outline check | The agents reviewed an older commit; commits landed since | `agents: 3 findings, new commits since` |
   | empty circle | No agent review yet | |
   | spinner | Agents are running, here or in another window | `agents 2/5`, `agents running in another window` |

2. **Watching GitHub.** Diffline checks GitHub every minute with one GraphQL search through `gh`: review requests, assignments, pull requests you've reviewed, your pull requests, watched repositories. The last list shows at startup while it refreshes. Once the list shows, a second request in the background finds the pull requests you could review, loads changed files for the risk scores (cached by commit, so only new pushes are fetched again), and checks `CODEOWNERS` against your teams (both cached for an hour).
3. **Agents run automatically** only on pull requests that request your review by name (not team requests, assignments, code-owner matches or others you could review: press Run on those), when they open and after each push: a 2-minute quiet period lets a burst of pushes count once, drafts are skipped, and each pull request gets at most 5 automatic runs. Pull requests over 100 files or 5,000 changed lines wait for you to press Run. Any pull request can be run by hand from the sidebar or the review page. When there's something new since the last agent review (new commits, or a description, comment or review update on GitHub), Run starts right away. When the agents already reviewed the latest commit and nothing has changed since, Run asks before reviewing again, since a second run would mostly repeat the first. Automatic runs only follow new commits. When a run finishes, Diffline tells you and can reload the review. With several VS Code windows open, one window starts the automatic runs and a pull request's agents run in one window at a time; the others show the run as "running in another window".
4. **The agents** run in parallel: the guide (description check, chapters, flow diagram) and the reviewers, by default architecture, correctness, tests and security, plus any you add. Each runs the harness headless in a checkout of the pull request's head that Diffline makes for the run (and deletes after), with the changed files as they were before beside it. Claude Code agents get file tools only (read, search, list), limited to those folders: no shell, no repository settings or hooks, no MCP servers. Codex agents run in its read-only sandbox. Both get a minimal environment, without your other tokens and keys. Every line an agent points at is checked against the diff; anchors that don't resolve are dropped rather than posted on the wrong line.
5. **The review page** is the Diffline page from `packages/review-ui`, in a VS Code panel: the briefing, chapters, Map, description check, Discussion, drafts, the finish sheet and posting. Its list (Home, or the back arrow) shows the same pull requests in the same groups and order as the sidebar.

## Fast by design

- Diffs are built from a local clone, not fetched file by file (about 0.2 s for a 30-file pull request), and cached by head commit.
- Commits are only fetched when missing. Diffline uses the clone in your workspace or the `diffline.clones` setting, and otherwise keeps its own partial clone (no file contents until needed).
- Pull requests that ask for your review are prepared in the background, so opening one is mostly the GitHub detail request (about 1 s).
- Large pull requests (over 40 files or 4,000 diff lines) stay responsive: files off screen skip layout and paint until you scroll near them, and jumps to a finding, draft or flow step land exactly. A 383-file pull request opens in about 1.2 s instead of 3, and a relayout takes milliseconds instead of a second.

## Customizing the agents

On first run Diffline writes its defaults to `~/.diffline`:

- `agents.yml` lists the agents, in the order they run. Each has a `name` (what the page calls it), a `focus` (one line on what it looks at, which the agent also reads), and its options: whether it's enabled, how many findings it may report, minimum confidence, files to skip, `runs-when` patterns, and a harness and model. The file also says what each severity means and holds the description rules for features and fixes.
- `agents/<id>.md` holds each agent's instructions, under **Look for** and **Leave alone**. HTML comments are notes for you; agents don't see them.

Diffline ships five agents. The **guide** is special: it checks the description, sets the reading order and draws the flow, and the lede (the briefing's opening line) runs on its harness. The architecture, correctness, test and security agents are reviewers: they report findings and checked notes.

**Your own agents.** **Diffline: New Agent…** (or **New agent…** in **Customize Agents…**) asks for a name and a focus, adds the agent to `agents.yml`, and opens `agents/<id>.md` for its instructions. It's a reviewer like the built-in ones, with the same options, and it runs once its file has instructions. You can also add a block to `agents.yml` and the file by hand. **Remove an Agent…** takes one out of `agents.yml` (its instructions stay); any agent but the guide can go, and **Reset Agent Settings** brings back the built-in ones. Ids are 2 to 32 lowercase letters, digits or dashes. Problems, such as a bad id or an agent without instructions, are listed in **Diffline: Show Agent Log**.

Agents run lean. Claude Code agents start without your MCP servers, plugins' skills and slash commands. Codex agents start with `--ignore-user-config`, so your `~/.codex/config.toml` (MCP servers, plugins, hooks, the default model and effort, the service tier) doesn't apply, and connectors, plugins, memories, sub-agents, goals, image generation and browser use are off. Set the Codex model in `diffline.codex.model` and anything else in `diffline.codex.extraArgs`, such as `["-c", "model_reasoning_effort=\"high\""]`.

Open the files with **Diffline: Customize Agents…**, and restore the defaults with **Diffline: Reset Agent Settings**. Changes apply to the next run.

## What it costs

Diffline adds no charges of its own. The agents use your Claude Code or Codex account, so their usage counts against your plan's limits or, with an API key, is billed to it.

- One run starts one CLI process per enabled agent (five by default), plus a short one for the briefing's opening line. Each reads the diff and the files it needs.
- Automatic runs follow each push to pull requests that request your review, at most 5 per pull request. Large pull requests wait for you to press Run.
- `diffline.claude.model` defaults to `sonnet`. Larger models cost more.
- **Diffline: Show Agent Log** shows each run's tokens and, for Claude Code, its cost. Codex doesn't report cost.

To spend less: turn off `diffline.agents.autoRun`, lower `diffline.agents.maxAutomaticRuns`, turn agents off in `agents.yml`, or list only the ones you want in `diffline.agents.enabled`.

## Privacy

What stays on your computer:

- Your drafts, reviewed marks and decisions, agent results, cached diffs and run logs, in VS Code's global storage for the extension. Run folders keep each agent's prompt, raw output and log, and `usage.json` with each agent's harness, model, time, tokens and (for Claude Code) cost.
- Agent settings in `~/.diffline`.
- Clones: the one in your workspace, the ones in `diffline.clones`, or Diffline's own partial clone in its global storage.

What leaves it:

- **GitHub**, through `gh` and `git`: Diffline reads pull requests, reviews, comments, checks, changed files, `CODEOWNERS` and your teams, and fetches commits. It writes to GitHub only when you press **Post now**: one review with your comments and decision, then your replies and the thread resolutions you queued. **Finish review → Preview what's sent** shows the exact requests first.
- **Your model provider**, through the agent CLI: the agents send the diff, the pull request's title, description and review threads, and the files they read to Anthropic (Claude Code) or OpenAI (Codex), under your account's terms. Agents only read: a checkout of the pull request made for the run, never your own clone.
- **Nothing else.** The review page uses VS Code's fonts and loads no remote images, fonts or scripts, and Diffline has no telemetry.

**Pull requests can contain text written to steer the agents** (prompt injection). Claude Code agents can't run commands or read outside the run's folders; Codex agents run commands only inside its read-only sandbox. Neither can change files, and their findings are only suggestions: nothing reaches GitHub unless you add it to your review and post it. Before posting, Diffline refuses a review that contains what looks like a private key or token. Settings that choose which programs run (`diffline.claude.path`, `diffline.codex.path`, their `extraArgs`, `diffline.clones`) are user settings only, so a repository's `.vscode/settings.json` can't change them. The [architecture notes](https://github.com/arminkarimi/diffline/blob/main/docs/architecture.md#security-model) describe the security model in full.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `diffline.harness` | `claude` | The default harness, `claude` or `codex`; an agent can set its own in `agents.yml` |
| `diffline.claude.path` | `claude` | The Claude Code CLI, or the full path to it |
| `diffline.claude.model` | `sonnet` | Model for agents on Claude Code; empty uses the CLI's default |
| `diffline.claude.extraArgs` | none | Extra arguments for every `claude` run |
| `diffline.codex.path` | `codex` | The Codex CLI, or the full path to it |
| `diffline.codex.model` | empty | Model for agents on Codex; empty uses the CLI's default |
| `diffline.codex.extraArgs` | none | Extra arguments for every `codex exec` run |
| `diffline.agents.autoRun` | on | Run automatically on pull requests that request your review by name |
| `diffline.agents.enabled` | empty | Run only these agent ids; empty runs every agent `agents.yml` turns on |
| `diffline.agents.maxParallel` | 5 | Agent processes at once |
| `diffline.agents.quietPeriodSeconds` | 120 | Wait after a push before an automatic run |
| `diffline.agents.maxAutomaticRuns` | 5 | Automatic runs per pull request |
| `diffline.agents.skipDrafts` | on | No automatic runs on drafts |
| `diffline.agents.autoRunMaxFiles` / `autoRunMaxLines` | 100 / 5000 | Larger pull requests wait for you to press Run |
| `diffline.agents.timeoutMinutes` | 20 | Stop an agent that runs longer |
| `diffline.watch.reviewRequested` | on | Watch pull requests that request your review by name |
| `diffline.watch.teamRequests` | on | List team review requests |
| `diffline.watch.assigned` | on | List pull requests assigned to you |
| `diffline.watch.reviewed` | on | List open pull requests you've reviewed |
| `diffline.watch.codeOwners` | on | Find pull requests that change files you or your teams own |
| `diffline.watch.authored` | on | List pull requests you opened |
| `diffline.watch.othersToReview` | on | Show **Others you could review** |
| `diffline.watch.repositories` | none | Also list every open pull request in these repositories (`owner/name`) |
| `diffline.watch.pollSeconds` | 60 | How often to check GitHub, at least 15 |
| `diffline.sidebar.groupBy` | `relationship` | `relationship` or `repository` |
| `diffline.sidebar.sortBy` | `risk` | `risk`, `created` or `updated` |
| `diffline.sidebar.othersLimit` | 10 | How many to show under **Others you could review**; 0 hides it |
| `diffline.clones` | none | `"owner/name": "/path/to/clone"` |

## Troubleshooting

- **The sidebar is empty, or the status bar shows a warning.** Run `gh auth status` in a terminal, and `gh auth login` if you're signed out. Hover the warning for GitHub's error. Team requests and code-owner matches need the `read:org` scope: `gh auth refresh -s read:org`.
- **"The GitHub CLI (gh) isn't installed or isn't on the PATH."** Install it, then restart VS Code.
- **An agent harness isn't found, or agents fail with a sign-in error.** **Diffline: Choose Agent Harnesses…** shows "not found" next to a CLI it can't run. Set `diffline.claude.path` or `diffline.codex.path` to the full path (`which claude`, `which codex`). Run the CLI once in a terminal to sign in. A missing or signed-out CLI fails only the agents that use it.
- **Agents fail or find nothing.** **Diffline: Show Agent Log** has each run's agents, errors, tokens and cost. Problems in `agents.yml`, like a bad id or an agent without instructions, are listed there too. For more, each run keeps every agent's prompt, raw output and log in the extension's global storage, under `runs/` (on macOS, `~/Library/Application Support/Code/User/globalStorage/arminkarimi.diffline/runs`).
- **Agents say they're running in another window.** Another VS Code window is running them. Stop them there, or wait.
- **Installing from a terminal prints `DeprecationWarning: url.parse() …`.** That comes from VS Code's own command-line tool, not Diffline. It's harmless; the install still works.
- **Remote windows (SSH, WSL, containers).** Diffline runs where the workspace is, so `gh`, `git` and the agent CLI need to be installed and signed in there.

## Development

From the repository root:

```sh
npm install
npm run build       # bundles to dist/ and copies packages/review-ui into media/ui
npm test            # unit tests (Node 26 runs them as TypeScript)
npm run typecheck
npm run package     # writes apps/vscode/diffline-<version>.vsix
```

Open `apps/vscode` in VS Code and press F5 to run the extension. From `apps/vscode`, with a pull request your `gh` account can read:

```sh
node scripts/smoke-github.ts owner/name#123                          # read-only GitHub checks
node scripts/e2e-agents.ts owner/name#123 --clone /path/to/clone     # run the agents end to end (costs money)
DIFFLINE_SMOKE_PR=owner/name#123 ./scripts/vscode-smoke.sh           # an isolated VS Code opens it and checks the basics
```

[CONTRIBUTING.md](https://github.com/arminkarimi/diffline/blob/main/CONTRIBUTING.md) has the details, and [docs/architecture.md](https://github.com/arminkarimi/diffline/blob/main/docs/architecture.md) explains how the extension works.

Not supported yet: comments that span several lines, file-level comments, and editing or deleting posted comments.

## License

MIT. The full text is in the LICENSE file that comes with the extension.
