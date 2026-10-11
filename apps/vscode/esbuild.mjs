// Bundles the extension and copies the shared Diffline UI (packages/review-ui) into media/ui.
// --production minifies and writes no sourcemap (it also removes a stale one from a dev build), for the .vsix.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

async function copyUi() {
  const out = path.join(root, "media", "ui");
  await mkdir(out, { recursive: true });
  for (const name of ["index.html", "app.js", "styles.css"]) {
    await cp(path.join(root, "..", "..", "packages", "review-ui", name), path.join(out, name));
  }
}

const options = {
  entryPoints: [path.join(root, "src", "extension.ts")],
  bundle: true,
  outfile: path.join(root, "dist", "extension.cjs"),
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

await copyUi();
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  if (production) await rm(`${options.outfile}.map`, { force: true });
  await build(options);
}
