# Contributing

How to work on Diffline. [docs/architecture.md](docs/architecture.md) explains how the extension fits together.

## Prerequisites

- **Node 26.** The tests are TypeScript, and Node 26 runs them directly, with no compile step.
- **git.** The tests build a small git repository as a fixture.
- **The GitHub CLI** (`gh`), signed in, for running the extension and the smoke tests.
- **VS Code** 1.95 or later.
- To run the agents: the Claude Code CLI or the Codex CLI, signed in. Unit tests don't need either.

## Setup

```sh
git clone https://github.com/arminkarimi/diffline.git
cd diffline
npm install
```

## Commands

From the repository root:

| Command | What it does |
| --- | --- |
| `npm run build` | Bundles the extension and copies the review page into it. |
| `npm test` | Runs the unit tests with Node's test runner. |
| `npm run typecheck` | Type-checks the extension and its tests. |
| `npm run package` | Builds a minified bundle and writes `apps/vscode/diffline-<version>.vsix`. |
| `npm run watch -w apps/vscode` | Rebuilds the bundle on every change. |

CI runs `npm ci`, the typecheck, the tests and the package step on every push and pull request (`.github/workflows/ci.yml`). Run the same before you push.

The tests build a sample git repository at `apps/vscode/test/fixtures/sample-repo` the first time they need it (it's gitignored). To rebuild it by hand, run `node test/fixtures/make-sample-repo.ts --force` in `apps/vscode`. `test/fixtures/review-data.json` is the review data the diff builder must produce from it.

To see what goes into the `.vsix`, run `npx vsce ls --no-dependencies` in `apps/vscode`.

## Running the extension

Open the `apps/vscode` folder in VS Code and press F5. It builds, then opens an Extension Development Host window with Diffline loaded. Edits to `packages/review-ui` show after a rebuild (`npm run build`) and reopening the review.

The development window uses your real `~/.diffline` and your `gh` account. Set `diffline.agents.autoRun` to off there if you don't want agents to start on their own.

## Checks against real GitHub

These read real pull requests. Use one your `gh` account can read. Run them from `apps/vscode`:

```sh
# Read-only checks of the GitHub layer. Sends no mutations.
node scripts/smoke-github.ts owner/name#123

# Build the review page for a pull request and write it to .dev/index.html, to check it in a browser.
node scripts/dev-page.ts owner/name#123 --clone /path/to/clone

# Run the agents end to end, without VS Code. This uses your Claude Code or Codex account, so it costs money.
node scripts/e2e-agents.ts owner/name#123 --clone /path/to/clone
```

### The VS Code smoke test

The smoke test opens an isolated VS Code (a throwaway profile and extensions folder) with Diffline, opens a pull request and checks the basics. Agents never run, and nothing is posted. Build first, then run from the repository root:

```sh
npm run build
DIFFLINE_SMOKE_PR=owner/name#123 ./apps/vscode/scripts/vscode-smoke.sh
```

Set `DIFFLINE_SMOKE_CLONE=/path/to/clone` to make it faster. The script expects VS Code at `/Applications/Visual Studio Code.app`, so it runs on macOS.

## Code style

- **Match the code around you.** Naming, structure and formatting follow the file you're in. Indent with 2 spaces (`.editorconfig`).
- **Comments explain why**, in plain English. Say what a reader can't see from the code: the constraint, the failure it prevents, the reason for an odd choice. Don't narrate what the next line does.
- **TypeScript runs without a compile step**, so the extension uses `erasableSyntaxOnly`: no enums, no namespaces, no parameter properties. Import with the `.ts` extension. `npm run typecheck` enforces this.
- **`src/core` and `src/agents` don't import `vscode`**, so they stay testable with plain Node. VS Code code goes in `src/vscode` and `src/extension.ts`.
- **The review page** (`packages/review-ui`) is plain HTML, CSS and JavaScript with no build step and no dependencies.
- **`src/core/risk.ts` mirrors `computeRisk` in `packages/review-ui/app.js`.** Change both together.
- **Text people read** (messages, settings descriptions, docs) uses short sentences and plain words. Say what happened and what to do next.
- **Add a test** for a behavior change. Tests live in `apps/vscode/test/`.

## Commit messages

- A subject line in the imperative, under 72 characters: "Skip drafts in automatic runs", not "Skipped drafts" or "Fixes".
- A body when the reason isn't obvious: what changed and why, in plain sentences.
- One logical change per commit.

## Private data stays out

Diffline is used on private repositories. Nothing from them goes into this repository: no names of private repositories or organizations, no code, diffs, pull request titles, descriptions, comments, agent output or screenshots.

- In docs, tests and examples, use `acme/web`, `acme/api` and `owner/name#123`.
- Fixtures are built from the sample repository in the tests, not copied from real pull requests.
- `.diffline/` and local notes are gitignored. Keep them that way.

Check your diff for this before you push.

## Cutting a release

1. Bump the version in `apps/vscode/package.json`:

   ```sh
   npm version 0.2.0 -w apps/vscode --no-git-tag-version
   ```

2. In `apps/vscode/CHANGELOG.md`, rename **Unreleased** to the new version and say what changed for users.
3. Update the `.vsix` file name in the install steps of `README.md` and `apps/vscode/README.md`.
4. Run the checks and build the package:

   ```sh
   npm run typecheck && npm test && npm run package
   ```

5. Install `apps/vscode/diffline-<version>.vsix` in VS Code and open a pull request with it.
6. Commit ("Diffline 0.2.0"), tag it `v0.2.0`, push, and attach the `.vsix` to a GitHub release:

   ```sh
   gh release create v0.2.0 apps/vscode/diffline-0.2.0.vsix --title "Diffline 0.2.0"
   ```

   Use the version's CHANGELOG section as the release notes.
