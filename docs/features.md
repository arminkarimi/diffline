# Features

What Diffline does today, in the VS Code extension. Settings and setup are in the [extension's README](../apps/vscode/README.md).

- [Read changes in order](#read-changes-in-order)
- [The description check](#the-description-check)
- [Agents review first](#agents-review-first)
- [Your own agents](#your-own-agents)
- [The Map](#the-map)
- [Risk score](#risk-score)
- [Pick up where you left off](#pick-up-where-you-left-off)
- [Workflow](#workflow)
- [Less noise](#less-noise)
- [The sidebar and Home](#the-sidebar-and-home)
- [Automatic runs](#automatic-runs)
- [Posting to GitHub](#posting-to-github)
- [Keyboard](#keyboard)

## Read changes in order

The guide agent groups the changed files into chapters and puts them in reading order. It works from the description's list of what changed, the commits and the import graph, so files that define things come before the files that use them. Each chapter says in one sentence what it does, and where it came from: the description, a commit, or the guide's own grouping. Housekeeping a reviewer can skim, such as configuration, is marked quiet.

Every changed file is in exactly one chapter. Files the guide leaves out go into a last chapter, "Everything else".

You can regroup at any time: **Chapters**, **Commits** (one chapter per commit, in the order they were pushed) or **Folders**. Without a guide run, the page groups files automatically by layer (data and schema, core logic, interface, tests, then configuration and docs), each in dependency order.

## The description check

Before you read the code, the guide checks the pull request's description against the rules for its kind of change.

- **A new feature** says what changes and why, has a supporting diagram (the architecture or a sequence), says how it rolls out, names the other pull requests it depends on (especially in other repositories, which GitHub doesn't link), and lists its risks and what's out of scope.
- **A bug fix or improvement** brings the usage, metrics or log data that show it was needed, a diagram, rollout notes and its dependencies.

The guide decides the kind from the title, labels and changes, and says why. For each rule it marks the description covered, partly covered or missing. It quotes the text that covers a rule and compares the description with the diff, so a flag the rollout notes skip counts as missing. If a quote is no longer in the description, the page says the description changed since the check.

Each gap comes with a question for the author. **Ask in my review** adds the question to your review summary, and it posts with your review. **Skip** sets it aside with a reason. On your own pull request, the check lists what reviewers will ask, so you can fill it in first. The check never blocks anything.

The rules are yours to change: `description-rules` in `~/.diffline/agents.yml` sets which rules each kind needs.

## Agents review first

Besides the guide, four reviewer agents read the diff: architecture, correctness, tests and security. They run in parallel, each in its own CLI process.

The **briefing** opens the review. Its first line, written once every finding is known, says whether the change looks sound and where to start. Below it: what the agents checked and found fine, the description gaps, and the findings.

Each **finding** sits inline on the line it's about. It has a severity (high, medium, low), a confidence (High confidence, Worth asking, Minor), the reasoning behind it, the lines that lead to the problem, and a suggested fix. For each one you decide:

- **Add to my review.** The draft comment starts reworded in a reviewer's voice. Switch it to **As written** to post the agent's words unchanged, or edit it.
- **Copy.** Takes the finding's exact text, to paste anywhere.
- **Dismiss**, with a reason: not a problem, intended, or out of scope.

Agents never approve or block, and the author only sees what you post. Approve stays unavailable until every high finding has a decision.

Every line an agent points at is checked against the diff. Small mistakes, such as a wrong path or different whitespace, are repaired. Anchors that don't resolve to a line of the diff are dropped, rather than posted on the wrong line.

## Your own agents

The agents' settings live in `~/.diffline`, written with defaults on first run:

- `agents.yml` lists the agents in the order they run, with each one's name, focus, and options: whether it's on, how many findings it may report, the lowest confidence it reports, files to skip, `runs-when` patterns, and a harness and model. It also says what each severity means, and holds the description rules.
- `agents/<id>.md` holds each agent's instructions, under **Look for** and **Leave alone**.

**Diffline: New Agent…** asks for a name and a focus, adds the agent, and opens its instructions file. It runs once that file has instructions. **Remove an Agent…** takes one out (its instructions stay), and **Reset Agent Settings** brings back the built-in ones.

**Per-agent harness.** Each agent runs on Claude Code or Codex. **Diffline: Choose Agent Harnesses…** shows which CLIs are installed and their versions, sets the default, and sets a harness for any single agent. A model can be set per agent too.

## The Map

The Map tab shows the change as a diagram the guide draws from the diff. Each box is one step of how the code runs, marked new, changed, removed or unchanged, and linked to the exact lines it stands for. Boxes can be the actor that starts the flow, a step, or a data store.

- **Flow cards** pick the flow to show. A change with two separate flows gets two.
- **Diff**, **Before** and **After** flip between the old and new flow. A changed step can say how it read before.
- Agent findings sit on the box where they happen. Each box shows whether its code is reviewed and whether it's new to you.
- Pick a box to read its code beside the map.
- **Follow the flow** walks you through the diff in the order the code runs, marking each step's lines. Your reviewed marks stay on hunks.
- The map says how much of the diff its boxes cover and which files they leave out.

The **Files** view needs no agent: chapters are rows, and lines follow the import graph.

## Risk score

Every pull request carries a risk score from 0 to 100, in the sidebar, in the page's list and on the review. It adds up:

- sensitive code the change touches: sign-in and sessions, secrets and encryption, payments, data migrations, public API;
- agent findings still in play;
- its size and how many files it spreads across;
- source files changed without tests, and test files that weren't updated;
- failing or running checks.

The breakdown shows what each part adds and which files are riskiest. Dismissed findings stop counting. Findings you added to your review count until they're fixed.

## Pick up where you left off

You mark hunks as reviewed. Marks are tied to each hunk's content, so they survive new pushes when a hunk didn't change. When new commits land, only the hunks they touch come back.

Diffline compares the pull request with the commit of your last review on GitHub. Every line that's new since then gets a blue mark in the margin, and a welcome note says how many hunks in how many files changed. **Only what's new** (`u`) hides the rest.

Drafts, reviewed marks, reading order and finding decisions are saved on your computer as you go.

## Workflow

The Workflow tab is the pull request's path to merge, as GitHub reports it:

1. **Checks** on the head commit: failing and running ones first, passed ones summarized.
2. **Agent review**: each agent and what it found.
3. **Review**: requested reviewers who haven't reviewed yet, everyone's latest review, your own review and drafts, and whether every high finding has a decision.
4. **Merge**: GitHub's merge state, such as ready, blocked, behind the base branch, or conflicting.

A "next step" card at the top says what's waiting, and on whom.

## Less noise

- **Lockfiles** (`package-lock.json`) turn into a package summary: packages added, updated and removed, and why each one changed. Versions that changed in the lockfile without `package.json` asking for them are flagged. The raw diff is one click away.
- **Fold noise** folds code you've reviewed and summarizes lockfiles.
- **Generated files**, such as lockfiles, minified files, snapshots and `dist/`, are marked and left out of the size in the risk score.
- **Long lines.** A long line that changed, like a prompt kept in one string, shows once: insertions are marked, deletions are struck through, and the unchanged text folds to the sentences around each change. A reworded phrase reads as one deletion and one insertion, not alternating words.
- **Test hints.** Source files show whether their test file changed.
- **Unified or split** diffs (`s`).

## The sidebar and Home

The Diffline sidebar lists open pull requests. By default they're grouped by how they concern you: review requested from you, assigned to you, you reviewed, you're a code owner, your teams' requests, your pull requests, watched repositories, and ones you opened by hand. **Others you could review**, at the bottom, lists open pull requests in your repositories that nobody asked you to review and that aren't approved yet.

**Group** switches to one group per repository. **Sort** orders each group by risk, newest, or most recently updated. Each row shows the risk score and the agents' status: reviewed the latest commit, reviewed an older one, not reviewed, or running (here or in another VS Code window).

**Home** opens the review page on its list of pull requests, with the same groups and order as the sidebar. The list shows each pull request's progress, drafts, open findings and description gaps, and notes when one is stacked on another.

## Automatic runs

The agents run automatically on pull requests that request your review by name, when they open and after each push. Team requests, assignments, code-owner matches and others you could review don't run automatically: press Run on those.

Limits keep automatic runs cheap and predictable:

- A quiet period (2 minutes by default) after the last push, so a burst of pushes runs the agents once.
- Drafts are skipped.
- At most 5 automatic runs per pull request.
- Pull requests over 100 files or 5,000 changed lines wait for you to press Run.
- At most 5 agent processes at once on your computer, and a 20-minute limit per agent.

Every limit is a setting. Any pull request can be run by hand. When the agents already reviewed the latest commit and nothing changed on GitHub since, Run asks before reviewing again.

With several VS Code windows open, one window starts the automatic runs, and a pull request's agents run in one window at a time. The others show "running in another window".

## Posting to GitHub

Nothing reaches GitHub until you post. **Finish review** collects your summary, line comments and decision: comment, approve or request changes. **Preview what's sent** shows the exact API requests. **Post now** sends one review with your line comments and decision, then your replies, then the thread resolutions you queued. If the review itself fails, the replies and resolutions don't go out.

The review is posted on the commit the page was built from, so comments land on the lines you read. Drafts that posted are removed, and anything that failed stays as a draft. **Refresh** pulls new commits and comments without losing drafts.

Before posting, Diffline refuses a review that contains what looks like a private key, token or password.

Not supported yet: comments that span several lines, file-level comments, and editing or deleting posted comments.

## Keyboard

| Keys | What they do |
| --- | --- |
| `j` / `k` | Next and previous hunk |
| `n` | Next unreviewed hunk |
| `r` | Mark reviewed, then move on |
| `c` | Comment on the hunk |
| `a` | Next agent finding |
| `u` | Only what's new to you |
| `[` / `]` | Previous and next file |
| `s` | Unified or split |
| `f` | Jump to a file |
| `1` to `4` | Changes, Map, Discussion, Workflow |
| `m` | The map of the change |
| `.` / `,` | Next and previous step of the flow |
| `?` | All shortcuts |
