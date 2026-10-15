# Features

What Diffline does today, in the VS Code extension. Settings and setup are in the [extension's README](../apps/vscode/README.md).

- [Read changes in order](#read-changes-in-order)
- [The description check](#the-description-check)
- [Agents review first](#agents-review-first)
- [Hand the review to another agent](#hand-the-review-to-another-agent)
- [Your own agents](#your-own-agents)
- [The Map](#the-map)
- [Risk score](#risk-score)
- [Pick up where you left off](#pick-up-where-you-left-off)
- [Workflow](#workflow)
- [Less noise](#less-noise)
- [The sidebar and Home](#the-sidebar-and-home)
- [Open a review from a link](#open-a-review-from-a-link)
- [Automatic runs](#automatic-runs)
- [Posting to GitHub](#posting-to-github)
- [Review metrics](#review-metrics)
- [Keyboard](#keyboard)

## Read changes in order

The guide agent groups the changed files into chapters and puts them in reading order. It works from the description's list of what changed, the commits and the import graph, so files that define things come before the files that use them. Each chapter says in one sentence what it does, and where it came from: the description, a commit, or the guide's own grouping. Housekeeping a reviewer can skim, such as configuration, is marked quiet.

Every changed file is in exactly one chapter. Files the guide leaves out go into a last chapter, "Everything else".

You can regroup at any time: **Chapters**, **Commits** (one chapter per commit, in the order they were pushed) or **Folders**. Without a guide run, the page groups files automatically by layer (data and schema, core logic, interface, tests, then configuration and docs), each in dependency order.

In the sidebar, the arrow next to a chapter collapses its file list, and Alt-click (Option-click on macOS) collapses or expands every chapter. A collapsed chapter shows how many hunks are left, and is highlighted while you read one of its files. Collapsed chapters stay collapsed while the page is open.

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

Decisions stay with their finding when the agents run again. A finding's id comes from its agent and the line it's on, so when the same agent flags the same line on a later run, the decision you made is still there, marked "on an earlier run". Decisions on findings that don't come back are kept, but not shown.

Agents never approve or block, and the author only sees what you post. Approve stays unavailable until every high finding has a decision.

Every line an agent points at is checked against the diff. Small mistakes, such as a wrong path or different whitespace, are repaired. Anchors that don't resolve to a line of the diff are dropped, rather than posted on the wrong line.

## Hand the review to another agent

**Copy for an agent**, in the briefing's header, copies the agent review as Markdown to paste into Claude Code, Codex, Pi or a chat. Its menu has three choices: **Copy all findings**, **Copy open findings only** (not dismissed and not already in your review), and **Save as Markdown…**. **Diffline: Copy Agent Review as Markdown** does the same from the command palette or a sidebar row.

The Markdown gives the other agent what it needs to find the code: the repository, the pull request, its branches, the commit the agents reviewed and the merge base with the commands to check them out, and each finding's file and line in that commit with a permalink. A removed line is numbered and linked at the merge base. It also has the summary, the description check with your decisions, each finding with its status, the checked notes, the reading order and the flows as Mermaid charts. It holds lines of code and the findings' text, so paste it only where that code may go.

## Your own agents

The agents' settings live in `~/.diffline`, written with defaults on first run:

- `agents.yml` lists the agents in the order they run, with each one's name, focus, and options: whether it's on, how many findings it may report, the lowest confidence it reports, files to skip, `runs-when` patterns, and a harness and model. It also says what each severity means, and holds the description rules.
- `agents/<id>.md` holds each agent's instructions, under **Look for** and **Leave alone**.

**Diffline: New Agent…** asks for a name and a focus, adds the agent, and opens its instructions file. It runs once that file has instructions. **Remove an Agent…** takes one out (its instructions stay), and **Reset Agent Settings** brings back the built-in ones.

**Per-agent harness.** Each agent runs on Claude Code, Codex or Pi. **Diffline: Choose Agent Harnesses…** shows which CLIs are installed and their versions, sets the default, and sets a harness for any single agent. A model can be set per agent too.

**Pi's model and thinking level.** Pi works with many model providers. By default its agents use the model and thinking level set in Pi. When you pick Pi, **Choose Pi model…** lists the models you're signed in to, then the thinking levels (off, minimal, low, medium, high, xhigh), for the default or for one agent. For one agent, it writes Pi's model syntax into `model:` in `agents.yml`, such as `model: openai/gpt-6.1-sol:high`, where `:high` is the thinking level.

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

A line under the title says where you stand: how and when you last reviewed and what's new since ("You approved this 2 days ago at abc1234 · 3 new commits and 2 new comments since", counting comments by others), "You haven't reviewed this yet", that your review is requested again or was dismissed, or, once it's over, "Merged by Alex Doe 3 days ago" or "Closed 3 days ago without merging".

Diffline compares the pull request with the commit of your last review on GitHub, whether you approved, requested changes or only commented. Every line that's new since then gets a blue mark in the margin, and a welcome note says how many hunks in how many files changed. **Only what's new** (`u`) hides the rest. Closing the welcome note lasts until the next push to that pull request.

- **You never reviewed it.** Every hunk you haven't marked reviewed counts as new.
- **The branch was rewritten** (a force-push or rebase) since your review. The note says so instead of counting commits. If your clone still has the commit you reviewed, lines that differ from it get the blue mark; if not, every hunk you haven't marked reviewed counts as new.

While a review is open, the sidebar's checks keep watching it. When the pull request is merged, closed, reopened, pushed to or updated on GitHub, a bar at the top of the page says so, with **Refresh**. The page doesn't reload by itself, so you keep your place.

Drafts, reviewed marks, reading order and finding decisions are saved on your computer as you go.

## Workflow

The Workflow tab is the pull request's path to merge, as GitHub reports it:

1. **Checks** on the head commit: failing and running ones first, passed ones summarized.
2. **Agent review**: each agent and what it found.
3. **Review**: requested reviewers who haven't reviewed yet, everyone's latest review, your own review (approved, changes requested, commented, dismissed or requested again) and drafts, and whether every high finding has a decision. Once the pull request is merged or closed, this stage says so.
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

The Diffline sidebar lists open pull requests. By default they're grouped by how they concern you: review requested from you, assigned to you, you reviewed, you're a code owner, your teams' requests, your pull requests, watched repositories, and ones you opened by hand. **Others you could review** lists open pull requests in your repositories that nobody asked you to review and that aren't approved yet. **Recently merged or closed**, at the bottom, keeps the pull requests you reviewed or wrote for 3 days after they're merged or closed (`diffline.watch.recentlyClosedDays`; 0 turns it off), so you can see how they ended.

The list shows as soon as GitHub answers its main search (review requested, assigned, you reviewed, yours, watched, opened by hand), which runs every minute (`diffline.watch.pollSeconds`); at startup, the last session's list shows until then. The other groups load in the background and keep their rows and counts while they reload. **Recently merged or closed** loads after the list shows, then every 10 minutes, and right away when a pull request leaves the list, since it may have just merged. Your teams' requests and **Others you could review** load about 5 seconds after the first list, then every 5 minutes. Changed files (for the risk score) and code-owner matches are checked as open pull requests come in. **Refresh**, in the sidebar's title bar, checks everything at once, and so does changing a `diffline.watch` setting.

**Group** switches to one group per repository, where merged and closed ones stay in their repository. **Sort** orders each group by risk, newest, or most recently updated. Each row shows the risk score and the agents' status: reviewed the latest commit, reviewed an older one (commits landed since the agents ran), not reviewed, or running (here or in another VS Code window).

Each row also says how you reviewed it, when, and what changed since: "you approved 2d ago · new commits", "you commented 5h ago · updated since", "re-requested · you approved 3d ago". It says draft and conflicts, and merged or closed once it's over. The hover adds your review's commit, the pull request's state and its approvals. Your review is fetched for the pull requests you're involved in; team requests, watched repositories and others you could review keep their searches lean, so their rows only say whether you approved or requested changes.

**Home** opens the review page on its list of pull requests, with the same groups and order as the sidebar. The list shows each pull request's progress, drafts, open findings and description gaps, your review and what changed since, draft, conflict, merged and closed badges, and its approvals ("2 approvals", "changes requested by 1") when GitHub's review decision isn't known. It notes when one is stacked on another.

## Open a review from a link

**Diffline: Open a Pull Request…** (⌥⇧⌘P on macOS, Ctrl+Shift+Alt+P on Windows and Linux) opens any pull request from a GitHub link or `owner/name#123`. When the clipboard holds one, the box starts with it.

A link opens a review from a browser, a chat or a terminal: `vscode://diffline.diffline/open?url=https://github.com/acme/web/pull/123`, or `?pr=acme/web%23123`. Cursor's links start with `cursor://`. **Diffline: Copy Link to This Review** copies the link for the open review or a sidebar row. The first time, VS Code asks whether Diffline may open the link. A link only opens the review and adds it to the sidebar; it never runs the agents or posts anything.

Opening doesn't refresh the sidebar or wait for it. The page shows as soon as GitHub answers, with the description, discussion, checks, workflow and agent briefing, and "Loading the changes…" where the diff goes; the changes fill in when they're ready, without a reload. Small pull requests open in one go. On a large one, the page shows in about 1 second instead of 4 to 8, and the diff takes about 3 seconds more to draw. The [extension's README](../apps/vscode/README.md) has the link formats and what works while the changes load.

## Automatic runs

The agents run automatically on pull requests that request your review by name, when they open and after each push. Team requests, assignments, code-owner matches and others you could review don't run automatically: press Run on those.

Limits keep automatic runs cheap and predictable:

- A quiet period (2 minutes by default) after the last push, so a burst of pushes runs the agents once.
- Drafts are skipped.
- At most 5 automatic runs per pull request.
- Pull requests over 100 files or 5,000 changed lines wait for you to press Run.
- Approved pull requests ask first (see below).
- At most 5 agent processes at once on your computer, and a 20-minute limit per agent.

Every limit is a setting. Any pull request can be run by hand. When the agents already reviewed the latest commit and nothing changed on GitHub since, Run asks before reviewing again.

**Approved pull requests.** A pull request counts as approved when someone's latest review approves it and nobody's latest review requests changes. Its agents' review may not be needed, so by default an automatic run on it waits, and Diffline asks once per push: **Skip this PR**, **Run anyway** or **Always skip approved**. Skip this PR and Run anyway are remembered for the pull request, so later pushes don't ask again. Several waiting at once get one notification, and **Review them** picks which to run. The sidebar row and the review page say why the run waits. `diffline.agents.approvedPullRequests` is `ask` by default; `skip` skips without asking, and `run` runs them like any other. Unless it's `run`, Run on an approved pull request asks to confirm, and a run that's going when the pull request gets approved offers **Stop**.

With several VS Code windows open, one window starts the automatic runs, and a pull request's agents run in one window at a time. The others show "running in another window".

## Posting to GitHub

Nothing reaches GitHub until you post. **Finish review** collects your summary, line comments and decision: comment, approve or request changes. **Preview what's sent** shows the exact API requests. **Post now** sends one review with your line comments and decision, then your replies, then the thread resolutions you queued. If the review itself fails, the replies and resolutions don't go out.

The review is posted on the commit the page was built from, so comments land on the lines you read. Drafts that posted are removed, and anything that failed stays as a draft. **Refresh** pulls new commits and comments without losing drafts.

Posting on a pull request that's already merged or closed asks first. GitHub still records the review.

Before posting, Diffline refuses a review that contains what looks like a private key, token or password.

Not supported yet: comments that span several lines, file-level comments, and editing or deleting posted comments.

## Review metrics

**Diffline: Show Review Metrics**, or **Review metrics** on Home, shows how your reviews and the agents are going, for the last 7, 30 or 90 days, or all time:

- **Your reviews.** Reviews per week, by decision. The time the page was in use per review, how much of each diff you marked reviewed, how many reviews were later rounds or followed a new push, and your own comments next to those that came from agent findings.
- **Agent findings.** For each agent, the share of its findings you used (added to your review, posted or copied), dismissed, or left open when you posted a review. Dismissals show their most common reason. An agent with fewer than 10 decided findings says "too few to tell". Below that: severity by confidence, how much you reworded findings before posting, the description rules you asked about or skipped and why, how an agent did before and after its instructions or model changed, and each finding with its outcome.
- **Agent runs.** Failures, duration, tokens and cost, and cost per useful finding, for automatic and manual runs. **Skipped (approved)** counts the automatic runs that didn't start because the pull request was already approved.

The agent tables can be grouped by agent, harness, model or Pi's thinking level, so you can compare one setup with another. **Export CSV** saves one row per finding and its outcome; **Export JSON** saves the raw events.

The numbers come from a log the extension keeps on your computer, in its global storage: one line per thing you did with a finding or description rule, per review you posted, and per agent run. It holds finding titles, but no code, diffs or comment text, and it's never sent anywhere. It's on by default. `diffline.metrics.enabled` turns it off, and **Diffline: Delete Review Metrics** deletes it. The [architecture notes](architecture.md#review-metrics) describe its format.

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
