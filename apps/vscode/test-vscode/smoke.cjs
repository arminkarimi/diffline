// Runs inside a real VS Code extension host (scripts/vscode-smoke.sh). Read-only against GitHub; agents never run.
const vscode = require("vscode");
const assert = require("node:assert/strict");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// The pull request to open, from scripts/vscode-smoke.sh (DIFFLINE_SMOKE_PR).
const PR = process.env.DIFFLINE_SMOKE_PR;

exports.run = async () => {
  const log = [];
  const step = (s) => { log.push(s); console.log(`[smoke] ${s}`); };
  const ext = vscode.extensions.getExtension("arminkarimi.diffline");
  assert.ok(ext, "extension is installed");
  let t = Date.now();
  const api = await ext.activate();
  step(`activated in ${Date.now() - t} ms`);

  const commands = await vscode.commands.getCommands(true);
  for (const c of ["diffline.refresh", "diffline.open", "diffline.openPullRequest", "diffline.runAgents", "diffline.cancelAgents", "diffline.selectHarness", "diffline.editAgentInstructions", "diffline.resetAgentSettings", "diffline.showLog", "diffline.newAgent", "diffline.removeAgent", "diffline.openHome", "diffline.groupBy", "diffline.sortBy", "diffline.showMetrics", "diffline.deleteMetrics", "diffline.copyAgentReview"]) {
    assert.ok(commands.includes(c), `command ${c} is registered`);
  }
  step("commands registered");

  t = Date.now();
  await vscode.commands.executeCommand("diffline.refresh");
  const rows = api.service.all().filter((r) => r.summary);
  step(`refresh listed ${rows.length} pull requests in ${Date.now() - t} ms (viewer ${api.service.viewer && api.service.viewer.login}, error ${api.service.lastError})`);
  assert.ok(rows.length > 0, "the list has pull requests");
  assert.equal(api.service.all().filter((r) => ["queued", "running"].includes(r.run.state)).length, 0, "no agents ran (autoRun is off)");

  t = Date.now();
  await vscode.commands.executeCommand("diffline.open", PR);
  await until(() => api.panel.html.includes("window.REVIEW_DATA"), 60000, "the review page");
  step(`opened ${PR} in ${Date.now() - t} ms`);
  const html = api.panel.html;
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /window\.DIFFLINE_HOST/);
  assert.match(html, /nonce-/);
  assert.ok(!html.includes('src="review-data.js"'), "the data script was replaced");

  t = Date.now();
  await vscode.commands.executeCommand("diffline.open", PR);
  await until(() => api.panel.html.includes("window.REVIEW_DATA"), 60000, "the review page again");
  step(`reopened ${PR} in ${Date.now() - t} ms (diff from cache)`);

  const risks = await Promise.all(rows.slice(0, 5).map((r) => api.service.risk(r)));
  step(`risk scores: ${risks.map((r) => r.score).join(", ")}`);
  t = Date.now();
  await vscode.commands.executeCommand("diffline.openHome");
  step(`home with a review open: switched to the list in ${Date.now() - t} ms`);

  api.panel.dispose();
  t = Date.now();
  await vscode.commands.executeCommand("diffline.openHome");
  await until(() => api.panel.html.includes('"startView":"inbox"'), 60000, "the home page");
  const groups = JSON.parse(api.panel.html.match(/"groups":(\[.*?\]),"grouping"/)[1]);
  step(`home from scratch in ${Date.now() - t} ms: ${groups.map((g) => `${g.label} (${g.keys.length})`).join(", ")}`);
  assert.ok(groups.length > 0, "the home page has groups");

  // The review metrics report: from an open page it switches in place; from scratch the page opens on it.
  await vscode.commands.executeCommand("diffline.showMetrics");
  api.panel.dispose();
  t = Date.now();
  await vscode.commands.executeCommand("diffline.showMetrics");
  await until(() => api.panel.html.includes('"startView":"metrics"'), 60000, "the review metrics page");
  const report = await api.service.metricsReport({ days: 30, groupBy: "agent" });
  step(`review metrics page in ${Date.now() - t} ms: ${report.report.total} events in the log, metrics ${report.enabled ? "on" : "off"}`);

  // A fresh profile gets agents.yml in the current format: each agent with its name and focus.
  const yml = require("node:fs").readFileSync(require("node:path").join(process.env.DIFFLINE_HOME, "agents.yml"), "utf8");
  assert.match(yml, /  security:\n    name: "?Security agent"?\n    focus: /);
  step("agent settings written with names and focus lines");

  require("node:fs").writeFileSync(process.env.DIFFLINE_SMOKE_OUT, log.join("\n") + "\nOK\n");
};
