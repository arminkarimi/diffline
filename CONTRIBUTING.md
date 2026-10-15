# Contributing

How to work on Diffline. [docs/architecture.md](docs/architecture.md) explains how the extension fits together.

## Prerequisites

- **Node 26.** The tests are TypeScript, and Node 26 runs them directly, with no compile step.
- **git.** The tests build a small git repository as a fixture.
- **The GitHub CLI** (`gh`), signed in, for running the extension and the smoke tests.
- **VS Code** 1.95 or later.
- To run the agents: the Claude Code CLI, the Codex CLI or Pi, signed in. Unit tests don't need any of them.

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
| `npm run install-local` | Packages the extension and installs it into VS Code, replacing the installed version. Set `CODE` to use another editor's CLI (`CODE=cursor`, `CODE=code-insiders`). Reload the window afterwards. |
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

# Run the agents end to end, without VS Code. This uses your Claude Code or Codex account, or the provider account Pi is signed in to, so it costs money.
node scripts/e2e-agents.ts owner/name#123 --clone /path/to/clone
```

`dev-page.ts` also takes:

| Flag | What it does |
| --- | --- |
| `--sample` | Builds the page from `test/fixtures/review-data.json` instead of GitHub. The views work; nothing can be posted. |
| `--agent <file>` | Shows an agent review from a file, such as `test/fixtures/agent-file.json` (the briefing and findings). Works with `--sample` too. |
| `--metrics sample\|<file>\|empty\|off` | Gives the page a review metrics report: from made-up events, from a log file (`events.jsonl`), from an empty log, or with metrics turned off. |
| `--start metrics` | Opens the page on the review metrics report. |
| `--staged <ms>` | Opens the page without the diff ("Loading the changes…") and sends it that many ms later, as the panel does for a pull request whose diff isn't built yet. `--staged-error <ms>` sends a failure instead. |

`node scripts/dev-page.ts --sample --metrics sample --start metrics` shows the report on made-up data, without GitHub. `node scripts/dev-page.ts --sample --staged 3000` shows the page opening in two parts.

### The VS Code smoke test

The smoke test opens an isolated VS Code (a throwaway profile and extensions folder) with Diffline, opens a pull request and checks the basics. Agents never run, and nothing is posted. Build first, then run from the repository root:

```sh
npm run build
DIFFLINE_SMOKE_PR=owner/name#123 ./apps/vscode/scripts/vscode-smoke.sh
```

Set `DIFFLINE_SMOKE_CLONE=/path/to/clone` to make it faster. The script expects VS Code at `/Applications/Visual Studio Code.app`, so it runs on macOS.

### Timing an open

`open-timing.sh` opens a pull request by link in an isolated VS Code, once cold, then with the diff cached and with everything cached, and prints the extension's timing of each open (see [Timing an open](docs/architecture.md#timing-an-open)). Build first, then run from `apps/vscode`:

```sh
DIFFLINE_SMOKE_PR=owner/name#123 ./scripts/open-timing.sh
```

`DIFFLINE_TIMING_RUNS` sets how many cached opens of each kind (2 by default). `DIFFLINE_TIMING_SEED=/path/to/clone.git` copies a bare clone in as Diffline's own, so the first open doesn't clone. `DIFFLINE_TIMING_LOG=1` also prints what was fetched and built, with the repository's name left out. It makes a few GitHub requests per open; keep runs few.

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
- **Sign off every commit** (`git commit -s`). The `Signed-off-by: Your Name <you@example.com>` line certifies the [Developer Certificate of Origin](https://developercertificate.org): that you wrote the change or have the right to submit it under the project's MIT license. Pull requests with unsigned commits can't be merged. To sign off commits you already made: `git rebase --signoff main`.

## Private data stays out

Diffline is used on private repositories. Nothing from them goes into this repository: no names of private repositories or organizations, no code, diffs, pull request titles, descriptions, comments, agent output or screenshots.

- In docs, tests and examples, use `acme/web`, `acme/api` and `owner/name#123`.
- Fixtures are built from the sample repository in the tests, not copied from real pull requests.
- `.diffline/` and local notes are gitignored. Keep them that way.

Check your diff for this before you push.

## Cutting a release

Pushing a version tag runs `.github/workflows/release.yml`: it runs the typecheck and tests, packages the `.vsix`, creates the GitHub release with the `.vsix` and the version's CHANGELOG section, and publishes the same `.vsix` to the VS Code Marketplace and Open VSX. It stops if the tag isn't `v` plus the version in `apps/vscode/package.json`, or if the CHANGELOG has no section for that version.

1. Bump the version in `apps/vscode/package.json`:

   ```sh
   npm version 0.4.0 -w apps/vscode --no-git-tag-version
   ```

2. In `apps/vscode/CHANGELOG.md`, rename **Unreleased** to the new version (`## 0.4.0`) and say what changed for users. That section becomes the release notes and shows on the stores' Changelog tab.
3. Update the version in the root `README.md` (**Status** and the `.vsix` file name).
4. Run the checks and build the package:

   ```sh
   npm run typecheck && npm test && npm run package
   ```

5. Install `apps/vscode/diffline-<version>.vsix` in VS Code and open a pull request with it.
6. Commit ("Diffline 0.4.0"), tag and push:

   ```sh
   git tag v0.4.0
   git push origin main v0.4.0
   ```

   The workflow does the rest. Each publish step that has no token (see below) is skipped with a notice, so the GitHub release still goes out. Running the workflow again on the same tag is safe: the release gets the `.vsix` replaced, and the stores skip a version they already have.

**Dry run.** Actions → **Release** → **Run workflow**, with **Dry run** ticked (the default), checks and packages the current branch and uploads the `.vsix` and the release notes as a workflow artifact. It publishes nothing. Run on a tag with **Dry run** unticked to retry a release.

**The packaged README.** The stores show `apps/vscode/README.md` from the `.vsix`. `npm run package` rewrites its relative links to `https://github.com/arminkarimi/diffline/blob/main/apps/vscode/…` and its images to `https://raw.githubusercontent.com/arminkarimi/diffline/main/apps/vscode/…` (vsce doesn't use the `repository.directory` field), so images must be PNG or JPEG on `main`; SVG isn't allowed. The screenshots are in `apps/vscode/media/screenshots` and stay out of the `.vsix`. To retake them, build the review page on the fixture data (after `npm run build`, from `apps/vscode`; it writes `.dev/index.html`), open it in a browser at 1280×800 with 2× scale in the light theme, and capture the briefing, a finding, the Map and Home (`#inbox`):

```sh
node scripts/dev-page.ts --sample --agent test/fixtures/agent-file.json --state approved
```

### One-time setup

The repository owner does this once. Nobody else needs these accounts or tokens.

1. **VS Code Marketplace publisher.** Sign in at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and create the publisher `diffline` (the `publisher` in `apps/vscode/package.json`).
2. **Marketplace token.** In Azure DevOps ([dev.azure.com](https://dev.azure.com)), create a personal access token with **Organization: All accessible organizations** and the **Marketplace → Manage** scope. Check it with `npx @vscode/vsce verify-pat diffline`. Add it to the repository as the Actions secret `VSCE_PAT` (Settings → Secrets and variables → Actions).
3. **Open VSX namespace.** Sign in at [open-vsx.org](https://open-vsx.org) with GitHub, link an Eclipse account and sign the publisher agreement in your profile settings, then create an access token there. Create the namespace once: `npx ovsx create-namespace diffline -p <token>`, and claim ownership of it in the Open VSX repository's issues (the namespace's settings page links the form).
4. **Open VSX publishing.** The first version has to be published with the access token: add it as the Actions secret `OVSX_PAT` and push a tag. Then switch to trusted publishing, which needs no stored token: once you own the namespace, open **Settings → Trusted Publishers** on Open VSX, pick `diffline` and GitHub Actions, and enter `arminkarimi`, `diffline` and the workflow filename `release.yml` (no environment). Then delete the `OVSX_PAT` secret, which would otherwise take precedence, and the next release publishes with the workflow's OIDC token. If that release's Open VSX step fails, add the secret back and re-run the workflow on the tag. Without the secret and without the registration, the Open VSX step fails.
5. Push a tag.

Without a PAT: the Marketplace also accepts a Microsoft Entra ID identity. Create an app registration or managed identity in Entra ID with a federated credential for this repository's tags, add it to the publisher as a member, give the publish job `id-token: write`, sign in with `azure/login`, and publish with `npx @vscode/vsce publish --azure-credential --packagePath <vsix>`. The workflow implements the PAT route.
