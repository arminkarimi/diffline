import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { buildPage } from "../src/vscode/page.ts";

const TEMPLATE = `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>
<script src="review-data.js"></script>
<script src="app.js"></script>
</body></html>`;

test("buildPage: diff text with replacement patterns, script tags and line separators survives intact", () => {
  const tricky = [
    "echo $'a\\tb'", // $' inserts what follows the match
    "x=$`date`", // $` inserts what precedes it
    "s/$&/x/", // $& inserts the match
    "price: $$5",
    "</script><script>alert(1)</script>",
    "<!-- comment",
    `line${String.fromCharCode(0x2028)}separator`,
  ];
  const data = { files: [{ path: "a.sh", lines: tricky }] };
  const html = buildPage(TEMPLATE, { csp: "default-src 'none'", nonce: "n0nce", stylesUrl: "S", appUrl: "A", shim: "", data, live: { pr: 1 } });

  // Exactly one inline script, ending where it should, and the template around it unchanged.
  const scripts = [...html.matchAll(/<script nonce="n0nce">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(html.match(/<script/g)?.length, 2, "only the data script and app.js");
  assert.ok(html.includes('<script nonce="n0nce" src="A"></script>'));
  assert.ok(html.includes('href="S"'));
  assert.ok(html.includes(`content="default-src 'none'"`));

  const sandbox: Record<string, any> = { window: {} };
  vm.runInNewContext(scripts[0][1], sandbox);
  assert.equal(JSON.stringify(sandbox.window.REVIEW_DATA), JSON.stringify(data));
  assert.equal(JSON.stringify(sandbox.window.DIFFLINE_LIVE), "{\"pr\":1}");
});
