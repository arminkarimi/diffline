# @diffline/core

Diffline's product rules, as pure TypeScript functions: how pull requests are grouped in the list, review status and what changed since your review, the risk score, `CODEOWNERS` matching, the words on a row, and relative times. The VS Code extension bundles them.

Node 26 runs the source as it is, with no build step. The package isn't published; it's an npm workspace in this repository.

## What's in it

| Module | What it decides |
| --- | --- |
| `@diffline/core/grouping` | How pull requests are grouped in the list (the sidebar and Home): by relationship (review requested, assigned, you reviewed, code owner, team, yours, watched, opened here, recently merged or closed) or by repository, how each group is sorted, and Others you could review at the bottom. |
| `@diffline/core/review-status` | Your last review of a pull request and what changed since (new commits, updated on GitHub), approval counts, and how a pull request changed while its page was open. |
| `@diffline/core/freshness` | Whether the last agent review is current, behind the head, or older than activity on GitHub. |
| `@diffline/core/files` | Which changed files are generated (lockfiles, minified bundles, snapshots, build output): folded on the review page and left out of the risk score's changed lines. |
| `@diffline/core/risk` | The 0–100 risk score and its factors. It mirrors `computeRisk` in `packages/review-ui/app.js`; change both together. |
| `@diffline/core/codeowners` | `CODEOWNERS` parsing and matching, with GitHub's rules. |
| `@diffline/core/row-text` | The words on a row and in its hover: your review, the state, approvals, the agents' status. |
| `@diffline/core/time` | Relative times: "5 minutes ago". |
| `@diffline/core/types` | The input shapes the functions read. |

## What belongs here

Pure functions over the input types in `src/types.ts`, and those types. No GitHub client, no network, no storage, no UI, no editor APIs, and no dependencies.

The inputs are the smallest shapes the rules read, not any consumer's whole model. Each consumer maps its own data into them. The extension's own types have everything these have and more, so it passes them as they are, and TypeScript checks that they still fit.

Code that fetches, stores or draws stays in the app that uses it.

## Working on it

The same conventions as the rest of the repository ([CONTRIBUTING.md](../../CONTRIBUTING.md)): `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `import type` for types, relative imports with the `.ts` extension. The extension imports a module by its subpath: `import { buildGroups } from "@diffline/core/grouping"`.

```sh
npm test -w packages/core
npm run typecheck -w packages/core
```

The tests are in `test/`, one file per module.
