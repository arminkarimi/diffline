import assert from "node:assert/strict";
import { test } from "node:test";

import { isGenerated } from "../src/files.ts";

test("isGenerated: lockfiles, minified bundles, snapshots and build output, at any depth", () => {
  for (const path of ["package-lock.json", "web/package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "Gemfile.lock", "assets/app.min.js", "assets/app.min.css", "src/__snapshots__/view.test.ts.snap", "dist/index.js", "packages/ui/dist/ui.js"]) {
    assert.equal(isGenerated(path), true, path);
  }
});

test("isGenerated: ordinary source and look-alikes aren't", () => {
  for (const path of ["package.json", "src/lock.json", "yarn.lock.md", "app.min.ts", "src/distance.ts", "distribution/notes.md", "mydist/x.js", "Cargo.toml", "go.mod"]) {
    assert.equal(isGenerated(path), false, path);
  }
});
