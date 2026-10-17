# Changelog

## 0.4.2

Setup guidance for new installs, and a tidier sidebar.

- **No log button in the sidebar's title bar.** **Diffline: Show Agent Log** is still in the Command Palette.
- **Setup guidance on first run.** Diffline checks for git, the GitHub CLI and its sign-in, and an agent CLI (Claude Code, Codex or Pi) when it starts. **Get started with Diffline**, a walkthrough that opens on install, has the install commands for macOS, Windows and Linux and ticks off each step as Diffline finds it. A notification names what's missing, once per session (**Don't show again** turns it off), and the empty sidebar explains each problem with buttons to install, sign in in a terminal and **Check again**. **Diffline: Check Setup** lists what's found, with versions, and **Diffline: Get Started** reopens the walkthrough. When agents fail because their CLI is missing or signed out, the notification offers **Set up**.

## 0.4.1

A new extension ID for the stores: `diffline.diffline`.

- **The extension ID is now `diffline.diffline`**, from the `diffline` publisher, instead of `arminkarimi.diffline`. Install it from the Marketplace or Open VSX (`ext install diffline.diffline`), or from this release's `.vsix`.
- **Coming from an earlier version?** VS Code sees a different extension, so the old one stays installed until you remove it. The new Diffline waits and offers **Uninstall and Reload**; your reviews, drafts, agent runs, clones and review metrics come along. Pinned pull requests and the "remember" answers for agents on approved pull requests start over. Your agent settings in `~/.diffline` and your `diffline.*` settings don't change.
- **Review links use the new ID**: `vscode://diffline.diffline/open?…`. A link copied before still works with **Open a Pull Request…** from the clipboard.

## 0.4.0

Ready for the VS Code Marketplace and Open VSX, and chapters fold in the sidebar.

- **Ready for the Marketplace and Open VSX.** The README is the listing page, with install steps for VS Code and for Cursor, VSCodium and Windsurf (Open VSX). The `.vsix` from a GitHub release still works.
- **Collapse chapters in the sidebar.** The arrow next to a chapter folds its file list; Alt-click (Option-click on macOS) folds or unfolds every chapter. A folded chapter shows how many hunks are left and is highlighted while you read one of its files.
- **Screenshots in the README**: the agents' briefing, a finding in the diff, the Map and Home.

## 0.3.2

Open a review from a link, and see the pull request before its diff is ready.

- **Open a review from a link.** `vscode://arminkarimi.diffline/open?url=<GitHub pull request link>` or `?pr=owner/name%23123` (`cursor://` in Cursor) opens that review from a browser, a chat or a terminal. A link only opens the review and adds it to the sidebar; it never runs the agents or posts anything, and one Diffline can't read shows a warning. **Diffline: Copy Link to This Review**, in the Command Palette or a sidebar row's menu, copies the link. **Open a Pull Request…** has a shortcut, **⌥⇧⌘P** on macOS and **Ctrl+Shift+Alt+P** on Windows and Linux, and starts with the pull request on your clipboard.
- **The page shows before the diff.** Opening a pull request no longer refreshes the sidebar. The page shows as soon as GitHub answers, with the description, Discussion, Workflow, checks and the agent briefing, and "Loading the changes…" until the diff is ready; then the changes fill in without a reload. Diffline fetches the pull request's head while GitHub answers. On a large pull request the page shows in about 1 s instead of 4 to 8 s; drawing a large diff still takes about 3 s. Small pull requests open in one go.
- **Timings in the log.** **Diffline: Show Agent Log** says how long each open took: GitHub's answer, building the diff, and drawing the page and the changes.

## 0.3.1

A faster sidebar: the list shows without waiting for background searches.

- **The sidebar list shows sooner.** It no longer waits for the background searches: the main search's results show as soon as GitHub answers, every minute as before. **Recently merged or closed** loads after the list, then every 10 minutes and right away when a pull request leaves the list; your teams' requests and **Others you could review** load about 5 seconds after the first list, then every 5 minutes. **Refresh** and changing a `diffline.watch` setting check everything at once, and background groups keep their rows and counts while they reload. `diffline.watch.recentlyClosedDays` now defaults to 3 days instead of 7. On a real account, the first list went from about 4.3 to 3.0 seconds (median of three).

## 0.3.0

See where every pull request stands: your review and what changed since, merged and closed pull requests, and notices while a review is open. Works in Cursor.

- **Cursor**: the READMEs say Diffline works in Cursor and how to install it there (`cursor --install-extension`, or **Extensions: Install from VSIX…**).
- **Your review on every row.** Sidebar rows say how you reviewed a pull request, when, and what changed since: "you approved 2d ago · new commits", "you commented 5h ago · updated since", "re-requested · you approved 3d ago". They also say merged, closed and conflicts. The hover adds your review's commit, the pull request's state and its approvals, and the agents' lines now say "since the agents ran". Rows whose agents reviewed an older commit say `behind` instead of "new commits since".
- **Recently merged or closed.** Pull requests you reviewed or wrote stay listed for 7 days after they're merged or closed, in a new last group. `diffline.watch.recentlyClosedDays` sets the days; 0 turns it off.
- **Where you stand on the review page.** A line under the title says how and when you reviewed and what's new since (commits, comments by others, or a rewritten branch), that you haven't reviewed it yet, or who merged it. The status pill and Home rows show approvals when GitHub's review decision isn't known, and Home rows show your review and draft, conflict, merged and closed badges. The Workflow's Review stage shows your review once, and says Merged or Closed when it's over.
- **Changes while a review is open.** When the open pull request is merged, closed, pushed to or updated on GitHub, a bar on the page offers **Refresh** instead of the page going stale. Posting a review on a merged or closed pull request asks first.
- **New to you** counts every hunk you haven't marked reviewed when you never reviewed the pull request, and says the branch was rewritten after a force-push instead of counting every commit as new. Closing the Welcome back note lasts until the next push to that pull request, not for every pull request. Times say "1 day ago" from 24 hours instead of 48.

## 0.2.1

Copy an agent review as Markdown for another agent, and jumps to findings that land on large pull requests.

- **Copy an agent review for another agent.** **Copy for an agent**, in the review page's agent briefing, copies the agent review as Markdown to paste into Claude Code, Codex, Pi or a chat: all findings, only the open ones, or saved as a file. **Diffline: Copy Agent Review as Markdown** does the same from the command palette or a sidebar row. It keeps the git references: the repository, pull request and branches, the reviewed commit and merge base with commands to check them out, and each finding's path and line in the reviewed commit with a permalink. It also has the summary, the description check, each finding's status, the checked notes, the reading order and the flows as Mermaid charts.
- **Jumping to a finding on a large pull request lands on it.** On pull requests with many files, a jump (from the briefing, Next, a diagram or the guided tour) could end on a different finding: the browser followed whatever was at the top of the screen while the files around it rendered. The target is now held in place until you scroll.

## 0.2.0

Pi as a third agent harness, review metrics, and a prompt before agents run on approved pull requests.

- **Pi as a third harness.** Agents can run on [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), with any model provider you've signed in to with Pi. Pi agents get only Pi's read tools, run offline in an empty folder of their own, and report cost. Choose the model and thinking level with **Choose Pi model…** in **Choose Agent Harnesses…**, `diffline.pi.model` and `diffline.pi.thinking`, or per agent with `model:` in `agents.yml`.
- **Review metrics.** **Diffline: Show Review Metrics**, or **Review metrics** on Home, shows your reviews per week, which agents' findings you use, dismiss or leave open, and what agent runs take and cost, for a period and grouped by agent, harness, model or thinking level. Export the events as JSON or the finding outcomes as CSV. The log behind it stays on your computer, holds finding titles but no code, diffs or comment text, and is never sent anywhere. Turn it off with `diffline.metrics.enabled`; **Diffline: Delete Review Metrics** deletes it.
- **Decisions stay with their findings across re-runs.** A finding's id now comes from its agent and the line it's on, so a decision stays with the same finding when the agents run again, marked "on an earlier run". Before, a decision could attach to a different finding after a re-run. Decisions saved by earlier versions don't say which run they were made on, so their findings show as open again.
- **The review page follows the sidebar.** Changing the sidebar's grouping or sort order updates an open review page's list without a reload.
- **Approved pull requests ask before the agents run.** When someone's latest review approves a pull request and nobody's requests changes, an automatic run on it waits and Diffline asks once per push: **Skip this PR**, **Run anyway** (both remembered for the pull request) or **Always skip approved**. `diffline.agents.approvedPullRequests` is `ask` by default, or `skip` or `run`. Unless it's `run`, Run on an approved pull request asks to confirm, and a run that's going when the pull request gets approved offers **Stop**. Show Review Metrics counts the skipped runs.
- **Install a local build** with `npm run install-local`, which packages the extension and installs it into VS Code.
- **Documentation**: [features](https://github.com/arminkarimi/diffline/blob/main/docs/features.md), [architecture](https://github.com/arminkarimi/diffline/blob/main/docs/architecture.md) and [contributing](https://github.com/arminkarimi/diffline/blob/main/CONTRIBUTING.md) guides.
- **Continuous integration**: every push and pull request runs the typecheck and tests, and builds the `.vsix`.

## 0.1.0

The first release, as a preview.

- **Sidebar of pull requests** through the GitHub CLI: review requested from you, assigned to you, you reviewed, you're a code owner, your teams' requests, your pull requests, watched repositories, ones you opened here, and others you could review. Group by relationship or by repository; sort by risk, newest or recently updated. Each row shows a 0–100 risk score and the agents' status.
- **Home**: the review page's list of pull requests, grouped and sorted like the sidebar.
- **Review agents that run on your computer** through the Claude Code CLI or the Codex CLI, read-only. The guide checks the description against the rules for features and fixes, sets a reading order and draws the flow the change touches. The architecture, correctness, tests and security agents report findings and checked notes. Lines that don't resolve against the diff are dropped.
- **Automatic runs** on pull requests that request your review by name, after a quiet period, at most 5 per pull request, skipping drafts and pull requests over 100 files or 5,000 changed lines. Any pull request can be run by hand. Run asks before repeating a review of an unchanged pull request.
- **One run per pull request across VS Code windows**: one window starts the automatic runs, the others show "running in another window".
- **Choose a harness per agent**, and add or remove agents of your own in `~/.diffline/agents.yml` and `~/.diffline/agents/<id>.md`.
- **Token counts and cost** per agent in the log and the run folder. Codex doesn't report cost.
- **The review page** in a panel: briefing, chapters, Map, description check, Discussion, drafts, finish and posting. Nothing reaches GitHub until you press **Post now**.
- **Fast diffs** from a local clone (your workspace, `diffline.clones`, or Diffline's own partial clone), cached by head commit. Large pull requests stay responsive.
