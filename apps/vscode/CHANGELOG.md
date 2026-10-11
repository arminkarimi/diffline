# Changelog

## Unreleased

- **The review page follows the sidebar.** Changing the sidebar's grouping or sort order updates an open review page's list without a reload.
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
