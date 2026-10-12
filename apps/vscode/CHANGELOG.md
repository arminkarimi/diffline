# Changelog

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
