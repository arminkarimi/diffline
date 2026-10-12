/* Diffline's review page. It runs in the VS Code extension's webview, which sets three globals before this script:
 * window.REVIEW_DATA (the diff), window.DIFFLINE_LIVE (the pull request from GitHub, the agents' results and the saved
 * review state) and window.DIFFLINE_HOST (the bridge back to the extension). */
(() => {
"use strict";

const D = window.REVIEW_DATA;
const LIVE = window.DIFFLINE_LIVE;
const HOST = window.DIFFLINE_HOST;
const app = document.getElementById("app");
if (!LIVE || !HOST || !D || !Array.isArray(D.files)) {
  app.innerHTML = `<div class="missing"><p class="eyebrow">Diffline</p><h1>Open this review in VS Code</h1>
    <p>This page is part of the Diffline extension. Open a pull request from the Diffline sidebar.</p></div>`;
  return;
}

/* ---------- Helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const icon = (name, cls = "") => `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const num = (n) => Number(n || 0).toLocaleString("en-US"); // 13288 → "13,288"
const uid = () => "d" + Math.random().toString(36).slice(2, 9);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const joinNames = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const mq = (q) => window.matchMedia(q);
const reduced = mq("(prefers-reduced-motion: reduce)");
const coarse = mq("(pointer: coarse)");
const narrow = mq("(max-width: 1099px)");
const phone = mq("(max-width: 699px)");
const wide = mq("(min-width: 1280px)");
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

function replaceHTML(target, html) {
  const el = typeof target === "string" ? $(target) : target;
  if (el) el.outerHTML = html;
}

// The review state (drafts, review marks, decisions) belongs to the page. The extension saves it on this machine.
const liveState = LIVE.state || {};
let liveSync = "saved", liveSyncError = "", flushTimer = null;

const api = (method, path, body) => HOST.api(method, path, body);
const reloadPage = () => HOST.reload();

// What the reviewer does with agent findings, and the reviews they post, go to the extension's local review metrics
// (when they're turned on there). Only ids, actions, reasons and counts: the extension adds the rest from the agent
// review it stored.
function sendMetrics(events) {
  if (!events.length || typeof HOST.metrics !== "function") return;
  try { HOST.metrics({ head: D.head && D.head.sha, run: (LIVE.agent && LIVE.agent.ranAt) || null, events }); } catch { /* metrics are best effort */ }
}

async function flushLiveState() {
  clearTimeout(flushTimer);
  try {
    await api("PUT", "/state", liveState);
    liveSync = "saved";
  } catch (err) {
    liveSync = "error";
    liveSyncError = err.message;
  }
  const el = document.getElementById("sync");
  if (el) el.outerHTML = syncHTML();
}

const store = {
  read(name, fallback) { return liveState[name] === undefined ? fallback : liveState[name]; },
  write(name, value) {
    liveState[name] = value;
    liveSync = "saving";
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushLiveState, 350);
  },
};

/* ---------- Time ---------- */

const nowISO = () => new Date().toISOString();
const fmt = (opts) => new Intl.DateTimeFormat("en-US", opts);
const F_DAY = fmt({ weekday: "long" });
const F_DATE = fmt({ weekday: "short", month: "short", day: "numeric" });
const F_YMD = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const dayDiff = (a, b) => Math.round((Date.parse(F_YMD.format(b)) - Date.parse(F_YMD.format(a))) / 864e5);

function ago(iso) {
  const then = new Date(iso);
  const now = new Date(nowISO());
  const secs = (now - then) / 1000;
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min ago`;
  const days = dayDiff(then, now);
  if (days === 0) return plural(Math.round(secs / 3600), "hour") + " ago";
  if (days === 1) return "yesterday";
  if (days < 7) return F_DAY.format(then);
  return F_DATE.format(then);
}

/* ---------- People, the pull request and its threads, from GitHub ---------- */

const livePid = (login) => (LIVE.viewer && login && login === LIVE.viewer.login ? "you" : login || "ghost");
// GitHub bodies can carry HTML (bot badges, <details>). Keep the text and the images' alt text.
const stripHtmlComments = (text) => String(text || "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/gi, "$1")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/?(?:p|div|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|blockquote)\b[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

function hueOf(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function initialsOf(name) {
  const parts = String(name || "?").split(/[\s._-]+/).filter(Boolean);
  const first = parts[0] || "?";
  return (first[0] + (parts[1] ? parts[1][0] : first[1] || "")).toUpperCase();
}

function livePeople() {
  const people = {};
  const add = (login, name) => {
    if (!login) return;
    const id = livePid(login);
    if (people[id]) return;
    const display = name || login;
    people[id] = { name: display, short: id === "you" ? "you" : display.split(" ")[0], initials: initialsOf(display), hue: hueOf(login), login };
  };
  if (LIVE.viewer) add(LIVE.viewer.login, LIVE.viewer.name);
  const p = LIVE.pr || {};
  if (p.author) add(p.author.login, p.author.name);
  [...(p.reviewRequests || []), ...(p.latestReviews || []), ...(p.reviews || []), ...(p.comments || [])].forEach((x) => add(x.login, x.name));
  (LIVE.threads || []).forEach((t) => t.comments.forEach((c) => add(c.login, c.name)));
  (LIVE.list || []).forEach((it) => it.author && add(it.author.login, it.author.name));
  if (!people.you) people.you = { name: "You", short: "you", initials: "YO", hue: 222 };
  if (!people.ghost) people.ghost = { name: "Someone", short: "someone", initials: "?", hue: 220 };
  return people;
}

function liveTimeline() {
  const p = LIVE.pr || {};
  const out = [];
  const words = { APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "had a review dismissed" };
  if (p.createdAt) out.push({ at: p.createdAt, who: p.author ? livePid(p.author.login) : null, icon: "pr", text: `opened this pull request with ${plural((D.commits || []).length, "commit")}` });
  (p.reviews || []).forEach((r) => {
    if (r.submittedAt) out.push({ at: r.submittedAt, who: livePid(r.login), icon: r.state === "APPROVED" ? "check-circle" : r.state === "CHANGES_REQUESTED" ? "x-circle" : "eye", text: words[r.state] || "reviewed", body: stripHtmlComments(r.body) });
  });
  (p.comments || []).forEach((c) => { if (c.createdAt) out.push({ at: c.createdAt, who: livePid(c.login), icon: "message", text: "commented", body: stripHtmlComments(c.body) }); });
  const ag = LIVE.agent;
  if (ag && ag.ranAt) out.push({ at: ag.ranAt, agent: true, icon: "bot", text: `<b>Review agents</b> ran on <code>${esc(String(ag.commit || "").slice(0, 7))}</code> and left ${plural((ag.findings || []).length, "finding")}` });
  return out;
}

function livePR() {
  const p = LIVE.pr || {};
  const ag = LIVE.agent || {};
  return {
    number: LIVE.number,
    repo: LIVE.repo,
    title: p.title || `Pull request #${LIVE.number}`,
    author: p.author ? livePid(p.author.login) : "ghost",
    opened: p.createdAt || ((D.commits || [])[0] || {}).date || new Date().toISOString(),
    description: stripHtmlComments(p.body),
    lastReview: { at: p.lastReview ? p.lastReview.submittedAt : null, files: p.viewedFiles || [] },
    plan: (ag.plan && ag.plan.chapters) || [],
    planReasons: (ag.plan && ag.plan.reasons) || [],
    threads: [],
    timeline: liveTimeline(),
  };
}

const PEOPLE = livePeople();
const nameOf = (id) => (id === "you" ? "You" : PEOPLE[id]?.name || id);
const avatar = (id, size = "") => {
  const p = PEOPLE[id] || { initials: "?", hue: 220, name: id };
  return `<span class="av${size ? " " + size : ""}" style="--h:${p.hue}" title="${esc(p.name)}" aria-hidden="true">${p.initials}</span>`;
};

const PR = livePR();
// Your own pull request reads differently: "you pushed", "your description", "your reviewers".
const ownPR = () => PR.author === "you";
const authorShort = (start) => (ownPR() ? (start ? "You" : "you") : PEOPLE[PR.author].short);

const STAGE_NOTE_AGENTS = "Agents never approve or block. Their findings guide the human review, and a person decides on each one.";

// The review agents and what they found: the agent run the extension stored for this pull request.
const AG = LIVE.agent || null;
const AGENTS = ((AG && AG.agents) || []).map((a) => ({ ...a, short: a.short || a.name }));
const AGENT_BY = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
const AGENT_RUN_AT = (AG && AG.ranAt) || null;
const SEV = { high: "High", medium: "Medium", low: "Low" };
const SEV_RANK = { high: 3, medium: 2, low: 1 };
const DISMISS_REASONS = ["Not a problem", "Intended", "Out of scope"];
const BRIEF_LEDE = (AG && AG.lede) || "";
const FINDINGS = ((AG && AG.findings) || []).filter((x) => AGENT_BY[x.agent]);
const CHECKED = ((AG && AG.checked) || []).filter((c) => AGENT_BY[c.agent]);

/* The guide's description check. The team's rules say what a description covers for each kind of change. The guide
   checks the description against them before the other agents start and hands them what it found, so a gap in the
   description becomes a question rather than a guess. Which rules apply to each kind is a setting of the guide agent. */
const DESC_RULES = {
  what: { title: "What changes", noun: "what changes", text: "What the change is" },
  why: { title: "Why", noun: "the why", text: "Why the change is needed" },
  evidence: { title: "Evidence", noun: "evidence", text: "Usage, metrics or log data that show why the change was needed" },
  diagram: { title: "Diagram", noun: "a diagram", text: "A supporting diagram, such as the architecture or a sequence" },
  rollout: { title: "Rollout", noun: "rollout notes", text: "Notes on how it rolls out" },
  dependencies: { title: "Dependencies", noun: "dependencies", text: "Other pull requests it depends on that aren't linked to it, especially in other repositories" },
  risks: { title: "Risks", noun: "risks", text: "Any risks, and what's out of scope" },
};
const DESC_RULE_ORDER = Object.keys(DESC_RULES);
const DESC_KINDS = { feature: "New feature", fix: "Bug fix or improvement" };
const DESC_STATUS = { covered: "Covered", partly: "Partly", missing: "Missing", none: "None found" };
const DESC_ICON = { covered: "check-circle", partly: "circle", missing: "x-circle", none: "minus" };
const DESC_SKIP_REASONS = ["Not needed here", "Covered elsewhere"];
const DESC = (AG && AG.description) || null;
// The guide agent's diagrams of how the change works. Each box names the diff lines it stands for,
// the same way findings do, and pins the findings that happen in that step.
const DIAGRAM_DATA = (AG && AG.diagrams) || [];
const STAGE_ICONS = { checks: "checks", agents: "bot", review: "eye", merge: "merge" };

/* ---------- Model built from the exported diff ---------- */

function hashStr(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const commits = D.commits || [];
const files = D.files.map((f, i) => {
  const parts = f.path.split("/");
  const base = parts.pop();
  return {
    ...f, i, base,
    dir: parts.length ? parts.join("/") + "/" : "",
    hunks: f.hunks.map((h, j) => ({ ...h, i: j, key: `${i}:${j}`, id: hashStr(`${f.path}\n${h.lines.map((l) => l[0] + l[3]).join("\n")}`), weight: h.lines.filter((l) => l[0] !== " ").length })),
  };
});
const byPath = new Map(files.map((f) => [f.path, f]));
// Large pull requests: the browser skips layout and paint for files outside the viewport (see .many-files in styles.css).
if (files.length > 40 || files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0) > 4000) {
  document.documentElement.classList.add("many-files");
}
const HUNK = new Map();
const HUNK_ID = new Map();
const LINE_HUNK = new Map();
const lineKey = (l) => (l[0] === "-" ? `o${l[1]}` : `n${l[2]}`);
files.forEach((f) => f.hunks.forEach((h) => {
  HUNK.set(h.key, { f, h });
  HUNK_ID.set(h.id, h.key);
  h.lines.forEach((l) => LINE_HUNK.set(`${f.i}:${lineKey(l)}`, h.key));
}));

// Import graph between changed files. Type-only imports don't set the reading order.
function resolveImport(from, spec) {
  const parts = from.split("/");
  parts.pop();
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const base = parts.join("/");
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
    const f = byPath.get(cand);
    if (f) return f;
  }
  return null;
}

function importsOf(f) {
  if (!f.content || !/^(ts|tsx)$/.test(f.lang)) return [];
  const out = new Set();
  for (const line of f.content) {
    if (/^\s*(import|export)\s+type\b/.test(line)) continue;
    const m = line.match(/^\s*(?:import|export)\b.*?\bfrom\s+["']([^"']+)["']/) || line.match(/^\s*\}\s*from\s+["']([^"']+)["']/) || line.match(/^\s*import\s+["']([^"']+)["']/);
    if (!m || !m[1].startsWith(".")) continue;
    const target = resolveImport(f.path, m[1]);
    if (target && target !== f) out.add(target.i);
  }
  return [...out];
}
files.forEach((f) => { f.uses = importsOf(f); });

// Files that define things come before the files that use them.
function depOrder(fs) {
  const inSet = new Set(fs.map((f) => f.i));
  const done = new Set(), out = [];
  const visit = (f, stack) => {
    if (done.has(f.i) || stack.has(f.i)) return;
    stack.add(f.i);
    f.uses.filter((d) => inSet.has(d)).map((d) => files[d]).forEach((d) => visit(d, stack));
    stack.delete(f.i);
    done.add(f.i);
    out.push(f);
  };
  fs.forEach((f) => visit(f, new Set()));
  return out;
}

const clonePlan = (plan) => plan.map((c) => ({ ...c, source: c.source ? { ...c.source } : null, files: [...c.files] }));

function planChapters(plan) {
  const used = new Set();
  const out = [];
  for (const c of plan) {
    const fs = c.files.map((p) => byPath.get(p)).filter((f) => f && !used.has(f.path));
    fs.forEach((f) => used.add(f.path));
    if (fs.length) out.push({ ...c, files: fs, kind: "plan" });
  }
  if (!out.length) return null;
  const rest = files.filter((f) => !used.has(f.path));
  if (rest.length) out.push({ title: "Other changes", note: "Files the chapters don't cover yet.", files: depOrder(rest), kind: "plan", source: { kind: "auto", text: "Not in any chapter" } });
  return out;
}

// Used when nobody drafted chapters, for example for a diff from another repository.
function layerChapters(fs) {
  const isTest = (f) => /\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(f.path);
  const isQuiet = (f) => f.generated || /\.(md|json|ya?ml|lock|toml|txt)$/i.test(f.path) || /(^|\/)\./.test(f.path);
  const layerOf = (f) => (/(^|\/)(migrations?|db|schema|models?|prisma)\//i.test(f.path) || /\.(sql|prisma)$/i.test(f.path) ? "data"
    : /(^|\/)(web|components|pages|views|ui)\//i.test(f.path) || /\.(tsx|jsx|vue|svelte|css|scss)$/i.test(f.path) ? "ui" : "logic");
  const groups = { data: [], logic: [], ui: [], tests: [], quiet: [] };
  fs.forEach((f) => groups[isTest(f) ? "tests" : isQuiet(f) ? "quiet" : layerOf(f)].push(f));
  const copy = {
    data: ["Data and schema", "Migrations and data access. The rest depends on them, so read these first."],
    logic: ["Core logic", "In dependency order: files that define things come before the files that use them."],
    ui: ["Interface", "What people see, built on the logic above."],
    tests: ["Tests", "Tests for the changes above."],
    quiet: ["Configuration and docs", "Dependencies, configuration and docs."],
  };
  return Object.keys(copy).filter((k) => groups[k].length).map((k) => ({
    title: copy[k][0], note: copy[k][1], files: depOrder(groups[k]), quiet: k === "quiet", kind: "auto",
  }));
}

// Each file goes with the commit that wrote most of its added lines.
function commitChapters() {
  const byCommit = new Map();
  for (const f of files) {
    const tally = new Map();
    f.hunks.forEach((h) => h.lines.forEach((l) => { if (l[0] === "+" && l[4] >= 0) tally.set(l[4], (tally.get(l[4]) || 0) + 1); }));
    let best = commits.length ? 0 : -1, most = -1;
    tally.forEach((n, ci) => { if (n > most) { most = n; best = ci; } });
    if (!byCommit.has(best)) byCommit.set(best, []);
    byCommit.get(best).push(f);
  }
  return [...byCommit.keys()].sort((a, b) => a - b).map((ci) => {
    const c = commits[ci];
    const note = c && c.body ? c.body.split(/\n\s*\n/)[0].split("\n").map((l) => l.trim().replace(/^[-*]\s+/, "")).filter(Boolean).join(" · ").replace(/: · /g, ": ") : "";
    return { title: c ? c.subject : "Other changes", note, files: depOrder(byCommit.get(ci)), kind: "commit", commit: ci };
  });
}

function folderChapters() {
  const byDir = new Map();
  files.forEach((f) => {
    const dir = f.dir.replace(/\/$/, "") || "Repository root";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  });
  return [...byDir.keys()].sort().map((dir) => ({ title: dir, note: "", files: byDir.get(dir).sort((a, b) => a.base.localeCompare(b.base)), kind: "folder" }));
}

let chapters = [];
let ORDER = [];
function rebuildChapters() {
  const list = S.grouping === "commits" ? commitChapters()
    : S.grouping === "folders" ? folderChapters()
    : planChapters(S.plan) || layerChapters(files);
  chapters = list.map((c, i) => ({ ...c, n: i + 1 }));
  files.forEach((f) => { f.ch = null; });
  chapters.forEach((c) => c.files.forEach((f) => { f.ch = c.n; }));
  ORDER = chapters.flatMap((c) => c.files.flatMap((f) => f.hunks.map((h) => h.key)));
}
const PACE = 24; // changed lines a reviewer reads per minute
const sinceIdx = D.since ? D.since.index : null;
const newCommits = sinceIdx == null ? [] : commits.slice(sinceIdx + 1);

function anchorFor(path, match) {
  const f = byPath.get(path);
  if (!f) return null;
  for (const h of f.hunks) for (const l of h.lines) if (l[3].includes(match)) return { f: f.i, k: lineKey(l) };
  return { f: f.i, k: "file" };
}

const LABEL_PREFIX = /^\s*\**(nit|question|blocking|suggestion|praise)\**\s*(?:\([^)]*\))?\s*:\s*/i;

function liveThreads() {
  return (LIVE.threads || []).map((t) => {
    const f = byPath.get(t.path);
    if (!f || !t.comments.length) return null;
    let k = t.line ? (t.side === "LEFT" ? `o${t.line}` : `n${t.line}`) : "file";
    if (k !== "file" && !LINE_HUNK.has(`${f.i}:${k}`)) k = "file";
    const bodies = t.comments.map((c) => stripHtmlComments(c.body));
    const m = bodies[0].match(LABEL_PREFIX);
    return {
      id: t.id, gh: true, f: f.i, k, label: m ? m[1].toLowerCase() : "", outdated: t.outdated,
      state: t.resolved ? "resolved" : "open", origin: t.resolved ? "resolved" : "open",
      comments: t.comments.map((c, i) => ({ by: livePid(c.login), at: c.createdAt, body: i === 0 && m ? bodies[0].slice(m[0].length) : bodies[i], url: c.url, dbId: c.dbId })),
    };
  }).filter(Boolean);
}

function applyThreadActions(threads, actions) {
  threads.forEach((t) => {
    const a = actions[t.id];
    if (a === "resolve") { t.state = "resolved"; t.pending = "resolve"; t.resolvedBy = "you"; }
    if (a === "unresolve") { t.state = "open"; t.pending = "unresolve"; }
  });
  return threads;
}

// Findings anchor to diff lines by their text.
const FIND = FINDINGS.map((x) => {
  const a = anchorFor(x.path, x.match);
  if (!a || a.k === "file") return null;
  const steps = (x.steps || []).map((st) => ({ ...st, ...anchorFor(st.path || x.path, st.match) })).filter((st) => st.k && st.k !== "file");
  return { ...x, f: a.f, k: a.k, hunk: LINE_HUNK.get(`${a.f}:${a.k}`), steps };
}).filter(Boolean);

// The description check, in rule order, with its references to the diff resolved like a finding's steps.
const DESC_ITEMS = (DESC && DESC_KINDS[DESC.kind] ? DESC.items || [] : [])
  .filter((it) => DESC_RULES[it.rule] && DESC_STATUS[it.status])
  .map((it) => ({ ...it, refs: (it.refs || []).map((r) => ({ ...r, ...anchorFor(r.path, r.match) })).filter((r) => r.k && r.k !== "file") }))
  .sort((a, b) => DESC_RULE_ORDER.indexOf(a.rule) - DESC_RULE_ORDER.indexOf(b.rule));
const descIsGap = (it) => it.status === "partly" || it.status === "missing";
const DESC_GAPS = DESC_ITEMS.filter(descIsGap);
const descNorm = (s) => String(s || "").replace(/\s+/g, " ").trim();
// A quote the description no longer contains means it was edited after the check ran.
const DESC_STALE = DESC_ITEMS.some((it) => it.quote && !descNorm(PR.description).includes(descNorm(it.quote)));

function defaultReviewed() {
  const seen = new Set(PR.lastReview.files);
  return files.flatMap((f) => (seen.has(f.path) ? f.hunks.filter((h) => !h.fresh).map((h) => h.key) : []));
}

/* Drafts outlive new commits. A draft stays on its line while that line is in the diff. When a push moves or removes
   it, the draft follows its line's text (saved with it, or the finding it came from) to wherever that is now. With no
   match it stays detached, listed in Drafts to copy or delete, and never lands on another file's line. */

function findDiffLine(text, preferPath) {
  const needle = String(text).trim();
  if (!needle) return null;
  const order = [...files].sort((a, b) => (b.path === preferPath) - (a.path === preferPath));
  let deleted = null;
  for (const f of order) for (const h of f.hunks) for (const l of h.lines) {
    if (!l[3].includes(needle)) continue;
    if (l[0] !== "-") return { f: f.i, k: lineKey(l) };
    deleted = deleted || { f: f.i, k: lineKey(l) };
  }
  return deleted;
}

/* Finding ids come from the agent and the line a finding is on, so a finding that comes back on a later run keeps its
   id and the decision made on it. Each decision records the run (the agent file's ranAt) it was made on, and decisions
   for findings that aren't in this run stay saved as history. Ids from before that ("f1", "f2", …) only numbered a
   run's findings: a decision on one counts only with the run it was made on, which older decisions don't have. */
const LEGACY_ID = /^f\d+$/;
const SAVED_FINDINGS = store.read("findings", {}) || {};
const validDecision = (id, rec) => !!(rec && rec.state) && (!LEGACY_ID.test(id) || (!!rec.run && rec.run === AGENT_RUN_AT));

function placeDraft(d) {
  if (d.replyTo) return d;
  // A draft from a finding with an old positional id can't be tied to this run's finding.
  if (d.fromFinding && LEGACY_ID.test(d.fromFinding) && !validDecision(d.fromFinding, SAVED_FINDINGS[d.fromFinding])) d = { ...d, fromFinding: null };
  // What the draft's line should say: its own saved text, or the line its finding points at.
  const finding = d.fromFinding ? FINDINGS.find((x) => x.id === d.fromFinding) : null;
  const expected = String(d.lineText || (finding && finding.match) || "").trim();
  const f = d.path ? byPath.get(d.path) : files[d.f];
  const here = f && LINE_HUNK.has(`${f.i}:${d.k}`) ? lineText(f.i, d.k) : null;
  if (here != null && (!expected || String(here).includes(expected))) {
    return { ...d, f: f.i, lineText: d.lineText || here, detached: false, moved: false, placed: !d.lineText };
  }
  const hit = expected ? findDiffLine(expected, d.path || (finding && finding.path)) : null;
  if (hit) return { ...d, f: hit.f, k: hit.k, path: files[hit.f].path, lineText: lineText(hit.f, hit.k), detached: false, moved: true, placed: true };
  return { ...d, f: null, detached: true };
}

/* ---------- State ---------- */

const prefs = store.read("prefs", {});
const S = {
  view: "pr",
  tab: "changes",
  filter: "all",
  fold: prefs.fold !== false,
  split: !!prefs.split,
  banner: prefs.banner !== false,
  reviewed: new Set((store.read("reviewedIds", null) || defaultReviewed().map((k) => HUNK.get(k).h.id)).map((id) => HUNK_ID.get(id)).filter(Boolean)),
  drafts: (store.read("drafts", []) || []).map(placeDraft).filter((d) => d.replyTo || d.detached || (d.f != null && files[d.f])),
  threadActions: store.read("threadActions", {}) || {},
  threads: liveThreads(),
  opened: new Set(),      // reviewed hunks the reader unfolded
  fileOpen: new Set(),    // files the reader expanded by hand
  fileShut: new Set(),    // files the reader collapsed by hand
  gaps: new Set(),        // expanded unchanged regions, "file:index"
  longOpen: new Set(),    // long changed lines the reader unfolded, "file:line"
  raw: new Set(),         // lockfiles showing the raw diff
  openThreads: new Set(), // resolved threads the reader expanded
  focus: null,
  composer: null,
  sheet: null,
  current: null,
  palIdx: 0,
  palList: [],
  findings: SAVED_FINDINGS, // finding id -> { state: "accepted" | "dismissed", reason, draft, at, run, title }
  desc: store.read("desc", {}) || {},    // description rule -> { state: "asked" | "skipped", reason, at }
  descSkipping: null,
  brief: prefs.brief !== false,
  checkedOpen: false,
  evidence: new Set(),
  answers: new Set(),
  dismissing: null,
  lastFinding: null,
  grouping: ["chapters", "commits", "folders"].includes(prefs.grouping) ? prefs.grouping : "chapters",
  plan: (store.read("plan", null) || []).length ? store.read("plan", null) : clonePlan(PR.plan),
  planState: store.read("planState", "draft"), // draft | edited
  pushDecision: null,
  pushSummary: store.read("pushSummary", "") || "",
  pushConfirm: false,
  pushBusy: false,
  planDraft: null,
};
applyThreadActions(S.threads, S.threadActions);
if (S.drafts.some((d) => d.placed)) {
  S.drafts.forEach((d) => { delete d.placed; });
  save();
}
rebuildChapters();

function save() {
  store.write("reviewedIds", [...S.reviewed].map((k) => HUNK.get(k)?.h.id).filter(Boolean));
  store.write("drafts", S.drafts.map((d) => (d.f != null && files[d.f] ? { ...d, path: files[d.f].path } : d)));
  store.write("threadActions", S.threadActions);
  store.write("findings", S.findings);
  store.write("desc", S.desc);
  store.write("pushSummary", S.pushSummary);
  store.write("plan", S.plan);
  store.write("planState", S.planState);
  store.write("prefs", { fold: S.fold, split: S.split, banner: S.banner, brief: S.brief, grouping: S.grouping });
}

/* ---------- Time spent on the review ---------- */

// Time this pull request's page is focused and in use: it counts while the page has focus, up to a minute after the
// last input. It adds up across reloads (saved in the review state) until a review is posted, then starts again.
const IDLE_MS = 60_000;
let activeMs = Math.max(0, Number(store.read("activeMs", 0)) || 0);
let activeSaved = activeMs;
let lastInput = Date.now(), lastTick = Date.now(), pageFocused = document.hasFocus();

function tickActive() {
  const now = Date.now();
  if (pageFocused && S.view === "pr" && document.visibilityState !== "hidden") {
    const until = Math.min(now, lastInput + IDLE_MS);
    if (until > lastTick) activeMs += until - lastTick;
  }
  lastTick = now;
}

function saveActive() {
  tickActive();
  // A small write, at most every 30 s while someone's reviewing.
  if (Math.abs(activeMs - activeSaved) >= 1000) { activeSaved = activeMs; store.write("activeMs", Math.round(activeMs)); }
}

/** The time spent since the page opened or the last review was posted, which starts the count again. */
function takeActiveTime() {
  tickActive();
  const ms = Math.round(activeMs);
  activeMs = activeSaved = 0;
  store.write("activeMs", 0);
  return ms;
}

function watchActivity() {
  const input = () => { tickActive(); lastInput = Date.now(); };
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach((t) => window.addEventListener(t, input, { passive: true, capture: true }));
  let moved = 0;
  window.addEventListener("pointermove", () => { const now = Date.now(); if (now - moved > 5000) { moved = now; input(); } }, { passive: true });
  window.addEventListener("focus", () => { tickActive(); pageFocused = true; lastInput = Date.now(); });
  window.addEventListener("blur", () => { tickActive(); pageFocused = false; saveActive(); });
  document.addEventListener("visibilitychange", () => saveActive());
  window.addEventListener("pagehide", () => saveActive());
  setInterval(saveActive, 30_000);
}

/* ---------- Derived review state ---------- */

const slotKey = (fi, k) => `${fi}:${k}`;
const threadsAt = (fi, k) => S.threads.filter((t) => t.f === fi && t.k === k);
const draftsAt = (fi, k) => S.drafts.filter((d) => !d.replyTo && d.f === fi && d.k === k);
const hunkOfAnchor = (fi, k) => LINE_HUNK.get(slotKey(fi, k));

function hunkTalk(f, h) {
  const inHunk = (x) => x.f === f.i && hunkOfAnchor(x.f, x.k) === h.key;
  return S.threads.some(inHunk) || S.drafts.some((d) => !d.replyTo && inHunk(d));
}

function hunkVisible(f, h) {
  if (S.filter === "new") return h.fresh && !S.reviewed.has(h.key);
  if (S.filter === "todo") return !S.reviewed.has(h.key);
  if (S.filter === "flag") return hunkFlagged(h);
  if (S.filter === "talk") return hunkTalk(f, h);
  return true;
}

function fileVisible(f) {
  if (!f.hunks.length) return S.filter === "all";
  if (S.filter === "talk" && (threadsAt(f.i, "file").length || draftsAt(f.i, "file").length)) return true;
  return f.hunks.some((h) => hunkVisible(f, h));
}

function fileProgress(f) {
  const total = f.hunks.length;
  const done = f.hunks.filter((h) => S.reviewed.has(h.key)).length;
  return { done, total, all: total > 0 && done === total };
}

function chapterProgress(c) {
  let done = 0, total = 0;
  c.files.forEach((f) => { const p = fileProgress(f); done += p.done; total += p.total; });
  return { done, total, all: total > 0 && done === total };
}

const fileState = (f) => { const p = fileProgress(f); return p.all ? "done" : p.done ? "part" : "todo"; };
const isCollapsed = (f) => (S.fileOpen.has(f.i) ? false : S.fileShut.has(f.i) ? true : S.fold && S.filter === "all" && fileProgress(f).all && !fileOpenFindings(f).length);
const hunkOpen = (h) => !S.reviewed.has(h.key) || S.opened.has(h.key) || !S.fold || S.filter === "talk" || S.filter === "flag" || hunkHasOpenFinding(h);
const useSplit = () => S.split && wide.matches;

function counts() {
  let all = 0, reviewed = 0, fresh = 0, talk = 0, flag = 0;
  for (const f of files) for (const h of f.hunks) {
    all++;
    const done = S.reviewed.has(h.key);
    if (done) reviewed++;
    if (h.fresh && !done) fresh++;
    if (hunkTalk(f, h)) talk++;
    if (hunkFlagged(h)) flag++;
  }
  return { all, reviewed, todo: all - reviewed, fresh, talk, flag };
}

const progress = () => { const c = counts(); return c.all ? c.reviewed / c.all : 1; };
function minutesFor(keys) {
  const lines = keys.reduce((sum, k) => { const x = HUNK.get(k); return sum + (x && !x.f.generated ? x.h.weight : 0); }, 0);
  return Math.max(1, Math.round(lines / PACE));
}
const totalMinutes = () => minutesFor(ORDER);
// "16 min", or "about 3 hours" for long reads.
const readTime = (min) => (min < 90 ? `${min} min` : `${Math.round(min / 60)} hours`);
const remainingMinutes = () => minutesFor(ORDER.filter((k) => !S.reviewed.has(k)));
const openThreadCount = () => S.threads.filter((t) => t.state !== "resolved").length;
const decisionOf = (id) => (validDecision(id, S.findings[id]) ? S.findings[id] : null);
const findingState = (x) => { const rec = decisionOf(x.id); return (rec && rec.state) || "open"; };
// A decision made when an earlier agent run flagged the same line.
const earlierRun = (rec) => !!(rec && rec.run && AGENT_RUN_AT && rec.run !== AGENT_RUN_AT);
const findingById = (id) => FIND.find((x) => x.id === id);
const openFindings = () => FIND.filter((x) => findingState(x) === "open");
const highOpen = () => FIND.filter((x) => x.severity === "high" && findingState(x) === "open");
const findingsAt = (fi, k) => FIND.filter((x) => x.f === fi && x.k === k);
const hunkFlagged = (h) => FIND.some((x) => x.hunk === h.key);
const hunkHasOpenFinding = (h) => FIND.some((x) => x.hunk === h.key && findingState(x) === "open");
const fileOpenFindings = (f) => FIND.filter((x) => x.f === f.i && findingState(x) === "open");
const descState = (it) => (S.desc[it.rule] && S.desc[it.rule].state) || "open";
const descOpen = () => DESC_GAPS.filter((it) => descState(it) === "open");

// Asking about a gap adds its question to the review summary, under one heading, so it posts with the review.
const DESC_ASK_HEAD = "Could the description cover these? They'd help the rest of the review.";
const descAskLine = (it) => `- **${DESC_RULES[it.rule].title}:** ${it.ask}`;

function askDescription(items) {
  const rows = S.pushSummary.replace(/\s+$/, "").split("\n");
  const lines = items.map(descAskLine).filter((l) => !rows.includes(l));
  if (lines.length) {
    const last = rows.reduce((at, r, i) => (DESC_GAPS.some((g) => descAskLine(g) === r) ? i : at), -1);
    if (rows.includes(DESC_ASK_HEAD) && last >= 0) rows.splice(last + 1, 0, ...lines);
    else { if (rows.join("").trim()) rows.push(""); rows.push(DESC_ASK_HEAD, "", ...lines); }
    S.pushSummary = rows.join("\n").replace(/^\n+/, "");
  }
  const fresh = items.filter((it) => descState(it) !== "asked");
  items.forEach((it) => { S.desc[it.rule] = { state: "asked", at: nowISO() }; });
  save();
  sendMetrics(fresh.map((it) => ({ kind: "description", action: "asked", rule: it.rule })));
}

// Questions that went out in a posted summary can't be taken back.
function markDescPosted(text) {
  DESC_GAPS.forEach((it) => { if (descState(it) === "asked" && text.includes(descAskLine(it))) S.desc[it.rule].posted = true; });
}

function undoDescription(rule) {
  const it = DESC_ITEMS.find((x) => x.rule === rule);
  const was = it ? descState(it) : "open";
  if (it && descState(it) === "asked") {
    const rows = S.pushSummary.split("\n").filter((r) => r !== descAskLine(it));
    if (!DESC_GAPS.some((g) => rows.includes(descAskLine(g)))) {
      const h = rows.indexOf(DESC_ASK_HEAD);
      if (h >= 0) rows.splice(h, rows[h + 1] === "" ? 2 : 1);
    }
    S.pushSummary = rows.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  delete S.desc[rule];
  save();
  if (was !== "open") sendMetrics([{ kind: "description", action: "undone", rule, reason: was }]);
}

/* ---------- Diagrams: the change as boxes and arrows ---------- */

// A ref names a line by its text and can reach to a later line in the same hunk.
// Removed steps look at deleted lines first, every other step at added and unchanged ones.
function refRange(r, removed) {
  const f = byPath.get(r.path);
  if (!f || !r.match) return null;
  const preferred = (l) => (removed ? l[0] === "-" : l[0] !== "-");
  for (const ok of [preferred, () => true]) {
    for (const h of f.hunks) {
      const from = h.lines.findIndex((l) => ok(l) && l[3].includes(r.match));
      if (from < 0) continue;
      let to = from;
      if (r.end) { const e = h.lines.findIndex((l, x) => x >= from && l[3].includes(r.end)); if (e >= 0) to = e; }
      else if (r.lines) to = Math.min(h.lines.length - 1, from + r.lines - 1);
      return { f: f.i, h: h.key, from, to };
    }
  }
  return null;
}

function inRange(at, x) {
  if (x.hunk !== at.h) return false;
  const idx = HUNK.get(at.h).h.lines.findIndex((l) => lineKey(l) === x.k);
  return idx >= at.from && idx <= at.to;
}

const DIAGRAMS = DIAGRAM_DATA.filter((dg) => dg && Array.isArray(dg.nodes) && dg.nodes.length).map((dg, di) => {
  let num = 0;
  const nodes = dg.nodes.map((n) => {
    const refs = (n.refs || []).map((r) => ({ ...r, at: refRange(r, n.change === "removed") }));
    const ats = refs.filter((r) => r.at).map((r) => r.at);
    const hunks = [...new Set(ats.map((a) => a.h))];
    const finds = n.findings ? n.findings.map(findingById).filter(Boolean) : FIND.filter((x) => ats.some((a) => inRange(a, x)));
    // Boxes with code are numbered: they're the stops when you follow the flow.
    return { ...n, kind: n.kind || "step", refs, hunks, finds, num: hunks.length ? ++num : null };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (dg.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  return { ...dg, id: String(dg.id || `flow-${di + 1}`), short: dg.short || dg.title, nodes, edges, byId: new Map(nodes.map((n) => [n.id, n])), steps: num };
});
const dgById = (id) => DIAGRAMS.find((d) => d.id === id) || null;
const CHANGE_WORD = { added: "New", changed: "Changed", removed: "Removed" };
const initialMap = () => ({ view: DIAGRAMS[0] ? DIAGRAMS[0].id : "files", mode: "diff", sel: null });
S.map = initialMap();
S.tour = null; // { dg, i } while following the flow through the diff

// Before hides what the pull request adds, After hides what it removes. Diff shows both.
function dgView(dg, mode) {
  const hide = mode === "before" ? "added" : mode === "after" ? "removed" : null;
  const nodes = dg.nodes.filter((n) => !hide || n.change !== hide);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = dg.edges.filter((e) => (!hide || e.change !== hide) && ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}
const dgText = (x, mode) => (mode === "before" && x.before ? { ...x, ...x.before } : x);
const dgChanged = (dg) => dg.nodes.some((n) => n.change) || dg.edges.some((e) => e.change);
// A flow that's new from top to bottom has no before picture to flip to.
const dgHasBefore = (dg) => dgChanged(dg) && dgView(dg, "before").nodes.length > 0;

function nodeProgress(n) {
  const done = n.hunks.filter((k) => S.reviewed.has(k)).length;
  return { done, total: n.hunks.length, all: n.hunks.length > 0 && done === n.hunks.length };
}
const nodeFresh = (n) => n.hunks.some((k) => HUNK.get(k).h.fresh && !S.reviewed.has(k));
const liveFinds = (n) => n.finds.filter((x) => findingState(x) !== "dismissed");

function dgCoverage(dg) {
  const touched = new Set(dg.nodes.flatMap((n) => n.hunks));
  return {
    touched: touched.size,
    all: files.reduce((s, f) => s + f.hunks.length, 0),
    outside: chapters.flatMap((c) => c.files).filter((f) => f.hunks.length && !f.hunks.some((h) => touched.has(h.key))),
  };
}

// Following the flow visits every place a numbered box points at, in the agent's order.
function tourStops(dg) {
  return dg.nodes.filter((n) => n.num).flatMap((n) => {
    const ats = n.refs.filter((r) => r.at);
    return ats.map((r, j) => ({ node: n, at: r.at, part: j + 1, parts: ats.length }));
  });
}

// Layered layout: each box sits one row below the lowest box that leads to it. An edge that skips
// rows gets a waypoint in each row it crosses, and rows are ordered so edges cross as little as they can.
function layoutFlow(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const out = new Map(ids.map((id) => [id, []]));
  edges.forEach((e) => out.get(e.from).push(e));
  const back = new Set(), seen = new Map();
  const walk = (id) => {
    seen.set(id, 1);
    out.get(id).forEach((e) => { const s = seen.get(e.to); if (s === 1) back.add(e); else if (!s) walk(e.to); });
    seen.set(id, 2);
  };
  ids.forEach((id) => { if (!seen.has(id)) walk(id); });
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0, moved = true; moved && pass <= ids.length; pass++) {
    moved = false;
    edges.forEach((e) => { if (!back.has(e) && rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); moved = true; } });
  }
  const rows = Array.from({ length: Math.max(0, ...rank.values()) + 1 }, () => []);
  ids.forEach((id) => rows[rank.get(id)].push(`n:${id}`));
  const routes = edges.map((e, i) => {
    const vias = [];
    if (!back.has(e)) for (let r = rank.get(e.from) + 1; r < rank.get(e.to); r++) { rows[r].push(`v:${i}-${r}`); vias.push(`v:${i}-${r}`); }
    return { ...e, i, vias, back: back.has(e) };
  });
  const up = new Map(), down = new Map();
  const link = (m, a, b) => { if (!m.has(a)) m.set(a, []); m.get(a).push(b); };
  routes.filter((r) => !r.back).forEach((r) => {
    const chain = [`n:${r.from}`, ...r.vias, `n:${r.to}`];
    for (let k = 0; k + 1 < chain.length; k++) { link(down, chain[k], chain[k + 1]); link(up, chain[k + 1], chain[k]); }
  });
  const places = () => new Map(rows.flatMap((row) => row.map((key, i) => [key, i - (row.length - 1) / 2])));
  const order = (row, nbrs) => {
    const at = places();
    const score = new Map(row.map((key) => {
      const ns = nbrs.get(key) || [];
      return [key, ns.length ? ns.reduce((s, x) => s + at.get(x), 0) / ns.length : at.get(key)];
    }));
    row.sort((a, b) => score.get(a) - score.get(b));
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let r = 1; r < rows.length; r++) order(rows[r], up);
    for (let r = rows.length - 2; r >= 0; r--) order(rows[r], down);
  }
  return { rows, routes };
}

/* ---------- Risk ---------- */

// Path words that mark code where mistakes are expensive. `p` is how much one such area adds.
const RISK_AREAS = [
  { id: "auth", label: "Sign-in and session code", p: 0.25, extra: /sign-?in|sign-?up|two-?factor/i,
    words: ["auth", "authentication", "authorization", "session", "sessions", "login", "logout", "password", "passwords", "oauth", "jwt", "mfa", "2fa", "cookie", "cookies"] },
  { id: "secrets", label: "Secrets and encryption", p: 0.25, extra: /encrypt|decrypt|cipher|credential|secret/i,
    words: ["crypto", "cipher", "encrypt", "encryption", "decrypt", "credential", "credentials", "secret", "secrets", "kms", "vault"] },
  { id: "payments", label: "Payments", p: 0.25,
    words: ["payment", "payments", "charge", "charges", "billing", "invoice", "invoices", "stripe", "checkout", "subscription", "subscriptions", "refund", "refunds"] },
  { id: "data", label: "Data migrations", p: 0.2, extra: /\.sql$|(^|\/)migrations?\//i,
    words: ["migration", "migrations", "migrate", "schema"] },
  { id: "api", label: "Public API", p: 0.1,
    words: ["controller", "controllers", "route", "routes", "api", "graphql", "resolver", "resolvers", "mutation", "mutations", "handler", "handlers"] },
];
const FINDING_WEIGHT = { high: 0.25, medium: 0.12, low: 0.04 };
const RISK_WORD = { low: "Low", medium: "Medium", high: "High" };
const riskLevel = (score) => (score >= 65 ? "high" : score >= 35 ? "medium" : "low");
const pathTokens = (path) => path.split(/[\/._-]+|(?=[A-Z][a-z])/).map((t) => t.toLowerCase()).filter(Boolean);
const isTestPath = (path) => /\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e[\w-]*|specs?)\//i.test(path);

function areasOf(path) {
  const tokens = new Set(pathTokens(path));
  return RISK_AREAS.filter((a) => a.words.some((w) => tokens.has(w)) || (a.extra && a.extra.test(path)));
}

// Each factor is a chance that something goes wrong; they combine like independent risks,
// so the score saturates instead of passing 100. Points split the score by each factor's share.
function computeRisk(input) {
  const changed = (input.files || []).filter((f) => !f.generated);
  const source = changed.filter((f) => !isTestPath(f.path));
  const tests = changed.filter((f) => isTestPath(f.path));
  const factors = [];
  const add = (id, label, detail, p, extra = {}) => { if (p > 0) factors.push({ id, label, detail, p: Math.min(0.95, p), ...extra }); };

  for (const area of RISK_AREAS) {
    const hit = source.filter((f) => areasOf(f.path).includes(area));
    if (hit.length) add(`area-${area.id}`, area.label, hit.length === 1 ? hit[0].path.split("/").pop() : plural(hit.length, "file"), area.p, { files: hit.map((f) => f.path) });
  }
  const inPlay = (input.findings || []).filter((x) => x.state !== "dismissed");
  for (const sev of ["high", "medium", "low"]) {
    const these = inPlay.filter((x) => x.severity === sev);
    if (these.length) add(`find-${sev}`, plural(these.length, `${sev} agent finding`), these.every((x) => x.state === "accepted") ? "In your review, not fixed yet" : "Not decided yet", 1 - Math.pow(1 - FINDING_WEIGHT[sev], these.length));
  }
  const lines = changed.reduce((n, f) => n + f.additions + f.deletions, 0);
  add("size", `${lines.toLocaleString("en-US")} changed lines`, lines > 800 ? "A lot to hold in your head at once" : "", Math.min(0.2, 0.066 * Math.log2(1 + lines / 100)));
  if (changed.length >= 20) add("breadth", `Spread across ${changed.length} files`, "", 0.03);
  if (source.length && !tests.length) add("tests-none", "No tests changed", `${plural(source.length, "source file")} changed without a test`, 0.12);
  const stale = source.filter((f) => f.tests && !f.tests.changed);
  if (stale.length) add("tests-stale", `${plural(stale.length, "test file")} not updated`, stale.slice(0, 3).map((f) => f.tests.path.split("/").pop()).join(", "), 1 - Math.pow(0.96, stale.length), { files: stale.map((f) => f.path) });
  const c = input.checks || {};
  if (c.failed) add("checks-failed", `${plural(c.failed, "check")} failing`, "", 0.12);
  else if (c.running) add("checks-running", `${plural(c.running, "check")} still running`, "", 0.02);

  const score = Math.round(100 * (1 - factors.reduce((keep, f) => keep * (1 - f.p), 1)));
  const weight = factors.reduce((sum, f) => sum - Math.log(1 - f.p), 0) || 1;
  factors.forEach((f) => { f.points = Math.round((-Math.log(1 - f.p) / weight) * score); });
  const drift = score - factors.reduce((sum, f) => sum + f.points, 0);
  if (factors.length && drift) factors.reduce((a, b) => (b.points > a.points ? b : a)).points += drift;
  factors.sort((a, b) => b.points - a.points);
  return { score, level: riskLevel(score), factors, lines };
}

function currentCheckCounts() {
  const cs = (LIVE.pr && LIVE.pr.checks) || [];
  return { total: cs.length, failed: cs.filter((c) => checkState(c) === "blocked").length, running: cs.filter((c) => checkState(c) === "running").length };
}

const currentRisk = () => computeRisk({
  files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, generated: f.generated, tests: f.tests })),
  findings: FIND.map((x) => ({ severity: x.severity, state: findingState(x) })),
  checks: currentCheckCounts(),
});

function riskiestFiles(limit = 5) {
  return files.filter((f) => !f.generated && !isTestPath(f.path)).map((f) => {
    const areas = areasOf(f.path);
    const finds = FIND.filter((x) => x.f === f.i && findingState(x) !== "dismissed");
    const ps = [...areas.map((a) => a.p), ...finds.map((x) => FINDING_WEIGHT[x.severity] || 0), Math.min(0.15, (f.additions + f.deletions) / 2000)];
    const score = Math.round(100 * (1 - ps.reduce((keep, p) => keep * (1 - p), 1)));
    const why = [...areas.map((a) => a.label), finds.length ? plural(finds.length, "agent finding") : "", plural(f.additions + f.deletions, "changed line")].filter(Boolean);
    return { f, score, why };
  }).filter((x) => x.score >= 10).sort((a, b) => b.score - a.score).slice(0, limit);
}

const riskPillHTML = (r) => `<button type="button" class="risk risk-${r.level}" data-act="risk" title="What goes into this score">
  <span class="risk-num">${r.score}</span><span class="risk-lvl">${RISK_WORD[r.level]} risk</span><span class="risk-bar" aria-hidden="true"><i style="width:${r.score}%"></i></span></button>`;
const riskBadgeHTML = (r) => `<span class="risk-badge risk-${r.level}" title="${RISK_WORD[r.level]} risk: ${r.score} of 100">${r.score}<span class="sr-only"> of 100, ${RISK_WORD[r.level].toLowerCase()} risk</span></span>`;

function riskSheetHTML() {
  const r = currentRisk();
  const top = riskiestFiles();
  const lower = [];
  const open = FIND.filter((x) => findingState(x) === "open");
  if (open.length) lower.push({ text: `Decide the ${plural(open.length, "open agent finding")}. Dismissed ones stop counting.`, act: "go-brief", label: "Show findings" });
  if (FIND.some((x) => findingState(x) === "accepted")) lower.push({ text: "Findings in your review keep counting until the author fixes them." });
  if (r.factors.some((f) => f.id === "checks-failed")) lower.push({ text: "Get the failing checks green." });
  if (r.factors.some((f) => f.id.startsWith("tests"))) lower.push({ text: "Add or update tests for the code that changed." });
  if (r.lines > 800) lower.push({ text: `Split it up. ${r.lines.toLocaleString("en-US")} lines is a lot to review in one sitting.` });
  const max = Math.max(1, ...r.factors.map((f) => f.points));
  return `${sheetHead("risk", `Risk ${r.score} of 100`)}
  <div class="sheet-body">
    <div class="risk-hero risk-${r.level}"><span class="risk-hero-num">${r.score}</span>
      <div class="risk-hero-text"><b>${RISK_WORD[r.level]} risk</b>
        <span class="risk-scale" aria-hidden="true"><i style="left:${r.score}%"></i></span>
        <span class="risk-legend" aria-hidden="true"><span>Low</span><span>Medium</span><span>High</span></span></div></div>
    <p class="sheet-lede">How much could go wrong if this merges as it is. Diffline adds up what it can see: the code it touches, the agent findings still in play, its size, its tests and its checks. Use it to decide where to spend your attention. It isn't a verdict.</p>
    <h3 class="eyebrow">What adds to it</h3>
    <ul class="risk-factors">${r.factors.length ? r.factors.map((f) => `<li><span class="rf-pts">+${f.points}</span>
      <div class="rf-text"><b>${esc(f.label)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ""}</div>
      <span class="rf-bar" aria-hidden="true"><i style="width:${Math.round((f.points / max) * 100)}%"></i></span></li>`).join("") : `<li class="dim">Nothing stands out.</li>`}</ul>
    ${top.length ? `<h3 class="eyebrow">Riskiest files</h3><ul class="risk-files">${top.map((x) => `<li><button type="button" class="risk-file" data-act="goto-file" data-f="${x.f.i}">
      ${riskBadgeHTML({ score: x.score, level: riskLevel(x.score) })}<span class="rfile-path mono">${esc(x.f.dir)}<b>${esc(x.f.base)}</b></span>
      <span class="rfile-why">${esc(x.why.join(" · "))}</span></button></li>`).join("")}</ul>` : ""}
    ${lower.length ? `<h3 class="eyebrow">What would lower it</h3><ul class="risk-lower">${lower.map((l) => `<li>${icon("arrow")}<span>${esc(l.text)}</span>${l.act ? `<button type="button" class="link" data-act="${l.act}">${l.label}</button>` : ""}</li>`).join("")}</ul>` : ""}
    ${BRIEF_LEDE ? `<h3 class="eyebrow">The agents' read</h3><p class="risk-read">${agentAv("xs")}<span>${inline(BRIEF_LEDE)}</span></p>` : ""}
  </div>`;
}

/* ---------- The path to merge ---------- */

const CHECK_WORDS = { SUCCESS: "Passed", NEUTRAL: "Neutral", SKIPPED: "Skipped", FAILURE: "Failed", CANCELLED: "Cancelled", TIMED_OUT: "Timed out", ACTION_REQUIRED: "Needs action", STALE: "Stale", ERROR: "Error", STARTUP_FAILURE: "Failed to start" };
const checkState = (c) => (c.status !== "COMPLETED" ? "running" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "passed" : "blocked");
const checkDetail = (c) => (c.status !== "COMPLETED" ? ({ QUEUED: "Queued", IN_PROGRESS: "Running", PENDING: "Pending", WAITING: "Waiting", EXPECTED: "Expected" }[c.status] || "Running") : CHECK_WORDS[c.conclusion] || "Done");

function liveStages() {
  const p = LIVE.pr || {};
  const out = [];

  const checks = (p.checks || []).map((c, i) => ({ id: `ck-${i}`, name: c.name || "check", st: checkState(c), detail: c.description || checkDetail(c), url: c.url }));
  const failed = checks.filter((g) => g.st === "blocked"), running = checks.filter((g) => g.st === "running"), passed = checks.filter((g) => g.st === "passed");
  let checkGates = [...failed, ...running];
  if (passed.length > 6) checkGates.push({ id: "ck-passed", name: `${plural(passed.length, "check")} passed`, st: "passed", detail: passed.slice(0, 8).map((g) => g.name).join(", ") + (passed.length > 8 ? " and more" : "") });
  else checkGates = checkGates.concat(passed);
  if (!checks.length) checkGates = [{ id: "ck-none", name: LIVE.github ? "No checks reported" : "Checks unavailable", st: LIVE.github ? "passed" : "upcoming", detail: LIVE.github ? "GitHub has no checks for the head commit" : "Sign in to the GitHub CLI to load checks" }];
  out.push({ id: "checks", name: "Checks", gates: checkGates,
    st: failed.length ? "blocked" : running.length ? "running" : checks.length || LIVE.github ? "done" : "upcoming",
    caption: !checks.length ? (LIVE.github ? "No checks" : "Unavailable") : failed.length ? `${plural(failed.length, "check")} failing` : running.length ? `${passed.length} of ${checks.length} passed, ${running.length} running` : `All ${checks.length} passed` });

  if (AGENTS.length) {
    const high = FIND.filter((x) => x.severity === "high").length;
    out.push({ id: "agents", name: "Agent review", short: "Agents", st: "done", note: STAGE_NOTE_AGENTS,
      gates: AGENTS.map((a) => {
        const n = FIND.filter((x) => x.agent === a.id).length;
        return { id: `agent-${a.id}`, agent: true, name: a.name, role: a.focus, st: "passed",
          detail: a.id === "guide" ? `Drafted ${plural((PR.plan || []).length, "chapter")}` : n ? plural(n, "finding") : "Nothing to flag" };
      }),
      caption: FIND.length ? `${plural(FIND.length, "finding")}${high ? `, ${high} high` : ""}` : "Nothing flagged" });
  } else {
    out.push({ id: "agents", name: "Agent review", short: "Agents", st: "upcoming", caption: "Not run yet",
      gates: [{ id: "agent-none", agent: true, name: "No agent run for this pull request", st: "upcoming",
        detail: "Run the agents from the briefing on the Changes tab, or with the play button on this pull request in the Diffline sidebar." }] });
  }

  const gates = [];
  const latest = new Map((p.latestReviews || []).filter((r) => r.login).map((r) => [r.login, r]));
  (p.reviewRequests || []).forEach((r) => {
    if (r.login && latest.has(r.login)) return;
    gates.push({ id: `rq-${r.login || r.team}`, who: r.login ? livePid(r.login) : null, name: r.login ? nameOf(livePid(r.login)) : `@${r.team}`, role: "Review requested", st: "waiting", detail: "Hasn't reviewed yet" });
  });
  latest.forEach((r) => {
    const id = livePid(r.login);
    if (id === "you") return;
    gates.push({ id: `rv-${r.login}`, who: id, name: nameOf(id), st: r.state === "APPROVED" ? "passed" : r.state === "CHANGES_REQUESTED" ? "blocked" : "waiting",
      role: { APPROVED: "Approved", CHANGES_REQUESTED: "Requested changes", COMMENTED: "Commented", DISMISSED: "Review dismissed" }[r.state] || "Reviewed",
      detail: r.submittedAt ? ago(r.submittedAt) : "" });
  });
  const mineLatest = LIVE.viewer ? latest.get(LIVE.viewer.login) : null;
  gates.push({ id: "you", who: "you", name: "You", role: mineLatest ? `Your last review: ${(mineLatest.state || "").toLowerCase().replace("_", " ")}` : "Your review", st: "waiting", mine: true,
    detail: S.drafts.length ? `${plural(S.drafts.length, "draft")} saved on this machine` : "No drafts yet",
    action: { act: "finish", label: "Finish review" } });
  const hi = highOpen();
  if (FIND.length) gates.push({ id: "findings", agent: true, name: "Agent findings", role: "A person decides on each high finding", st: hi.length ? "waiting" : "passed", mine: hi.length > 0,
    detail: hi.length ? (hi.length === 1 ? "1 high finding needs your decision" : `${hi.length} high findings need your decision`) : "Every high finding has a decision",
    action: hi.length ? { act: "go-finding", id: hi[0].id, label: "Decide" } : null });
  const decision = p.reviewDecision;
  out.push({ id: "review", name: "Review", gates, st: decision === "APPROVED" ? "done" : decision === "CHANGES_REQUESTED" ? "blocked" : "active",
    caption: decision === "APPROVED" ? "Approved" : decision === "CHANGES_REQUESTED" ? "Changes requested" : decision === "REVIEW_REQUIRED" ? "Review required" : LIVE.github ? "In review" : "Unknown" });

  const merge = p.state === "MERGED" ? ["done", "passed", "Merged"] : p.state === "CLOSED" ? ["blocked", "blocked", "Closed without merging"] : p.isDraft ? ["upcoming", "upcoming", "Still a draft"]
    : ({ CLEAN: ["active", "waiting", "Ready to merge"], BLOCKED: ["upcoming", "upcoming", "Waiting on required reviews or checks"], BEHIND: ["upcoming", "upcoming", "Behind the base branch"],
      DIRTY: ["blocked", "blocked", "Has merge conflicts"], UNSTABLE: ["upcoming", "upcoming", "Some checks are failing"], HAS_HOOKS: ["active", "waiting", "Ready to merge"] }[p.mergeStateStatus]
      || ["upcoming", "upcoming", LIVE.github ? "GitHub is still working it out" : "Unknown"]);
  out.push({ id: "merge", name: "Merge", st: merge[0], caption: merge[2],
    gates: [{ id: "merge", name: "Merge", role: p.baseRefName ? `into ${p.baseRefName}` : "", st: merge[1], detail: merge[2] }] });
  return out;
}

const stages = () => liveStages();

function prState() {
  const p = LIVE.pr || {};
  if (p.state === "MERGED") return { label: "Merged", cls: "s-ok" };
  if (p.state === "CLOSED") return { label: "Closed", cls: "s-bad" };
  if (p.isDraft) return { label: "Draft", cls: "s-blue" };
  if (p.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", cls: "s-bad" };
  if (p.reviewDecision === "APPROVED") return { label: "Approved", cls: "s-ok" };
  return { label: "In review", cls: "s-blue" };
}

function flowSummary() {
  const cur = stages().find((s) => s.st !== "done");
  return cur ? `${cur.name}: ${cur.caption}` : "Shipped: live in production";
}

/* ---------- Syntax highlighting ---------- */

const KW_TS = new Set("import export from const let var function return if else for while do switch case break continue default async await new type interface extends implements class enum as in of typeof keyof instanceof true false null undefined void throw try catch finally this super readonly private public protected static yield declare namespace satisfies abstract".split(" "));
const TYPES_TS = new Set("string number boolean unknown never any object bigint symbol".split(" "));
const KW_SQL = new Set("create table alter add column not null default primary key references check in and or on insert into values select from where update set delete drop index unique if exists returning constraint foreign cascade".split(" "));
const TYPES_SQL = new Set("text integer int bigint timestamptz timestamp jsonb json boolean serial varchar numeric uuid date".split(" "));
const KW_SH = new Set("if then else elif fi for in do done while case esac function return exit set echo local export".split(" "));
const KW_RS = new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err".split(" "));
const TYPES_RS = new Set("bool char str String usize isize u8 u16 u32 u64 u128 i8 i16 i32 i64 i128 f32 f64 Vec Option Result Box Rc Arc HashMap HashSet BTreeMap".split(" "));

function tokenize(s, lang) {
  switch (lang) {
    case "ts": return tokTS(s, false);
    case "tsx": return tokTS(s, true);
    case "sql": return tokWords(s, { comment: /--.*/y, kw: KW_SQL, types: TYPES_SQL, ci: true, str: /'(?:''|[^'])*'?/y });
    case "sh": return tokWords(s, { comment: /#.*/y, kw: KW_SH, vars: true, str: /"(?:\\.|[^"\\])*"?|'[^']*'?/y });
    // A quote closed after one character is a char literal; otherwise it starts a lifetime such as 'a.
    case "rust": return tokWords(s, { comment: /\/\/.*/y, kw: KW_RS, types: TYPES_RS, macros: true, str: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])'/y });
    case "yaml": return tokYAML(s);
    case "json": return tokJSON(s);
    case "md": return tokMD(s);
    default: return [{ s, c: "" }];
  }
}

function tokTS(s, jsx) {
  const out = [];
  const trimmed = s.trimStart();
  if (/^\*(?!\*)|^\*\/|^\/\*/.test(trimmed) && !/\*\/./.test(trimmed)) return [{ s, c: "c" }];
  if (jsx && /^\s*[A-Za-z][\w .,'’!?…:-]*$/.test(s) && !KW_TS.has(trimmed.split(/\s/)[0])) return [{ s, c: "" }];
  const R = {
    ws: /\s+/y, lc: /\/\/.*/y, bc: /\/\*.*?(?:\*\/|$)/y, str: /(["'`])(?:\\.|(?!\1)[^\\])*\1?/y,
    num: /\d[\d_]*(?:\.\d+)?/y, id: jsx ? /[A-Za-z_$][\w$]*(?:-[A-Za-z]\w*)*/y : /[A-Za-z_$][\w$]*/y,
  };
  let i = 0, inTag = false, depth = 0, jsxText = false, tagNext = false;
  const at = (re) => { re.lastIndex = i; const m = re.exec(s); return m ? m[0] : null; };
  const push = (text, c) => { out.push({ s: text, c }); i += text.length; };
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) if (out[j].s.trim()) return out[j]; return null; };
  while (i < s.length) {
    let m;
    const ch = s[i];
    if ((m = at(R.ws))) { push(m, ""); continue; }
    if (jsxText && ch !== "{" && ch !== "<") {
      let j = i;
      while (j < s.length && s[j] !== "{" && s[j] !== "<") j++;
      push(s.slice(i, j), "");
      continue;
    }
    if ((m = at(R.lc))) { push(m, "c"); continue; }
    if ((m = at(R.bc))) { push(m, "c"); continue; }
    if ((m = at(R.str))) { push(m, "s"); continue; }
    if (jsx && ch === "<" && /[A-Za-z/>]/.test(s[i + 1] || "")) {
      const p = prevSig();
      const generic = p && p.c !== "k" && /[\w$)\]]$/.test(p.s);
      if (!generic) {
        push(s[i + 1] === "/" ? "</" : "<", "p");
        inTag = true; tagNext = true; jsxText = false; depth = 0;
        continue;
      }
    }
    if ((m = at(R.id))) {
      const next = s[i + m.length] || "";
      const after = s[i + m.length + 1] || "";
      let c = "";
      if (tagNext) { c = "tag"; tagNext = false; }
      else if (KW_TS.has(m)) c = "k";
      else if (jsx && ((inTag && depth === 0) || (next === "=" && after !== "=" && after !== ">"))) c = "a";
      else if (TYPES_TS.has(m)) c = "t";
      else if (next === "(") c = "f";
      else if (/^[A-Z]/.test(m)) c = "t";
      push(m, c);
      continue;
    }
    if (/\d/.test(ch) && (m = at(R.num))) { push(m, "n"); continue; }
    if (ch === "{") { if (inTag) depth++; jsxText = false; }
    else if (ch === "}") { if (inTag && depth > 0) depth--; }
    else if (inTag && depth === 0 && ch === "/" && s[i + 1] === ">") { inTag = false; push("/>", "p"); continue; }
    else if (inTag && depth === 0 && ch === ">") { inTag = false; jsxText = true; push(">", "p"); continue; }
    push(ch, "p");
  }
  return out;
}

function tokWords(s, o) {
  const out = [];
  let i = 0;
  const at = (re) => { re.lastIndex = i; const m = re.exec(s); return m ? m[0] : null; };
  const WS = /\s+/y, ID = /[A-Za-z_]\w*/y, NUM = /\d+(?:\.\d+)?/y, VAR = /\$\{?[\w@#?*!-]+\}?|\$\(/y;
  while (i < s.length) {
    let m;
    if ((m = at(WS))) { out.push({ s: m, c: "" }); i += m.length; continue; }
    if ((i === 0 || /\s/.test(s[i - 1])) && (m = at(o.comment))) { out.push({ s: m, c: "c" }); i += m.length; continue; }
    if ((m = at(o.str))) { out.push({ s: m, c: "s" }); i += m.length; continue; }
    if (o.vars && (m = at(VAR))) { out.push({ s: m, c: "n" }); i += m.length; continue; }
    if ((m = at(ID))) {
      const w = o.ci ? m.toLowerCase() : m;
      const next = s[i + m.length];
      out.push({ s: m, c: o.kw.has(w) ? "k" : o.types && o.types.has(w) ? "t" : next === "(" || (o.macros && next === "!") ? "f" : "" });
      i += m.length;
      continue;
    }
    if ((m = at(NUM))) { out.push({ s: m, c: "n" }); i += m.length; continue; }
    out.push({ s: s[i], c: "p" });
    i++;
  }
  return out;
}

function tokYAML(s) {
  const out = [];
  let i = 0;
  const m = s.match(/^(\s*)(- )?("[^"]*"|'[^']*'|[\w./@-]+)(:)(?=\s|$)/);
  if (m) {
    if (m[1]) out.push({ s: m[1], c: "" });
    if (m[2]) out.push({ s: m[2], c: "p" });
    out.push({ s: m[3], c: "key" }, { s: ":", c: "p" });
    i = m[0].length;
  } else {
    const d = s.match(/^(\s*)(- )/);
    if (d) {
      if (d[1]) out.push({ s: d[1], c: "" });
      out.push({ s: d[2], c: "p" });
      i = d[0].length;
    }
  }
  const rest = s.slice(i);
  const hash = rest.search(/(^|\s)#/);
  const value = hash >= 0 ? rest.slice(0, hash) : rest;
  const comment = hash >= 0 ? rest.slice(hash) : "";
  const re = /("(?:\\.|[^"\\])*"?)|('[^']*'?)|(\b(?:true|false|null|yes|no)\b)|(\b\d+(?:\.\d+)?\b)|([[\]{},])|(\s+)|([^\s"'[\]{},]+)/y;
  let x;
  while (re.lastIndex < value.length && (x = re.exec(value))) {
    const quoteOk = x[2] && (x.index === 0 || /[\s:[,]/.test(value[x.index - 1]));
    out.push({ s: x[0], c: x[1] ? "s" : x[2] ? (quoteOk ? "s" : "") : x[3] ? "k" : x[4] ? "n" : x[5] ? "p" : "" });
  }
  if (comment) {
    const lead = comment.match(/^\s*/)[0];
    if (lead) out.push({ s: lead, c: "" });
    out.push({ s: comment.slice(lead.length), c: "c" });
  }
  return out;
}

function tokJSON(s) {
  const out = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|(\s+)|(\S)/y;
  let m;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (m[1]) { out.push({ s: m[1], c: m[2] ? "key" : "s" }); if (m[2]) out.push({ s: m[2], c: "p" }); }
    else if (m[3]) out.push({ s: m[3], c: "n" });
    else if (m[4]) out.push({ s: m[4], c: "k" });
    else if (m[5]) out.push({ s: m[5], c: "" });
    else out.push({ s: m[6], c: "p" });
  }
  return out;
}

function tokMD(s) {
  if (/^#{1,6} /.test(s)) return [{ s, c: "h" }];
  const out = [];
  let i = 0;
  const m = s.match(/^(\s*)([-*+]|\d+\.)(?= )/);
  if (m) { out.push({ s: m[0], c: "p" }); i = m[0].length; }
  const re = /(`[^`]*`)|(\*\*[^*]+\*\*)|([^`*]+|\*)/y;
  re.lastIndex = i;
  let x;
  while (re.lastIndex < s.length && (x = re.exec(s))) out.push({ s: x[0], c: x[1] ? "s" : x[2] ? "b" : "" });
  return out;
}

// Paints syntax tokens and marks the character ranges a word diff found.
function hl(s, lang, ranges) {
  const toks = tokenize(s, lang);
  const rs = ranges || [];
  let out = "", pos = 0, ri = 0;
  for (const t of toks) {
    const start = pos, end = pos + t.s.length;
    let cur = start;
    while (cur < end) {
      while (ri < rs.length && rs[ri][1] <= cur) ri++;
      const r = rs[ri];
      let stop = end, marked = false;
      if (r && r[0] <= cur) { marked = true; stop = Math.min(end, r[1]); }
      else if (r && r[0] < end) stop = r[0];
      const piece = esc(t.s.slice(cur - start, stop - start));
      const inner = t.c ? `<span class="t-${t.c}">${piece}</span>` : piece;
      out += marked ? `<mark class="w">${inner}</mark>` : inner;
      cur = stop;
    }
    pos = end;
  }
  return out;
}

/* ---------- Word-level diff for paired lines ---------- */

const WD_CACHE = new Map();

// A changed line longer than this that pairs with its old version shows as one line: only what changed is
// spelled out, and the unchanged text around it folds away. Prompts and tool descriptions live in lines like these.
const LONG_LINE = 240;

function wordDiffs(h) {
  if (WD_CACHE.has(h.key)) return WD_CACHE.get(h.key);
  const map = new Map();
  map.long = new Map();    // index of a long deleted line -> { add: index of its new version, ops }
  map.longAdd = new Set(); // new versions shown together with their old line
  const L = h.lines;
  let i = 0;
  while (i < L.length) {
    if (L[i][0] !== "-") { i++; continue; }
    const dels = [], adds = [];
    while (i < L.length && L[i][0] === "-") dels.push(i++);
    while (i < L.length && L[i][0] === "+") adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const a = L[dels[k]][3], b = L[adds[k]][3];
      const ops = wordOps(a, b);
      const r = ops && wordRanges(ops, a, b);
      if (!r) continue;
      map.set(dels[k], r[0]);
      map.set(adds[k], r[1]);
      if (Math.max(a.length, b.length) > LONG_LINE) { map.long.set(dels[k], { add: adds[k], ops }); map.longAdd.add(adds[k]); }
    }
  }
  WD_CACHE.set(h.key, map);
  return map;
}

// Token diff of two versions of a line, as [op, aStart, aEnd, bStart, bEnd] with op "=", "-" or "+".
// The shared start and end are matched first. A short middle goes through the full comparison table;
// a long one, such as a prompt edited in several places, goes through Myers' diff, whose cost grows
// with the size of the change rather than the length of the line.
function wordOps(a, b) {
  const TOK = /\w+|\s+|[^\w\s]/g;
  const ta = a.match(TOK) || [], tb = b.match(TOK) || [];
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
  const A = ta.slice(pre, ta.length - suf), B = tb.slice(pre, tb.length - suf);
  const script = A.length * B.length <= 20000 ? lcsScript(A, B) : myersScript(A, B);
  if (!script) return null;
  const ops = [];
  let pa = 0, pb = 0;
  const push = (op, la, lb) => {
    const last = ops[ops.length - 1];
    if (last && last[0] === op) { last[2] += la; last[4] += lb; }
    else ops.push([op, pa, pa + la, pb, pb + lb]);
    pa += la;
    pb += lb;
  };
  for (let x = 0; x < pre; x++) push("=", ta[x].length, ta[x].length);
  let x = 0, y = 0;
  for (const op of script) {
    if (op === "=") { push("=", A[x].length, B[y].length); x++; y++; }
    else if (op === "-") { push("-", A[x].length, 0); x++; }
    else { push("+", 0, B[y].length); y++; }
  }
  for (let k = ta.length - suf; k < ta.length; k++) push("=", ta[k].length, ta[k].length);
  // Joining edits marks some unchanged words too, so the true counts travel with the result.
  const joined = joinEdits(ops, a);
  joined.added = ops.reduce((sum, o) => sum + (o[0] === "+" ? o[4] - o[3] : 0), 0);
  joined.removed = ops.reduce((sum, o) => sum + (o[0] === "-" ? o[2] - o[1] : 0), 0);
  return joined;
}

// A reworded phrase comes out of a token diff as alternating words ("To" → "For", "avoid" → "results").
// Edits separated only by a space or one short word are joined, so the phrase reads as one deletion and
// one insertion. Separators with punctuation, as in code, keep their edits apart.
function joinEdits(ops, a) {
  const segs = [];
  for (const [op, as, ae, bs, be] of ops) {
    const last = segs[segs.length - 1];
    const kind = op === "=" ? "=" : "x";
    if (last && last.kind === "x" && kind === "x") { last.ae = ae; last.be = be; }
    else segs.push({ kind, as, ae, bs, be });
  }
  for (let i = 1; i < segs.length - 1; i++) {
    const s = segs[i];
    if (s.kind === "=" && segs[i - 1].kind === "x" && segs[i + 1].kind === "x" && /^\s*\w{0,10}\s*$/.test(a.slice(s.as, s.ae))) {
      const prev = segs[i - 1], next = segs[i + 1];
      prev.ae = next.ae;
      prev.be = next.be;
      segs.splice(i, 2);
      i--;
    }
  }
  const out = [];
  for (const s of segs) {
    if (s.kind === "=") { out.push(["=", s.as, s.ae, s.bs, s.be]); continue; }
    if (s.ae > s.as) out.push(["-", s.as, s.ae, s.bs, s.bs]);
    if (s.be > s.bs) out.push(["+", s.ae, s.ae, s.bs, s.be]);
  }
  return out;
}

// Edit script ("=", "-", "+" per token) from the full comparison table.
function lcsScript(A, B) {
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let x = m - 1; x >= 0; x--) for (let y = n - 1; y >= 0; y--) {
    dp[x][y] = A[x] === B[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
  }
  const out = [];
  let x = 0, y = 0;
  while (x < m && y < n) {
    if (A[x] === B[y]) { out.push("="); x++; y++; }
    else if (dp[x + 1][y] >= dp[x][y + 1]) { out.push("-"); x++; }
    else { out.push("+"); y++; }
  }
  for (; x < m; x++) out.push("-");
  for (; y < n; y++) out.push("+");
  return out;
}

// The shortest edit script by Myers' O(ND) diff, or null when the versions differ too much to be worth
// marking. `budget` caps the work, so two unrelated long lines give up quickly instead of stalling the page.
function myersScript(A, B, budget = 2e6) {
  const n = A.length, m = B.length, off = n + m + 1;
  const v = new Int32Array(2 * off + 1);
  const trace = [];
  let work = 0;
  for (let d = 0; d <= n + m; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; work++; }
      v[off + k] = x;
      if (++work > budget) return null;
      if (x >= n && y >= m) {
        // Walk back through the saved rows: each step of d was one insert or delete, plus a diagonal run.
        const out = [];
        for (let e = d; e > 0; e--) {
          const row = trace[e], at = (kk) => row[kk + e + 1];
          const kk = x - y;
          const prevK = kk === -e || (kk !== e && at(kk - 1) < at(kk + 1)) ? kk + 1 : kk - 1;
          const px = at(prevK), py = px - prevK;
          while (x > px && y > py) { out.push("="); x--; y--; }
          out.push(x === px ? "+" : "-");
          x = px;
          y = py;
        }
        while (x > 0 && y > 0) { out.push("="); x--; y--; }
        return out.reverse();
      }
    }
  }
  return null;
}

// Marked ranges for each side, or null when most of the line changed and marks would only add noise.
function wordRanges(ops, a, b) {
  const merge = (rs, str) => {
    const out = [];
    for (const r of rs) {
      const last = out[out.length - 1];
      if (last && (last[1] === r[0] || !str.slice(last[1], r[0]).trim())) last[1] = r[1];
      else out.push([r[0], r[1]]);
    }
    return out.filter(([p, q]) => str.slice(p, q).trim());
  };
  const A = merge(ops.filter((o) => o[0] === "-").map((o) => [o[1], o[2]]), a);
  const B = merge(ops.filter((o) => o[0] === "+").map((o) => [o[3], o[4]]), b);
  if (!A.length && !B.length) return null;
  const share = (rs, str) => rs.reduce((sum, [p, q]) => sum + q - p, 0) / Math.max(1, str.trim().length);
  if (share(A, a) > 0.65 || share(B, b) > 0.65) return null;
  return [A, B];
}

const indentOf = (s) => { const m = s.match(/^[ \t]*/)[0]; return m.replace(/\t/g, "  ").length; };

/* ---------- Small markdown for comments and the description ---------- */

const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
const paras = (s) => (s.trim() ? s.trim().split(/\n{2,}/).map((p) => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`).join("") : "");
const firstLine = (s) => s.replace(/```[\s\S]*?```/g, "").trim().split("\n")[0];

// A run of list lines as nested lists: an item indented further than the one before it starts a list inside it.
function listHTML(items) {
  let out = "";
  const open = []; // the lists still open: { type, indent }
  for (const it of items) {
    while (open.length > 1 && it.indent < open[open.length - 1].indent) out += `</li></${open.pop().type}>`;
    const top = open[open.length - 1];
    if (!top || it.indent > top.indent) {
      out += `<${it.type}>`;
      open.push({ type: it.type, indent: it.indent });
    } else {
      out += "</li>";
      if (top.type !== it.type) { out += `</${top.type}><${it.type}>`; top.type = it.type; }
    }
    out += `<li>${inline(it.text)}`;
  }
  while (open.length) out += `</li></${open.pop().type}>`;
  return out;
}

function mdBlock(src) {
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(listHTML(list));
    list = [];
  };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^#{1,3} (.*)/))) { flush(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = line.match(/^(\s*)[-*] (.*)/))) { list.push({ type: "ul", indent: m[1].length, text: m[2] }); continue; }
    if ((m = line.match(/^(\s*)\d+\. (.*)/))) { list.push({ type: "ol", indent: m[1].length, text: m[2] }); continue; }
    flush();
    out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("");
}

// The line a comment is about. A long line is cut down to the part that changed.
function lineQuote(fi, k) {
  const text = lineText(fi, k);
  if (text == null || text.length <= LONG_LINE) return { text, clipped: false };
  let at = 0;
  const hk = LINE_HUNK.get(`${fi}:${k}`);
  if (hk) {
    const { h } = HUNK.get(hk);
    const r = wordDiffs(h).get(h.lines.findIndex((l) => lineKey(l) === k));
    if (r && r.length) at = r[0][0];
  }
  const from = at > 60 ? text.lastIndexOf(" ", at - 60) + 1 : 0;
  return { text: `${from ? "… " : ""}${text.slice(from, from + 220).trim()} …`, clipped: true };
}

function lineText(fi, k) {
  const f = files[fi];
  if (!f || !k || k === "file") return null;
  const side = k[0], no = +k.slice(1);
  for (const h of f.hunks) for (const l of h.lines) {
    if (side === "o" && l[0] === "-" && l[1] === no) return l[3];
    if (side === "n" && l[0] !== "-" && l[2] === no) return l[3];
  }
  return side === "n" && f.content ? f.content[no - 1] ?? null : null;
}
const lineName = (k) => (k === "file" ? "the whole file" : k[0] === "o" ? `deleted line ${k.slice(1)}` : `line ${k.slice(1)}`);

function dedent(lines) {
  const pad = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return Number.isFinite(pad) ? lines.map((l) => l.slice(pad)) : lines;
}

function bodyHTML(text, anchor) {
  const parts = String(text || "").replace(/\r\n/g, "\n").split(/```([\w-]*)\n([\s\S]*?)\n?```/);
  let out = "";
  for (let i = 0; i < parts.length; i += 3) {
    out += paras(parts[i]);
    if (i + 2 < parts.length) {
      const lang = parts[i + 1], code = parts[i + 2];
      out += lang === "suggestion" ? suggestionHTML(code, anchor) : `<pre class="quote-code">${code.split("\n").map((l) => hl(l, lang === "tsx" ? "tsx" : /^(ts|js|typescript|javascript)$/.test(lang) ? "ts" : lang)).join("\n")}</pre>`;
    }
  }
  return out;
}

function suggestionHTML(code, anchor) {
  const f = anchor ? files[anchor.f] : null;
  const lang = f ? f.lang : "text";
  const before = anchor ? lineText(anchor.f, anchor.k) : null;
  const all = dedent([...(before != null ? [before] : []), ...code.split("\n")]);
  const oldLines = before != null ? all.slice(0, 1) : [];
  const newLines = before != null ? all.slice(1) : all;
  const ops = before != null && newLines.length === 1 && Math.max(before.length, newLines[0].length) > LONG_LINE ? wordOps(oldLines[0], newLines[0]) : null;
  if (ops && wordRanges(ops, oldLines[0], newLines[0])) {
    const key = `${anchor.f}:${anchor.k}:suggestion`;
    return `<div class="sugg"><div class="sugg-head">${icon("pencil")}Suggested change</div>
      <div class="sugg-row lrow"><span class="sg">±</span>${longTextHTML(oldLines[0], newLines[0], ops, lang, S.longOpen.has(key), key)}</div></div>`;
  }
  return `<div class="sugg"><div class="sugg-head">${icon("pencil")}Suggested change</div>
    ${oldLines.map((l) => `<div class="sugg-row del"><span class="sg">−</span>${hl(l, lang)}</div>`).join("")}
    ${newLines.map((l) => `<div class="sugg-row add"><span class="sg">+</span>${hl(l, lang)}</div>`).join("")}
    <div class="sugg-foot">${esc(PEOPLE[PR.author].short)} can apply this with one click.</div></div>`;
}

/* ---------- Chrome: ribbon, top bar, header, track ---------- */

const LOGO = `<svg class="logo" viewBox="0 0 30 16" aria-hidden="true"><path d="M1.5 8h27" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/><circle cx="15" cy="8" r="5" fill="var(--sheet)" stroke="currentColor" stroke-width="2.6"/></svg>`;
const TICK = `<span class="box" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span>`;
// In VS Code, "System" follows the editor's theme: VS Code marks the webview's body vscode-light, vscode-dark or a
// high-contrast variant. A theme the reader picks here wins.
let themeFollowsHost = false;
const themeNow = () => (themeFollowsHost ? "system" : document.documentElement.dataset.theme || "system");
function hostTheme() {
  const c = document.body.classList;
  if (c.contains("vscode-light") || c.contains("vscode-high-contrast-light")) return "light";
  if (c.contains("vscode-dark") || c.contains("vscode-high-contrast")) return "dark";
  return null;
}
function applyHostTheme() {
  if (!themeFollowsHost) return;
  const t = hostTheme();
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };

function syncHTML() {
  const text = liveSync === "error" ? `Couldn't save: ${liveSyncError}` : liveSync === "saving" ? "Saving…" : "Saved on this machine";
  return `<span class="sync sync-${liveSync}" id="sync">${esc(text)}</span>`;
}

function ribbonHTML() {
  return `<div class="ribbon ribbon-live" id="ribbon"><span class="ribbon-tag">Local</span>
      <span class="ribbon-text">${S.view === "inbox" ? "Your pull requests" : S.view === "metrics" ? "Your review metrics" : `${esc(LIVE.repo)} #${LIVE.number}`}${LIVE.github ? "" : ` · <b>GitHub isn't connected.</b> Run <code>gh auth login</code>, then refresh.`}<span class="long"> · Drafts stay on this machine until you post them.</span></span>
    ${S.view !== "pr" ? "" : syncHTML()}
    <button type="button" class="link" data-act="live-refresh">Refresh</button>
      ${S.view !== "pr" ? "" : `<a class="link" href="${esc(LIVE.url)}" target="_blank" rel="noopener">GitHub</a>`}</div>`;
}

function miniTrackHTML(states) {
  const st = states || stages().map((s) => s.st);
  return `<span class="mini" aria-hidden="true">${st.map((s) => `<i class="md md-${s}"></i>`).join("")}</span>`;
}

function finishBtnHTML(where) {
  const badge = S.drafts.length ? `<i class="badge">${S.drafts.length}</i>` : "";
  return `<button type="button" class="btn primary finish finish-${where}" data-act="finish">Finish review${badge}</button>`;
}

function topbarHTML() {
  const pr = S.view === "pr";
  return `<header class="bar" id="bar">
    <button type="button" class="icon-btn back" data-act="inbox" aria-label="Back to your reviews">${icon("left")}</button>
    <a class="brand" href="#inbox" data-act="inbox" aria-label="Diffline, your reviews">${LOGO}<span class="brand-word">diffline</span></a>
    ${pr ? `<nav class="crumbs" aria-label="Location"><button type="button" class="crumb-repo crumb-link" data-act="inbox" title="All pull requests in this session">${esc(PR.repo)}</button><span class="crumb-sep">/</span>
      <span class="crumb-pr">#${PR.number}</span><span class="crumb-title">${esc(PR.title)}</span></nav>` : `<span class="crumbs"></span>`}
    <div class="bar-end">
      ${pr ? `<button type="button" class="mini-track" data-act="tab" data-tab="workflow" title="Path to merge">${miniTrackHTML()}<span class="mini-label">${esc(flowSummary())}</span></button>` : ""}
      ${pr ? `<button type="button" class="icon-btn only-wide" data-act="palette" aria-label="Jump to file" title="Jump to file (F)">${icon("search")}</button>` : ""}
      <button type="button" class="icon-btn" data-act="theme" aria-label="Theme: ${themeNow()}" title="Theme: ${themeNow()}">${icon(THEME_ICON[themeNow()])}</button>
      ${pr ? finishBtnHTML("bar") : ""}
      ${avatar("you")}
    </div>
  </header>`;
}

function stageNode(s) {
  if (s.st === "done") return icon("check");
  if (s.st === "blocked") return icon("x");
  if (s.st === "running") return `<span class="spin" aria-hidden="true"></span>`;
  return icon(STAGE_ICONS[s.id]);
}

function trackHTML(ss) {
  return `<div class="track" id="track" role="list" aria-label="Path to merge" style="--stages:${ss.length}">
    ${ss.map((s) => `<button type="button" class="stg st-${s.st}" role="listitem" data-act="tab" data-tab="workflow" data-stage="${s.id}" aria-label="${s.name}: ${esc(s.caption)}">
      <span class="stg-rail"><span class="stg-node">${stageNode(s)}</span></span>
      <span class="stg-name"><span class="nm-long">${s.name}</span><span class="nm-short">${s.short || s.name}</span></span><span class="stg-cap">${esc(s.caption)}</span></button>`).join("")}
  </div>`;
}

const tabBtn = (id, label, count) => `<button type="button" class="tab" role="tab" data-act="tab" data-tab="${id}" aria-selected="${S.tab === id}">${label}${count == null ? "" : `<span class="tab-count">${count}</span>`}</button>`;

function prHeadHTML() {
  const ss = stages();
  const st = prState();
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const cur = ss.find((s) => s.st !== "done");
  return `<section class="pr-head" id="pr-head">
    <div class="pr-eyebrow"><span class="state ${st.cls}">${st.label}</span>${riskPillHTML(currentRisk())}<span class="mono dim">${esc(PR.repo)} #${PR.number}</span></div>
    <h1 class="pr-title">${esc(PR.title)}</h1>
    <p class="pr-meta">${avatar(PR.author, "sm")}<span><b>${esc(PEOPLE[PR.author].name)}</b> wants to merge
      <code class="ref">${esc(D.head.ref)}</code> into <code class="ref">${esc(D.base.ref)}</code></span>
      <span>${plural(commits.length, "commit")} · ${plural(files.length, "file")} · <span class="n-add">+${num(add)}</span> <span class="n-del">−${num(del)}</span> · about ${readTime(totalMinutes())} to review</span></p>
    ${trackHTML(ss)}
    <p class="track-sum">${cur ? `<b>${cur.name}</b><span>${esc(cur.caption)}</span>` : `<b>Shipped</b><span>Live in production</span>`}</p>
    <nav class="tabs" role="tablist" aria-label="Pull request">
      ${tabBtn("changes", "Changes", files.length)}${tabBtn("map", "Map", null)}${tabBtn("discussion", "Discussion", openThreadCount())}${tabBtn("workflow", "Workflow", `${ss.filter((s) => s.st === "done").length}/${ss.length}`)}
    </nav>
  </section>`;
}

/* ---------- Changes tab ---------- */

function changesHTML() {
  return `<div class="changes">
    <aside class="rail" id="rail" aria-label="Review guide">${guideHTML()}</aside>
    <div class="stream-wrap">${toolbarHTML()}<div class="stream" id="stream">${streamHTML()}</div></div>
  </div>`;
}

function toolbarHTML() {
  const c = counts();
  const f = (id, label, n) => `<button type="button" data-act="filter" data-filter="${id}" aria-pressed="${S.filter === id}">${label}<b>${n}</b></button>`;
  return `<div class="toolbar" id="toolbar">
    <div class="seg" role="group" aria-label="Show">${f("all", "All", c.all)}${f("new", "New to you", c.fresh)}${f("todo", "Unreviewed", c.todo)}${f("flag", "Flagged", c.flag)}${f("talk", "Comments", c.talk)}</div>
    <div class="tool-end">
      <button type="button" class="chip-toggle" data-act="fold" aria-pressed="${S.fold}" title="Summarize lockfiles and fold reviewed code">${icon("layers")}Fold noise</button>
      <div class="seg only-xl" role="group" aria-label="Diff layout">
        <button type="button" data-act="split" data-split="0" aria-pressed="${!S.split}">Unified</button><button type="button" data-act="split" data-split="1" aria-pressed="${S.split}">Split</button>
      </div>
    </div>
  </div>`;
}

function welcomeHTML() {
  if (!S.banner || !newCommits.length || !PR.lastReview || !PR.lastReview.at) return "";
  const freshHunks = files.flatMap((f) => f.hunks).filter((h) => h.fresh).length;
  const freshFiles = files.filter((f) => f.hunks.some((h) => h.fresh)).length;
  return `<section class="welcome" id="welcome" aria-label="Changes since your last review">
    <div class="welcome-mark">${icon("pencil")}</div>
    <div>
      <h2>Welcome back. ${esc(authorShort(true))} pushed ${plural(newCommits.length, "commit")} since your review on ${F_DAY.format(new Date(PR.lastReview.at))}.</h2>
      <p>${plural(freshHunks, "hunk")} in ${plural(freshFiles, "file")} changed. What you already reviewed stays folded, and every line that's new to you has a blue mark in the margin.</p>
      <ul class="welcome-commits">${newCommits.map((c) => `<li><code>${esc(c.short)}</code><span>${esc(c.subject)}</span><time>${ago(c.date)}</time></li>`).join("")}</ul>
    </div>
    <div class="welcome-actions">
      <button type="button" class="btn primary sm" data-act="filter" data-filter="new">Show only what's new</button>
      <button type="button" class="icon-btn sm" data-act="banner-close" aria-label="Dismiss">${icon("x")}</button>
    </div>
  </section>`;
}

const agentAv = (size = "") => `<span class="agent-av${size ? " " + size : ""}" aria-hidden="true">${icon("bot")}</span>`;

function findingsTally() {
  const accepted = FIND.filter((x) => findingState(x) === "accepted").length;
  const dismissed = FIND.filter((x) => findingState(x) === "dismissed").length;
  return `${accepted} added to your review, ${dismissed} dismissed`;
}

// In VS Code the extension runs the agents; the page can ask for a run and says when they reviewed an older push.
const agentsBehind = () => !!(AG && AG.commit && D.head && AG.commit !== D.head.sha);
const hostRunHTML = (label) => `<button type="button" class="btn sm ghost" data-act="host-run-agents">${icon("play")}${label}</button>`;
// Why an automatic run is held back (a large or an approved pull request), from the extension.
const runNoteHTML = () => (LIVE.runNote ? `<p>${esc(LIVE.runNote)}</p>` : "");

function briefHTML() {
  if (!FIND.length && !CHECKED.length && !DESC_ITEMS.length) {
    return `<section class="brief is-closed" id="brief" aria-label="Agent review"><header class="brief-head">${agentAv("lg")}<div class="brief-title"><h2>No agent review yet</h2>
      <p>Run the agents to check the description, set a reading order, draw the flow and look for problems.</p>${runNoteHTML()}</div>${hostRunHTML("Run agents")}</header></section>`;
  }
  const decided = FIND.length - openFindings().length;
  const head = `<header class="brief-head">${agentAv("lg")}<div class="brief-title"><h2>Agents reviewed this before you</h2>
      <p>${AGENTS.length} agents ran on <code>${esc(String((AG && AG.commit) || "").slice(0, 7))}</code> ${AGENT_RUN_AT ? ago(AGENT_RUN_AT) : ""} · ${plural(FIND.length, "finding")}${decided ? `, ${decided} decided` : ""}${agentsBehind() ? ` · <b>an older push than the one you're reviewing</b>` : ""}</p>${runNoteHTML()}</div>
      ${hostRunHTML(agentsBehind() ? "Run again" : "Rerun")}
      <button type="button" class="icon-btn sm" data-act="brief-toggle" aria-expanded="${S.brief}" aria-label="${S.brief ? "Collapse" : "Expand"} the agent briefing">${icon("chev")}</button></header>`;
  if (!S.brief) return `<section class="brief is-closed" id="brief" aria-label="Agent review">${head}</section>`;
  const items = FIND.map((x) => {
    const st = findingState(x);
    return `<li><button type="button" class="brief-item is-${st}" data-act="go-finding" data-id="${x.id}">
      <span class="sev sev-${x.severity}">${SEV[x.severity]}</span><span class="bi-title">${inline(x.title)}</span>
      <span class="bi-where mono">${esc(files[x.f].base)}:${x.k.slice(1)}</span>
      <span class="bi-state">${st === "open" ? icon("arrow") : st === "accepted" ? "In your review" : "Dismissed"}</span></button></li>`;
  }).join("");
  const checked = CHECKED.map((c) => {
    const f = byPath.get(c.path);
    return `<li><span class="checked-agent">${esc(AGENT_BY[c.agent].short)}</span><span class="checked-text">${inline(c.text)}</span>${f ? `<button type="button" class="link mono" data-act="goto-file" data-f="${f.i}">${esc(f.base)}</button>` : ""}</li>`;
  }).join("");
  return `<section class="brief" id="brief" aria-label="Agent review">
    ${head}
    ${BRIEF_LEDE ? `<p class="brief-lede">${inline(BRIEF_LEDE)}</p>` : ""}
    ${descSummaryHTML()}
    ${briefMapHTML()}
    ${FIND.length ? `<ol class="brief-list">${items}</ol>` : ""}
    <div class="brief-checked"><button type="button" class="brief-more" data-act="checked-toggle" aria-expanded="${S.checkedOpen}">${icon("check-circle")}${plural(CHECKED.length, "thing")} checked and fine${icon("chev", "chev")}</button>
      ${S.checkedOpen ? `<ul class="checked">${checked}</ul>` : ""}</div>
    <p class="brief-note">${icon("info")}<span>${ownPR()
      ? "Agents don't approve or block. It's your pull request, so treat this as your check before anyone else reviews it. Findings are never posted on their own."
      : `Agents don't approve or block. You decide on every finding, and ${esc(PEOPLE[PR.author].short)} only sees what you post.`}</span></p>
  </section>`;
}

function briefMapHTML() {
  const dg = DIAGRAMS[0];
  if (!dg || !dg.steps) return "";
  const pinned = new Set(dg.nodes.flatMap((n) => liveFinds(n).map((x) => x.id))).size;
  const added = dg.nodes.filter((n) => n.change === "added").length;
  return `<div class="brief-map">${icon("flow")}<span class="bm-text"><b>${inline(dg.title)}</b>
      <span>Drawn as ${plural(dg.steps, "step")}${added ? `, ${added} of them new` : ""}${pinned ? `, with ${plural(pinned, "finding")} on it` : ""}</span></span>
    <span class="bm-acts"><button type="button" class="btn sm" data-act="tab" data-tab="map">See the map</button><button type="button" class="btn sm agent" data-act="tour-start">${icon("play")}Follow the flow</button></span></div>`;
}

/* The description check: a summary in the briefing and on Discussion, and a sheet with every rule. */

const descKind = () => DESC_KINDS[DESC.kind].toLowerCase();
const descTitles = (items) => joinNames(items.map((it) => DESC_RULES[it.rule].noun));

function descChipsHTML() {
  return `<ul class="dc-chips" aria-label="Description rules">${DESC_ITEMS.map((it) => `<li class="dc-chip is-${it.status}${descIsGap(it) && descState(it) !== "open" ? " is-decided" : ""}">
    ${icon(DESC_ICON[it.status])}<span>${esc(DESC_RULES[it.rule].title)}</span><span class="sr-only"> · ${esc(DESC_STATUS[it.status])}</span></li>`).join("")}</ul>`;
}

function descSummaryHTML() {
  if (!DESC_ITEMS.length) return "";
  const open = descOpen();
  const asked = DESC_GAPS.filter((it) => descState(it) === "asked").length;
  const skipped = DESC_GAPS.length - open.length - asked;
  const see = `<button type="button" class="btn sm" data-act="desc-sheet">See the check</button>`;
  let text, acts;
  if (!DESC_GAPS.length) { text = `It covers every rule for a ${esc(descKind())}.`; acts = see; }
  else if (ownPR()) {
    text = `Reviewers will ask about ${esc(descTitles(DESC_GAPS))}. Adding ${DESC_GAPS.length === 1 ? "it" : "them"} to your description first saves a round trip, and gives the agents the context next time they run.`;
    acts = `${LIVE.url ? `<a class="btn sm agent" href="${esc(LIVE.url)}" target="_blank" rel="noopener">${icon("external")}Edit it on GitHub</a>` : ""}${see}`;
  } else if (open.length) {
    text = `${cap(esc(descTitles(open)))} ${open.length === 1 ? "is" : "are"} missing or thin.${asked || skipped ? ` ${[asked ? `${asked} asked` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(", ")}.` : ""}`;
    acts = `<button type="button" class="btn sm agent" data-act="desc-ask-all">${icon("plus")}Ask ${esc(authorShort(false))} for ${open.length === 1 ? "it" : `all ${open.length}`}</button>${see}`;
  } else {
    // Questions that went out with a posted review read as asked; the rest still wait in the summary.
    const posted = DESC_GAPS.filter((it) => descState(it) === "asked" && S.desc[it.rule].posted).length;
    const waiting = [posted ? `${plural(posted, "question")} asked in your review` : "", asked - posted ? `${plural(asked - posted, "question")} in your review summary` : ""].filter(Boolean);
    text = `${waiting.length ? cap(waiting.join(", ")) : "No questions asked"}${skipped ? `, ${skipped} skipped` : ""}.`;
    acts = see;
  }
  return `<div class="brief-desc" id="desc-sum">${icon("doc")}<div class="bd-main">
      <p class="bd-head"><b>Description</b><span>checked as a ${esc(descKind())} · ${DESC_ITEMS.length - DESC_GAPS.length} of ${DESC_ITEMS.length} covered</span></p>
      ${descChipsHTML()}
      <p class="bd-text">${text}${DESC_STALE ? ` <span class="dc-stale-inline">It changed after the check ran.</span>` : ""}</p>
      <div class="bd-acts">${acts}</div></div></div>`;
}

function descItemHTML(it) {
  const st = descState(it), r = DESC_RULES[it.rule], own = ownPR();
  const refs = it.refs.length ? `<div class="dc-refs">${it.refs.map((x) => `<button type="button" class="dc-ref" data-act="go-line" data-f="${x.f}" data-k="${x.k}"><span class="mono">${esc(files[x.f].base)}:${x.k.slice(1)}</span><code>${esc(x.match)}</code></button>`).join("")}</div>` : "";
  let foot = "";
  if (descIsGap(it) && !own) {
    const undo = `<button type="button" class="link" data-act="desc-undo" data-rule="${it.rule}">Undo</button>`;
    if (st === "asked") foot = S.desc[it.rule].posted ? `<p class="dc-done">${icon("check")}<span>Asked in your review</span></p>` : `<p class="dc-done">${icon("check")}<span>In your review summary</span>${undo}</p>`;
    else if (st === "skipped") foot = `<p class="dc-done"><span>Skipped as “${esc(S.desc[it.rule].reason)}”</span>${undo}</p>`;
    else if (S.descSkipping === it.rule) foot = `<div class="dc-acts"><span class="dismiss-q">Why skip it?</span>${DESC_SKIP_REASONS.map((x) => `<button type="button" class="btn sm" data-act="desc-skip" data-rule="${it.rule}" data-r="${esc(x)}">${esc(x)}</button>`).join("")}<button type="button" class="btn sm ghost" data-act="desc-skip-cancel">Cancel</button></div>`;
    else foot = `<div class="dc-acts"><button type="button" class="btn sm agent" data-act="desc-ask" data-rule="${it.rule}">${icon("plus")}Ask in my review</button><button type="button" class="btn sm ghost" data-act="desc-skip-ask" data-rule="${it.rule}">Skip</button></div>`;
  }
  return `<li class="dc-item is-${it.status}${descIsGap(it) && st !== "open" ? " is-decided" : ""}" id="dc-${it.rule}">
    <p class="dc-top"><span class="dc-st is-${it.status}">${icon(DESC_ICON[it.status])}${esc(DESC_STATUS[it.status])}</span><b>${esc(r.title)}</b></p>
    <p class="dc-rule">${esc(r.text)}</p>
    ${it.quote ? `<blockquote class="dc-quote">${inline(it.quote)}</blockquote>` : ""}
    ${it.note ? `<p class="dc-note">${inline(it.note)}</p>` : ""}
    ${refs}
    ${descIsGap(it) && it.ask ? `<p class="dc-ask">${agentAv("xs")}<span>${inline(it.ask)}</span></p>` : ""}
    ${foot}</li>`;
}

function descSheetHTML() {
  const own = ownPR(), open = descOpen();
  const foot = own
    ? (LIVE.url ? `<a class="btn agent" href="${esc(LIVE.url)}" target="_blank" rel="noopener">${icon("external")}Edit it on GitHub</a>` : "")
    : open.length ? `<button type="button" class="btn agent" data-act="desc-ask-all">${icon("plus")}Ask for ${open.length === 1 ? "it" : `all ${open.length}`}</button>` : "";
  return `${sheetHead("desc", "Description check")}
  <div class="sheet-body">
    <p class="dc-kind">The guide agent checked ${own ? "your" : `${esc(PEOPLE[PR.author].short)}'s`} description as a <b>${esc(descKind())}</b>.${DESC.why ? ` ${inline(cap(String(DESC.why).replace(/\.$/, "")))}.` : ""}</p>
    ${DESC_STALE ? `<p class="dc-stale">${icon("alert")}<span>The description changed after this check ran, so some quotes may be out of date.</span></p>` : ""}
    <ol class="dc-list">${DESC_ITEMS.map(descItemHTML).join("")}</ol>
    <p class="brief-note">${icon("info")}<span>The other agents read this check before they review, so a gap in the description becomes a question for the author instead of a guess. ${own ? "Reviewers see the same check." : "Questions you ask go into your review summary and post with your review."}</span></p>
  </div>
  <div class="sheet-foot"><button type="button" class="btn ghost" data-act="sheet-close">Close</button>${foot}</div>`;
}

function refreshDesc(focusRule) {
  if (S.sheet && S.sheet.id === "desc") {
    const sheet = $("#sheet-desc");
    if (sheet) sheet.innerHTML = descSheetHTML();
    const el = focusRule && document.getElementById(`dc-${focusRule}`);
    if (el) { const b = el.querySelector("button"); if (b) b.focus({ preventScroll: true }); }
  }
  const sum = $("#desc-sum");
  if (sum) replaceHTML(sum, descSummaryHTML());
  const card = $("#desc-card");
  if (card) replaceHTML(card, descCardHTML());
}

function descCardHTML() {
  return DESC_ITEMS.length ? `<section class="desc-check" id="desc-card" aria-label="Description check">${descSummaryHTML().replace(' id="desc-sum"', "")}</section>` : "";
}

// Where a finding sits on the map, as a link back to it.
function findingMapHTML(x) {
  for (const dg of DIAGRAMS) {
    const ns = dg.nodes.filter((n) => n.finds.includes(x));
    if (!ns.length) continue;
    const nums = ns.filter((n) => n.num).map((n) => String(n.num));
    const text = nums.length > 1 ? `Steps ${joinNames(nums)}` : nums.length ? `Step ${nums[0]}` : "On the map";
    return `<button type="button" class="finding-map" data-act="map-node" data-dg="${esc(dg.id)}" data-node="${esc(ns[0].id)}" title="Show it on the map">${icon("flow")}${text}</button>`;
  }
  return "";
}

function findingHTML(x) {
  const st = findingState(x);
  const a = AGENT_BY[x.agent];
  if (st !== "open") {
    const rec = decisionOf(x.id) || {};
    const pending = rec.draft && S.drafts.some((d) => d.id === rec.draft);
    const what = (st === "accepted" ? (pending ? "Added to your review as a draft" : "Posted in your review") : `Dismissed as “${rec.reason}”`) + (earlierRun(rec) ? " on an earlier run" : "");
    return `<div class="finding is-${st}" id="fd-${x.id}"><div class="finding-sum">${agentAv("sm")}<span class="sev sev-${x.severity}">${SEV[x.severity]}</span>
      <span class="fs-text"><b>${inline(x.title)}</b> · ${esc(what)}</span>${st === "dismissed" || pending ? `<button type="button" class="link" data-act="finding-undo" data-id="${x.id}">Undo</button>` : ""}</div></div>`;
  }
  const why = S.evidence.has(x.id);
  const steps = why ? `<ol class="steps">${x.steps.map((st2) => `<li><button type="button" class="step" data-act="go-line" data-f="${st2.f}" data-k="${st2.k}"><span class="mono">${esc(files[st2.f].base)}:${st2.k.slice(1)}</span><span>${esc(st2.text)}</span></button></li>`).join("")}</ol>` : "";
  const answers = (x.followups || []).map((q, i) => (S.answers.has(`${x.id}:${i}`) ? `<p class="fa">${agentAv("xs")}<span>${esc(q.a)}</span></p>` : "")).join("");
  const foot = S.dismissing === x.id
    ? `<span class="dismiss-q">Why dismiss it?</span>${DISMISS_REASONS.map((r) => `<button type="button" class="btn sm" data-act="finding-dismiss" data-id="${x.id}" data-r="${esc(r)}">${esc(r)}</button>`).join("")}<button type="button" class="btn sm ghost" data-act="finding-dismiss-cancel">Cancel</button>`
    : `<button type="button" class="btn sm agent" data-act="finding-adopt" data-id="${x.id}">${icon("plus")}Add to my review</button><button type="button" class="btn sm ghost" data-act="copy-finding" data-id="${x.id}" title="Copy the finding word for word">${icon("copy")}Copy</button><button type="button" class="btn sm ghost" data-act="finding-dismiss-ask" data-id="${x.id}">Dismiss</button>`;
  return `<article class="finding" id="fd-${x.id}" aria-label="${esc(a.name)}: ${esc(x.title.replace(/`/g, ""))}">
    <header class="finding-head">${agentAv("sm")}<b>${esc(a.name)}</b><span class="sev sev-${x.severity}">${SEV[x.severity]}</span><span class="finding-conf">${esc(x.confidence)}</span>${findingMapHTML(x)}</header>
    <h4 class="finding-title">${inline(x.title)}</h4>
    <p class="finding-body">${inline(x.body)}</p>
    ${x.steps.length ? `<button type="button" class="finding-why" data-act="finding-why" data-id="${x.id}" aria-expanded="${why}">${icon("chev")}How the agent got there</button>${steps}` : ""}
    ${x.fix ? `<div class="finding-fix"><p><b>Suggested fix.</b> ${inline(x.fix.text)}</p>${x.fix.code ? `<pre class="fix-code">${x.fix.code.split("\n").map((l) => hl(l, x.fix.lang)).join("\n")}</pre>` : ""}</div>` : ""}
    ${x.followups && x.followups.length ? `<div class="fq-row">${x.followups.map((q, i) => `<button type="button" class="fq${S.answers.has(`${x.id}:${i}`) ? " is-on" : ""}" data-act="followup" data-id="${x.id}" data-q="${i}" aria-expanded="${S.answers.has(`${x.id}:${i}`)}">${esc(q.q)}</button>`).join("")}</div>${answers}` : ""}
    <footer class="finding-foot">${foot}</footer>
  </article>`;
}

function findingItemHTML(x) {
  const st = findingState(x);
  return `<li><button type="button" class="titem" data-act="go-finding" data-id="${x.id}">
    <span class="titem-top"><span class="sev sev-${x.severity}">${SEV[x.severity]}</span><span class="mono">${esc(files[x.f].base)} · ${esc(lineName(x.k))}</span>${st !== "open" ? `<span>· ${st === "accepted" ? "added" : "dismissed"}</span>` : ""}</span>
    <span class="titem-text">${inline(x.title)}</span></button></li>`;
}

function flagHTML(f) {
  const fl = fileOpenFindings(f);
  if (!fl.length) return "";
  const top = fl.reduce((a, b) => (SEV_RANK[b.severity] > SEV_RANK[a.severity] ? b : a));
  return `<span class="g-flag gf-${top.severity}" title="${plural(fl.length, "open agent finding")}">${icon("bot")}${fl.length}</span>`;
}

function agentsRowHTML() {
  if (!FIND.length) return "";
  const open = openFindings();
  return `<button type="button" class="g-agents" data-act="go-brief">${agentAv("xs")}<span>${open.length ? `${plural(open.length, "agent finding")} to decide` : "Every agent finding is decided"}</span>${icon("arrow")}</button>`;
}

function streamHTML() {
  const parts = [briefHTML(), welcomeHTML()];
  let shown = 0;
  for (const c of chapters) {
    const fs = c.files.filter(fileVisible);
    if (!fs.length) continue;
    shown += fs.length;
    parts.push(chapterHTML(c, fs));
  }
  parts.push(shown ? endHTML() : emptyHTML());
  return parts.join("");
}

function chProgHTML(c) {
  const p = chapterProgress(c);
  return `<span class="ch-prog">${p.all ? `${icon("check")}Reviewed` : `${p.done} of ${plural(p.total, "hunk")}`}</span>`;
}

const KIND_WORD = { plan: "Chapter", auto: "Chapter", commit: "Commit", folder: "Folder" };

function chapterMetaHTML(c) {
  if (c.kind === "commit") {
    const cm = commits[c.commit];
    return cm ? `<p class="ch-source"><code>${esc(cm.short)}</code> · ${esc(cm.author)} · ${ago(cm.date)}</p>` : "";
  }
  if (c.kind === "folder") return `<p class="ch-source">${plural(c.files.length, "file")}</p>`;
  if (c.source && c.source.kind === "description") return `<p class="ch-source">From ${ownPR() ? "your" : `${esc(PEOPLE[PR.author].short)}'s`} description: “${inline(c.source.text)}”</p>`;
  if (c.source && c.source.kind === "commits") return `<p class="ch-source">From the commits: “${inline(c.source.text)}”</p>`;
  return "";
}

function chapterHTML(c, fs) {
  const p = chapterProgress(c);
  return `<section class="chapter${p.all ? " is-done" : ""}" id="ch-${c.n}" data-ch="${c.n}">
    <header class="ch-head">
      <span class="ch-num" aria-hidden="true">${c.n}</span>
      <div>
        <p class="eyebrow">${KIND_WORD[c.kind] || "Chapter"} ${c.n} of ${chapters.length}${c.quiet ? " · low risk" : ""}</p>
        <h2${c.kind === "folder" ? ' class="is-path"' : ""}>${esc(c.title)}</h2>
        ${c.note ? `<p class="ch-note">${c.kind === "plan" || c.kind === "auto" ? agentAv("xs") : ""}<span>${inline(c.note)}</span></p>` : ""}
        ${chapterMetaHTML(c)}
      </div>
      ${chProgHTML(c)}
    </header>
    <div class="ch-files">${fs.map(fileHTML).join("")}</div>
  </section>`;
}

function emptyHTML() {
  const copy = {
    new: ["You're caught up", "Everything that changed since your last review is marked reviewed.", `<button type="button" class="btn sm" data-act="filter" data-filter="all">Show all changes</button>`],
    todo: ["Everything is reviewed", "Every hunk has your mark. Time to decide.", finishBtnHTML("end")],
    flag: ["Nothing flagged", "The agents didn't flag anything in this pull request.", `<button type="button" class="btn sm" data-act="filter" data-filter="all">Show all changes</button>`],
    talk: ["No comments yet", "Click a line number to start a comment.", `<button type="button" class="btn sm" data-act="filter" data-filter="all">Show all changes</button>`],
    all: ["No changes", "This branch has no differences from its base.", ""],
  }[S.filter];
  return `<div class="end"><h3>${copy[0]}</h3><p>${copy[1]}</p>${copy[2]}</div>`;
}

function endHTML() {
  const c = counts();
  if (!c.todo) return `<div class="end"><h3>That's the whole change</h3><p>You reviewed all ${c.all} hunks. Post your comments and pick a decision.</p>${finishBtnHTML("end")}</div>`;
  return `<div class="end"><h3>${plural(c.todo, "hunk")} left</h3><p>About ${readTime(remainingMinutes())} of reading. Unreviewed hunks stay open until you mark them.</p>
    <button type="button" class="btn sm" data-act="next-unreviewed">Jump to the next one</button></div>`;
}

function pathHTML(f) {
  const cur = `<span class="dir">${esc(f.dir)}</span><span class="base">${esc(f.base)}</span>`;
  return f.status === "renamed" && f.oldPath ? `<span class="dir">${esc(f.oldPath)}</span>${icon("arrow", "path-arrow")}${cur}` : cur;
}

function fileHeadHTML(f) {
  const p = fileProgress(f);
  const collapsed = isCollapsed(f);
  const status = { added: "Added", deleted: "Deleted", renamed: "Renamed" }[f.status];
  const tags = [
    status ? `<span class="tag tag-${f.status}">${status}${f.status === "renamed" && f.similarity ? ` · ${f.similarity}% same` : ""}</span>` : "",
    f.generated ? `<span class="tag">Generated</span>` : "",
    fileOpenFindings(f).length ? `<span class="tag tag-agent">${icon("bot")}${plural(fileOpenFindings(f).length, "finding")}</span>` : "",
  ].join("");
  return `<header class="fh" id="fh-${f.i}">
    <button type="button" class="fh-toggle" data-act="file-toggle" data-f="${f.i}" aria-expanded="${!collapsed}" aria-label="${collapsed ? "Expand" : "Collapse"} ${esc(f.path)}">${icon("chev")}</button>
    <div class="fh-path" title="${esc(f.path)}">${pathHTML(f)}</div>
    <div class="fh-meta">${tags}<span class="fh-counts"><span class="n-add">+${f.additions}</span><span class="n-del">−${f.deletions}</span></span></div>
    <button type="button" class="tick tick-file${p.done && !p.all ? " is-part" : ""}" data-act="file-reviewed" data-f="${f.i}" aria-pressed="${p.all}" style="--p:${p.total ? p.done / p.total : 0}" aria-label="${p.all ? "Mark file unreviewed" : "Mark the whole file reviewed"}">${TICK}<span class="tick-l">${p.all ? "Reviewed" : "Mark reviewed"}</span></button>
  </header>`;
}

function hintsHTML(f) {
  const hints = [];
  if (f.tests) {
    const name = f.tests.path.split("/").pop();
    hints.push(f.tests.changed
      ? `<span class="hint ok">${icon("check-circle")}Tests updated in <code>${esc(name)}</code></span>`
      : `<span class="hint warn">${icon("alert")}<code>${esc(name)}</code> wasn't updated</span>`);
  }
  return hints.length ? `<div class="hints">${hints.join("")}</div>` : "";
}

function fileHTML(f) {
  const collapsed = isCollapsed(f);
  let body = "";
  if (!collapsed) {
    const fileSlot = slotHTML(f, "file");
    const content = f.deps && S.fold && !S.raw.has(f.i) ? depsHTML(f) : hunksHTML(f);
    body = `<div class="fbody">${hintsHTML(f)}${fileSlot}${content}</div>`;
  }
  return `<article class="file${collapsed ? " is-collapsed" : ""}${fileProgress(f).all ? " is-reviewed" : ""}" id="f-${f.i}" data-f="${f.i}">${fileHeadHTML(f)}${body}</article>`;
}

function hunksHTML(f) {
  if (!f.hunks.length) return `<div class="deps"><p class="deps-lede">${icon("info")}<span>${f.binary ? "Binary file. There's nothing to show line by line." : "Renamed without changes."}</span></p></div>`;
  let out = "";
  f.hunks.forEach((h, idx) => {
    if (!hunkVisible(f, h)) return;
    if (S.filter === "all") out += gapHTML(f, idx);
    out += hunkHTML(f, h);
  });
  if (S.filter === "all") out += gapHTML(f, f.hunks.length);
  return out;
}

function gapAt(f, idx) {
  if (!f.content) return null;
  const prev = f.hunks[idx - 1], next = f.hunks[idx];
  if (!prev && !next) return null;
  const from = prev ? (prev.newLines ? prev.newStart + prev.newLines : prev.newStart + 1) : 1;
  const to = next ? (next.newLines ? next.newStart - 1 : next.newStart) : f.content.length;
  if (to < from) return null;
  const offset = prev
    ? (prev.oldLines ? prev.oldStart + prev.oldLines : prev.oldStart + 1) - from
    : (next.oldLines ? next.oldStart : next.oldStart + 1) - (next.newLines ? next.newStart : next.newStart + 1);
  return { from, to, offset, count: to - from + 1 };
}

function gapHTML(f, idx) {
  const g = gapAt(f, idx);
  if (!g) return "";
  const key = `${f.i}:${idx}`;
  if (!S.gaps.has(key)) {
    const where = idx === 0 ? " above" : idx === f.hunks.length ? " below" : "";
    return `<button type="button" class="gap" data-act="expand" data-g="${key}">${icon("unfold")}<span>Show ${plural(g.count, "unchanged line")}${where}</span></button>`;
  }
  let rows = "";
  for (let n = g.from; n <= g.to; n++) {
    const l = [" ", n + g.offset, n, f.content[n - 1] ?? "", -1, 0];
    rows += useSplit() ? sRow(f, l, null, l, null) : uRow(f, l, null);
    rows += slotHTML(f, `n${n}`);
  }
  return `<div class="rows ctx">${rows}</div>`;
}

function hunkHTML(f, h) {
  const done = S.reviewed.has(h.key);
  const open = hunkOpen(h);
  const range = f.status === "added" && f.hunks.length === 1
    ? `New file · ${plural(h.newLines, "line")}`
    : `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
  return `<section class="hunk${done ? " is-reviewed" : ""}${open ? " is-open" : ""}${S.focus === h.key ? " is-focus" : ""}" id="h-${h.key.replace(":", "-")}" data-h="${h.key}">
    <header class="hh">
      <button type="button" class="hh-toggle" data-act="hunk-open" data-h="${h.key}" ${done ? `aria-expanded="${open}"` : 'tabindex="-1"'}>
        <span class="hh-range">${range}</span>${h.section ? `<span class="hh-sec">${hl(h.section, f.lang)}</span>` : ""}
      </button>
      ${done && !open ? `<span class="hh-lines">${plural(h.weight, "changed line")}</span>` : ""}
      ${open && longSummary(h) ? `<span class="hh-long">${esc(longSummary(h))}</span>` : ""}
      ${h.fresh && !done ? `<span class="pill-new">New to you</span>` : ""}
      ${hunkHasOpenFinding(h) ? `<span class="pill-agent">${icon("bot")}Flagged</span>` : ""}
      <button type="button" class="tick" data-act="toggle-hunk" data-h="${h.key}" aria-pressed="${done}">${TICK}<span class="tick-l">${done ? "Reviewed" : "Mark reviewed"}</span></button>
    </header>
    ${open ? `<div class="rows">${rowsHTML(f, h)}</div>` : ""}
  </section>`;
}

function uRow(f, l, ranges) {
  const [t, o, n, s, , fresh] = l;
  const k = lineKey(l);
  const cls = t === "+" ? " add" : t === "-" ? " del" : "";
  const sign = t === "+" ? "+" : t === "-" ? "−" : "";
  return `<div class="row${cls}${fresh ? " fresh" : ""}" data-f="${f.i}" data-k="${k}">`
    + `<button type="button" class="add-c" data-act="comment" data-f="${f.i}" data-k="${k}" tabindex="-1" aria-label="Comment on ${lineName(k)}">${icon("plus")}</button>`
    + `<span class="no no-o" data-act="comment" data-f="${f.i}" data-k="${k}">${o ?? ""}</span>`
    + `<span class="no no-n" data-act="comment" data-f="${f.i}" data-k="${k}">${n ?? ""}</span>`
    + `<div class="cd" style="--i:${indentOf(s)}"><span class="sg" aria-hidden="true">${sign}</span>${hl(s, f.lang, ranges)}</div></div>`;
}

function sRow(f, left, lr, right, rr) {
  const cell = (l, ranges, side) => {
    if (!l) return `<span class="no"></span><div class="cd empty"></div>`;
    const [t, o, n, s, , fresh] = l;
    const k = lineKey(l);
    const cls = t === "+" ? " add" : t === "-" ? " del" : "";
    return `<span class="no${cls}" data-act="comment" data-f="${f.i}" data-k="${k}">${(side === "L" ? o : n) ?? ""}</span>`
      + `<div class="cd${cls}${fresh ? " fresh" : ""}" style="--i:${indentOf(s)}">${hl(s, f.lang, ranges)}</div>`;
  };
  const k = right ? lineKey(right) : left ? lineKey(left) : "";
  return `<div class="srow" data-f="${f.i}" data-k="${k}">${cell(left, lr, "L")}${cell(right, rr, "R")}</div>`;
}

/* A long line that changed shows once: deletions struck through, insertions marked, and the unchanged
   text around them folded, keeping whole sentences next to each change. */

function charClasses(str, lang) {
  const cls = new Array(str.length).fill("");
  let pos = 0;
  for (const t of tokenize(str, lang)) { if (t.c) cls.fill(t.c, pos, pos + t.s.length); pos += t.s.length; }
  return cls;
}

function paint(str, cls, from, to) {
  let out = "";
  for (let i = from; i < to;) {
    let j = i + 1;
    while (j < to && cls[j] === cls[i]) j++;
    const piece = esc(str.slice(i, j));
    out += cls[i] ? `<span class="t-${cls[i]}">${piece}</span>` : piece;
    i = j;
  }
  return out;
}

const SENTENCE_END = /\.\s|\\n|\n/g;

// Where the context before a change starts: the start of its sentence, if it's near.
function ctxStart(t, end) {
  const floor = Math.max(0, end - 280);
  let cut = -1;
  SENTENCE_END.lastIndex = floor;
  for (let m; (m = SENTENCE_END.exec(t)) && m.index + m[0].length <= end;) cut = m.index + m[0].length;
  if (cut >= 0) return cut;
  if (!floor) return 0;
  const sp = t.indexOf(" ", end - 100);
  return sp < 0 || sp >= end ? end - 100 : sp + 1;
}

// Where the context after a change ends: the end of the sentence it continues into.
function ctxEnd(t, start) {
  const ceil = Math.min(t.length, start + 280);
  SENTENCE_END.lastIndex = start;
  const m = SENTENCE_END.exec(t);
  if (m && m.index < ceil) return m.index + m[0].length;
  if (ceil === t.length) return ceil;
  const sp = t.indexOf(" ", start + 100);
  return sp < 0 || sp > ceil ? ceil : sp;
}

function longTextHTML(a, b, ops, lang, open, key) {
  const ca = charClasses(a, lang), cb = charClasses(b, lang);
  const count = (n) => `⋯ ${n.toLocaleString("en-US")} unchanged characters`;
  const gap = (n) => (key ? `<button type="button" class="lw-gap" data-act="long-toggle" data-key="${key}" title="Show the whole line">${count(n)}</button>` : `<span class="lw-gap">${count(n)}</span>`);
  let out = "";
  ops.forEach((o, j) => {
    if (o[0] === "-") { out += `<del class="wd">${paint(a, ca, o[1], o[2])}</del>`; return; }
    if (o[0] === "+") { out += `<ins class="wi">${paint(b, cb, o[3], o[4])}</ins>`; return; }
    const s0 = o[3], e0 = o[4];
    const first = j === 0, last = j === ops.length - 1;
    // The line's first words say which line this is; the rest keeps the sentences around each change.
    const head = first ? Math.min(e0, (b.indexOf(" ", Math.max(indentOf(b), s0) + 40) + 1) || e0) : ctxEnd(b, s0);
    const tail = last ? e0 : ctxStart(b, e0);
    if (open || tail - head < 120) { out += paint(b, cb, s0, e0); return; } // too little to be worth folding
    out += paint(b, cb, s0, head) + gap(tail - head) + paint(b, cb, tail, e0);
  });
  if (open) out += ` <button type="button" class="lw-gap is-open" data-act="long-toggle" data-key="${key}">Fold the unchanged text</button>`;
  return out;
}

function longRowHTML(f, h, di, lp) {
  const del = h.lines[di], add = h.lines[lp.add];
  const k = lineKey(add);
  const key = `${f.i}:${k}`;
  const nums = (side) => `<span class="no no-${side}" data-act="comment" data-f="${f.i}" data-k="${k}">${side === "o" ? del[1] : add[2]}</span>`;
  return `<div class="row lrow${add[5] ? " fresh" : ""}" data-f="${f.i}" data-k="${k}">`
    + `<button type="button" class="add-c" data-act="comment" data-f="${f.i}" data-k="${k}" tabindex="-1" aria-label="Comment on ${lineName(k)}">${icon("plus")}</button>`
    + nums("o") + nums("n")
    + `<div class="cd" style="--i:${indentOf(add[3])}"><span class="sg" aria-hidden="true">±</span>${longTextHTML(del[3], add[3], lp.ops, f.lang, S.longOpen.has(key), key)}</div></div>`;
}

// What changed in a hunk's long lines, for its header.
function longSummary(h) {
  const wd = wordDiffs(h);
  if (!wd.long.size) return "";
  let plus = 0, minus = 0;
  wd.long.forEach(({ ops }) => { plus += ops.added; minus += ops.removed; });
  const n = (x) => x.toLocaleString("en-US");
  return `${wd.long.size === 1 ? "One long line" : `${wd.long.size} long lines`} changed: ${[plus && `${n(plus)} characters added`, minus && `${n(minus)} removed`].filter(Boolean).join(", ")}`;
}

function rowsHTML(f, h) {
  const wd = wordDiffs(h);
  const L = h.lines;
  let out = "";
  if (!useSplit()) {
    L.forEach((l, i) => {
      if (wd.longAdd.has(i)) return; // shown together with its old version
      const lp = wd.long.get(i);
      out += lp ? longRowHTML(f, h, i, lp) + slotHTML(f, lineKey(l)) + slotHTML(f, lineKey(L[lp.add])) : uRow(f, l, wd.get(i)) + slotHTML(f, lineKey(l));
    });
    return out;
  }
  let i = 0;
  while (i < L.length) {
    if (L[i][0] === " ") { out += sRow(f, L[i], null, L[i], null) + slotHTML(f, lineKey(L[i])); i++; continue; }
    const dels = [], adds = [];
    while (i < L.length && L[i][0] === "-") dels.push(i++);
    while (i < L.length && L[i][0] === "+") adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const a = dels[k], b = adds[k];
      const lp = a != null && wd.long.get(a);
      if (lp) { out += longRowHTML(f, h, a, lp) + slotHTML(f, lineKey(L[a])) + slotHTML(f, lineKey(L[b])); continue; }
      out += sRow(f, a != null ? L[a] : null, a != null ? wd.get(a) : null, b != null ? L[b] : null, b != null ? wd.get(b) : null);
      if (a != null) out += slotHTML(f, lineKey(L[a]));
      if (b != null) out += slotHTML(f, lineKey(L[b]));
    }
  }
  return out;
}

/* ---------- Threads, drafts and the composer ---------- */

const composerHere = (fi, k) => S.composer && !S.composer.sheet && !S.composer.replyTo && S.composer.f === fi && S.composer.k === k;

function slotHTML(f, k) {
  const threads = threadsAt(f.i, k);
  const drafts = draftsAt(f.i, k).filter((d) => !(S.composer && !S.composer.sheet && S.composer.editing === d.id));
  const comp = composerHere(f.i, k);
  const finds = k === "file" ? [] : findingsAt(f.i, k);
  if (!threads.length && !drafts.length && !comp && !finds.length) return "";
  return `<div class="slot${k === "file" ? " slot-file" : ""}" data-slot="${slotKey(f.i, k)}">${finds.map(findingHTML).join("")}${threads.map(threadHTML).join("")}${drafts.map(draftHTML).join("")}${comp ? composerHTML() : ""}</div>`;
}

function commentHTML(c, label, anchor) {
  const tools = c.draft ? `<span class="cmt-tools"><button type="button" class="link" data-act="edit-draft" data-id="${c.draft}">Edit</button><button type="button" class="link" data-act="delete-draft" data-id="${c.draft}">Delete</button></span>` : "";
  return `<article class="cmt">${avatar(c.by, "sm")}<div class="cmt-main">
    <header class="cmt-head"><b>${esc(nameOf(c.by))}</b>${label ? `<span class="label l-${label}">${label}</span>` : ""}${c.via ? `<span class="cmt-via">${icon("bot")}${c.verbatim ? "The agent's words" : "From an agent finding"}</span>` : ""}${c.draft ? `<span class="label l-draft">draft</span>` : `<time>${ago(c.at)}</time>`}${tools}</header>
    <div class="cmt-body">${bodyHTML(c.body, anchor)}</div></div></article>`;
}

function draftHTML(d) {
  return `<div class="thread is-draft" id="th-${d.id}">${commentHTML({ by: "you", body: d.body, draft: d.id, via: d.fromFinding, verbatim: d.verbatim }, d.label, d)}</div>`;
}

function threadHTML(t) {
  const resolved = t.state === "resolved";
  if (resolved && !S.openThreads.has(t.id)) {
    return `<div class="thread is-resolved" id="th-${t.id}"><button type="button" class="thread-sum" data-act="thread-open" data-id="${t.id}">${icon("check-circle")}
      <span class="ts-text"><b>Resolved${t.resolvedBy ? ` by ${esc(t.resolvedBy === "you" ? "you" : PEOPLE[t.resolvedBy]?.short || t.resolvedBy)}` : ""}</b> · ${esc(firstLine(t.comments[0].body))}</span>
      <span class="dim">${plural(t.comments.length, "comment")}</span></button></div>`;
  }
  const editingReply = S.composer && !S.composer.sheet && S.composer.replyTo === t.id;
  const replies = S.drafts.filter((d) => d.replyTo === t.id && !(editingReply && S.composer.editing === d.id));
  const foot = editingReply ? composerHTML() : `<div class="thread-foot">
      <button type="button" class="btn sm ghost" data-act="reply" data-id="${t.id}">${icon("reply")}Reply</button>
      ${resolved ? `<button type="button" class="btn sm ghost" data-act="unresolve" data-id="${t.id}">Reopen</button>`
        : `<button type="button" class="btn sm" data-act="resolve" data-id="${t.id}">${icon("check")}Resolve</button>`}
    </div>`;
  return `<div class="thread" id="th-${t.id}">
    ${t.comments.map((c, i) => commentHTML(c, i === 0 ? t.label : "", t)).join("")}
    ${replies.map((d) => commentHTML({ by: "you", body: d.body, draft: d.id }, "", t)).join("")}
    ${t.gh ? `<div class="gh-meta">${t.pending ? `<span class="pill blue">${t.pending === "resolve" ? "Resolves" : "Reopens"} on GitHub when you post</span>` : ""}${t.outdated ? `<span class="pill">Outdated</span>` : ""}${t.comments[0].url ? `<a class="link" href="${esc(t.comments[0].url)}" target="_blank" rel="noopener">View on GitHub</a>` : ""}</div>` : ""}
    ${foot}
  </div>`;
}

const LABELS = [["", "Comment"], ["suggestion", "Suggestion"], ["question", "Question"], ["nit", "Nit"], ["blocking", "Blocking"], ["praise", "Praise"]];

function composerHTML() {
  const c = S.composer;
  const reply = !!c.replyTo;
  const f = files[c.f];
  return `<form class="composer" id="composer" autocomplete="off">
    ${reply ? "" : `<div class="composer-head">${c.editing ? "Editing your comment on" : "Commenting on"} ${esc(lineName(c.k))} of <code>${esc(f.base)}</code></div>${c.fromFinding ? `<div class="composer-words">
        ${c.texts ? `<div class="words" role="group" aria-label="Wording"><button type="button" data-act="words" data-v="reworded" aria-pressed="${c.variant !== "verbatim"}">Reworded</button><button type="button" data-act="words" data-v="verbatim" aria-pressed="${c.variant === "verbatim"}">As written</button></div>` : ""}
        <span class="composer-note">${icon("bot")}${c.variant === "verbatim" ? "The agent's finding, word for word. It posts under your name." : "Drafted from the agent's finding in a reviewer's voice. Edit it in your own words."}</span></div>` : ""}
      <div class="labels" role="radiogroup" aria-label="Kind of comment">${LABELS.map(([v, l]) => `<button type="button" role="radio" class="lab${v ? " l-" + v : ""}" aria-checked="${c.label === v}" data-act="label" data-v="${v}">${l}</button>`).join("")}</div>`}
    <label class="sr-only" for="composer-text">${reply ? "Reply" : "Comment"}</label>
    <textarea id="composer-text" rows="3" placeholder="${reply ? "Write a reply" : ownPR() ? "Leave a note for your reviewers" : `Leave a note for ${esc(PEOPLE[PR.author].short)}`}" autofocus>${esc(c.text)}</textarea>
    <div class="composer-foot"><span class="kbd-hint">${isMac ? "⌘" : "Ctrl"} + Enter adds it</span>
      <button type="button" class="btn sm ghost" data-act="composer-cancel">Cancel</button>
      <button type="submit" class="btn sm primary">${c.editing ? "Save" : "Add to review"}</button></div>
  </form>`;
}

/* ---------- Lockfile summary ---------- */

function depsHTML(f) {
  const d = f.deps;
  const why = (p) => (p.requested ? { text: "Requested in package.json", warn: false }
    : p.direct ? { text: "Changed in the lockfile only. package.json didn't ask for it.", warn: true }
    : { text: "Pulled in by another package", warn: false });
  const rows = [
    ...d.added.map((p) => ({ kind: "added", icon: "plus", p, ver: p.version })),
    ...d.updated.map((p) => ({ kind: "updated", icon: "up", p, ver: `${p.from} → ${p.to}` })),
    ...d.removed.map((p) => ({ kind: "removed", icon: "minus", p, ver: p.version })),
  ];
  const parts = [];
  if (d.added.length) parts.push(`${plural(d.added.length, "package")} added`);
  if (d.updated.length) parts.push(`${d.updated.length} updated`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  return `<div class="deps">
    <p class="deps-lede">${icon("package")}<span>Summarized from the lockfile: ${parts.join(", ") || "no package changes"}. The raw diff is ${plural(f.additions + f.deletions, "line")} of JSON.</span></p>
    ${rows.length ? `<div class="table-wrap"><table class="deps-table"><thead><tr><th>Package</th><th>Version</th><th>Why it changed</th></tr></thead><tbody>
      ${rows.map((r) => { const w = why(r.p); return `<tr class="dep-${r.kind}"><td><span class="dep-name"><span class="dep-kind" aria-label="${r.kind}">${icon(r.icon)}</span>${esc(r.p.name)}${r.p.dev ? ` <span class="tag">dev</span>` : ""}</span></td>
        <td class="dep-ver">${esc(r.ver)}</td><td class="dep-why${w.warn ? " warn" : ""}">${esc(w.text)}</td></tr>`; }).join("")}
    </tbody></table></div>` : ""}
    <button type="button" class="btn sm" data-act="raw" data-f="${f.i}">Show the raw diff</button>
  </div>`;
}

/* ---------- Review guide and mobile dock ---------- */

function ring(pct, size) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r, mid = size / 2;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="ring-bg" cx="${mid}" cy="${mid}" r="${r}"/>
    <circle class="ring-fg" cx="${mid}" cy="${mid}" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>
    ${size >= 40 ? `<text class="ring-t" x="50%" y="50%" dominant-baseline="central" text-anchor="middle">${Math.round(pct * 100)}<tspan>%</tspan></text>` : ""}
  </svg>`;
}

function guideFileHTML(f) {
  const p = fileProgress(f);
  const fresh = f.hunks.some((h) => h.fresh && !S.reviewed.has(h.key));
  const talk = S.threads.filter((t) => t.f === f.i && t.state !== "resolved").length + S.drafts.filter((d) => !d.replyTo && d.f === f.i).length;
  return `<li><a class="g-file${S.current === f.i ? " is-current" : ""}" href="#f-${f.i}" data-act="goto-file" data-f="${f.i}" title="${esc(f.path)}">
    <span class="mark m-${fileState(f)}" style="--p:${p.total ? p.done / p.total : 0}"></span>
    <span class="g-name">${esc(f.base)}</span>
    ${fresh ? `<span class="g-new" title="Changed since your review"></span>` : ""}
    ${flagHTML(f)}
    ${talk ? `<span class="g-talk" title="${plural(talk, "open comment")}">${icon("message")}${talk}</span>` : ""}
    <span class="g-count"><span class="n-add">+${f.additions}</span>${f.deletions ? ` <span class="n-del">−${f.deletions}</span>` : ""}</span>
  </a></li>`;
}

function groupingHTML() {
  const opt = (id, label) => `<button type="button" data-act="group" data-g="${id}" aria-pressed="${S.grouping === id}">${label}</button>`;
  return `<div class="seg seg-group" role="group" aria-label="Group changes by">${opt("chapters", "Chapters")}${opt("commits", "Commits")}${opt("folders", "Folders")}</div>`;
}

function provenanceHTML() {
  const who = PEOPLE[PR.author].short;
  if (S.grouping === "commits") return `<p class="g-by"><span>One chapter per commit, in the order ${esc(who)} pushed them</span></p>`;
  if (S.grouping === "folders") return `<p class="g-by"><span>One chapter per folder</span></p>`;
  if (chapters[0] && chapters[0].kind === "auto") return `<p class="g-by">${agentAv("xs")}<span>Grouped automatically by layer, in dependency order</span></p>`;
  return `<p class="g-by">${agentAv("xs")}<span>Drafted by the guide agent${S.planState === "edited" ? ". You adjusted it for your review" : ""}.</span> <button type="button" class="link" data-act="plan-open">See how</button></p>`;
}

function guideHTML() {
  const c = counts();
  return `<div class="guide">
    <div class="g-top">${ring(progress(), 46)}<div class="g-top-text"><b>${c.reviewed} of ${plural(c.all, "hunk")} reviewed</b>
      <span>${c.todo ? `About ${readTime(remainingMinutes())} left` : "Nothing left to read"}</span></div></div>
    ${groupingHTML()}
    ${provenanceHTML()}
    ${agentsRowHTML()}
    <ol class="g-chapters">${chapters.map((ch) => {
      const p = chapterProgress(ch);
      return `<li class="g-ch${p.all ? " is-done" : ""}"><a class="g-ch-title" href="#ch-${ch.n}" data-act="goto-ch" data-ch="${ch.n}"><span class="g-n">${ch.n}</span><span>${esc(ch.title)}</span>${p.all ? icon("check", "g-done") : ""}</a>
        <ul>${ch.files.map(guideFileHTML).join("")}</ul></li>`;
    }).join("")}</ol>
    <p class="g-keys"><kbd>j</kbd><kbd>k</kbd> move <kbd>r</kbd> reviewed <kbd>c</kbd> comment <button type="button" class="link" data-act="shortcuts">All shortcuts</button></p>
  </div>`;
}

function dockHTML() {
  const c = counts();
  return `<nav class="dock" id="dock" aria-label="Review actions">
    <button type="button" class="dock-btn" data-act="guide-sheet">${icon("list")}<span>Guide</span></button>
    <button type="button" class="dock-btn" data-act="next-unreviewed">${ring(progress(), 24)}<span>${c.todo ? "Next" : "Done"}</span></button>
    <button type="button" class="dock-btn" data-act="drafts-sheet">${icon("message")}<span>Comments</span>${S.drafts.length ? `<i class="badge">${S.drafts.length}</i>` : ""}</button>
    ${finishBtnHTML("dock")}
  </nav>`;
}

/* ---------- Sheets ---------- */

const sheetHead = (id, title) => `<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="${id}-title">${title}</h2>
  <button type="button" class="icon-btn" data-act="sheet-close" aria-label="Close">${icon("x")}</button></div>`;

const EVENT_OF = { approve: "APPROVE", changes: "REQUEST_CHANGES", comment: "COMMENT" };
const withLabel = (label, body) => (label && !new RegExp(`^\\s*\\**${label}\\b`, "i").test(body) ? `${label}: ${body}` : body);

function buildPushPayload() {
  const problems = [], comments = [], replies = [], replyIds = [], commentIds = [];
  S.drafts.forEach((d) => {
    if (d.replyTo) {
      const t = findThread(d.replyTo);
      const root = t && t.comments[0];
      if (!root || !root.dbId) problems.push("A reply belongs to a thread that isn't on GitHub.");
      else { replies.push({ comment_id: root.dbId, body: d.body }); replyIds.push(d.id); }
      return;
    }
    if (d.detached) { problems.push(`A comment on ${d.path ? d.path.split("/").pop() : "a file"} isn't in the diff any more: new commits moved or removed its line. Copy or delete it in Drafts.`); return; }
    const f = files[d.f];
    if (!f || d.k === "file" || !LINE_HUNK.has(`${d.f}:${d.k}`)) { problems.push(`A comment on ${f ? f.base : "a file"} isn't on a line of the diff. Move it or delete it.`); return; }
    comments.push({ path: f.path, line: +d.k.slice(1), side: d.k[0] === "o" ? "LEFT" : "RIGHT", body: withLabel(d.label, d.body) });
    commentIds.push(d.id);
  });
  const acts = Object.entries(S.threadActions || {});
  const resolve = acts.filter(([, a]) => a === "resolve").map(([id]) => id);
  const unresolve = acts.filter(([, a]) => a === "unresolve").map(([id]) => id);
  return {
    // head: the commit this page's diff (and so every comment's line) is from.
    body: { event: EVENT_OF[S.pushDecision] || "COMMENT", body: S.pushSummary.trim(), comments, replies, resolve, unresolve, head: D.head && D.head.sha },
    meta: { replyIds, commentIds, resolve, unresolve }, problems,
  };
}

function pushProblem(p) {
  if (p.problems.length) return p.problems.join(" ");
  const b = p.body;
  if (b.event === "REQUEST_CHANGES" && !b.body) return "Add a summary. GitHub needs one when you request changes.";
  if (b.event === "COMMENT" && !b.body && !b.comments.length && !b.replies.length && !b.resolve.length && !b.unresolve.length) return "There's nothing to post yet. Add a comment or a summary.";
  return "";
}

const pushError = (msg) => `<p class="push-error">${icon("alert")}<span>${esc(msg)}</span></p>`;

function showPushPanel(html) {
  S.pushPanel = html;
  const el = $("#push-panel");
  if (el) el.innerHTML = html;
}

function refreshPushFoot() {
  const el = $("#push-foot");
  if (el) el.innerHTML = pushFootHTML();
}

function pushFootHTML() {
  if (!LIVE.github) return `<span class="push-note">Run <code>gh auth login</code> in a terminal, then refresh, to post.</span><button type="button" class="btn ghost" data-act="sheet-close">Close</button>`;
  if (S.pushConfirm) {
    const who = LIVE.viewer ? `@${esc(LIVE.viewer.login)}` : "you";
    return `<span class="push-note"><b>Post as ${who} to ${esc(PR.repo)} #${PR.number}?</b> Everyone who can see the pull request will see it.</span>
      <button type="button" class="btn ghost" data-act="push-back"${S.pushBusy ? " disabled" : ""}>Back</button>
      <button type="button" class="btn primary" data-act="push-now"${S.pushBusy ? " disabled" : ""}>${S.pushBusy ? `<span class="spin" aria-hidden="true"></span>Posting` : "Post now"}</button>`;
  }
  return `<button type="button" class="btn ghost push" data-act="push-preview">Preview what's sent</button>
    <button type="button" class="btn ghost" data-act="sheet-close">Cancel</button>
    <button type="button" class="btn primary" data-act="push-post">Post to GitHub</button>`;
}

// A posted review for the review metrics: each finding's draft that went out (with its text, so the extension can tell
// how much it was reworded; the text isn't logged), each finding of this run still open, and the review itself with
// the time spent on it.
function logPosted(drafts, event) {
  const fromFindings = drafts.filter((d) => d.fromFinding && findingById(d.fromFinding));
  sendMetrics([
    ...fromFindings.map((d) => ({ kind: "finding", action: "posted", finding: d.fromFinding, text: d.body, verbatim: !!d.verbatim })),
    ...openFindings().map((x) => ({ kind: "finding", action: "left-open", finding: x.id })),
    { kind: "review", action: "submitted", review: {
      event: { APPROVE: "approve", REQUEST_CHANGES: "changes" }[event] || "comment",
      own: ownPR(), comments: drafts.length, fromFindings: drafts.filter((d) => d.fromFinding).length,
      reviewed: S.reviewed.size, hunks: counts().all, agents: !!AG, activeMs: takeActiveTime(),
    } },
  ]);
}

async function previewPush() {
  const p = buildPushPayload();
  const problem = pushProblem(p);
  if (problem) return showPushPanel(pushError(problem));
  try {
    const res = await api("POST", "/push?dry=1", p.body);
    showPushPanel(`<div class="push-preview"><p class="eyebrow">What will be sent${res.as ? ` as @${esc(res.as)}` : ""}</p>
      <ol>${res.steps.map((st) => `<li><code>${esc(st.request)}</code>${st.kind === "review" ? ` · ${esc(st.json.event)}, ${plural(st.json.comments.length, "line comment")}` : ""}</li>`).join("")}</ol>
      <details><summary>Request bodies</summary><pre class="quote-code">${esc(JSON.stringify(res.steps.map((st) => st.json || { threadId: st.thread }), null, 2))}</pre></details></div>`);
  } catch (err) {
    showPushPanel(pushError(err.message));
  }
}

async function postPush() {
  const p = buildPushPayload();
  const problem = pushProblem(p);
  if (problem) { S.pushConfirm = false; refreshPushFoot(); showPushPanel(pushError(problem)); return; }
  S.pushBusy = true;
  refreshPushFoot();
  try {
    const res = await api("POST", "/push", p.body);
    const results = res.results || [];
    const review = results.find((r) => r.kind === "review");
    if (review && !review.ok) throw new Error(review.error);
    // Drop the local copy of everything that made it to GitHub; keep what failed.
    const posted = new Set(review || !p.body.comments.length ? p.meta.commentIds : []);
    const replyResults = results.filter((r) => r.kind === "reply");
    p.meta.replyIds.forEach((id, i) => { if (replyResults[i] && replyResults[i].ok) posted.add(id); });
    if (review || results.some((r) => r.ok)) logPosted(S.drafts.filter((d) => posted.has(d.id)), p.body.event);
    S.drafts = S.drafts.filter((d) => !posted.has(d.id));
    const resolveResults = results.filter((r) => r.kind === "resolve"), unresolveResults = results.filter((r) => r.kind === "unresolve");
    p.meta.resolve.forEach((id, i) => { if (resolveResults[i] && resolveResults[i].ok) delete S.threadActions[id]; });
    p.meta.unresolve.forEach((id, i) => { if (unresolveResults[i] && unresolveResults[i].ok) delete S.threadActions[id]; });
    const failed = results.filter((r) => !r.ok);
    S.pushConfirm = false;
    S.pushBusy = false;
    if (review && review.ok) markDescPosted(S.pushSummary);
    if (!failed.length) { S.pushSummary = ""; S.pushDecision = null; }
    save();
    await flushLiveState();
    if (failed.length) {
      refreshPushFoot();
      showPushPanel(pushError(`The review was posted, but ${plural(failed.length, "step")} failed and stayed as drafts: ${failed[0].error}`));
      return;
    }
    showPushPanel(`<p class="push-ok">${icon("check-circle")}<span>Posted to GitHub.${review && review.url ? ` <a class="link" href="${esc(review.url)}" target="_blank" rel="noopener">Open the review</a>.` : ""} Reloading with the latest from GitHub…</span></p>`);
    await api("POST", "/refresh");
    reloadPage();
  } catch (err) {
    S.pushBusy = false;
    S.pushConfirm = false;
    refreshPushFoot();
    showPushPanel(pushError(err.message));
  }
}

async function refreshLive() {
  toast("Refreshing from GitHub…");
  try {
    await flushLiveState();
    await api("POST", "/refresh");
    reloadPage();
  } catch (err) {
    toast(`Couldn't refresh: ${err.message}`);
  }
}

// The finish sheet's row for the description check: open gaps, or the questions already in the summary.
function descFinishRowHTML() {
  if (!DESC_GAPS.length || ownPR()) return "";
  // Questions already posted with an earlier review aren't part of this one.
  const open = descOpen().length, asked = DESC_GAPS.filter((it) => descState(it) === "asked" && !S.desc[it.rule].posted).length;
  if (!open && !asked) return "";
  return `<li>${icon("doc")}<div class="fr-text"><b>${open ? `${plural(open, "gap")} in the description` : `${plural(asked, "question")} about the description`}</b>
    <span>${open ? `Optional. Ask ${esc(PEOPLE[PR.author].short)} to fill ${open === 1 ? "it" : "them"} in, or skip ${open === 1 ? "it" : "them"}.` : "In your summary below"}</span></div>
    ${open ? `<button type="button" class="btn sm" data-act="desc-sheet">Decide</button>` : ""}</li>`;
}

function finishSheetHTML() {
  const c = counts();
  const own = PR.author === "you";
  const blocking = S.drafts.filter((d) => d.label === "blocking").length;
  const hi = highOpen();
  const undecided = openFindings();
  const noApprove = own ? "GitHub doesn't let you approve your own pull request" : blocking ? "Not available while you have a blocking comment" : hi.length ? "Decide on the high agent finding first" : "";
  const noChanges = own ? "GitHub doesn't let you request changes on your own pull request" : "";
  if (!S.pushDecision || (S.pushDecision === "approve" && noApprove) || (S.pushDecision === "changes" && noChanges)) S.pushDecision = blocking && !own ? "changes" : "comment";
  const replies = S.drafts.filter((d) => d.replyTo).length;
  const comments = S.drafts.length - replies;
  const detached = S.drafts.filter((d) => d.detached).length;
  const acts = Object.values(S.threadActions || {});
  const dec = (v, title, desc, disabled) => `<label class="dec dec-${v}${disabled ? " is-disabled" : ""}" for="dec-${v}">
    <input type="radio" name="decision" id="dec-${v}" value="${v}" ${S.pushDecision === v ? "checked" : ""} ${disabled ? "disabled" : ""}>
    <span class="dec-dot"></span><span class="dec-text"><b>${title}</b><span>${desc}</span></span></label>`;
  S.pushConfirm = false;
  S.pushPanel = "";
  return `${sheetHead("finish", "Post your review to GitHub")}
  <div class="sheet-body">
    <ul class="fr-list">
      <li>${ring(progress(), 30)}<div class="fr-text"><b>${c.reviewed} of ${plural(c.all, "hunk")} reviewed</b>
        <span>${c.todo ? `${c.todo} left, about ${readTime(remainingMinutes())}` : "You've seen every change"}</span></div>
        ${c.todo ? `<button type="button" class="btn sm" data-act="next-unreviewed">Keep reviewing</button>` : ""}</li>
      <li>${icon("message")}<div class="fr-text"><b>${comments || replies ? `${plural(comments, "comment")}${replies ? ` and ${plural(replies, "reply", "replies")}` : ""} to post` : "No new comments"}</b>
        <span>${blocking ? `${blocking} marked blocking. ` : ""}Saved on this machine until you post</span></div></li>
      ${detached ? `<li>${icon("alert")}<div class="fr-text"><b>${plural(detached, "draft")} no longer in the diff</b>
        <span>New commits moved or removed ${detached === 1 ? "its line" : "their lines"}. Copy or delete ${detached === 1 ? "it" : "them"} before posting.</span></div>
        <button type="button" class="btn sm" data-act="drafts-sheet">Review</button></li>` : ""}
      ${acts.length ? `<li>${icon("check-circle")}<div class="fr-text"><b>${plural(acts.length, "thread")} to ${acts.every((a) => a === "resolve") ? "resolve" : "update"}</b><span>Applied after the review is posted</span></div></li>` : ""}
      ${FIND.length ? `<li>${agentAv()}<div class="fr-text"><b>${hi.length ? (hi.length === 1 ? "1 high agent finding needs your decision" : `${hi.length} high agent findings need your decision`) : undecided.length ? `${plural(undecided.length, "agent finding")} still open` : "Every agent finding has a decision"}</b>
        <span>${hi.length ? "Add it to your review or dismiss it to unlock approval" : undecided.length ? "Optional. Agent findings are never posted on their own." : findingsTally()}</span></div>
        ${undecided.length ? `<button type="button" class="btn sm" data-act="go-finding" data-id="${(hi[0] || undecided[0]).id}">Decide</button>` : ""}</li>` : ""}
      ${descFinishRowHTML()}
    </ul>
    <fieldset class="decision"><legend>Your decision</legend>
      ${dec("comment", "Comment", "Feedback without a decision")}
      ${dec("approve", "Approve", noApprove || `Approves #${PR.number} on GitHub`, !!noApprove)}
      ${dec("changes", "Request changes", noChanges || "Merging waits until the author responds", !!noChanges)}
    </fieldset>
    <label class="field-label" for="fr-summary">Summary <span class="dim">(required when you request changes)</span></label>
    <textarea id="fr-summary" rows="${S.pushSummary ? 6 : 3}" placeholder="${ownPR() ? "What should your reviewers read first?" : `What should ${esc(PEOPLE[PR.author].short)} read first?`}">${esc(S.pushSummary)}</textarea>
    <div class="push-panel" id="push-panel" aria-live="polite"></div>
  </div>
  <div class="sheet-foot" id="push-foot">${pushFootHTML()}</div>`;
}

function threadItemHTML(t) {
  const f = files[t.f];
  return `<li><button type="button" class="titem" data-act="go-thread" data-id="${t.id}">
    <span class="titem-top">${t.label ? `<span class="label l-${t.label}">${t.label}</span>` : ""}<span class="mono">${esc(f.base)} · ${esc(lineName(t.k))}</span></span>
    <span class="titem-text">${esc(firstLine(t.comments[t.comments.length - 1].body))}</span></button></li>`;
}

function draftItemHTML(d) {
  if (d.detached) {
    return `<li class="titem-detached"><div class="titem"><span class="titem-top"><span class="label l-draft">draft</span>${d.label ? `<span class="label l-${d.label}">${d.label}</span>` : ""}<span class="mono">${esc(d.path ? d.path.split("/").pop() : "")} · ${esc(lineName(d.k))}</span></span>
      <span class="titem-text">${esc(firstLine(d.body) || "Suggested change")}</span>
      <span class="titem-note">Not in the diff any more: new commits moved or removed this line. Copy it to place it again, or delete it.</span></div>
      <div class="titem-acts"><button type="button" class="btn sm" data-act="copy-draft" data-id="${d.id}">${icon("copy")}Copy</button><button type="button" class="btn sm ghost" data-act="delete-draft" data-id="${d.id}">Delete</button></div></li>`;
  }
  const t = d.replyTo ? S.threads.find((x) => x.id === d.replyTo) : null;
  const f = files[t ? t.f : d.f];
  return `<li><button type="button" class="titem" data-act="go-draft" data-id="${d.id}">
    <span class="titem-top"><span class="label l-draft">${t ? "reply" : "draft"}</span>${d.label ? `<span class="label l-${d.label}">${d.label}</span>` : ""}<span class="mono">${esc(f ? f.base : "")} · ${esc(lineName(t ? t.k : d.k))}</span>${d.moved ? `<span>· moved with its line</span>` : ""}</span>
    <span class="titem-text">${esc(firstLine(d.body) || "Suggested change")}</span></button></li>`;
}

function draftsSheetHTML() {
  const open = S.threads.filter((t) => t.state !== "resolved");
  return `${sheetHead("drafts", "Your review")}
  <div class="sheet-body">
    <h3 class="eyebrow">Drafts · post when you finish</h3>
    ${S.drafts.length ? `<ul class="tlist">${S.drafts.map(draftItemHTML).join("")}</ul>` : `<p class="empty-note">No drafts yet. Tap a line of code, then Comment.</p>`}
    <h3 class="eyebrow">Open threads</h3>
    ${open.length ? `<ul class="tlist">${open.map(threadItemHTML).join("")}</ul>` : `<p class="empty-note">Nothing open.</p>`}
    ${FIND.length ? `<h3 class="eyebrow">Agent findings</h3><ul class="tlist">${FIND.map(findingItemHTML).join("")}</ul>` : ""}
  </div>
  <div class="sheet-foot">${finishBtnHTML("sheet")}</div>`;
}

const SHORTCUTS = [
  [["j"], ["k"], "Next and previous hunk"], [["n"], null, "Next unreviewed hunk"], [["r"], null, "Mark reviewed, then move on"],
  [["c"], null, "Comment on the hunk"], [["a"], null, "Next agent finding"], [["u"], null, "Only what's new to you"], [["["], ["]"], "Previous and next file"],
  [["s"], null, "Unified or split"], [["f"], null, "Jump to a file"], [["1"], ["4"], "Changes, Map, Discussion, Workflow"],
  [["m"], null, "The map of the change"], [["."], [","], "Next and previous step of the flow"],
  [[isMac ? "⌘" : "Ctrl", "Enter"], null, "Add a comment or submit"], [["Esc"], null, "Close"],
];

function shortcutsSheetHTML() {
  return `${sheetHead("keys", "Keyboard shortcuts")}<div class="sheet-body"><dl class="keys">
    ${SHORTCUTS.map(([a, b, what]) => `<dt>${a.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}${b ? ` <span class="dim">/</span> ${b.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}` : ""}</dt><dd>${what}</dd>`).join("")}
  </dl></div>`;
}

function paletteItems(q) {
  const ql = q.trim().toLowerCase();
  const list = chapters.flatMap((c) => c.files).filter((f) => !ql || f.path.toLowerCase().includes(ql));
  S.palList = list.map((f) => f.i);
  S.palIdx = Math.min(S.palIdx, Math.max(0, list.length - 1));
  if (!list.length) return `<li class="pal-empty dim">No files match “${esc(q)}”.</li>`;
  return list.map((f, j) => `<li><button type="button" class="pal-item" role="option" aria-selected="${j === S.palIdx}" data-act="goto-file" data-f="${f.i}">
    <span class="mark m-${fileState(f)}" style="--p:${f.hunks.length ? fileProgress(f).done / f.hunks.length : 0}"></span>
    <span class="pal-path"><span class="dir">${esc(f.dir)}</span>${esc(f.base)}</span>
    <span class="g-count"><span class="n-add">+${f.additions}</span> <span class="n-del">−${f.deletions}</span></span></button></li>`).join("");
}

function paletteSheetHTML() {
  S.palIdx = 0;
  return `<h2 id="palette-title" class="sr-only">Jump to file</h2>
    <div class="pal-input">${icon("search")}<label class="sr-only" for="palette-q">File name</label><input id="palette-q" type="text" placeholder="Jump to file" autocomplete="off" spellcheck="false" autofocus></div>
    <ul class="pal-list" id="palette-list" role="listbox" aria-label="Files">${paletteItems("")}</ul>`;
}

function composerSheetHTML() {
  const c = S.composer;
  const f = files[c.f];
  const q = c.replyTo ? { text: null } : lineQuote(c.f, c.k);
  return `${sheetHead("composer", c.replyTo ? "Reply" : c.editing ? "Edit comment" : "New comment")}
    <div class="sheet-body">
      ${q.text != null ? `<div class="quote-code">${q.clipped ? esc(q.text) : hl(q.text.trim(), f.lang)}</div>` : ""}
      ${composerHTML()}
    </div>`;
}

/* ---------- Chapters: the author's view ---------- */

function planRelations(plan) {
  const chapterOf = new Map();
  plan.forEach((c, i) => c.files.forEach((p) => chapterOf.set(p, i)));
  return plan.map((c, i) => {
    let issue = null, builds = null;
    for (const p of c.files) {
      const f = byPath.get(p);
      if (!f) continue;
      for (const di of f.uses) {
        const dep = files[di];
        const j = chapterOf.get(dep.path);
        if (j == null) continue;
        if (j > i && !issue) issue = `<code>${esc(f.base)}</code> uses <code>${esc(dep.base)}</code>, which comes later, in chapter ${j + 1}. Reviewers would meet it before it's explained.`;
        if (j < i && !builds) builds = `Builds on chapter ${j + 1}: <code>${esc(f.base)}</code> uses <code>${esc(dep.base)}</code>.`;
      }
    }
    return { issue, builds };
  });
}

const planKey = (plan) => JSON.stringify(plan.map((c) => [c.title, c.files]));
const planChanged = () => S.planDraft && planKey(S.planDraft) !== planKey(S.plan);

function planFileHTML(path, i, plan) {
  const f = byPath.get(path);
  if (!f) return "";
  const id = `plan-file-${f.i}`;
  return `<li class="plan-file"><span class="mono" title="${esc(f.path)}">${esc(f.base)}</span>
    <label class="sr-only" for="${id}">Chapter for ${esc(f.base)}</label>
    <select id="${id}" data-plan-file="${esc(path)}">${plan.map((c, j) => `<option value="${j}"${j === i ? " selected" : ""}>${j + 1}. ${esc(c.title)}</option>`).join("")}<option value="new">New chapter</option></select></li>`;
}

function planBodyHTML() {
  const plan = S.planDraft;
  const rel = planRelations(plan);
  const issues = rel.filter((r) => r.issue).length;
  const intro = `<p class="plan-view"><span class="ribbon-tag">Your view</span><span class="dim">Changes here only affect your reading order. Nothing is posted.</span></p>
    <p class="sheet-lede">The guide agent drafted these chapters from the commits and the import graph. Move a file to change the order; Diffline checks that each chapter still builds on the ones before it.</p>`;
  return `${intro}
    <div class="plan-why"><h3 class="eyebrow">How the agent drafted them</h3>
      <ul>${PR.planReasons.map((r) => `<li>${agentAv("xs")}<span>${inline(r)}</span></li>`).join("")}</ul></div>
    <p class="plan-check${issues ? " has-issue" : ""}">${issues ? `${icon("alert")}${plural(issues, "chapter")} reads before code it depends on` : `${icon("check-circle")}Reading order checked: every chapter builds on the ones before it`}</p>
    <ol class="plan-list">${plan.map((c, i) => `<li class="plan-card${rel[i].issue ? " has-issue" : ""}">
      <div class="plan-card-head"><span class="g-n">${i + 1}</span>
        <label class="sr-only" for="plan-title-${i}">Title of chapter ${i + 1}</label>
        <input class="plan-title" id="plan-title-${i}" data-plan-title="${i}" value="${esc(c.title)}" autocomplete="off">
        <button type="button" class="icon-btn sm" data-act="plan-move" data-i="${i}" data-dir="-1" aria-label="Move chapter ${i + 1} up"${i === 0 ? " disabled" : ""}>${icon("up")}</button>
        <button type="button" class="icon-btn sm" data-act="plan-move" data-i="${i}" data-dir="1" aria-label="Move chapter ${i + 1} down"${i === plan.length - 1 ? " disabled" : ""}>${icon("up", "flip")}</button>
      </div>
      ${c.source ? `<p class="plan-source">${c.source.kind === "description" ? `From the description: “${inline(c.source.text)}”` : c.source.kind === "commits" ? `From the commits: “${inline(c.source.text)}”` : esc(c.source.text)}</p>` : ""}
      <ul class="plan-files">${c.files.map((path) => planFileHTML(path, i, plan)).join("")}</ul>
      ${rel[i].issue ? `<p class="plan-issue">${icon("alert")}<span>${rel[i].issue}</span></p>` : rel[i].builds ? `<p class="plan-builds">${agentAv("xs")}<span>${rel[i].builds}</span></p>` : ""}
    </li>`).join("")}</ol>
    <p class="brief-note">${icon("info")}<span>Your adjustments are saved on this machine with your drafts.</span></p>`;
}

function planSheetHTML() {
  return `${sheetHead("plan", `Chapters for #${PR.number}`)}
    <div class="sheet-body" id="plan-body">${planBodyHTML()}</div>
    <div class="sheet-foot"><button type="button" class="btn ghost push" data-act="plan-reset">${icon("reset")}Agent's draft</button>
      <button type="button" class="btn ghost" data-act="sheet-close">Cancel</button>
      <button type="button" class="btn primary" data-act="plan-save" id="plan-save">${planChanged() ? "Save changes" : "Looks right"}</button></div>`;
}

/* ---------- Workflow tab ---------- */

function flowNext() {
  const hi = highOpen();
  if (hi.length) return { icon: "bot", tone: "you", primary: true, title: "Start with the agent's high finding", text: `${hi[0].title.replace(/`/g, "")} (${files[hi[0].f].base})`, action: { act: "go-finding", id: hi[0].id, label: "Show the finding" } };
  const cur = stages().find((st) => st.st !== "done");
  if (!cur) return { icon: "check-circle", tone: "ok", title: "Everything is green", text: "Checks, reviews and merge requirements are all satisfied on GitHub." };
  return { icon: STAGE_ICONS[cur.id] || "clock", title: `${cur.name}: ${cur.caption}`,
    text: LIVE.github ? `As GitHub reported it ${ago(LIVE.loadedAt)}. Refresh to update.` : "GitHub isn't connected. Run gh auth login in a terminal, then refresh.",
    action: S.drafts.length ? { act: "finish", label: "Finish review" } : null };
}

function gateIcon(g) {
  if (g.st === "passed") return icon("check-circle");
  if (g.st === "blocked") return icon("x-circle");
  if (g.st === "running") return `<span class="spin" aria-hidden="true"></span>`;
  if (g.st === "waiting") return icon("clock");
  return icon("circle");
}

function gateHTML(g) {
  const act = g.action ? `<button type="button" class="btn sm${g.mine ? " primary" : ""}" data-act="${g.action.act}"${g.action.id ? ` data-id="${g.action.id}"` : ""}>${g.action.label}</button>` : "";
  return `<li class="gate g-${g.st}${g.mine ? " is-you" : ""}">
    <span class="gate-icon">${gateIcon(g)}</span>${g.who ? avatar(g.who, "sm") : g.agent ? agentAv("sm") : ""}
    <div class="gate-text"><b>${esc(g.name)}${g.role ? ` <span class="gate-role">· ${esc(g.role)}</span>` : ""}</b>
      <span>${esc(g.detail)}</span>
    </div>${act}${g.url && /^https:\/\/github\.com\//.test(g.url) ? `<a class="btn sm ghost gate-link" href="${esc(g.url)}" target="_blank" rel="noopener" aria-label="Details of ${esc(g.name)} on GitHub">Details${icon("external")}</a>` : ""}</li>`;
}

function wfMainHTML() {
  const ss = stages();
  const next = flowNext();
  return `<div class="wf-main" id="wf-main">
    <header class="wf-head">
      <div><p class="eyebrow">Workflow</p><h2>Path to merge</h2>
        <p class="dim">What GitHub reports for this pull request: checks on the head commit, reviews and merge requirements.</p></div>
    </header>
    <div class="next-up${next.tone ? " tone-" + next.tone : ""}" id="next-up">${icon(next.icon)}<div class="next-up-text"><b>${esc(next.title)}</b><span>${esc(next.text)}</span></div>
      ${next.action ? `<button type="button" class="btn sm${next.primary ? " primary" : ""}" data-act="${next.action.act}"${next.action.id ? ` data-id="${next.action.id}"` : ""}>${next.action.label}</button>` : ""}</div>
    <ol class="lane" id="lane">${ss.map((s) => `<li class="lane-stage st-${s.st}" id="stage-${s.id}">
      <span class="lane-node">${stageNode(s)}</span>
      <div class="lane-card"><header class="lane-head"><h3>${s.name}</h3><span class="lane-st">${esc(s.caption)}</span></header>
        <ul class="gates">${s.gates.map(gateHTML).join("")}</ul>${s.note ? `<p class="lane-note">${icon("info")}<span>${esc(s.note)}</span></p>` : ""}</div>
    </li>`).join("")}</ol>
  </div>`;
}

function ownersHTML() {
  const text = D.workspace && D.workspace[".github/CODEOWNERS"];
  if (!text) return "";
  const rows = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => l.trim().split(/\s+/));
  return `<li><div class="rule" role="group" aria-label="Code owners"><span class="rule-icon neutral">${icon("users")}</span><span class="rule-text"><b>Code owners</b>
    <span>From <code>.github/CODEOWNERS</code>. Each owned path needs one owner's approval.</span>
    <ul class="owners">${rows.map(([p, ...owners]) => `<li><code>${esc(p === "*" ? "everything else" : p)}</code><span class="dim">${esc(owners.join(" "))}</span></li>`).join("")}</ul></span></div></li>`;
}

function wfSideHTML() {
  const owners = ownersHTML();
  return `<aside class="wf-side" id="wf-side"><section class="side-card"><h3>Rules</h3>
    <p class="dim">Diffline shows GitHub's own requirements for this pull request: required checks, reviews and the merge state.</p>
    ${owners ? `<ul class="rules">${owners}</ul>` : ""}</section></aside>`;
}

const workflowHTML = () => `<div class="wf">${wfMainHTML()}${wfSideHTML()}</div>`;

/* ---------- Discussion tab ---------- */

const TL_ICON = { pr: "pr", eye: "eye", commit: "commit", "check-circle": "check-circle", message: "message", "x-circle": "x-circle" };

function timelineHTML() {
  const items = [...PR.timeline].sort((a, b) => new Date(a.at) - new Date(b.at));
  return items.map((e) => `<li class="tl">
    <span class="tl-icon">${e.who ? avatar(e.who, "sm") : e.agent ? agentAv("sm") : icon(TL_ICON[e.icon] || "commit")}</span>
    <div class="tl-body"><p>${e.who ? `<b>${esc(nameOf(e.who))}</b> ` : ""}${e.text}<time>${ago(e.at)}</time></p>
      ${e.body ? `<div class="tl-quote">${paras(e.body)}</div>` : ""}</div></li>`).join("");
}

function reviewersHTML() {
  const review = stages().find((st) => st.id === "review");
  const tone = (g) => (g.st === "passed" ? "ok" : g.st === "blocked" ? "bad" : g.mine ? "blue" : "warn");
  return (review ? review.gates.filter((g) => g.who) : []).map((g) => `<li class="person">${avatar(g.who)}<div class="person-text"><b>${esc(g.name)}</b><span>${esc(g.role || "")}</span></div>
    <span class="pill ${tone(g)}">${esc(g.st === "passed" ? "Approved" : g.st === "blocked" ? "Changes" : g.mine ? "You" : "Pending")}</span></li>`).join("");
}

function discussionHTML() {
  const open = S.threads.filter((t) => t.state !== "resolved");
  const done = S.threads.filter((t) => t.state === "resolved");
  return `<div class="disc">
    <div class="disc-main">
      <article class="desc"><header class="desc-head">${avatar(PR.author)}<div><b>${esc(PEOPLE[PR.author].name)}</b><span class="dim">opened this ${ago(PR.opened)}</span></div></header>
        <div class="prose">${mdBlock(PR.description)}</div></article>
      ${descCardHTML()}
      <h2 class="section-title">Activity</h2>
      <ol class="timeline" id="timeline">${timelineHTML()}</ol>
      <p class="dim live-note">${icon("info")}To add a general comment, write it as the summary when you post your review.</p>
    </div>
    <aside class="disc-side">
      <section class="side-card"><h3>Reviewers</h3><ul class="people">${reviewersHTML()}</ul></section>
      <section class="side-card"><h3>Threads</h3><p class="dim">${open.length} open, ${done.length} resolved</p>
        <ul class="tlist">${[...open, ...done].map(threadItemHTML).join("")}</ul></section>
      ${FIND.length ? `<section class="side-card"><h3>Agent findings</h3><p class="dim">${openFindings().length} open, ${FIND.length - openFindings().length} decided</p><ul class="tlist">${FIND.map(findingItemHTML).join("")}</ul></section>` : ""}
    </aside>
  </div>`;
}

/* ---------- Map tab ---------- */

const DG_LAYOUT = new Map(); // diagram on the page -> the edges to draw once its boxes are laid out
const MODE_WORD = { diff: "Diff", before: "Before", after: "After" };
const mapDiagram = () => dgById(S.map.view);
const mapMode = (dg) => (!dg ? "after" : dgHasBefore(dg) ? S.map.mode : dgChanged(dg) ? "diff" : "after");
const cssId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
const plainText = (s) => String(s || "").replace(/`/g, "");

function mapHTML() {
  return `<div class="map" id="map"><div class="map-main" id="map-main">${mapMainHTML()}</div>
    <aside class="map-side" id="map-side" aria-label="Map details">${mapSideHTML()}</aside></div>`;
}

// The flows the guide agent drew, as cards: what each one is, how much of it the pull request changes, its findings and
// how much of it you've reviewed. "All files" is the last card. Picking one shows it below.
function flowPickerHTML() {
  if (!DIAGRAMS.length) return "";
  const card = (id, title, sub, stats) => {
    const on = S.map.view === id;
    return `<button type="button" class="flow-card${on ? " is-on" : ""}" role="tab" aria-selected="${on}" data-act="dg-view" data-v="${esc(id)}">
      <span class="flow-card-title">${title}</span>${sub ? `<span class="flow-card-sub">${sub}</span>` : ""}<span class="flow-card-stats">${stats}</span></button>`;
  };
  const cards = DIAGRAMS.map((d, i) => {
    const hunks = [...new Set(d.nodes.flatMap((n) => n.hunks))];
    const done = hunks.filter((k) => S.reviewed.has(k)).length;
    const changes = Object.keys(CHANGE_WORD).map((c) => [c, d.nodes.filter((n) => n.change === c).length]).filter(([, n]) => n);
    const finds = [...new Set(d.nodes.flatMap(liveFinds))];
    const high = finds.some((x) => x.severity === "high" && findingState(x) === "open");
    const stats = [
      `<span>${plural(d.steps, "step")}</span>`,
      ...changes.map(([c, n]) => `<span class="fc-${c}">${n} ${CHANGE_WORD[c].toLowerCase()}</span>`),
      finds.length ? `<span class="fc-find${high ? " is-high" : ""}">${icon(high ? "alert" : "bot")}${plural(finds.length, "finding")}</span>` : "",
      hunks.length ? `<span class="fc-prog${done === hunks.length ? " is-done" : ""}">${done === hunks.length ? icon("check") : ""}${done} of ${hunks.length} hunks reviewed</span>` : "",
    ].join("");
    return card(d.id, `<b class="flow-card-n" aria-hidden="true">${i + 1}</b><span>${inline(d.title)}</span>`, d.short && d.short !== d.title ? inline(d.short) : "", stats);
  });
  cards.push(card("files", `<b class="flow-card-n" aria-hidden="true">${icon("layers")}</b><span>All files</span>`, "How the changed files connect, chapter by chapter", `<span>${plural(files.length, "file")}</span><span>${plural(chapters.length, "chapter")}</span>`));
  return `<div class="flow-pick"><p class="eyebrow">${DIAGRAMS.length === 1 ? "The flow the guide agent drew" : `${DIAGRAMS.length} flows the guide agent drew`}</p>
    <div class="flow-picker" role="tablist" aria-label="Flows in this pull request">${cards.join("")}</div></div>`;
}

const MODE_TIP = { diff: "New, changed and removed steps together", before: "How the flow worked before this pull request", after: "How the flow works with this pull request" };

function mapMainHTML() {
  const dg = mapDiagram();
  const mode = mapMode(dg);
  const at = S.tour && dg && S.tour.dg === dg.id ? tourCurrent() : null;
  const head = dg
    ? `<p class="eyebrow">How it works</p><h2>${inline(dg.title)}</h2>${dg.summary ? `<p class="map-sum">${inline(dg.summary)}</p>` : ""}
      <p class="map-by">${agentAv("xs")}<span>Drawn by the guide agent from the diff. Every numbered box links to the lines it stands for.</span></p>`
    : `<p class="eyebrow">Files</p><h2>How the changed files connect</h2>
      <p class="map-sum">One row per chapter, in reading order. Lines join files that import each other. Pick a file to see what it uses and what uses it.</p>`;
  const modes = dg && dgHasBefore(dg)
    ? `<div class="map-mode"><span id="map-mode-label">Show</span><div class="seg" role="group" aria-labelledby="map-mode-label">${Object.keys(MODE_WORD).map((m) => `<button type="button" data-act="dg-mode" data-m="${m}" aria-pressed="${mode === m}" title="${MODE_TIP[m]}">${MODE_WORD[m]}</button>`).join("")}</div></div>`
    : "";
  return `${flowPickerHTML()}<header class="map-head"><div class="map-title">${head}</div>
      ${dg && dg.steps ? `<button type="button" class="btn primary" data-act="tour-start" data-dg="${esc(dg.id)}">${icon("play")}${at ? `Continue at step ${at.node.num}` : "Follow the flow"}</button>` : ""}</header>
    <div class="map-bar">${modes}${dg ? legendHTML(dg, mode) : legendHTML(null)}</div>
    <div class="dg-wrap">${dg ? flowHTML(dg, mode) : filesMapHTML()}</div>
    ${dg ? coverageHTML(dg) : ""}
    ${!DIAGRAMS.length ? `<p class="map-hint">${agentAv("xs")}<span>${AGENTS.length ? "The guide agent didn't draw a flow for this pull request. It leaves one out when the change has no runtime flow, such as docs or configuration only." : "There's no flow diagram yet. Run the agents, and the guide agent draws the flow this pull request changes."}</span></p>` : ""}`;
}

function legendHTML(dg, mode) {
  if (mode === "before") return `<p class="map-legend">How it worked before this pull request. Findings and review marks are about the new code, so they're hidden here.</p>`;
  const items = [];
  if (dg && mode === "diff") {
    ["added", "changed", "removed"].forEach((c) => { if (dg.nodes.some((n) => n.change === c)) items.push(`<span class="legend-item"><i class="lg-box c-${c}"></i>${CHANGE_WORD[c]}</span>`); });
    if (dg.nodes.some((n) => !n.change && n.kind !== "actor")) items.push(`<span class="legend-item"><i class="lg-box c-same"></i>Unchanged</span>`);
  }
  items.push(`<span class="legend-item"><span class="mark m-done"></span>Reviewed</span>`, `<span class="legend-item"><span class="mark m-part" style="--p:.5"></span>Partly reviewed</span>`);
  if (dg ? dg.nodes.some(nodeFresh) : files.some((f) => f.hunks.some((h) => h.fresh && !S.reviewed.has(h.key)))) items.push(`<span class="legend-item"><span class="g-new"></span>New to you</span>`);
  if (dg && dgChanged(dg) && !dgHasBefore(dg)) items.push(`<span class="legend-item dim">Everything in this flow is new.</span>`);
  return `<p class="map-legend">${items.join("")}</p>`;
}

function flowHTML(dg, mode) {
  const v = dgView(dg, mode);
  const L = layoutFlow(v.nodes, v.edges);
  const key = `${dg.id}:${mode}`;
  const routes = L.routes.map((r) => ({ ...r, cls: mode === "diff" ? r.change || "same" : "same" }));
  DG_LAYOUT.set(key, { routes, arrows: true });
  const rows = L.rows.map((row) => `<div class="dg-row${row.filter((k) => k[0] === "n").length > 2 ? " is-busy" : ""}">${row.map((k) => (k[0] === "v"
    ? `<span class="dg-via" data-via="${esc(k.slice(2))}" aria-hidden="true"></span>`
    : dgNodeHTML(dg.byId.get(k.slice(2)), mode))).join("")}</div>`).join("");
  const labels = routes.map((r) => {
    const text = dgText(r, mode).label;
    return text ? `<span class="dg-elabel e-${r.cls}" data-e="${r.i}" data-from="${esc(r.from)}" data-to="${esc(r.to)}" hidden>${esc(text)}</span>` : "";
  }).join("");
  return `<div class="dg dg-flow" data-dg="${esc(key)}" role="group" aria-label="${esc(plainText(dg.title))}"><svg class="dg-svg" aria-hidden="true"></svg>${rows}${labels}</div>`;
}

function dgNodeHTML(n, mode) {
  const t = dgText(n, mode);
  const now = mode !== "before"; // marks and findings describe the code at the head of the branch
  const tone = mode === "diff" ? n.change || "same" : "plain";
  const p = nodeProgress(n);
  const fl = now ? liveFinds(n) : [];
  const top = fl.length ? fl.reduce((a, b) => (SEV_RANK[b.severity] > SEV_RANK[a.severity] ? b : a)) : null;
  // Refs point at the new code, so the old picture only names files for the steps that were removed.
  const names = now || n.change === "removed" ? [...new Set(n.refs.filter((r) => r.at).map((r) => shortPath(files[r.at.f])))] : [];
  const sel = S.map.sel === n.id;
  const cls = `dg-node k-${n.kind} c-${tone}${sel ? " is-sel" : ""}${now && tourNodeId() === n.id ? " is-tour" : ""}`;
  const attrs = `type="button" class="${cls}${n.kind === "actor" && !n.num ? " is-pill" : ""}" data-act="dg-node" data-node="${esc(n.id)}" aria-pressed="${sel}"`;
  if (n.kind === "actor" && !n.num) return `<button ${attrs}>${icon("users")}<span class="dg-label">${inline(t.label)}</span></button>`;
  const mark = now && p.total ? `<span class="mark m-${p.all ? "done" : p.done ? "part" : "todo"}" style="--p:${p.done / p.total}" title="${p.done} of ${plural(p.total, "hunk")} reviewed"></span>` : "";
  const fresh = now && nodeFresh(n) ? `<span class="g-new" title="New to you"></span>` : "";
  const chip = mode === "diff" && n.change ? `<span class="tag tag-${n.change}">${CHANGE_WORD[n.change]}</span>` : "";
  const num = now && n.num ? `<span class="dg-num">${n.num}</span>` : "";
  const sev = top ? `<span class="sev sev-${top.severity}${findingState(top) === "open" ? "" : " is-decided"}" title="${esc(plainText(top.title))}">${SEV[top.severity]}${fl.length > 1 ? ` +${fl.length - 1}` : ""}</span>` : "";
  return `<button ${attrs}>
    ${num || chip || mark || fresh ? `<span class="dg-top">${num}${chip}<span class="dg-state">${fresh}${mark}</span></span>` : ""}
    <span class="dg-label">${n.kind === "actor" ? icon("users") : n.kind === "data" ? icon("db") : ""}${inline(t.label)}</span>
    ${t.detail ? `<span class="dg-detail">${inline(t.detail)}</span>` : ""}
    ${names.length || sev ? `<span class="dg-foot"><span class="dg-where">${esc(names.join(" · "))}</span>${sev}</span>` : ""}
  </button>`;
}

// The Files view needs no agent: chapters are rows, and lines follow the import graph.
function filesMapHTML() {
  const routes = [];
  files.forEach((f) => f.uses.forEach((d) => routes.push({ from: `f${d}`, to: `f${f.i}`, i: routes.length, vias: [], cls: "same" })));
  DG_LAYOUT.set("files", { routes, arrows: false, loose: true });
  const rows = chapters.map((c) => {
    const p = chapterProgress(c);
    return `<div class="dg-ch${p.all ? " is-done" : ""}"><p class="dg-ch-title"><span class="g-n">${c.n}</span><span>${esc(c.title)}</span>${p.all ? icon("check", "g-done") : ""}</p>
      <div class="dg-row">${c.files.map(fileNodeHTML).join("")}</div></div>`;
  }).join("");
  // With many imports the lines turn into a tangle, so they wait until a file is picked.
  return `<div class="dg dg-filemap${routes.length > 14 ? " is-quiet" : ""}" data-dg="files" role="group" aria-label="Changed files by chapter"><svg class="dg-svg" aria-hidden="true"></svg>${rows}</div>`;
}

function fileNodeHTML(f) {
  const p = fileProgress(f);
  const sel = S.map.sel === `f${f.i}`;
  const fresh = f.hunks.some((h) => h.fresh && !S.reviewed.has(h.key));
  return `<button type="button" class="dg-node dg-file${sel ? " is-sel" : ""}" data-act="dg-node" data-node="f${f.i}" aria-pressed="${sel}" title="${esc(f.path)}">
    <span class="mark m-${fileState(f)}" style="--p:${p.total ? p.done / p.total : 0}"></span><span class="dg-fname">${esc(shortPath(f))}</span>${fresh ? `<span class="g-new" title="New to you"></span>` : ""}${flagHTML(f)}
    <span class="g-count"><span class="n-add">+${f.additions}</span>${f.deletions ? ` <span class="n-del">−${f.deletions}</span>` : ""}</span></button>`;
}

// A file name, with its folder when another changed file has the same name.
const shortPath = (f) => (files.some((g) => g !== f && g.base === f.base) ? `${f.dir.split("/").filter(Boolean).pop() || ""}/${f.base}` : f.base);

function coverageHTML(dg) {
  const c = dgCoverage(dg);
  const shown = c.outside.slice(0, 8).map((f) => `<button type="button" class="link mono" data-act="goto-file" data-f="${f.i}" title="${esc(f.path)}">${esc(shortPath(f))}</button>`);
  const more = c.outside.length - shown.length;
  return `<p class="map-cover">${icon("info")}<span>The boxes touch ${c.touched} of ${plural(c.all, "hunk")}.${shown.length
    ? ` Not in the diagram: ${shown.join(", ")}${more > 0 ? ` and ${plural(more, "more file")}` : ""}. Read those in Changes.`
    : " Every changed file is in it."}</span></p>`;
}

function mapSideHTML() {
  const dg = mapDiagram();
  const sel = S.map.sel;
  if (sel && !narrow.matches) {
    if (dg && dg.byId.has(sel)) return stepPanelHTML(dg, dg.byId.get(sel));
    if (!dg && sel[0] === "f" && files[+sel.slice(1)]) return filePanelHTML(files[+sel.slice(1)]);
  }
  return mapGuideHTML(dg);
}

function mapGuideHTML(dg) {
  if (!dg) {
    return `<section class="side-card"><h3>Reading the files map</h3>
      <p class="dim">Chapters run top to bottom, in the order the guide suggests reading them. Each file carries its review mark, its open agent findings and its size. Pick one to see how it connects.</p></section>`;
  }
  const pinned = [];
  dg.nodes.forEach((n) => liveFinds(n).forEach((x) => { if (!pinned.some((p) => p.x === x)) pinned.push({ x, n }); }));
  const c = { added: 0, changed: 0, removed: 0 };
  dg.nodes.forEach((n) => { if (n.change) c[n.change]++; });
  const parts = [c.added && `${c.added} new`, c.changed && `${c.changed} changed`, c.removed && `${c.removed} removed`].filter(Boolean);
  return `<section class="side-card"><h3>Start here</h3>
      <p class="dim">${plural(dg.nodes.length, "box", "boxes")}${parts.length ? `: ${joinNames(parts)}` : ""}. Pick one to see its code and findings, or follow the flow through the diff.</p>
      ${pinned.length ? `<ul class="tlist">${pinned.map(({ x, n }) => `<li><button type="button" class="titem" data-act="dg-node" data-node="${esc(n.id)}">
        <span class="titem-top"><span class="sev sev-${x.severity}">${SEV[x.severity]}</span><span>${n.num ? `Step ${n.num} · ` : ""}${esc(plainText(n.label))}</span></span>
        <span class="titem-text">${inline(x.title)}</span></button></li>`).join("")}</ul>` : ""}
    </section>
    <section class="side-card"><h3>Two ways to read</h3>
      <p class="dim">Chapters follow how the code builds on itself. The flow follows how it runs. Both count toward the same review marks.</p></section>`;
}

const stepFindingHTML = (x) => `<li><button type="button" class="titem" data-act="go-finding" data-id="${x.id}">
  <span class="titem-top"><span class="sev sev-${x.severity}">${SEV[x.severity]}</span><span>${esc(AGENT_BY[x.agent].name)}</span>${findingState(x) === "open" ? "" : `<span>· ${findingState(x) === "accepted" ? "in your review" : "dismissed"}</span>`}</span>
  <span class="titem-text">${inline(x.title)}</span></button></li>`;

function stepPanelHTML(dg, n) {
  const b = n.before || {};
  const p = nodeProgress(n);
  const chs = [...new Set(n.refs.filter((r) => r.at).map((r) => files[r.at.f].ch).filter(Boolean))].sort((a, c) => a - c);
  const list = dgView(dg, mapMode(dg)).nodes;
  const i = list.indexOf(n);
  const was = [b.label && b.label !== n.label ? b.label : "", b.detail || ""].filter(Boolean).join(": ");
  const kind = n.num ? `Step ${n.num} of ${dg.steps}` : n.kind === "actor" ? "Where it starts" : "Context";
  return `<div class="dp" id="dp">
    <header class="dp-head"><p class="eyebrow">${kind}${n.change ? ` · ${CHANGE_WORD[n.change]}` : n.num ? " · Unchanged" : ""}</p>
      <span class="dp-nav"><button type="button" class="icon-btn sm" data-act="dg-step" data-dir="-1" aria-label="Previous box"${i <= 0 ? " disabled" : ""}>${icon("left")}</button><button type="button" class="icon-btn sm" data-act="dg-step" data-dir="1" aria-label="Next box"${i >= list.length - 1 ? " disabled" : ""}>${icon("left", "flip")}</button><button type="button" class="icon-btn sm" data-act="dg-clear" aria-label="Close">${icon("x")}</button></span></header>
    <h3 class="dp-title" id="mapnode-title">${inline(n.label)}</h3>
    ${n.detail ? `<p class="dp-text">${inline(n.detail)}</p>` : ""}
    ${n.change === "changed" && was ? `<p class="dp-before"><span class="tag">Before</span><span>${inline(was)}</span></p>` : ""}
    ${n.num ? `<div class="dp-foot"><button type="button" class="btn sm primary" data-act="tour-start" data-dg="${esc(dg.id)}" data-node="${esc(n.id)}">${icon("play")}Read it in the diff</button>
      <span class="dp-prog"><span class="mark m-${p.all ? "done" : p.done ? "part" : "todo"}" style="--p:${p.done / p.total}"></span><span>${p.all ? "Reviewed" : `${p.done} of ${plural(p.total, "hunk")} reviewed`}${chs.length ? ` · ${chs.length > 1 ? "chapters" : "chapter"} ${joinNames(chs.map(String))}` : ""}</span></span></div>` : ""}
    ${n.finds.length ? `<ul class="tlist dp-finds">${n.finds.map(stepFindingHTML).join("")}</ul>` : ""}
    ${n.refs.length ? `<div class="dp-code">${n.refs.map((r, j) => excerptHTML(n, r, j)).join("")}</div>` : n.kind === "actor" ? "" : `<p class="dim">This box has no code of its own in the diff. It's here so the flow reads end to end.</p>`}
  </div>`;
}

// A few lines around the code a box stands for, with one line of context on each side.
function excerptHTML(n, r, j) {
  const name = String(r.path || "").split("/").pop();
  if (!r.at) return `<p class="ex-missing">${icon("alert")}<span>The agent pointed at <code>${esc(name)}</code>, but that code isn't in this diff.</span></p>`;
  const { f, h } = HUNK.get(r.at.h);
  const from = Math.max(0, r.at.from - 1), to = Math.min(h.lines.length - 1, r.at.to + 1);
  const CAP = 24;
  let rows = "";
  const wd = wordDiffs(h);
  for (let x = from; x <= Math.min(to, from + CAP - 1); x++) {
    if (wd.longAdd.has(x)) continue; // shown with its old version
    const l = h.lines[x];
    const lp = wd.long.get(x);
    const kind = lp ? " lrow" : l[0] === "+" ? " add" : l[0] === "-" ? " del" : "";
    const code = lp ? longTextHTML(l[3], h.lines[lp.add][3], lp.ops, f.lang, false, null)
      : l[3].length > LONG_LINE ? `${hl(l[3].slice(0, 200), f.lang)} <span class="lw-gap">⋯ ${(l[3].length - 200).toLocaleString("en-US")} more characters</span>` : hl(l[3], f.lang);
    rows += `<div class="ex-row${kind}${x < r.at.from || x > r.at.to ? " ctx" : ""}"><span class="ex-no">${(lp ? h.lines[lp.add][2] : l[0] === "-" ? l[1] : l[2]) ?? ""}</span>`
      + `<span class="ex-cd" style="--i:${indentOf(l[3])}"><span class="sg" aria-hidden="true">${lp ? "±" : l[0] === "+" ? "+" : l[0] === "-" ? "−" : ""}</span>${code}</span></div>`;
  }
  const more = to - from + 1 - CAP;
  const nums = h.lines.slice(r.at.from, r.at.to + 1).filter((l) => l[0] !== "-").map((l) => l[2]);
  const where = !nums.length ? "deleted lines" : nums.length === 1 ? `line ${nums[0]}` : `lines ${nums[0]}–${nums[nums.length - 1]}`;
  return `<figure class="ex"><figcaption><button type="button" class="link mono" data-act="tour-start" data-node="${esc(n.id)}" data-part="${j}" title="Read ${esc(f.path)} in the diff">${esc(f.base)}</button><span>${where}</span></figcaption>
    <div class="ex-rows">${rows}</div>${more > 0 ? `<p class="ex-more">${plural(more, "more line")} in the diff</p>` : ""}</figure>`;
}

function filePanelHTML(f) {
  const p = fileProgress(f);
  const usedBy = files.filter((g) => g.uses.includes(f.i));
  const steps = DIAGRAMS.flatMap((dg) => dg.nodes.filter((n) => n.refs.some((r) => r.at && r.at.f === f.i)).map((n) => ({ dg, n })));
  const ch = chapters.find((c) => c.n === f.ch);
  const fl = FIND.filter((x) => x.f === f.i);
  const chip = (g) => `<button type="button" class="dp-chip mono" data-act="dg-node" data-node="f${g.i}" title="${esc(g.path)}">${esc(shortPath(g))}</button>`;
  const none = `<span class="dim">No other changed file</span>`;
  return `<div class="dp" id="dp">
    <header class="dp-head"><p class="eyebrow">${ch ? `Chapter ${ch.n} · ${esc(ch.title)}` : "File"}</p><span class="dp-nav"><button type="button" class="icon-btn sm" data-act="dg-step" data-dir="-1" aria-label="Previous file">${icon("left")}</button><button type="button" class="icon-btn sm" data-act="dg-step" data-dir="1" aria-label="Next file">${icon("left", "flip")}</button><button type="button" class="icon-btn sm" data-act="dg-clear" aria-label="Close">${icon("x")}</button></span></header>
    <h3 class="dp-title mono" id="mapnode-title">${esc(shortPath(f))}</h3>
    <p class="dp-text mono">${esc(f.dir || "Repository root")}</p>
    <p class="dp-prog"><span class="mark m-${fileState(f)}" style="--p:${p.total ? p.done / p.total : 0}"></span><span>${p.total ? `${p.done} of ${plural(p.total, "hunk")} reviewed` : "Nothing to review line by line"} · <span class="n-add">+${f.additions}</span> <span class="n-del">−${f.deletions}</span></span></p>
    <dl class="dp-rel">
      <dt>Uses</dt><dd>${f.uses.length ? f.uses.map((d) => chip(files[d])).join("") : none}</dd>
      <dt>Used by</dt><dd>${usedBy.length ? usedBy.map(chip).join("") : none}</dd>
      ${steps.length ? `<dt>In the flow</dt><dd>${steps.map(({ dg, n }) => `<button type="button" class="dp-chip" data-act="map-node" data-dg="${esc(dg.id)}" data-node="${esc(n.id)}">${n.num ? `${n.num}. ` : ""}${esc(plainText(n.label))}</button>`).join("")}</dd>` : ""}
    </dl>
    ${fl.length ? `<ul class="tlist dp-finds">${fl.map(stepFindingHTML).join("")}</ul>` : ""}
    <div class="dp-foot"><button type="button" class="btn primary" data-act="goto-file" data-f="${f.i}">Open in Changes</button></div>
  </div>`;
}

// Edges are drawn once the boxes have their places, and again whenever a box changes size.
function drawDiagram(root) {
  const L = DG_LAYOUT.get(root.dataset.dg);
  const svg = root.querySelector(".dg-svg");
  if (!L || !svg) return;
  const box = root.getBoundingClientRect();
  if (!box.width) return;
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }; };
  const at = new Map();
  root.querySelectorAll(".dg-node").forEach((el) => at.set(`n:${el.dataset.node}`, rectOf(el)));
  root.querySelectorAll(".dg-via").forEach((el) => at.set(`v:${el.dataset.via}`, rectOf(el)));
  const cx = (r) => r.x + r.w / 2;
  const routes = L.routes.filter((r) => at.has(`n:${r.from}`) && at.has(`n:${r.to}`));
  // Spread the edges that leave or enter a box along its edge, in the order of their other ends.
  const ox = new Map(), ix = new Map();
  const spread = (end, into, other) => {
    const groups = new Map();
    routes.forEach((r) => { if (r.back) return; if (!groups.has(r[end])) groups.set(r[end], []); groups.get(r[end]).push(r); });
    groups.forEach((list, id) => {
      const rect = at.get(`n:${id}`);
      list.sort((a, b) => cx(other(a)) - cx(other(b)));
      const step = Math.min(36, (rect.w * 0.6) / list.length);
      list.forEach((r, k) => into.set(r, cx(rect) + (k - (list.length - 1) / 2) * step));
    });
  };
  if (!L.loose) {
    spread("from", ox, (r) => at.get(r.vias[0] || `n:${r.to}`));
    spread("to", ix, (r) => at.get(r.vias[r.vias.length - 1] || `n:${r.from}`));
  }
  const curve = (p, q) => { const my = (p.y + q.y) / 2; return `C${p.x} ${my} ${q.x} ${my} ${q.x} ${q.y}`; };
  const spots = new Map();
  let paths = "";
  routes.forEach((r) => {
    const a = at.get(`n:${r.from}`), b = at.get(`n:${r.to}`);
    let d, mid = null;
    if (L.loose) {
      if (b.y > a.y + a.h - 2) d = `M${cx(a)} ${a.y + a.h}${curve({ x: cx(a), y: a.y + a.h }, { x: cx(b), y: b.y })}`;
      else if (a.y > b.y + b.h - 2) d = `M${cx(a)} ${a.y}${curve({ x: cx(a), y: a.y }, { x: cx(b), y: b.y + b.h })}`;
      else { const y = Math.max(a.y + a.h, b.y + b.h) + 22; d = `M${cx(a)} ${a.y + a.h}C${cx(a)} ${y} ${cx(b)} ${y} ${cx(b)} ${b.y + b.h}`; }
    } else if (r.back) {
      const s = { x: a.x + a.w, y: a.y + a.h / 2 }, t = { x: b.x + b.w + 3, y: b.y + b.h / 2 };
      const bend = Math.max(s.x, t.x) + 40;
      d = `M${s.x} ${s.y}C${bend} ${s.y} ${bend} ${t.y} ${t.x} ${t.y}`;
      mid = { x: bend - 10, y: (s.y + t.y) / 2 };
    } else {
      const pts = [{ x: ox.get(r), y: a.y + a.h }];
      r.vias.forEach((v) => { const w = at.get(v); pts.push({ x: cx(w), y: w.y }, { x: cx(w), y: w.y + w.h }); });
      pts.push({ x: ix.get(r), y: b.y - 3 });
      d = `M${pts[0].x} ${pts[0].y}`;
      for (let k = 1; k < pts.length; k++) d += k % 2 === 0 && k < pts.length - 1 ? `L${pts[k].x} ${pts[k].y}` : curve(pts[k - 1], pts[k]);
      mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }
    if (mid) spots.set(r.i, mid);
    paths += `<path class="dg-e e-${r.cls}" d="${d}" data-from="${esc(r.from)}" data-to="${esc(r.to)}" data-cls="${r.cls}"/>`;
  });
  if (!root.dataset.arrow) root.dataset.arrow = "ah" + Math.random().toString(36).slice(2, 8);
  const marker = (c) => `<marker id="${root.dataset.arrow}-${c}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="ah ah-${c}" d="M1 1.5 8.5 5 1 8.5z"/></marker>`;
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = (L.arrows ? `<defs>${["same", "added", "removed", "hot"].map(marker).join("")}</defs>` : "") + paths;
  // Labels of edges that leave the same gap can collide, so push overlapping ones apart.
  const tags = [];
  root.querySelectorAll(".dg-elabel").forEach((el) => {
    const p = spots.get(+el.dataset.e);
    el.hidden = !p;
    if (p) tags.push({ el, x: p.x, y: p.y, w: el.offsetWidth + 8 });
  });
  tags.sort((a, b) => a.y - b.y || a.x - b.x);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length && tags[j].y - tags[i].y < 18; j++) {
        const [l, r] = tags[i].x <= tags[j].x ? [tags[i], tags[j]] : [tags[j], tags[i]];
        const overlap = (l.x + l.w / 2) - (r.x - r.w / 2);
        if (overlap > 0) { l.x -= overlap / 2; r.x += overlap / 2; }
      }
    }
  }
  tags.forEach((t) => { t.el.style.left = `${Math.max(t.w / 2, Math.min(box.width - t.w / 2, t.x))}px`; t.el.style.top = `${t.y}px`; });
  hiliteDiagram(root);
}

// The picked box, its edges and its neighbours stay bright. Everything else steps back.
function hiliteDiagram(root) {
  const sel = S.map.sel;
  const on = !!sel && !!root.querySelector(`.dg-node[data-node="${cssId(sel)}"]`);
  root.classList.toggle("has-sel", on);
  const near = new Set(on ? [sel] : []);
  root.querySelectorAll(".dg-e").forEach((p) => {
    const hot = on && (p.dataset.from === sel || p.dataset.to === sel);
    p.classList.toggle("is-hot", hot);
    if (hot) { near.add(p.dataset.from); near.add(p.dataset.to); }
    if (root.dataset.arrow && DG_LAYOUT.get(root.dataset.dg)?.arrows) p.setAttribute("marker-end", `url(#${root.dataset.arrow}-${hot ? "hot" : p.dataset.cls})`);
  });
  root.querySelectorAll(".dg-elabel").forEach((el) => el.classList.toggle("is-hot", on && (el.dataset.from === sel || el.dataset.to === sel)));
  root.querySelectorAll(".dg-node").forEach((el) => el.classList.toggle("is-near", near.has(el.dataset.node)));
}

let dgObserver = null;
function mountDiagrams() {
  if (dgObserver) { dgObserver.disconnect(); dgObserver = null; }
  const roots = $$(".dg");
  roots.forEach(drawDiagram);
  if (!roots.length || typeof ResizeObserver === "undefined") return;
  dgObserver = new ResizeObserver((entries) => {
    const todo = new Set(entries.map((en) => en.target.closest(".dg")).filter(Boolean));
    requestAnimationFrame(() => todo.forEach((root) => { if (document.contains(root)) drawDiagram(root); }));
  });
  roots.forEach((root) => { dgObserver.observe(root); root.querySelectorAll(".dg-node").forEach((el) => dgObserver.observe(el)); });
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => $$(".dg").forEach(drawDiagram));

function refreshMap() {
  const main = $("#map-main");
  if (!main) return;
  main.innerHTML = mapMainHTML();
  const side = $("#map-side");
  if (side) side.innerHTML = mapSideHTML();
  mountDiagrams();
}

function mapNodePanel(id) {
  const dg = mapDiagram();
  if (dg && dg.byId.has(id)) return stepPanelHTML(dg, dg.byId.get(id));
  if (!dg && id && id[0] === "f" && files[+id.slice(1)]) return filePanelHTML(files[+id.slice(1)]);
  return "";
}

// Picking a box shows its details beside the map on wide screens, and in a sheet on narrow ones.
function selectMapNode(id, keep) {
  S.map.sel = !keep && S.map.sel === id && !narrow.matches ? null : id;
  $$("#map .dg-node").forEach((el) => { const on = el.dataset.node === S.map.sel; el.classList.toggle("is-sel", on); el.setAttribute("aria-pressed", String(on)); });
  $$("#map .dg").forEach(hiliteDiagram);
  if (narrow.matches) {
    const html = S.map.sel ? mapNodePanel(S.map.sel) : "";
    if (!html) { if (S.sheet && S.sheet.id === "mapnode") closeSheet(); return; }
    const sheet = S.sheet && S.sheet.id === "mapnode" ? $("#sheet-mapnode") : null;
    if (sheet) sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>${html}`;
    else openSheet("mapnode", `<div class="grab" aria-hidden="true"></div>${html}`, "side map-sheet");
    return;
  }
  const side = $("#map-side");
  if (side) side.innerHTML = mapSideHTML();
}

function stepMapNode(dir) {
  const dg = mapDiagram();
  const list = dg ? dgView(dg, mapMode(dg)).nodes.map((n) => n.id) : chapters.flatMap((c) => c.files).map((f) => `f${f.i}`);
  if (!list.length) return;
  const i = list.indexOf(S.map.sel);
  const next = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + dir))];
  selectMapNode(next, true);
  const el = $(`#map .dg-node[data-node="${cssId(next)}"]`);
  if (el && !narrow.matches) el.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "auto" : "smooth" });
}

function showOnMap(dgId, nodeId) {
  closeSheet(true);
  if (dgById(dgId)) S.map.view = dgId;
  S.map.sel = null;
  if (S.tab !== "map") setTab("map"); else refreshMap();
  selectMapNode(nodeId, true);
  const el = $(`#map .dg-node[data-node="${cssId(nodeId)}"]`);
  if (el) { el.scrollIntoView({ block: "center", behavior: reduced.matches ? "auto" : "smooth" }); pulse(el); }
}

/* ---------- Inbox ---------- */

const REVIEW_WORD = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "commented", DISMISSED: "had a review dismissed" };

// The same four stages as liveStages(), from the summary the extension keeps for every pull request.
function summaryFlow(it) {
  const c = it.checks || {};
  const checks = !c.total ? (LIVE.github ? "done" : "upcoming") : c.failed ? "blocked" : c.running ? "running" : "done";
  const agents = it.agent ? "done" : "upcoming";
  const review = it.reviewDecision === "APPROVED" ? "done" : it.reviewDecision === "CHANGES_REQUESTED" ? "blocked" : "active";
  const merge = it.state === "MERGED" ? "done" : it.state === "CLOSED" || it.mergeStateStatus === "DIRTY" ? "blocked" : it.mergeStateStatus === "CLEAN" ? "active" : "upcoming";
  return [checks, agents, review, merge];
}

function summaryFlowText(it) {
  const c = it.checks || {};
  if (it.state === "MERGED") return "Merged";
  if (it.state === "CLOSED") return "Closed";
  if (c.failed) return `Checks · ${plural(c.failed, "check")} failing`;
  if (c.running) return `Checks · ${c.running} running`;
  if (!it.agent) return "Agent review · not run yet";
  if (it.reviewDecision === "APPROVED") return it.mergeStateStatus === "CLEAN" ? "Merge · ready" : "Merge · waiting on requirements";
  if (it.reviewDecision === "CHANGES_REQUESTED") return "Review · changes requested";
  return "Review · review required";
}

// Pull requests can come from several repositories, so numbers alone don't tell them apart.
const LIVE_KEY = `${LIVE.repo}#${LIVE.number}`;
const itemKey = (it) => it.key || `${it.repo || LIVE.repo}#${it.number}`;
const liveRepos = () => [...new Set((LIVE.list || []).map((it) => it.repo || LIVE.repo))];
const liveRisk = (it) => (itemKey(it) === LIVE_KEY ? currentRisk() : it.riskInput ? computeRisk(it.riskInput) : null);
const byRisk = (a, b) => ((liveRisk(b) || { score: -1 }).score - (liveRisk(a) || { score: -1 }).score);
const isWaitingOnYou = (it) => it.state === "OPEN" && !it.own && it.viewerReview !== "APPROVED";

function liveRowHTML(it) {
  // Opened from the sidebar's Home, the pull request behind the page isn't one you chose, so it isn't marked.
  const current = itemKey(it) === LIVE_KEY && !LIVE.startView;
  const author = it.author ? livePid(it.author.login) : "ghost";
  const flow = current ? stages().map((st) => st.st) : summaryFlow(it);
  const flowText = current ? flowSummary().replace(": ", " · ") : summaryFlowText(it);
  const notes = [];
  if (it.error) notes.push(it.error);
  if (it.stackedOnPr) notes.push(`Stacked on #${it.stackedOnPr}`);
  else if (it.baseRefName && it.baseRefName !== (it.defaultBranch || "main")) notes.push(`Into ${it.baseRefName}`);
  if (it.drafts) notes.push(`${plural(it.drafts, "draft")} saved`);
  if (it.agent) notes.push(it.agent.openHigh ? plural(it.agent.openHigh, "high agent finding") : it.agent.open ? plural(it.agent.open, "agent finding") : it.agent.findings ? "Agent findings decided" : "Agents found nothing");
  if (it.description) notes.push(it.description.gaps ? `Description: ${plural(it.description.gaps, "gap")}` : "Description covers the rules");
  if (it.viewerReview) notes.push(`You ${REVIEW_WORD[it.viewerReview] || "reviewed"}`);
  // Before its diff is built, a row only has GitHub's added and removed line counts to go on.
  const minutes = Math.max(1, Math.round((it.weight || (it.additions || 0) + (it.deletions || 0)) / PACE));
  const risk = liveRisk(it);
  const where = liveRepos().length > 1 ? `${(it.repo || LIVE.repo).split("/").pop()} #${it.number}` : `#${it.number}`;
  return `<li><button type="button" class="pr-row${current ? " is-current" : ""}" data-act="open-live-pr" data-key="${esc(itemKey(it))}" data-href="${esc(it.href || "")}">
    ${avatar(author)}
    <span class="pr-row-main"><span class="pr-row-title">${esc(it.title || `Pull request #${it.number}`)}</span>
      <span class="pr-row-meta"><span class="mono">${esc(where)}</span>${notes.length ? ` · ${esc(notes.join(" · "))}` : ""}${current ? ` · <span class="pr-row-note is-new">Open now</span>` : ""}</span></span>
    <span class="pr-row-flow">${miniTrackHTML(flow)}<span>${esc(flowText)}</span></span>
    <span class="pr-row-size">${risk ? riskBadgeHTML(risk) : ""}<span><span class="n-add">+${num(it.additions)}</span> <span class="n-del">−${num(it.deletions)}</span></span>
      <span class="dim">${it.hunks ? `${Math.min(it.reviewed || 0, it.hunks)} of ${it.hunks} hunks · ` : ""}about ${readTime(minutes)}</span></span>
  </button></li>`;
}

// The VS Code extension sends the sidebar's groups (LIVE.groups): the same sections, in the same order.
function liveGroupsHTML(list) {
  const byKey = new Map(list.map((it) => [itemKey(it).toLowerCase(), it]));
  return LIVE.groups.map((g) => {
    const items = g.keys.map((k) => byKey.get(k.toLowerCase())).filter(Boolean);
    if (!items.length) return "";
    const head = `${esc(g.label)}${g.description ? ` · ${esc(g.description)}` : ""}`;
    const rows = `<ul class="ib-list">${items.map(liveRowHTML).join("")}</ul>`;
    return g.collapsed
      ? `<details class="ib-sec ib-fold"><summary class="eyebrow">${head}</summary>${rows}</details>`
      : `<section class="ib-sec"><h2 class="eyebrow">${head}</h2>${rows}</section>`;
  }).join("");
}

const GROUPING_WORDS = { relationship: "Grouped by how they concern you", repository: "Grouped by repository" };
const SORT_WORDS = { risk: "riskiest first", created: "newest first", updated: "recently updated" };

function inboxHTML() {
  const list = LIVE.list || [];
  const grouped = Array.isArray(LIVE.groups);
  const waiting = grouped ? list.filter((it) => it.requested && it.state === "OPEN") : list.filter(isWaitingOnYou).sort(byRisk);
  const yours = list.filter((it) => it.own && it.state === "OPEN").sort(byRisk);
  const others = list.filter((it) => !isWaitingOnYou(it) && !yours.includes(it)).sort(byRisk);
  const sections = grouped
    ? `${LIVE.grouping ? `<p class="dim ib-mode">${GROUPING_WORDS[LIVE.grouping.by] || ""} · ${SORT_WORDS[LIVE.grouping.sort] || ""}, as in the Diffline sidebar. Change it from the sidebar's title bar.</p>` : ""}${liveGroupsHTML(list)}`
    : `${waiting.length ? `<section class="ib-sec"><h2 class="eyebrow">Waiting on you · riskiest first</h2><ul class="ib-list">${waiting.map(liveRowHTML).join("")}</ul></section>` : ""}
    ${yours.length ? `<section class="ib-sec"><h2 class="eyebrow">Your pull requests</h2><ul class="ib-list">${yours.map(liveRowHTML).join("")}</ul></section>` : ""}
    ${others.length ? `<section class="ib-sec"><h2 class="eyebrow">Also in this session</h2><ul class="ib-list">${others.map(liveRowHTML).join("")}</ul></section>` : ""}`;
  const note = "To add a pull request, use <b>Open Pull Request…</b> in the Diffline sidebar, or watch a repository in the <code>diffline.watch.repositories</code> setting.";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = PEOPLE.you && PEOPLE.you.name && PEOPLE.you.name !== "You" ? PEOPLE.you.name.split(" ")[0] : "";
  return `${ribbonHTML()}${topbarHTML()}<main class="page inbox" id="main">
    <header class="inbox-head"><p class="eyebrow">${liveRepos().length > 2 ? `${plural(list.length, "pull request")} in ${plural(liveRepos().length, "repository", "repositories")}` : esc(liveRepos().length > 1 ? joinNames(liveRepos().map((r) => r.split("/").pop())) : LIVE.repo)} · on this machine</p><h1>${greeting}${first ? `, ${esc(first)}` : ""}</h1>
      <p class="lede">${waiting.length ? `${plural(waiting.length, "pull request")} ${waiting.length === 1 ? "is" : "are"} waiting on you.` : "Nothing is waiting on you."} Drafts and review marks stay on this machine until you post them.</p>
      ${typeof HOST.metricsReport === "function" ? `<p class="ib-links"><button type="button" class="btn sm" data-act="metrics">${icon("chart")}Review metrics</button><span class="dim">Your reviews per week, which agent findings you use, and what agent runs cost</span></p>` : ""}</header>
    ${sections}
    <p class="dim live-note">${icon("info")}<span>${note}</span></p>
  </main>`;
}

/* ---------- Review metrics ---------- */

// The extension keeps a log of what the reviewer does with agent findings, the reviews they post and each agent run
// (on this machine only), and adds it up for a period when the page asks (HOST.metricsReport). The page draws the
// numbers as tables: Your reviews, Agent findings and Agent runs.

const METRIC_PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [null, "All time"]];
const METRIC_GROUPS = { agent: "Agent", harness: "Harness", model: "Model", thinking: "Thinking" };
const OUTCOME_WORD = { useful: "Useful", dismissed: "Dismissed", ignored: "Ignored", undecided: "Undecided" };
const OUTCOME_PILL = { useful: "ok", dismissed: "bad", ignored: "warn", undecided: "" };
const ACTION_WORD = { added: "Added to your review", posted: "Posted", copied: "Copied", dismissed: "Dismissed", "left-open": "Left open when you posted", undone: "Decision undone" };
const FAILURE_WORD = { missing: "not installed", auth: "not signed in", timeout: "timed out", cancelled: "stopped", failed: "failed", badOutput: "unusable output" };
const M = { days: 30, groupBy: "agent", data: null, error: "", loading: false, seq: 0, exFilter: "all" };
try {
  const saved = JSON.parse(localStorage.getItem("diffline:metrics") || "{}");
  if (METRIC_PERIODS.some(([d]) => d === saved.days)) M.days = saved.days;
  if (METRIC_GROUPS[saved.groupBy]) M.groupBy = saved.groupBy;
} catch { /* optional */ }

const pctText = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const money = (x) => (x == null ? "–" : x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`);
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : num(n));
function duration(ms) {
  if (ms == null) return "–";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim() : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
const minutesText = (m) => (m == null ? "–" : m < 1 ? "<1 min" : `${Math.round(m)} min`);
const periodWord = () => (M.days ? `the last ${M.days} days` : "all time");
const F_SHORT = fmt({ month: "short", day: "numeric" });
const shortDate = (iso) => { const t = Date.parse(iso.length === 10 ? `${iso}T12:00:00` : iso); return Number.isFinite(t) ? F_SHORT.format(new Date(t)) : ""; };

function loadMetrics() {
  if (typeof HOST.metricsReport !== "function") {
    M.error = "This version of the Diffline extension can't show review metrics.";
    refreshMetrics();
    return;
  }
  const seq = ++M.seq;
  M.loading = true;
  M.error = "";
  refreshMetrics();
  HOST.metricsReport({ days: M.days, groupBy: M.groupBy }).then(
    (d) => { if (seq !== M.seq) return; M.data = d; M.loading = false; refreshMetrics(); },
    (err) => { if (seq !== M.seq) return; M.loading = false; M.error = err.message || String(err); refreshMetrics(); },
  );
}

function refreshMetrics() {
  if (S.view !== "metrics") return;
  // The pickers are redrawn: keep the keyboard focus on the button that was pressed.
  const had = document.activeElement && document.activeElement.closest && document.activeElement.closest("#mx-controls [data-act]");
  const again = had ? `#mx-controls [data-act="${had.dataset.act}"]${had.dataset.days ? `[data-days="${had.dataset.days}"]` : ""}${had.dataset.by ? `[data-by="${had.dataset.by}"]` : ""}${had.dataset.format ? `[data-format="${had.dataset.format}"]` : ""}` : null;
  replaceHTML("#mx-controls", metricsControlsHTML());
  if (again) { const el = $(again); if (el) el.focus({ preventScroll: true }); }
  const body = $("#metrics-body");
  if (body) { body.innerHTML = metricsBodyHTML(); body.setAttribute("aria-busy", String(M.loading)); }
  const st = $("#mx-status");
  if (st) st.textContent = M.loading ? "Reading the review metrics…" : M.error ? `Couldn't read the review metrics: ${M.error}` : M.data ? `Showing ${periodWord()}, grouped by ${METRIC_GROUPS[M.groupBy].toLowerCase()}.` : "";
}

function saveMetricPrefs() { try { localStorage.setItem("diffline:metrics", JSON.stringify({ days: M.days, groupBy: M.groupBy })); } catch { /* optional */ } }

const segHTML = (label, id, items, act, attr) => `<div class="mx-ctl"><span class="eyebrow" id="${id}">${label}</span>
  <div class="seg" role="group" aria-labelledby="${id}">${items.map(([value, text, on]) => `<button type="button" data-act="${act}" data-${attr}="${esc(value)}" aria-pressed="${on}">${esc(text)}</button>`).join("")}</div></div>`;

function metricsControlsHTML() {
  const exportable = !!(M.data && M.data.report.total);
  return `<div class="mx-controls" id="mx-controls">
    ${segHTML("Period", "mx-period", METRIC_PERIODS.map(([d, t]) => [d == null ? "all" : d, t, M.days === d]), "mx-period", "days")}
    ${segHTML("Group agents by", "mx-group", Object.entries(METRIC_GROUPS).map(([k, t]) => [k, t, M.groupBy === k]), "mx-group", "by")}
    <div class="mx-export">${exportable ? `<button type="button" class="btn sm" data-act="mx-export" data-format="csv" title="One row per finding outcome in ${periodWord()}">${icon("download")}Export CSV</button>
      <button type="button" class="btn sm" data-act="mx-export" data-format="json" title="The raw events in ${periodWord()}">${icon("download")}Export JSON</button>` : ""}</div>
  </div>`;
}

function metricsHTML() {
  return `${ribbonHTML()}${topbarHTML()}<main class="page inbox metrics" id="main">
    <header class="inbox-head"><p class="eyebrow">On this machine</p><h1>Review metrics</h1>
      <p class="lede">The reviews you posted, what you did with agent findings, and what agent runs took and cost. Diffline keeps this log on this computer and never sends it anywhere.</p></header>
    ${metricsControlsHTML()}
    <p class="sr-only" role="status" id="mx-status"></p>
    <div id="metrics-body" aria-busy="${M.loading}">${metricsBodyHTML()}</div>
  </main>`;
}

function metricsEmptyHTML(enabled) {
  return `<section class="mx-empty">
    <h2>${enabled ? "No review metrics yet" : "Review metrics are off"}</h2>
    <p>As you review, Diffline records what you do with each agent finding (added to your review, dismissed and why, copied, posted, or left open when you post), the description checks you ask about or skip, each review you post with the time you spent on it, and each agent run's duration, tokens and cost.</p>
    <p>It keeps them in a file in the extension's storage on this computer. They hold finding titles, but no code, diffs or comment text.</p>
    <p>${enabled ? "Open a pull request, decide on its agent findings and post a review, and the numbers show up here." : "Turn on the <code>diffline.metrics.enabled</code> setting to start recording."} <b>Diffline: Delete Review Metrics</b> deletes the file.</p>
  </section>`;
}

function metricsBodyHTML() {
  if (M.error && !M.data) return `<p class="mx-note bad">${icon("alert")}<span>Couldn't read the review metrics. ${esc(M.error)}</span></p>`;
  if (!M.data) return `<p class="mx-note dim"><span class="spin" aria-hidden="true"></span>Reading the review metrics…</p>`;
  const { enabled, report: r } = M.data;
  if (!r.total) return metricsEmptyHTML(enabled);
  const notes = [];
  if (!enabled) notes.push(`<p class="mx-note">${icon("info")}<span>Review metrics are off, so nothing new is recorded. These are from before they were turned off. The <code>diffline.metrics.enabled</code> setting turns them back on.</span></p>`);
  if (r.skipped) notes.push(`<p class="mx-note dim">${icon("info")}<span>${plural(r.skipped, "line")} of the log couldn't be read and ${r.skipped === 1 ? "isn't" : "aren't"} counted.</span></p>`);
  if (!r.inPeriod) {
    return `${notes.join("")}<section class="mx-empty"><h2>Nothing in ${periodWord()}</h2><p>The log has ${plural(r.total, "entry", "entries")}, all from before then.</p>
      <button type="button" class="btn sm" data-act="mx-period" data-days="all">Show all time</button></section>`;
  }
  return `${notes.join("")}${reviewsSectionHTML(r)}${findingsSectionHTML(r)}${runsSectionHTML(r)}`;
}

/* Your reviews */

function reviewsSectionHTML(r) {
  const t = r.reviews.total;
  const head = `<h2 class="mx-h">Your reviews</h2>`;
  if (!t.reviews) return `<section class="mx-sec" aria-labelledby="mx-reviews">${head.replace("<h2", '<h2 id="mx-reviews"')}<p class="dim">No reviews posted from Diffline in ${periodWord()}.</p></section>`;
  const tiles = [
    ["Reviews posted", num(t.reviews), `${t.approve} approved · ${t.changes} changes requested · ${t.comment} comments only`],
    ["Whose pull requests", `${t.others} · ${t.own}`, "others' · your own"],
    ["Median time per review", minutesText(t.activeMinutes), t.activeMeasured < t.reviews ? `${t.activeMeasured} of ${t.reviews} reviews measured` : "time the page was in use"],
    ["Median coverage", pctText(t.coverage), "of hunks marked reviewed"],
    ["Later rounds", pctText(t.laterRoundsPct), `${t.laterRounds} not the first review · ${t.newPush} after a new push`],
    ["Comments", `${num(t.yours)} · ${num(t.fromFindings)}`, "yours · from agent findings"],
  ];
  const all = r.reviews.weeks;
  const weeks = (all.length > 26 ? all.filter((w) => w.reviews) : all).slice().reverse();
  const max = Math.max(1, ...weeks.map((w) => w.reviews));
  return `<section class="mx-sec" aria-labelledby="mx-reviews"><h2 class="mx-h" id="mx-reviews">Your reviews</h2>
    <dl class="mx-tiles">${tiles.map(([k, v, sub]) => `<div class="mx-tile"><dt>${esc(k)}</dt><dd><b>${esc(v)}</b><span>${esc(sub)}</span></dd></div>`).join("")}</dl>
    <div class="table-wrap"><table class="deps-table mx-table">
      <caption>Reviews per week, newest first${all.length > weeks.length ? ". Weeks without reviews aren't listed" : ""}</caption>
      <thead><tr><th scope="col">Week of</th><th scope="col">Reviews</th><th scope="col">Approved · changes · comment</th><th scope="col">Others' · own</th><th scope="col" class="num">Median time</th><th scope="col" class="num">Coverage</th><th scope="col" class="num">Later rounds</th><th scope="col">Comments: yours · agents'</th></tr></thead>
      <tbody>${weeks.map((w) => `<tr${w.reviews ? "" : ' class="dim"'}><th scope="row" title="${esc(w.week)}">${esc(shortDate(w.start))}</th>
        <td><span class="mx-count"><span class="mx-bar" aria-hidden="true"><i style="width:${Math.round((w.reviews / max) * 100)}%"></i></span><span class="num">${w.reviews}</span></span></td>
        <td>${w.reviews ? `${w.approve} · ${w.changes} · ${w.comment}` : "–"}</td><td>${w.reviews ? `${w.others} · ${w.own}` : "–"}</td>
        <td class="num">${minutesText(w.activeMinutes)}</td><td class="num">${pctText(w.coverage)}</td>
        <td class="num">${w.reviews ? `${w.laterRounds}${w.newPush ? ` <span class="dim">(${w.newPush} new push${w.newPush === 1 ? "" : "es"})</span>` : ""}` : "–"}</td>
        <td>${w.reviews ? `${w.yours} · ${w.fromFindings}` : "–"}</td></tr>`).join("")}</tbody>
    </table></div>
  </section>`;
}

/* Agent findings */

function pctCell(g, key, n) {
  if (!g.decided) return `<td class="num dim">–</td>`;
  return `<td class="num">${g.tooFew ? `${n}` : `${pctText(g[key])} <span class="dim">(${n})</span>`}</td>`;
}

function findingRowHTML(g, total) {
  const head = total ? `<th scope="row">All</th>`
    : `<th scope="row"><button type="button" class="link mono" data-act="mx-examples" data-key="${esc(g.key)}" title="Show its findings">${esc(g.key)}</button></th>`;
  return `<tr${total ? ' class="mx-total"' : ""}>${head}<td class="num">${g.findings}</td>
    ${pctCell(g, "usefulPct", g.useful)}${pctCell(g, "dismissedPct", g.dismissed)}${pctCell(g, "ignoredPct", g.ignored)}
    <td class="num">${g.undecided || "–"}</td>
    <td>${g.tooFew ? `<span class="pill">Too few to tell</span>` : g.topDismissReason ? `${esc(g.topDismissReason.reason)} <span class="dim">(${g.topDismissReason.count})</span>` : "–"}</td>
    <td class="num">${g.editMedian == null ? "–" : pctText(g.editMedian)}</td></tr>`;
}

function matrixHTML(f) {
  if (!f.severities.length) return "";
  const cell = (sev, conf) => {
    const c = f.matrix.find((x) => x.severity === sev && x.confidence === conf);
    if (!c || !c.findings) return `<td class="num dim">–</td>`;
    if (c.tooFew) return `<td class="num"><span class="dim">${c.useful} of ${c.decided} useful</span></td>`;
    return `<td class="num">${pctText(c.usefulPct)} useful <span class="dim">of ${c.decided}</span></td>`;
  };
  return `${f.matrix.some((c) => c.findings && c.tooFew) ? `<p class="mx-lede">Cells with fewer than 10 decided findings show counts only.</p>` : ""}<div class="table-wrap"><table class="deps-table mx-table">
    <caption>Useful share by severity and confidence</caption>
    <thead><tr><th scope="col">Severity</th>${f.confidences.map((c) => `<th scope="col" class="num">${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${f.severities.map((s) => `<tr><th scope="row">${esc(SEV[s] || s)}</th>${f.confidences.map((c) => cell(s, c)).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

function configChangesHTML(f) {
  if (!f.changes.length) return "";
  const side = (s) => `${s.tooFew ? `<span class="dim">${plural(s.decided, "decided finding")}: too few to tell</span>` : `<b>${pctText(s.usefulPct)}</b> useful <span class="dim">of ${s.decided}</span>`}
    <span class="mx-sub">${s.model ? `<span class="mono">${esc(s.model)}</span> · ` : ""}instructions <span class="mono">${esc(s.instructions || "unknown")}</span> · ${esc(shortDate(s.from))}${s.to.slice(0, 10) !== s.from.slice(0, 10) ? `–${esc(shortDate(s.to))}` : ""}</span>`;
  return `<h3 class="eyebrow mx-h3">When an agent changed</h3><p class="mx-lede">Agents whose instructions or model changed in ${esc(periodWord())}, and how useful their findings were before and after.</p><div class="table-wrap"><table class="deps-table mx-table">
    <caption>The latest setup against the one before it</caption>
    <thead><tr><th scope="col">Agent</th><th scope="col">What changed</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
    <tbody>${f.changes.map((c) => `<tr><th scope="row"><span class="mono">${esc(c.agent)}</span></th><td>${esc(cap(joinNames(c.changed.map((x) => (x === "instructions" ? "instructions" : "model")))))}</td><td>${side(c.before)}</td><td>${side(c.after)}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function descriptionHTML(f) {
  if (!f.description.length) return "";
  return `<h3 class="eyebrow mx-h3">Description checks</h3><div class="table-wrap"><table class="deps-table mx-table">
    <caption>Description gaps you asked the author about, or skipped, by rule</caption>
    <thead><tr><th scope="col">Rule</th><th scope="col" class="num">Asked</th><th scope="col" class="num">Skipped</th><th scope="col">Why skipped</th></tr></thead>
    <tbody>${f.description.map((d) => `<tr><th scope="row">${esc((DESC_RULES[d.rule] && DESC_RULES[d.rule].title) || d.rule)}</th><td class="num">${d.asked}</td><td class="num">${d.skipped}</td>
      <td>${d.reasons.length ? d.reasons.map((x) => `${esc(x.reason)} <span class="dim">(${x.count})</span>`).join(" · ") : "–"}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function findingsSectionHTML(r) {
  const f = r.findings;
  const t = f.total;
  const groupWord = METRIC_GROUPS[r.groupBy];
  if (!t.findings && !f.description.length) return `<section class="mx-sec" aria-labelledby="mx-findings"><h2 class="mx-h" id="mx-findings">Agent findings</h2><p class="dim">No decisions on agent findings in ${periodWord()}.</p></section>`;
  const lede = t.decided
    ? `Of the ${plural(t.decided, "finding")} you decided, ${t.useful} ${t.useful === 1 ? "was" : "were"} useful (added to your review, posted or copied), ${t.dismissed} dismissed, and ${t.ignored} ignored (left open when you posted a review).${t.undecided ? ` ${t.undecided} more ${t.undecided === 1 ? "was" : "were"} decided and then undone.` : ""}${t.tooFew ? " That's too few to tell much yet." : ""}`
    : `No findings decided in ${periodWord()} yet.`;
  const rw = f.rewording;
  return `<section class="mx-sec" aria-labelledby="mx-findings"><h2 class="mx-h" id="mx-findings">Agent findings</h2>
    <p class="mx-lede">${esc(lede)}</p>
    ${t.findings ? `<p class="mx-lede">Shares are of decided findings; rows with fewer than 10 show counts only. Reworded is the median of how much you changed the agent's text before posting it. Pick ${groupWord === "Agent" ? "an agent" : `a ${groupWord.toLowerCase()}`} to see its findings.</p>
    <div class="table-wrap"><table class="deps-table mx-table">
      <caption>Agent findings by ${esc(groupWord.toLowerCase())}, ${esc(periodWord())}</caption>
      <thead><tr><th scope="col">${esc(groupWord)}</th><th scope="col" class="num">Findings</th><th scope="col" class="num">Useful</th><th scope="col" class="num">Dismissed</th><th scope="col" class="num">Ignored</th><th scope="col" class="num">Undone</th><th scope="col">Top dismiss reason</th><th scope="col" class="num" title="Median rewording of posted findings: 0% as the agent wrote it, 100% rewritten">Reworded</th></tr></thead>
      <tbody>${f.groups.map((g) => findingRowHTML(g, false)).join("")}</tbody>
      ${f.groups.length > 1 ? `<tfoot>${findingRowHTML(t, true)}</tfoot>` : ""}
    </table></div>` : ""}
    ${rw.posted ? `<p class="mx-lede">You posted ${plural(rw.posted, "finding")} as review comments. Median rewording: <b>${pctText(rw.median)}</b> (0% is the agent's text as it was, 100% fully rewritten); ${rw.unchanged} went out as written and ${rw.rewritten} mostly rewritten.</p>` : ""}
    ${t.findings ? `<h3 class="eyebrow mx-h3">Severity and confidence</h3>${matrixHTML(f)}` : ""}
    ${configChangesHTML(f)}
    ${descriptionHTML(f)}
  </section>`;
}

function examplesSheetHTML(key) {
  const all = (M.data && M.data.report.findings.examples[key]) || [];
  const counts = { all: all.length };
  for (const x of all) counts[x.outcome] = (counts[x.outcome] || 0) + 1;
  const list = M.exFilter === "all" ? all : all.filter((x) => x.outcome === M.exFilter);
  const tabs = ["all", "useful", "dismissed", "ignored", "undecided"].filter((o) => o === "all" || counts[o]);
  return `${sheetHead("mx-ex", `Findings: ${esc(key)}`)}
  <div class="sheet-body">
    <p class="sheet-lede">${plural(all.length, "finding")} from ${esc(periodWord())}, newest first${all.length >= 100 ? " (the latest 100)" : ""}.</p>
    <div class="seg mx-ex-seg" role="group" aria-label="Show">${tabs.map((o) => `<button type="button" data-act="mx-ex-filter" data-key="${esc(key)}" data-o="${o}" aria-pressed="${M.exFilter === o}">${o === "all" ? "All" : OUTCOME_WORD[o]} <b>${counts[o]}</b></button>`).join("")}</div>
    <ul class="mx-ex">${list.map((x) => `<li><span class="pill ${OUTCOME_PILL[x.outcome]}">${OUTCOME_WORD[x.outcome]}</span>
      <div><b>${esc(x.title || x.id)}</b><span class="dim">${esc(x.pr)} · ${esc(shortDate(x.at))} · ${esc(SEV[x.severity] || x.severity)}, ${esc(x.confidence)}${x.agent !== key ? ` · ${esc(x.agent)}` : ""}</span>
      <span class="dim">${esc(ACTION_WORD[x.action] || x.action)}${x.reason ? `: ${esc(x.reason)}` : ""}</span></div></li>`).join("") || `<li class="dim">None.</li>`}</ul>
  </div>`;
}

/* Agent runs */

function runsSectionHTML(r) {
  const t = r.runs.total;
  const groupWord = METRIC_GROUPS[r.groupBy];
  // Automatic runs that didn't start because the pull request was already approved (diffline.agents.approvedPullRequests).
  const skipped = t.skippedApproved || 0;
  const skippedText = skipped ? ` Skipped (approved): ${plural(skipped, "automatic run")} didn't start because the pull request was already approved.` : "";
  if (!t.runs) return `<section class="mx-sec" aria-labelledby="mx-runs"><h2 class="mx-h" id="mx-runs">Agent runs</h2><p class="dim">No agent runs in ${periodWord()}.${esc(skippedText)}</p></section>`;
  const failures = (g) => (g.failed ? Object.entries(g.failures).map(([k, n]) => `${n} ${FAILURE_WORD[k] || k}`).join(", ") : "–");
  const costCell = (g) => `${money(g.costUsd)}${g.costMissing ? ` <span class="dim">(${g.costMissing} not reported)</span>` : ""}`;
  const perUseful = (g) => (g.costPerUseful != null ? `${money(g.costPerUseful)} <span class="dim">(${g.usefulFindings})</span>` : g.costReported ? `<span class="dim">no useful findings</span>` : "–");
  return `<section class="mx-sec" aria-labelledby="mx-runs"><h2 class="mx-h" id="mx-runs">Agent runs</h2>
    <p class="mx-lede">${esc(`Agents ran ${plural(t.runs, "time")} (${t.auto} automatic, ${t.manual} by hand): ${t.finished} finished, ${t.failed} failed and ${t.cancelled} stopped. A run took ${duration(t.msMedian)} at the median.${skippedText}`)}
      ${t.costUsd != null ? esc(` They cost ${money(t.costUsd)} in all${t.costPerUseful != null ? `, ${money(t.costPerUseful)} per useful finding` : ""}.`) : ""}${t.costMissing ? esc(` ${plural(t.costMissing, "agent run")} didn't report a cost and ${t.costMissing === 1 ? "isn't" : "aren't"} in the totals.`) : ""}
      Cost per useful finding divides the reported cost by the useful findings from those same runs.</p>
    <div class="table-wrap"><table class="deps-table mx-table">
      <caption>Agent runs by ${esc(groupWord.toLowerCase())}, ${esc(periodWord())}</caption>
      <thead><tr><th scope="col">${esc(groupWord)}</th><th scope="col" class="num">Runs</th><th scope="col">Failed</th><th scope="col" class="num">Median time</th><th scope="col" class="num">Tokens in · cached · out</th><th scope="col">Cost</th><th scope="col">Per useful finding</th><th scope="col">Automatic · by hand</th></tr></thead>
      <tbody>${r.runs.groups.map((g) => `<tr><th scope="row"><span class="mono">${esc(g.key)}</span></th><td class="num">${g.runs}</td><td>${esc(failures(g))}</td><td class="num">${duration(g.msMedian)}</td>
        <td class="num">${g.tokens ? `${compact(g.tokens.input)} · ${compact(g.tokens.cachedInput)} · ${compact(g.tokens.output)}${g.tokensReported < g.runs ? ` <span class="dim">(${g.tokensReported} of ${g.runs})</span>` : ""}` : "–"}</td>
        <td>${costCell(g)}</td><td>${perUseful(g)}</td><td>${g.auto} · ${g.manual}</td></tr>`).join("")}</tbody>
    </table></div>
  </section>`;
}

/* ---------- Rendering and refresh ---------- */

function tabHTML() {
  if (S.tab === "workflow") return workflowHTML();
  if (S.tab === "discussion") return discussionHTML();
  if (S.tab === "map") return mapHTML();
  return changesHTML();
}

function render() {
  document.body.classList.toggle("is-pr", S.view === "pr");
  app.innerHTML = S.view === "inbox"
    ? inboxHTML()
    : S.view === "metrics"
    ? metricsHTML()
    : `${ribbonHTML()}${topbarHTML()}<main class="page" id="main">${prHeadHTML()}<div id="tab">${tabHTML()}</div></main>${dockHTML()}${tourHTML()}`;
  mountDiagrams();
  refreshTour();
  onScroll();
  // The report is read fresh each time it's shown.
  if (S.view === "metrics") loadMetrics();
}

function refreshTab() { const el = $("#tab"); if (el) el.innerHTML = tabHTML(); mountDiagrams(); refreshTour(); onScroll(); }
function refreshStream() { const el = $("#stream"); if (el) el.innerHTML = streamHTML(); markTour(); onScroll(); }

function refreshFile(i) {
  const el = document.getElementById(`f-${i}`);
  if (!el) return;
  if (!fileVisible(files[i])) { refreshStream(); return; }
  el.outerHTML = fileHTML(files[i]);
  markTour();
}

function refreshChrome() {
  if (S.view !== "pr") return;
  replaceHTML("#bar", topbarHTML());
  replaceHTML("#pr-head", prHeadHTML());
  replaceHTML("#dock", dockHTML());
  if (S.tab === "changes") {
    replaceHTML("#toolbar", toolbarHTML());
    const rail = $("#rail");
    if (rail) rail.innerHTML = guideHTML();
    $$(".chapter").forEach((el) => {
      const c = chapters[+el.dataset.ch - 1];
      el.classList.toggle("is-done", chapterProgress(c).all);
      replaceHTML(el.querySelector(".ch-prog"), chProgHTML(c));
    });
    replaceHTML("#brief", briefHTML());
    replaceHTML("#stream > .end:last-child", $("#stream .file") ? endHTML() : emptyHTML());
  }
  const sheetGuide = $("#sheet-guide .sheet-body");
  if (sheetGuide) sheetGuide.innerHTML = guideHTML();
  onScroll();
}

function refreshFlow() {
  if (S.view !== "pr") return;
  replaceHTML("#bar", topbarHTML());
  replaceHTML("#pr-head", prHeadHTML());
  if (S.tab === "workflow") replaceHTML("#wf-main", wfMainHTML());
  if (S.tab === "discussion") refreshTab();
  onScroll();
}

/* ---------- Navigation and scrolling ---------- */

const rootPad = () => parseFloat(getComputedStyle(document.documentElement).paddingTop) || 0;
const barHeight = () => ($("#bar")?.offsetHeight || 0) + rootPad();

function stickyOffset(withFile) {
  const tb = $("#toolbar");
  const tool = tb && getComputedStyle(tb).position === "sticky" ? tb.offsetHeight : 0;
  return barHeight() + tool + (withFile ? 52 : 0) + 8;
}

function scrollToEl(el, withFile) {
  if (!el) return;
  scrollToY(() => el.getBoundingClientRect().top + window.scrollY - stickyOffset(withFile));
}

// Scroll so that y() is at the top. On large pull requests, files off screen have estimated heights until they come
// near (.many-files), so a smooth scroll would end in the wrong place: jump, then correct once the files around the
// target have their real size.
function scrollToY(y) {
  if (!document.documentElement.classList.contains("many-files")) {
    window.scrollTo({ top: Math.max(0, y()), behavior: reduced.matches ? "auto" : "smooth" });
    return;
  }
  let tries = 0;
  const settle = () => {
    const top = Math.max(0, y());
    if (Math.abs(top - window.scrollY) <= 2 || tries++ >= 6) return;
    window.scrollTo({ top, behavior: "auto" });
    requestAnimationFrame(() => requestAnimationFrame(settle));
  };
  settle();
}

function pulse(el) {
  if (!el) return;
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
  setTimeout(() => el.classList.remove("pulse"), 1600);
}

function setHash(h) { try { history.replaceState(null, "", "#" + h); } catch { /* sandboxed frames may refuse */ } }

function setView(view) {
  tickActive(); // time on the review counts up to here
  S.view = view;
  S.composer = null;
  closeSheet(true);
  render();
  window.scrollTo(0, 0);
  setHash(view === "pr" ? S.tab : view);
}

function setTab(tab) {
  if (S.view !== "pr") { S.tab = tab; setView("pr"); return; }
  if (S.tab !== tab) {
    S.tab = tab;
    S.composer = null;
    $$(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    refreshTab();
  }
  setHash(tab);
  const tabs = $(".tabs");
  if (tabs) {
    const y = tabs.getBoundingClientRect().top + window.scrollY - barHeight() - 6;
    if (window.scrollY > y) window.scrollTo({ top: y });
  }
}

function setFilter(value) {
  if (S.view !== "pr" || S.tab !== "changes") setTab("changes");
  S.filter = value;
  S.focus = null;
  refreshStream();
  refreshChrome();
  const stream = $("#stream");
  if (stream) {
    const y = stream.getBoundingClientRect().top + window.scrollY - stickyOffset(false);
    if (window.scrollY > y) window.scrollTo({ top: Math.max(0, y) });
  }
}

function ensureFileOpen(fi) {
  const f = files[fi];
  if (!fileVisible(f)) { S.filter = "all"; refreshStream(); refreshChrome(); }
  if (isCollapsed(f)) { S.fileShut.delete(fi); S.fileOpen.add(fi); refreshFile(fi); }
}

function gotoFile(fi) {
  if (S.tab !== "changes") setTab("changes");
  ensureFileOpen(fi);
  const el = document.getElementById(`f-${fi}`);
  scrollToEl(el, false);
  pulse(el && el.querySelector(".fh"));
}

function gotoChapter(n) {
  if (S.tab !== "changes") setTab("changes");
  if (!document.getElementById(`ch-${n}`)) { S.filter = "all"; refreshStream(); refreshChrome(); }
  scrollToEl(document.getElementById(`ch-${n}`), false);
}

const hunkEl = (key) => document.getElementById(`h-${key.replace(":", "-")}`);

function focusHunk(key, scroll) {
  const { f, h } = HUNK.get(key);
  if (!hunkVisible(f, h)) { S.filter = "all"; refreshStream(); refreshChrome(); }
  ensureFileOpen(f.i);
  $$(".hunk.is-focus").forEach((el) => el.classList.remove("is-focus"));
  S.focus = key;
  const el = hunkEl(key);
  if (!el) return;
  el.classList.add("is-focus");
  if (scroll) scrollToEl(el, true);
}

function move(dir) {
  if (S.tab !== "changes") setTab("changes");
  const els = $$("#stream .hunk");
  if (!els.length) return;
  let i = els.findIndex((el) => el.dataset.h === S.focus);
  if (i < 0) {
    const top = stickyOffset(true);
    i = Math.max(0, els.findIndex((el) => el.getBoundingClientRect().bottom > top));
  } else {
    i = Math.min(els.length - 1, Math.max(0, i + dir));
  }
  focusHunk(els[i].dataset.h, true);
}

function moveFile(dir) {
  if (S.tab !== "changes") setTab("changes");
  const els = $$("#stream .file");
  if (!els.length) return;
  const top = stickyOffset(false) + 4;
  const i = Math.max(0, els.findIndex((el) => el.getBoundingClientRect().bottom > top));
  const cur = els[i];
  const target = dir > 0 ? els[i + 1] || cur : cur.getBoundingClientRect().top < top - 2 ? cur : els[i - 1] || cur;
  scrollToEl(target, false);
}

function nextUnreviewed() {
  closeSheet(true);
  if (S.tab !== "changes") setTab("changes");
  const pool = S.filter === "new" ? ORDER.filter((k) => HUNK.get(k).h.fresh) : ORDER;
  let todo = pool.filter((k) => !S.reviewed.has(k));
  if (!todo.length) todo = ORDER.filter((k) => !S.reviewed.has(k));
  if (!todo.length) { toast("Everything is reviewed."); openFinish(); return; }
  let from = S.focus ? ORDER.indexOf(S.focus) : -1;
  if (from < 0) {
    const top = stickyOffset(true);
    const el = $$("#stream .hunk").find((x) => x.getBoundingClientRect().bottom > top);
    from = el ? ORDER.indexOf(el.dataset.h) - 1 : -1;
  }
  focusHunk(todo.find((k) => ORDER.indexOf(k) > from) || todo[0], true);
}

/* ---------- Review marks ---------- */

function setReviewed(keys, on) {
  keys.forEach((k) => { if (on) S.reviewed.add(k); else S.reviewed.delete(k); S.opened.delete(k); });
  const fis = [...new Set(keys.map((k) => +k.split(":")[0]))];
  fis.forEach((i) => { S.fileOpen.delete(i); S.fileShut.delete(i); });
  save();
  if (S.filter === "all" || S.filter === "talk") fis.forEach(refreshFile);
  else refreshStream();
  refreshChrome();
}

function celebrateIfDone() {
  const c = counts();
  if (!c.todo) toast(`All ${c.all} hunks reviewed.`, { act: "finish", label: "Finish review" });
}

function toggleHunk(key) {
  const on = !S.reviewed.has(key);
  setReviewed([key], on);
  if (on) {
    const tick = hunkEl(key)?.querySelector(".tick");
    if (tick) tick.classList.add("just-on");
    celebrateIfDone();
  }
  return on;
}

function toggleFile(fi) {
  const f = files[fi];
  const on = !fileProgress(f).all;
  setReviewed(f.hunks.map((h) => h.key), on);
  const el = document.getElementById(`f-${fi}`);
  if (el && el.getBoundingClientRect().top < stickyOffset(false) - 8) scrollToEl(el, false);
  if (on) {
    const tick = el && el.querySelector(".fh .tick");
    if (tick) tick.classList.add("just-on");
    celebrateIfDone();
  }
}

function markFocused() {
  if (!S.focus) { move(1); return; }
  const key = S.focus;
  if (toggleHunk(key)) {
    const pool = S.filter === "new" ? ORDER.filter((k) => HUNK.get(k).h.fresh) : ORDER;
    const next = pool.slice(pool.indexOf(key) + 1).find((k) => !S.reviewed.has(k));
    if (next) focusHunk(next, true);
    else S.focus = null;
  } else {
    focusHunk(key, false);
  }
}

/* ---------- Following the flow ---------- */

// The tour walks the diff in the order the code runs. Review marks stay where they are: on hunks.
function tourCurrent() {
  if (!S.tour) return null;
  const dg = dgById(S.tour.dg);
  const stops = dg ? tourStops(dg) : [];
  return stops[S.tour.i] ? { dg, stops, ...stops[S.tour.i] } : null;
}
const tourNodeId = () => { const t = tourCurrent(); return t ? t.node.id : null; };

function startTour(dgId, nodeId, part) {
  const dg = dgById(dgId) || DIAGRAMS[0];
  if (!dg) return;
  const stops = tourStops(dg);
  if (!stops.length) { toast("None of the boxes point at code in this diff."); return; }
  let i = 0;
  if (nodeId) {
    const n = dg.byId.get(nodeId);
    const want = n && part != null && n.refs[part] ? n.refs[part].at : null;
    i = Math.max(0, stops.findIndex((s) => s.node.id === nodeId && (!want || s.at === want)));
  } else if (S.tour && S.tour.dg === dg.id) {
    i = S.tour.i;
  }
  S.tour = { dg: dg.id, i };
  closeSheet(true);
  tourGo(i);
}

function tourGo(i) {
  const dg = dgById(S.tour.dg);
  const stops = tourStops(dg);
  S.tour.i = Math.max(0, Math.min(stops.length - 1, i));
  const st = stops[S.tour.i];
  const { f, h } = HUNK.get(st.at.h);
  if (S.tab !== "changes") setTab("changes");
  if (!hunkVisible(f, h)) { S.filter = "all"; refreshStream(); refreshChrome(); }
  if (!hunkOpen(h)) S.opened.add(h.key);
  S.fileShut.delete(f.i);
  if (isCollapsed(f)) S.fileOpen.add(f.i);
  refreshFile(f.i);
  refreshTour();
  const row = tourRows(st)[0];
  if (row) scrollToY(() => row.getBoundingClientRect().top + window.scrollY - stickyOffset(true) - 44);
}

function tourRows(st) {
  const { f, h } = HUNK.get(st.at.h);
  const keys = new Set(h.lines.slice(st.at.from, st.at.to + 1).map(lineKey));
  return $$(`#f-${f.i} .hunk .row, #f-${f.i} .hunk .srow`).filter((el) => keys.has(el.dataset.k));
}

function markTour() {
  $$(".tour-hit").forEach((el) => el.classList.remove("tour-hit", "tour-first", "tour-last"));
  const t = S.view === "pr" && S.tab === "changes" ? tourCurrent() : null;
  if (!t) return;
  const rows = tourRows(t);
  rows.forEach((el) => el.classList.add("tour-hit"));
  if (rows.length) { rows[0].classList.add("tour-first"); rows[rows.length - 1].classList.add("tour-last"); }
}

function tourHTML() {
  const t = S.view === "pr" && S.tab === "changes" ? tourCurrent() : null;
  if (!t) return `<div class="tour" id="tour" hidden></div>`;
  const n = t.node;
  const open = liveFinds(n).filter((x) => findingState(x) === "open");
  const last = S.tour.i === t.stops.length - 1;
  const dots = t.dg.nodes.filter((x) => x.num).map((x) => `<i class="${x === n ? "on" : x.num < n.num ? "past" : ""}"></i>`).join("");
  return `<div class="tour" id="tour" role="region" aria-label="Following the flow">
    <button type="button" class="tour-map" data-act="tour-map" aria-label="Back to the map" title="Back to the map">${icon("flow")}</button>
    <div class="tour-text"><span class="tour-top"><span class="tour-dots" aria-hidden="true">${dots}</span><span>Step ${n.num} of ${t.dg.steps}${t.parts > 1 ? ` · ${t.part} of ${t.parts} places` : ""}</span></span>
      <b>${inline(n.label)}</b></div>
    ${open.length ? `<button type="button" class="sev sev-${open[0].severity} tour-find" data-act="go-finding" data-id="${open[0].id}" title="${esc(plainText(open[0].title))}">${SEV[open[0].severity]}</button>` : ""}
    <button type="button" class="icon-btn sm" data-act="tour-prev" aria-label="Previous step"${S.tour.i === 0 ? " disabled" : ""}>${icon("left")}</button>
    <button type="button" class="btn sm primary tour-next" data-act="tour-next">${last ? "Done" : "Next"}${last ? "" : icon("left", "flip")}</button>
    <button type="button" class="icon-btn sm" data-act="tour-end" aria-label="Stop following the flow">${icon("x")}</button>
  </div>`;
}

function refreshTour() {
  replaceHTML("#tour", tourHTML());
  document.body.classList.toggle("has-tour", !!(S.tour && S.view === "pr" && S.tab === "changes"));
  markTour();
}

function endTour(finished) {
  S.tour = null;
  refreshTour();
  if (!finished) return;
  const c = counts();
  if (c.todo) toast(`That's the whole flow. ${plural(c.todo, "hunk")} still ${c.todo === 1 ? "needs" : "need"} your mark.`, { act: "next-unreviewed", label: "Next unreviewed" });
  else toast("That's the whole flow, and every hunk is reviewed.", { act: "finish", label: "Finish review" });
}

/* ---------- Comments ---------- */

const findThread = (id) => S.threads.find((t) => t.id === id);
const composerFile = (c) => (c.replyTo ? findThread(c.replyTo)?.f ?? c.f : c.f);
const useSheetComposer = () => phone.matches || (coarse.matches && narrow.matches);

function openComposer(fi, k, opts = {}) {
  if (k !== "file" && !opts.replyTo && !LINE_HUNK.has(`${fi}:${k}`)) {
    toast("GitHub only takes comments on lines that are part of the diff.");
    return;
  }
  closeSheet(true);
  if (S.tab !== "changes") setTab("changes");
  const prev = S.composer;
  S.composer = {
    f: fi, k, label: opts.label ?? "", text: opts.text ?? "",
    replyTo: opts.replyTo ?? null, editing: opts.editing ?? null, fromFinding: opts.fromFinding ?? null,
    variant: opts.variant ?? null, texts: opts.texts ?? null, sheet: useSheetComposer(),
  };
  clearSel();
  if (prev && !prev.sheet && composerFile(prev) !== fi) refreshFile(composerFile(prev));
  if (S.composer.sheet) { openSheet("composer", composerSheetHTML()); return; }
  ensureFileOpen(fi);
  const hk = hunkOfAnchor(fi, k);
  if (hk && S.reviewed.has(hk)) S.opened.add(hk);
  refreshFile(fi);
  const ta = $("#composer-text");
  if (!ta) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const r = $("#composer").getBoundingClientRect();
  if (r.bottom > window.innerHeight - 16 || r.top < stickyOffset(true)) scrollToEl($("#composer"), true);
}

function closeComposer() {
  const c = S.composer;
  if (!c) return;
  S.composer = null;
  if (c.sheet) closeSheet();
  else refreshFile(composerFile(c));
}

function submitComposer() {
  const c = S.composer;
  if (!c) return;
  const ta = $("#composer-text");
  const text = (ta ? ta.value : c.text).trim();
  if (!text) { if (ta) ta.focus(); toast("Write something first."); return; }
  if (c.editing) {
    const d = S.drafts.find((x) => x.id === c.editing);
    if (d) { d.body = text; if (!c.replyTo) d.label = c.label; }
  } else if (c.replyTo) {
    S.drafts.push({ id: uid(), replyTo: c.replyTo, body: text });
  } else {
    const id = uid();
    S.drafts.push({ id, f: c.f, k: c.k, lineText: lineText(c.f, c.k), label: c.label, body: text, fromFinding: c.fromFinding || null, verbatim: c.variant === "verbatim" });
    const x = c.fromFinding ? findingById(c.fromFinding) : null;
    if (c.fromFinding) S.findings[c.fromFinding] = { state: "accepted", draft: id, at: nowISO(), run: AGENT_RUN_AT, ...(x ? { title: x.title } : {}) };
    if (x) sendMetrics([{ kind: "finding", action: "added", finding: x.id }]);
  }
  S.composer = null;
  save();
  if (c.sheet) closeSheet();
  refreshFile(composerFile(c));
  refreshChrome();
  toast(c.editing ? "Draft saved." : "Added to your review. It posts when you finish.");
}

function setLabel(value) {
  const c = S.composer;
  if (!c) return;
  const ta = $("#composer-text");
  if (ta) c.text = ta.value;
  c.label = value;
  if (value === "suggestion" && !c.text.trim()) {
    const line = lineText(c.f, c.k);
    if (line != null) c.text = "```suggestion\n" + line + "\n```";
  }
  replaceHTML("#composer", composerHTML());
  const next = $("#composer-text");
  if (next) { next.focus({ preventScroll: true }); next.setSelectionRange(next.value.length, next.value.length); }
}

function resolveThread(id, on) {
  const t = findThread(id);
  if (!t) return;
  // Resolving or reopening a GitHub thread waits for the posted review.
  const want = on ? "resolved" : "open";
  if (want === t.origin) { delete S.threadActions[id]; t.pending = null; }
  else { S.threadActions[id] = on ? "resolve" : "unresolve"; t.pending = on ? "resolve" : "unresolve"; }
  t.state = want;
  t.resolvedBy = on ? "you" : null;
  S.openThreads.delete(id);
  save();
  refreshFile(t.f);
  refreshChrome();
  toast(t.pending ? `This thread ${on ? "resolves" : "reopens"} on GitHub when you post your review.` : "Back to how it is on GitHub.");
}

function editDraft(id) {
  const d = S.drafts.find((x) => x.id === id);
  if (!d) return;
  const t = d.replyTo ? findThread(d.replyTo) : null;
  openComposer(t ? t.f : d.f, t ? t.k : d.k, { label: d.label || "", text: d.body, editing: d.id, replyTo: d.replyTo || null });
}

function deleteDraft(id) {
  const d = S.drafts.find((x) => x.id === id);
  if (!d) return;
  const t = d.replyTo ? findThread(d.replyTo) : null;
  S.drafts = S.drafts.filter((x) => x.id !== id);
  const rec = d.fromFinding ? decisionOf(d.fromFinding) : null;
  if (d.fromFinding && S.findings[d.fromFinding]) delete S.findings[d.fromFinding];
  save();
  if (rec && rec.state === "accepted" && findingById(d.fromFinding)) sendMetrics([{ kind: "finding", action: "undone", finding: d.fromFinding, reason: "added" }]);
  refreshFile(t ? t.f : d.f);
  refreshChrome();
  toast("Draft deleted.");
}

function goAnchor(fi, k, elId, openThread) {
  closeSheet(true);
  if (S.tab !== "changes") setTab("changes");
  if (!["all", "talk", "flag"].includes(S.filter)) { S.filter = "all"; refreshStream(); refreshChrome(); }
  const hk = hunkOfAnchor(fi, k);
  if (hk) S.opened.add(hk);
  if (openThread) S.openThreads.add(openThread);
  S.fileShut.delete(fi);
  S.fileOpen.add(fi);
  refreshFile(fi);
  const el = document.getElementById(elId);
  if (el) { scrollToEl(el, true); pulse(el); }
}

function goDraft(id) {
  const d = S.drafts.find((x) => x.id === id);
  if (!d) return;
  if (d.detached) { ACTIONS["drafts-sheet"](); return; }
  const t = d.replyTo ? findThread(d.replyTo) : null;
  if (t) goAnchor(t.f, t.k, `th-${t.id}`);
  else goAnchor(d.f, d.k, `th-${d.id}`);
}

/* ---------- Agent findings ---------- */

function goFinding(id) {
  const x = findingById(id);
  if (!x) return;
  S.lastFinding = id;
  goAnchor(x.f, x.k, `fd-${x.id}`);
}

function nextFinding() {
  const list = openFindings().length ? openFindings() : FIND;
  if (!list.length) { toast("The agents didn't flag anything."); return; }
  const i = list.findIndex((x) => x.id === S.lastFinding);
  goFinding(list[(i + 1) % list.length].id);
}

// The agent's finding word for word, as markdown that GitHub renders the same way.
function verbatimOf(x) {
  const parts = [`**${x.title}**`, x.body];
  if (x.fix) {
    parts.push(`Suggested fix: ${x.fix.text}`);
    if (x.fix.code) parts.push("```" + (x.fix.lang || "") + "\n" + x.fix.code + "\n```");
  }
  return parts.join("\n\n");
}

function adoptFinding(id) {
  const x = findingById(id);
  if (!x) return;
  const texts = { reworded: x.comment || verbatimOf(x), verbatim: verbatimOf(x) };
  openComposer(x.f, x.k, { label: x.label, text: texts.reworded, fromFinding: x.id, variant: "reworded", texts });
}

function copyToClipboard(text, done) {
  const manual = () => {
    openSheet("copy", `${sheetHead("copy", "Copy the finding")}<div class="sheet-body">
      <p class="sheet-lede">The browser didn't allow copying. The text is selected: press ${isMac ? "⌘" : "Ctrl"}+C.</p>
      <label class="sr-only" for="copy-text">Finding text</label><textarea id="copy-text" rows="12" readonly autofocus>${esc(text)}</textarea></div>`);
    setTimeout(() => { const ta = $("#copy-text"); if (ta) ta.select(); }, 60);
  };
  const legacy = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(done), () => (legacy() ? toast(done) : manual()));
  } else if (legacy()) toast(done);
  else manual();
}

function decideFinding(id, record) {
  const x = findingById(id);
  if (!x) return;
  if (record) S.findings[id] = { ...record, at: record.at || nowISO(), run: AGENT_RUN_AT, title: x.title };
  else delete S.findings[id];
  S.dismissing = null;
  save();
  refreshFile(x.f);
  refreshChrome();
  refreshFlow();
}

function undoFinding(id) {
  const rec = decisionOf(id);
  if (rec && rec.draft) S.drafts = S.drafts.filter((d) => d.id !== rec.draft);
  decideFinding(id, null);
  if (rec) sendMetrics([{ kind: "finding", action: "undone", finding: id, reason: rec.state === "accepted" ? "added" : rec.state }]);
  toast("The finding is open again.");
}

function goLine(fi, k) {
  ensureFileOpen(fi);
  const hk = hunkOfAnchor(fi, k);
  if (hk && !hunkOpen(HUNK.get(hk).h)) { S.opened.add(hk); refreshFile(fi); }
  const row = document.querySelector(`#f-${fi} .row[data-k="${k}"], #f-${fi} .srow[data-k="${k}"]`);
  if (row) { scrollToEl(row, true); pulse(row); }
}

/* ---------- Chapters ---------- */

function setGrouping(mode) {
  S.grouping = mode;
  S.focus = null;
  save();
  rebuildChapters();
  if (S.tab === "changes") refreshStream();
  refreshChrome();
}

function openPlan() {
  closeSheet(true);
  S.planDraft = clonePlan(S.plan);
  openSheet("plan", planSheetHTML(), "side plan-sheet");
}

function refreshPlan() {
  const body = $("#plan-body");
  if (body) {
    const top = body.scrollTop;
    body.innerHTML = planBodyHTML();
    body.scrollTop = top;
  }
  const btn = $("#plan-save");
  if (btn) btn.textContent = planChanged() ? "Save changes" : "Looks right";
}

function movePlanFile(path, to) {
  const plan = S.planDraft;
  const from = plan.findIndex((c) => c.files.includes(path));
  if (from < 0) return;
  plan[from].files = plan[from].files.filter((p) => p !== path);
  let target;
  if (to === "new") {
    target = { title: "New chapter", note: "", source: { kind: "author", text: "Added by you" }, files: [path] };
    plan.push(target);
  } else {
    target = plan[+to];
    target.files.push(path);
  }
  // The agent keeps the files inside a chapter in dependency order.
  target.files = depOrder(target.files.map((p) => byPath.get(p)).filter(Boolean)).map((f) => f.path);
  S.planDraft = plan.filter((c) => c.files.length);
  refreshPlan();
}

function savePlan() {
  const changed = planChanged();
  S.plan = clonePlan(S.planDraft).filter((c) => c.files.length);
  S.planState = planKey(S.plan) === planKey(PR.plan) ? "draft" : "edited";
  S.planDraft = null;
  S.grouping = "chapters";
  save();
  closeSheet();
  rebuildChapters();
  if (S.tab === "changes") refreshStream();
  refreshChrome();
  toast(changed ? "Chapters saved for your review." : "Chapters accepted.");
}

function commentFocused() {
  if (!S.focus) move(1);
  if (!S.focus) return;
  const { f, h } = HUNK.get(S.focus);
  const l = h.lines.find((x) => x[0] !== " ") || h.lines[0];
  openComposer(f.i, lineKey(l));
}

function selectRow(row) {
  const k = row.dataset.k, fi = +row.dataset.f;
  if (!k || Number.isNaN(fi)) return;
  clearSel();
  S.sel = { f: fi, k };
  row.classList.add("sel");
  row.insertAdjacentHTML("beforeend", `<button type="button" class="sel-chip" data-act="comment" data-f="${fi}" data-k="${k}">${icon("message")}Comment</button>`);
}

function clearSel() {
  $$(".row.sel, .srow.sel").forEach((r) => { r.classList.remove("sel"); r.querySelector(".sel-chip")?.remove(); });
  S.sel = null;
}

/* ---------- Finishing a review ---------- */

function openFinish() { closeSheet(true); openSheet("finish", finishSheetHTML()); }

/* ---------- Sheets, toasts and theme ---------- */

function openSheet(id, html, cls = "") {
  const layer = $("#overlay");
  const ret = S.sheet ? S.sheet.ret : document.activeElement;
  layer.innerHTML = `<div class="scrim" data-act="sheet-close"></div><div class="sheet${cls ? " " + cls : ""}" id="sheet-${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-title" tabindex="-1">${html}</div>`;
  layer.classList.add("is-open");
  document.documentElement.classList.add("sheet-open");
  S.sheet = { id, ret };
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("is-shown")));
  const target = layer.querySelector("[autofocus]") || layer.querySelector(".sheet");
  setTimeout(() => { if (target) target.focus({ preventScroll: true }); }, 40);
}

function closeSheet(instant) {
  if (!S.sheet) return;
  const layer = $("#overlay");
  const { id, ret } = S.sheet;
  S.sheet = null;
  if (id === "composer" && S.composer && S.composer.sheet) S.composer = null;
  layer.classList.remove("is-shown");
  document.documentElement.classList.remove("sheet-open");
  const done = () => { if (!S.sheet) { layer.classList.remove("is-open"); layer.innerHTML = ""; } };
  if (instant || reduced.matches) done(); else setTimeout(done, 240);
  if (ret && document.contains(ret) && typeof ret.focus === "function") ret.focus({ preventScroll: true });
}

function trapTab(e) {
  const sheet = $("#overlay .sheet");
  if (!sheet) return;
  const items = $$('button:not([disabled]), [href], input:not([disabled]), textarea, [tabindex="0"]', sheet).filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openPalette() { if (S.view === "pr") openSheet("palette", paletteSheetHTML(), "pal"); }

function paletteMove(dir) {
  if (!S.palList.length) return;
  S.palIdx = (S.palIdx + dir + S.palList.length) % S.palList.length;
  const items = $$("#palette-list .pal-item");
  items.forEach((b, j) => b.setAttribute("aria-selected", String(j === S.palIdx)));
  if (items[S.palIdx]) items[S.palIdx].scrollIntoView({ block: "nearest" });
}

function toast(msg, action) {
  const host = $("#toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-btn" data-act="${action.act}"${action.tab ? ` data-tab="${action.tab}"` : ""}>${esc(action.label)}</button>` : ""}`;
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, action ? 5200 : 2800);
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(themeNow()) + 1) % order.length];
  themeFollowsHost = next === "system";
  if (next !== "system") document.documentElement.dataset.theme = next;
  else applyHostTheme();
  try { localStorage.setItem("diffline:theme", next); } catch { /* optional */ }
  replaceHTML("#bar", topbarHTML());
  onScroll();
  toast(`Theme: ${cap(next)}`);
}

/* ---------- Actions ---------- */

const ACTIONS = {
  inbox: () => setView("inbox"),
  metrics: () => setView("metrics"),
  "mx-period": (el) => {
    M.days = el.dataset.days === "all" ? null : Number(el.dataset.days);
    saveMetricPrefs();
    loadMetrics();
  },
  "mx-group": (el) => {
    M.groupBy = el.dataset.by;
    saveMetricPrefs();
    loadMetrics();
  },
  "mx-examples": (el) => {
    M.exFilter = "all";
    openSheet("mx-ex", examplesSheetHTML(el.dataset.key), "side");
  },
  "mx-ex-filter": (el) => {
    M.exFilter = el.dataset.o;
    const sheet = $("#sheet-mx-ex");
    if (sheet) sheet.innerHTML = examplesSheetHTML(el.dataset.key);
    const btn = sheet && sheet.querySelector(`[data-act="mx-ex-filter"][data-o="${el.dataset.o}"]`);
    if (btn) btn.focus();
  },
  "mx-export": (el) => {
    const format = el.dataset.format;
    HOST.metricsExport({ format, days: M.days }).then(
      (res) => { if (res && res.saved) toast(`Exported ${format === "csv" ? "the finding outcomes" : "the review metrics"} to ${res.saved.split(/[\\/]/).pop()}`); },
      (err) => toast(`Couldn't export: ${err.message || err}`),
    );
  },
  "open-live-pr": (el) => {
    if (el.dataset.key === LIVE_KEY) { S.tab = "changes"; setView("pr"); return; }
    const go = () => HOST.open(el.dataset.key);
    // Save first only when a change is still waiting to be written.
    if (liveSync === "saving") flushLiveState().then(go, go); else go();
  },
  "live-refresh": () => refreshLive(),
  "host-run-agents": () => {
    HOST.runAgents();
    toast("The agents are running. Diffline tells you when they finish.");
  },
  "push-preview": () => previewPush(),
  "push-post": () => { S.pushConfirm = true; refreshPushFoot(); },
  "push-back": () => { S.pushConfirm = false; refreshPushFoot(); },
  "push-now": () => postPush(),
  tab: (el) => {
    closeSheet(true);
    setTab(el.dataset.tab);
    const stage = el.dataset.stage && document.getElementById(`stage-${el.dataset.stage}`);
    if (stage) { scrollToEl(stage, false); pulse(stage.querySelector(".lane-card")); }
  },
  filter: (el) => setFilter(el.dataset.filter),
  fold: () => {
    S.fold = !S.fold;
    save(); refreshStream(); refreshChrome();
    toast(S.fold ? "Lockfiles are summarized and reviewed code is folded." : "Showing every line.");
  },
  split: (el) => { S.split = el.dataset.split === "1"; save(); refreshStream(); refreshChrome(); },
  "banner-close": () => { S.banner = false; save(); $("#welcome")?.remove(); },
  "file-toggle": (el) => {
    const i = +el.dataset.f;
    if (isCollapsed(files[i])) { S.fileShut.delete(i); S.fileOpen.add(i); } else { S.fileOpen.delete(i); S.fileShut.add(i); }
    refreshFile(i);
    const node = document.getElementById(`f-${i}`);
    if (node && node.getBoundingClientRect().top < stickyOffset(false) - 8) scrollToEl(node, false);
  },
  "file-reviewed": (el) => toggleFile(+el.dataset.f),
  "toggle-hunk": (el) => { const key = el.dataset.h; if (!coarse.matches) S.focus = key; toggleHunk(key); },
  "hunk-open": (el) => {
    const key = el.dataset.h;
    if (!S.reviewed.has(key)) return;
    if (S.opened.has(key)) S.opened.delete(key); else S.opened.add(key);
    refreshFile(+key.split(":")[0]);
  },
  expand: (el) => { S.gaps.add(el.dataset.g); refreshFile(+el.dataset.g.split(":")[0]); },
  "long-toggle": (el) => {
    const key = el.dataset.key;
    if (S.longOpen.has(key)) S.longOpen.delete(key); else S.longOpen.add(key);
    refreshFile(+key.split(":")[0]);
  },
  raw: (el) => { const i = +el.dataset.f; S.raw.add(i); refreshFile(i); },
  comment: (el) => openComposer(+el.dataset.f, el.dataset.k),
  label: (el) => setLabel(el.dataset.v),
  "composer-cancel": () => closeComposer(),
  reply: (el) => { const t = findThread(el.dataset.id); if (t) openComposer(t.f, t.k, { replyTo: t.id }); },
  resolve: (el) => resolveThread(el.dataset.id, true),
  unresolve: (el) => resolveThread(el.dataset.id, false),
  "thread-open": (el) => { const t = findThread(el.dataset.id); if (t) { S.openThreads.add(t.id); refreshFile(t.f); } },
  "edit-draft": (el) => editDraft(el.dataset.id),
  "delete-draft": (el) => {
    deleteDraft(el.dataset.id);
    const sheet = S.sheet && S.sheet.id === "drafts" && $("#sheet-drafts");
    if (sheet) sheet.innerHTML = draftsSheetHTML();
  },
  finish: () => openFinish(),
  "sheet-close": () => (S.sheet && S.sheet.id === "composer" ? closeComposer() : closeSheet()),
  "guide-sheet": () => openSheet("guide", `${sheetHead("guide", "Review guide")}<div class="sheet-body">${guideHTML()}</div>`, "side"),
  "drafts-sheet": () => openSheet("drafts", draftsSheetHTML(), "side"),
  "copy-draft": (el) => { const d = S.drafts.find((x) => x.id === el.dataset.id); if (d) copyToClipboard(d.body, "Copied the draft."); },
  shortcuts: () => openSheet("keys", shortcutsSheetHTML()),
  palette: () => openPalette(),
  "goto-file": (el) => { closeSheet(true); gotoFile(+el.dataset.f); },
  "goto-ch": (el) => { closeSheet(true); gotoChapter(+el.dataset.ch); },
  "next-unreviewed": () => nextUnreviewed(),
  "go-thread": (el) => { const t = findThread(el.dataset.id); if (t) goAnchor(t.f, t.k, `th-${t.id}`, t.state === "resolved" ? t.id : null); },
  "go-draft": (el) => goDraft(el.dataset.id),
  "go-finding": (el) => goFinding(el.dataset.id),
  "dg-view": (el) => { S.map.view = el.dataset.v; S.map.sel = null; refreshMap(); },
  "dg-mode": (el) => { S.map.mode = el.dataset.m; refreshMap(); },
  "dg-node": (el) => selectMapNode(el.dataset.node, !!el.closest(".sheet, .map-side")),
  "dg-clear": () => {
    S.map.sel = null;
    if (S.sheet && S.sheet.id === "mapnode") closeSheet();
    selectMapNode(null, true);
  },
  "dg-step": (el) => stepMapNode(+el.dataset.dir),
  "map-node": (el) => showOnMap(el.dataset.dg, el.dataset.node),
  "tour-start": (el) => startTour(el.dataset.dg || S.map.view, el.dataset.node || null, el.dataset.part != null ? +el.dataset.part : null),
  "tour-next": () => {
    const t = tourCurrent();
    if (!t) return;
    if (S.tour.i >= t.stops.length - 1) endTour(true); else tourGo(S.tour.i + 1);
  },
  "tour-prev": () => { if (S.tour) tourGo(S.tour.i - 1); },
  "tour-end": () => endTour(false),
  "tour-map": () => { const t = tourCurrent(); if (t) showOnMap(t.dg.id, t.node.id); else setTab("map"); },
  group: (el) => setGrouping(el.dataset.g),
  "plan-open": () => openPlan(),
  "plan-move": (el) => {
    const i = +el.dataset.i, j = i + +el.dataset.dir;
    const plan = S.planDraft;
    if (!plan || j < 0 || j >= plan.length) return;
    [plan[i], plan[j]] = [plan[j], plan[i]];
    refreshPlan();
  },
  "plan-reset": () => { S.planDraft = clonePlan(PR.plan); refreshPlan(); toast("Back to the agent's draft."); },
  "plan-save": () => savePlan(),
  "go-brief": () => {
    closeSheet(true);
    if (S.tab !== "changes") setTab("changes");
    if (!$("#brief")) { S.filter = "all"; refreshStream(); refreshChrome(); }
    if (!S.brief) { S.brief = true; save(); replaceHTML("#brief", briefHTML()); }
    const brief = $("#brief");
    scrollToEl(brief, false);
    pulse(brief);
  },
  "brief-toggle": () => { S.brief = !S.brief; save(); replaceHTML("#brief", briefHTML()); },
  "checked-toggle": () => { S.checkedOpen = !S.checkedOpen; replaceHTML("#brief", briefHTML()); },
  "finding-why": (el) => {
    const x = findingById(el.dataset.id);
    if (!x) return;
    if (S.evidence.has(x.id)) S.evidence.delete(x.id); else S.evidence.add(x.id);
    refreshFile(x.f);
  },
  followup: (el) => {
    const x = findingById(el.dataset.id);
    if (!x) return;
    const key = `${x.id}:${el.dataset.q}`;
    if (S.answers.has(key)) S.answers.delete(key); else S.answers.add(key);
    refreshFile(x.f);
  },
  "go-line": (el) => goLine(+el.dataset.f, el.dataset.k),
  "finding-adopt": (el) => adoptFinding(el.dataset.id),
  "copy-finding": (el) => {
    const x = findingById(el.dataset.id);
    if (!x) return;
    copyToClipboard(verbatimOf(x), "Copied the finding, word for word.");
    sendMetrics([{ kind: "finding", action: "copied", finding: x.id }]);
  },
  words: (el) => {
    const c = S.composer;
    if (!c || !c.texts) return;
    const ta = $("#composer-text");
    if (ta) c.texts[c.variant || "reworded"] = ta.value;
    c.variant = el.dataset.v;
    c.text = c.texts[c.variant];
    replaceHTML("#composer", composerHTML());
    const next = $("#composer-text");
    if (next) { next.focus({ preventScroll: true }); next.setSelectionRange(next.value.length, next.value.length); }
  },
  risk: () => openSheet("risk", riskSheetHTML(), "side"),
  "desc-sheet": () => { if (DESC_ITEMS.length) openSheet("desc", descSheetHTML(), "side"); },
  "desc-ask": (el) => {
    const it = DESC_ITEMS.find((x) => x.rule === el.dataset.rule);
    if (!it) return;
    askDescription([it]);
    refreshDesc(it.rule);
    toast("Added to your review summary.", { act: "finish", label: "See it" });
  },
  "desc-ask-all": () => {
    const open = descOpen();
    if (!open.length) return;
    askDescription(open);
    refreshDesc();
    toast(`Added ${plural(open.length, "question")} to your review summary.`, { act: "finish", label: "See it" });
  },
  "desc-skip-ask": (el) => { S.descSkipping = el.dataset.rule; refreshDesc(el.dataset.rule); },
  "desc-skip-cancel": () => { const r = S.descSkipping; S.descSkipping = null; refreshDesc(r); },
  "desc-skip": (el) => {
    S.desc[el.dataset.rule] = { state: "skipped", reason: el.dataset.r, at: nowISO() };
    S.descSkipping = null;
    save();
    refreshDesc(el.dataset.rule);
    sendMetrics([{ kind: "description", action: "skipped", rule: el.dataset.rule, reason: el.dataset.r }]);
  },
  "desc-undo": (el) => { undoDescription(el.dataset.rule); refreshDesc(el.dataset.rule); },
  "finding-dismiss-ask": (el) => { const x = findingById(el.dataset.id); if (x) { S.dismissing = x.id; refreshFile(x.f); } },
  "finding-dismiss-cancel": () => { const x = findingById(S.dismissing); S.dismissing = null; if (x) refreshFile(x.f); },
  "finding-dismiss": (el) => {
    decideFinding(el.dataset.id, { state: "dismissed", reason: el.dataset.r });
    if (findingById(el.dataset.id)) sendMetrics([{ kind: "finding", action: "dismissed", finding: el.dataset.id, reason: el.dataset.r }]);
    toast(ownPR() ? `Dismissed as “${el.dataset.r}”.` : `Dismissed as “${el.dataset.r}”. ${PEOPLE[PR.author].short} won't see it.`);
  },
  "finding-undo": (el) => undoFinding(el.dataset.id),
  theme: () => cycleTheme(),
};

/* ---------- Events ---------- */

let lastSwipe = 0;
document.addEventListener("click", (e) => {
  if (Date.now() - lastSwipe < 350) return;
  const el = e.target.closest("[data-act]");
  if (el && !el.disabled) {
    const fn = ACTIONS[el.dataset.act];
    if (fn) { if (el.tagName === "A") e.preventDefault(); fn(el, e); return; }
  }
  if (!el) {
    const row = e.target.closest(".rows .row, .rows .srow");
    const selecting = window.getSelection && String(window.getSelection()).length > 0;
    if (row && coarse.matches && !selecting) { selectRow(row); return; }
    if (S.sel) clearSel();
  }
});

document.addEventListener("keydown", (e) => {
  const t = e.target instanceof Element ? e.target : document.body;
  const typing = t.closest("input, textarea, select, [contenteditable='true']");
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "Enter") {
    if (t.id === "composer-text") { e.preventDefault(); submitComposer(); return; }
    if (S.sheet && S.sheet.id === "finish") { e.preventDefault(); return; }
  }
  if (e.key === "Escape") {
    if (S.sheet) { e.preventDefault(); if (S.sheet.id === "composer") closeComposer(); else closeSheet(); return; }
    if (S.composer) { e.preventDefault(); closeComposer(); return; }
    if (S.sel) { clearSel(); return; }
    if (S.view === "pr" && S.tab === "map" && S.map.sel) { e.preventDefault(); ACTIONS["dg-clear"](); return; }
    if (S.view === "pr" && S.tab === "changes" && S.tour) { e.preventDefault(); endTour(false); }
    return;
  }
  if (e.key === "Tab" && S.sheet) { trapTab(e); return; }
  if (S.sheet && S.sheet.id === "palette" && t.id === "palette-q") {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteMove(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const fi = S.palList[S.palIdx];
      if (fi != null) { closeSheet(true); gotoFile(fi); }
    }
    return;
  }
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (typing || mod || e.altKey || S.sheet || S.view !== "pr") return;
  if (S.tab === "map" && (e.key === "j" || e.key === "k")) { e.preventDefault(); stepMapNode(e.key === "j" ? 1 : -1); return; }
  if (S.tab === "map" && e.key === "Enter" && t === document.body && S.map.sel) {
    const dg = mapDiagram();
    const n = dg && dg.byId.get(S.map.sel);
    if (n && n.num) { e.preventDefault(); startTour(dg.id, n.id); }
    return;
  }
  if (S.tab === "changes" && S.tour && (e.key === "." || e.key === ",")) { e.preventDefault(); ACTIONS[e.key === "." ? "tour-next" : "tour-prev"](); return; }
  const keys = {
    j: () => move(1), k: () => move(-1), n: () => nextUnreviewed(), r: () => markFocused(), v: () => markFocused(), a: () => nextFinding(),
    c: () => commentFocused(), u: () => setFilter(S.filter === "new" ? "all" : "new"),
    "]": () => moveFile(1), "[": () => moveFile(-1),
    s: () => { if (wide.matches) { S.split = !S.split; save(); refreshStream(); refreshChrome(); } },
    f: () => openPalette(), 1: () => setTab("changes"), 2: () => setTab("map"), 3: () => setTab("discussion"), 4: () => setTab("workflow"),
    m: () => setTab(S.tab === "map" ? "changes" : "map"),
    "?": () => ACTIONS.shortcuts(),
  };
  const fn = keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "composer-text" && S.composer) S.composer.text = t.value;
  else if (t.id === "fr-summary") { S.pushSummary = t.value; store.write("pushSummary", S.pushSummary); }
  else if (t.dataset && t.dataset.planTitle != null && S.planDraft) {
    S.planDraft[+t.dataset.planTitle].title = t.value;
    const btn = $("#plan-save");
    if (btn) btn.textContent = planChanged() ? "Save changes" : "Looks right";
  }
  else if (t.id === "palette-q") {
    S.palIdx = 0;
    const list = $("#palette-list");
    if (list) list.innerHTML = paletteItems(t.value);
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.planFile && S.planDraft) movePlanFile(t.dataset.planFile, t.value);
  if (t.name === "decision") S.pushDecision = t.value;
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "composer") submitComposer();
});

// Swipe a hunk to the right to mark it reviewed.
let swipe = null;
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  const rows = e.target.closest(".hunk > .rows");
  if (rows) swipe = { rows, hunk: rows.parentElement, x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId };
}, { passive: true });
document.addEventListener("pointermove", (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.on) {
    if (dx > 14 && Math.abs(dx) > Math.abs(dy) * 1.4) { swipe.on = true; swipe.hunk.classList.add("is-swiping"); clearSel(); }
    else if (Math.abs(dy) > 12 || dx < -14) { swipe = null; return; }
    else return;
  }
  swipe.dx = Math.max(0, Math.min(132, dx));
  swipe.rows.style.transform = `translateX(${swipe.dx}px)`;
  swipe.hunk.classList.toggle("swipe-armed", swipe.dx > 84);
}, { passive: true });
function endSwipe() {
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (!s.on) return;
  lastSwipe = Date.now();
  s.rows.style.transform = "";
  s.hunk.classList.remove("is-swiping", "swipe-armed");
  if (s.dx > 84) toggleHunk(s.hunk.dataset.h);
}
document.addEventListener("pointerup", endSwipe);
document.addEventListener("pointercancel", endSwipe);

let ticking = false;
window.addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; onScroll(); });
}, { passive: true });

function onScroll() {
  if (S.view !== "pr") return;
  const bar = $("#bar"), title = $("#pr-head .pr-title");
  if (bar && title) bar.classList.toggle("is-scrolled", title.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom);
  if (S.tab !== "changes") return;
  const top = stickyOffset(false) + 20;
  let cur = null;
  for (const el of $$("#stream .file")) {
    if (el.getBoundingClientRect().bottom > top) { cur = +el.dataset.f; break; }
  }
  if (cur === S.current) return;
  S.current = cur;
  $$(".g-file.is-current").forEach((a) => a.classList.remove("is-current"));
  if (cur != null) $$(`.g-file[data-f="${cur}"]`).forEach((a) => a.classList.add("is-current"));
}

if (wide.addEventListener) {
  wide.addEventListener("change", () => { if (S.view === "pr" && S.tab === "changes" && S.split) refreshStream(); });
  // Box details sit beside the map on wide screens and open as a sheet on narrow ones.
  narrow.addEventListener("change", () => { if (S.view === "pr" && S.tab === "map") { if (S.sheet && S.sheet.id === "mapnode") closeSheet(true); refreshMap(); } });
}

function routeFromHash() {
  const h = (location.hash || "").slice(1);
  if (h === "inbox" || (!h && LIVE.startView === "inbox")) S.view = "inbox";
  else if (h === "metrics" || (!h && LIVE.startView === "metrics")) S.view = "metrics";
  else if (["changes", "map", "discussion", "workflow"].includes(h)) { S.view = "pr"; S.tab = h; }
}
window.addEventListener("hashchange", () => { tickActive(); routeFromHash(); render(); });
// The VS Code extension's Home: show the list, with a fresh one from the sidebar.
// "host-view": the sidebar's Home, which shows the list. "host-list": the sidebar's grouping or order changed; an open
// list redraws in place, and a review keeps the new list for when the reader goes back to it.
window.addEventListener("diffline-host", (e) => {
  const m = e.detail || {};
  if (m.type !== "host-view" && m.type !== "host-list") return;
  if (Array.isArray(m.list)) LIVE.list = m.list;
  if (Array.isArray(m.groups)) LIVE.groups = m.groups;
  if (m.grouping) LIVE.grouping = m.grouping;
  if (m.type === "host-list") {
    if (S.view === "inbox") {
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    }
    return;
  }
  // "metrics": Diffline: Show Review Metrics, which reads the numbers afresh.
  const view = m.view === "metrics" ? "metrics" : "inbox";
  if (S.view === view) render(); else setView(view);
  window.scrollTo(0, 0);
});

/* ---------- Start ---------- */

try {
  const theme = localStorage.getItem("diffline:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else themeFollowsHost = true;
} catch { /* optional */ }
applyHostTheme();
// In VS Code the page uses the editor's fonts (and doesn't load its web font).
document.documentElement.classList.add("in-vscode");
new MutationObserver(applyHostTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
routeFromHash();
render();
watchActivity();
})();
