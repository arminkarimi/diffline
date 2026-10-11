import assert from "node:assert/strict";
import { test } from "node:test";

import { findSecrets } from "../src/core/secrets.ts";
import { checkPush, parseKey } from "../src/core/service.ts";
import { buildPage } from "../src/vscode/page.ts";

const detail = {
  threads: [{ id: "PRRT_1", comments: [{ dbId: 101 }, { dbId: 102 }] }],
} as any;

test("checkPush: replies and thread changes must be about this pull request's threads", () => {
  assert.doesNotThrow(() => checkPush({ event: "COMMENT", resolve: ["PRRT_1"], replies: [{ comment_id: 102, body: "ok" }] }, detail));
  assert.throws(() => checkPush({ event: "COMMENT", resolve: ["PRRT_other"] }, detail), /isn't on this pull request/);
  assert.throws(() => checkPush({ event: "COMMENT", unresolve: ["PRRT_other"] }, detail), /isn't on this pull request/);
  assert.throws(() => checkPush({ event: "COMMENT", replies: [{ comment_id: 999, body: "hi" }] }, detail), /isn't on this pull request/);
  assert.throws(() => checkPush(null, detail), /Expected a review/);
});

test("checkPush: nothing that looks like a secret is posted", () => {
  const key = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
  assert.throws(() => checkPush({ event: "COMMENT", body: `Found this:\n${key}\nabc` }, detail), /a private key in the summary.*nothing was sent/);
  const token = "ghp_" + "a".repeat(36);
  assert.throws(() => checkPush({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 3, body: `token ${token}` }] }, detail), /a GitHub token in the comment on src\/a\.ts:3/);
  assert.doesNotThrow(() => checkPush({ event: "COMMENT", body: "Use process.env.GITHUB_TOKEN, not a literal." }, detail));
});

test("findSecrets: common key and token shapes, and no false alarm on ordinary review text", () => {
  const hits = (text: string) => findSecrets([{ where: "x", text }]);
  assert.match(hits("AKIA" + "ABCDEFGHIJKLMNOP")[0], /AWS/);
  assert.match(hits("sk-ant-" + "a".repeat(30))[0], /Anthropic/);
  assert.match(hits("postgres://admin:hunter22@db.example.com/app")[0], /password/);
  assert.deepEqual(hits("Rename `token` to `accessToken` and check `AKIA` prefixes in the validator."), []);
  assert.deepEqual(hits("See https://github.com/o/r/pull/1 and postgres://localhost/app"), []);
});

test("parseKey: only names GitHub allows, so a key can't reach outside Diffline's folders", () => {
  assert.deepEqual(parseKey("Acme/api-server#3910"), { owner: "Acme", name: "api-server", number: 3910 });
  assert.deepEqual(parseKey("https://github.com/o/r.js/pull/7"), { owner: "o", name: "r.js", number: 7 });
  assert.equal(parseKey("o/..#1"), null);
  assert.equal(parseKey("../x#1"), null);
  assert.equal(parseKey("o/a\\b#1"), null);
  assert.equal(parseKey("-o/r#1"), null);
});

test("buildPage: no web font links, so opening a review requests nothing outside VS Code", () => {
  const template = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Recursive&display=swap">
<link rel="stylesheet" href="styles.css"></head><body><script src="review-data.js"></script><script src="app.js"></script></body></html>`;
  const html = buildPage(template, { csp: "default-src 'none'", nonce: "n", stylesUrl: "S", appUrl: "A", shim: "", data: {}, live: {} });
  assert.ok(!/fonts\.(googleapis|gstatic)/.test(html));
  assert.ok(html.includes('href="S"'));
});
