# Diffline

Diffline is a VS Code extension for reviewing GitHub pull requests; it works in Cursor too. Review agents run on your computer, through the Claude Code CLI, the Codex CLI or Pi, before you read a line. They check the description, set a reading order, draw the flow the change touches and report findings. You review in one page, decide what goes into your review, and post it to GitHub. Nothing reaches GitHub until you press **Post now**.

## Status

Preview, version 0.3.2. It reviews real pull requests, and it has rough edges. Diffline isn't on the VS Code Marketplace yet. Changes are listed in the [changelog](apps/vscode/CHANGELOG.md).

## Install

You need VS Code 1.95 or later (or Cursor), git, the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`), and the Claude Code CLI, the Codex CLI or Pi signed in.

Install the `.vsix` file:

```sh
code --install-extension diffline-0.3.2.vsix
```

Or in VS Code: Extensions view, **…** → **Install from VSIX…**. In Cursor, run `cursor --install-extension diffline-0.3.2.vsix`, or **Extensions: Install from VSIX…** from the Command Palette. To build the `.vsix` yourself, see [Development](#development).

The [extension's README](apps/vscode/README.md) covers the first run, settings, costs, privacy and troubleshooting.

## What it does

- **Reading order.** The guide agent groups the changed files into chapters, so files that define things come before the files that use them.
- **Description check.** The guide checks the description against the rules for a feature or a fix. Each gap comes with a question you can ask the author or skip.
- **Agents review first.** Architecture, correctness, test and security agents report findings with their reasoning and a suggested fix. You add each one to your review or dismiss it with a reason. Approval waits until every high finding has a decision.
- **Your own agents.** Add reviewers with their own instructions, and pick Claude Code, Codex or Pi per agent.
- **The Map.** The change as a diagram of how the code runs, linked to the lines each step stands for. **Follow the flow** walks the diff in that order.
- **Risk score.** Every pull request gets a score from 0 to 100, with the factors behind it.
- **Pick up where you left off.** Reviewed marks are kept per hunk. After new pushes, only what changed comes back.
- **Workflow.** Checks, agent review, reviews and merge state from GitHub, in one track.
- **Less noise.** Lockfile summaries, folded reviewed code, word-level diffs for long lines, and test hints.
- **The sidebar.** Pull requests grouped by how they concern you, sorted by risk, with a Home page in the review panel.

[docs/features.md](docs/features.md) describes each feature.

## Repository layout

This is a monorepo with npm workspaces.

| Path | What it is |
| --- | --- |
| `apps/vscode/` | The VS Code extension: the sidebar, GitHub access through `gh`, the agents, the review panel. Its [README](apps/vscode/README.md) is what users read. |
| `packages/review-ui/` | The review page the extension shows in a webview. Plain HTML, CSS and JavaScript, no build step. |
| `docs/` | [Features](docs/features.md) and [architecture](docs/architecture.md). |

## Development

You need Node 26 (it runs the TypeScript tests directly), git, the GitHub CLI and VS Code.

```sh
npm install
npm run build       # bundle the extension and copy the review page into it
npm test            # unit tests
npm run typecheck
npm run package     # writes apps/vscode/diffline-<version>.vsix
npm run install-local   # packages it and installs it into VS Code; reload the window after
CODE=cursor npm run install-local   # the same for Cursor
```

Open `apps/vscode` in VS Code and press F5 to run the extension in a development window. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest: the smoke tests, code style and how to cut a release. [docs/architecture.md](docs/architecture.md) explains how the extension works.

## License

MIT. Copyright Armin Karimi. See [LICENSE](LICENSE).
