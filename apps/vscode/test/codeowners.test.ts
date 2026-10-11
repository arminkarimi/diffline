import assert from "node:assert/strict";
import { test } from "node:test";

import { ownersOf, ownsAny, parseCodeowners } from "../src/core/codeowners.ts";

// GitHub's documented examples, trimmed.
const FILE = `
# Default owners
*       @global-owner1 @global-owner2
*.js    @js-owner #This is an inline comment.
*.go docs@example.com
/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/scripts/ @doctocat @octocat
**/logs @octocat
/apps/ @octocat
/apps/github
/src/payments/** @Acme/Payments
`;

test("CODEOWNERS: the last matching line wins, with GitHub's pattern rules", () => {
  const rules = parseCodeowners(FILE);
  assert.deepEqual(ownersOf("README.md", rules), ["@global-owner1", "@global-owner2"]);
  assert.deepEqual(ownersOf("web/app.js", rules), ["@js-owner"], "an unanchored pattern matches at any depth");
  assert.deepEqual(ownersOf("build/logs/a/b.txt", rules), ["@octocat"], "**/logs, further down, also matches build/logs");
  assert.deepEqual(ownersOf("scripts/build.sh", rules), ["@doctocat", "@octocat"]);
  assert.deepEqual(ownersOf("docs/getting-started.md", rules), ["@doctocat"], "/docs/ comes after docs/*");
  assert.deepEqual(ownersOf("deep/logs/x.txt", rules), ["@octocat"], "**/logs matches a logs folder anywhere");
  assert.deepEqual(ownersOf("apps/github/x.ts", rules), [], "a line without owners clears ownership");
  assert.deepEqual(ownersOf("apps/other/x.ts", rules), ["@octocat"]);
  assert.deepEqual(ownersOf("src/payments/charge/a.ts", rules), ["@acme/payments"], "owners are lowercased");
});

test("CODEOWNERS: a wildcard last part only matches at its own level", () => {
  const rules = parseCodeowners("docs/* @a\n");
  assert.deepEqual(ownersOf("docs/x.md", rules), ["@a"]);
  assert.deepEqual(ownersOf("docs/sub/x.md", rules), []);
});

test("ownsAny: by login or through a team, case-insensitively", () => {
  const rules = parseCodeowners(FILE);
  assert.equal(ownsAny(["src/payments/x.ts"], rules, { login: "someone", teams: ["acme/payments"] }), true);
  assert.equal(ownsAny(["scripts/a.sh"], rules, { login: "OctoCat", teams: [] }), true);
  assert.equal(ownsAny(["README.md"], rules, { login: "octocat", teams: [] }), false);
  assert.equal(ownsAny(["README.md"], [], { login: "octocat", teams: [] }), false);
});
