// Times opening one pull request by link in a real VS Code (scripts/open-timing.sh). Read-only against GitHub: a few
// detail queries and the sidebar's usual startup refresh. Agents never run. Prints timings only, never the pull request.
const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const PR = process.env.DIFFLINE_SMOKE_PR;
const RUNS = Math.max(1, Number(process.env.DIFFLINE_TIMING_RUNS || 2));
const LABEL = process.env.DIFFLINE_TIMING_LABEL || "pr";

exports.run = async () => {
  const out = [];
  const say = (s) => { out.push(s); console.log(`[timing] ${s}`); };
  const ext = vscode.extensions.getExtension("arminkarimi.diffline");
  assert.ok(ext, "extension is installed");
  const api = await ext.activate();
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(PR || "");
  assert.ok(m, "DIFFLINE_SMOKE_PR is owner/name#number");
  const key = { owner: m[1], name: m[2], number: Number(m[3]) };

  // Opens start once the sidebar's startup refresh and its background searches are done, as when VS Code has been open a while.
  await until(() => api.service.lastRefresh || api.service.lastError, 90000, "the startup refresh");
  await wait(8000);

  /** Open by link the way the version under test does it, and wait for its timing. */
  const open = async (what) => {
    const before = api.panel.timings.length;
    if (typeof api.openLink === "function") await api.openLink(key);
    else {
      // Before links: Open a Pull Request… pinned it, refreshed the whole list and opened the panel.
      await api.service.pin(key);
      void api.service.refresh().catch(() => undefined);
      await api.panel.show(key);
    }
    const t0 = Date.now();
    const t = await until(() => api.panel.timings.length > before && api.panel.timings[api.panel.timings.length - 1], 120000, "the open's timing");
    const { key: _key, line, ...rest } = t;
    say(`${LABEL} ${what}: ${JSON.stringify(rest)}`);
    say(`${LABEL} ${what}: ${line.replace(PR, "<pr>")} [waited ${Date.now() - t0} ms, page ${api.panel.html.length} chars]`);
    return t;
  };
  const id = `${key.owner}/${key.name}#${key.number}`.toLowerCase();

  await open("cold");
  for (let i = 0; i < RUNS; i++) {
    // The diff is cached on disk; the detail comes from GitHub again (VS Code opened earlier, or the cache aged out).
    api.panel.dispose();
    api.service.details.delete(id);
    await wait(1500);
    await open(`warm ${i + 1}`);
  }
  for (let i = 0; i < RUNS; i++) {
    // Opened earlier in this window: the detail is in memory too.
    api.panel.dispose();
    await wait(1500);
    await open(`cached ${i + 1}`);
  }
  await wait(3000); // the cached opens check GitHub after showing
  fs.writeFileSync(process.env.DIFFLINE_SMOKE_OUT, out.join("\n") + "\nOK\n");
};
