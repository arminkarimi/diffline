import assert from "node:assert/strict";
import { test } from "node:test";

import { clipboardPullRequest, parseOpenLink, reviewLink } from "../src/core/links.ts";

// As VS Code hands a URI to the extension: path, query and fragment, decoded.
const uri = (path: string, query = "", fragment = "") => ({ path, query, fragment });
const key = (owner: string, name: string, number: number) => ({ key: { owner, name, number } });

test("parseOpenLink: ?pr=owner/name#n and ?url= with a GitHub pull request link open that pull request", () => {
  assert.deepEqual(parseOpenLink(uri("/open", "pr=acme/web#123")), key("acme", "web", 123));
  // An unescaped # starts the fragment: the number there completes the key.
  assert.deepEqual(parseOpenLink(uri("/open", "pr=acme/web", "123")), key("acme", "web", 123));
  assert.deepEqual(parseOpenLink(uri("/open/", "pr=acme/web.js#7")), key("acme", "web.js", 7));
  assert.deepEqual(parseOpenLink(uri("/open", "url=https://github.com/acme/web/pull/123")), key("acme", "web", 123));
  // The pull request's tabs and anchors, www and http are fine; a query of the GitHub link's own is cut at its &.
  assert.deepEqual(parseOpenLink(uri("/open", "url=https://github.com/acme/web/pull/123/files")), key("acme", "web", 123));
  assert.deepEqual(parseOpenLink(uri("/open", "url=http://www.github.com/acme/web/pull/9", "discussion_r1")), key("acme", "web", 9));
  assert.deepEqual(parseOpenLink(uri("/open", "url=https://github.com/acme/web/pull/123?tab=files&x=1")), key("acme", "web", 123));
});

test("parseOpenLink: anything else is refused with a short reason", () => {
  const bad = [
    uri("/run", "pr=acme/web#1"), // another path: links only open reviews
    uri("/open/agents", "pr=acme/web#1"),
    uri("/open", ""), // nothing named
    uri("/open", "pr=acme/web#1&url=https://github.com/acme/web/pull/1"), // both
    uri("/open", "pr=acme/web"), // no number
    uri("/open", "pr=acme/web#0"),
    uri("/open", "pr=acme/web#12345678901"),
    uri("/open", "pr=acme/web#1x"),
    uri("/open", "pr=../../etc#1"), // names GitHub doesn't allow
    uri("/open", "pr=acme/..#1"),
    uri("/open", "pr=-acme/web#1"),
    uri("/open", "pr=https://github.com/acme/web/pull/1"), // a link goes in url=
    uri("/open", "url=acme/web#1"), // a key goes in pr=
    uri("/open", "url=https://evil.example/?github.com/acme/web/pull/1"),
    uri("/open", "url=https://github.com.evil.example/acme/web/pull/1"),
    uri("/open", "url=https://user@github.com/acme/web/pull/1"),
    uri("/open", "url=https://github.com:8443/acme/web/pull/1"),
    uri("/open", "url=javascript:alert(1)//github.com/acme/web/pull/1"),
    uri("/open", "url=https://github.com/acme/web/issues/1"),
    uri("/open", "url=https://github.com/acme/web/pull/1/../../../x/y/z/pull/2"), // dot segments that leave the pull request
    uri("/open", `pr=acme/web#1&x=${"a".repeat(3000)}`),
  ];
  for (const u of bad) {
    const r = parseOpenLink(u);
    assert.ok("error" in r, `refused: ${JSON.stringify(u).slice(0, 120)}`);
    assert.match((r as { error: string }).error, /diffline\.diffline\/open\?pr=owner\/name%23123/);
  }
  assert.match((parseOpenLink(uri("/run")) as { error: string }).error, /^That link isn't one Diffline knows\./);
});

test("reviewLink: the editor's scheme, and a link that parses back to the same pull request", () => {
  const k = { owner: "acme", name: "web", number: 123 };
  assert.equal(reviewLink("vscode", k), "vscode://diffline.diffline/open?pr=acme/web%23123");
  assert.equal(reviewLink("cursor", k), "cursor://diffline.diffline/open?pr=acme/web%23123");
  const u = new URL(reviewLink("vscode", k));
  assert.deepEqual(parseOpenLink({ path: u.pathname, query: decodeURIComponent(u.search.slice(1)), fragment: "" }), { key: k });
});

test("clipboardPullRequest: a pull request link or key alone is offered as its GitHub link; other text isn't", () => {
  assert.equal(clipboardPullRequest("https://github.com/acme/web/pull/123"), "https://github.com/acme/web/pull/123");
  assert.equal(clipboardPullRequest("  https://github.com/acme/web/pull/123/files#diff-1\n"), "https://github.com/acme/web/pull/123");
  assert.equal(clipboardPullRequest("acme/web#123"), "https://github.com/acme/web/pull/123");
  assert.equal(clipboardPullRequest("vscode://diffline.diffline/open?pr=acme/web%23123"), "https://github.com/acme/web/pull/123");
  assert.equal(clipboardPullRequest("cursor://diffline.diffline/open?pr=acme/web%23123", "cursor"), "https://github.com/acme/web/pull/123");
  assert.equal(clipboardPullRequest("vscode://arminkarimi.diffline/open?pr=acme/web%23123"), "https://github.com/acme/web/pull/123", "a link with the old ID");
  for (const t of ["", "hello", "see https://github.com/acme/web/pull/123 please", "https://github.com/acme/web", "https://github.com/acme/web/issues/3", "https://gitlab.com/acme/web/pull/3", "vscode://someone.else/open?pr=acme/web%231", "x".repeat(3000)]) {
    assert.equal(clipboardPullRequest(t), undefined, JSON.stringify(t.slice(0, 60)));
  }
});
