// The review panel: one webview that hosts the Diffline page (packages/review-ui, copied to media/ui) for one pull request
// at a time. The page's server calls arrive as messages and go to the service.

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { prChange, type PrSnapshot } from "@diffline/core/review-status";
import { parseKey, type DifflineService } from "../core/service.ts";
import type { PrKey, ReviewData } from "../core/types.ts";
import { prKeyString } from "../core/types.ts";
import { buildPage, hostShim, pendingReviewData } from "./page.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface AgentReviewExport {
  chars: number;
  findings: number;
  total: number;
  copied: boolean;
  /** The file it was saved to; null when the save dialog was cancelled or it was copied. */
  saved: string | null;
}

/**
 * A pull request's agent review as Markdown for another agent: copied to the clipboard (all findings, or the open ones
 * only), or saved where the reader picks. From the review page's menu and the Copy Agent Review command.
 */
export async function exportAgentReview(
  service: Pick<DifflineService, "agentReviewMarkdown">,
  key: PrKey,
  mode: "copy" | "open" | "save",
  log: (line: string) => void,
): Promise<AgentReviewExport> {
  const out = await service.agentReviewMarkdown(key, { openOnly: mode === "open" });
  const base = { chars: out.markdown.length, findings: out.findings, total: out.total };
  if (mode === "save") {
    const uri = await vscode.window.showSaveDialog({
      title: `Save ${prKeyString(key)}'s agent review as Markdown`,
      defaultUri: vscode.Uri.file(path.join(os.homedir(), out.name)),
      filters: { Markdown: ["md"] },
      saveLabel: "Save",
    });
    if (!uri) return { ...base, copied: false, saved: null };
    await writeFile(uri.fsPath, out.markdown, { encoding: "utf8", mode: 0o600 });
    log(`Saved ${prKeyString(key)}'s agent review to ${uri.fsPath}`);
    return { ...base, copied: false, saved: uri.fsPath };
  }
  await vscode.env.clipboard.writeText(out.markdown);
  log(`Copied ${prKeyString(key)}'s agent review: ${out.findings} of ${out.total} findings, ${out.markdown.length} characters`);
  return { ...base, copied: true, saved: null };
}

/** What a page measured itself when it drew (performance.now() in the webview, rounded ms). */
export interface PageMarks {
  /** When the page's script started, from when the page began loading: parsing the HTML and its inline data. For the changes stage, when it started drawing them. */
  start: number;
  /** How long building the page's model, drawing it and laying it out took from there. */
  render: number;
}

/**
 * One open of a review, for the log line and the measuring script (scripts/open-timing.sh). Times are ms from the open;
 * `waited` is how long the panel waited after the detail for a diff that was nearly ready (up to DIFF_GRACE_MS), which
 * the page's total includes and its parts don't.
 * In one stage (the diff was ready with GitHub's detail): `data` (detail and diff ready), `page` (HTML built), `shown`
 * (the page said it drew). In two stages (`staged`): `detail`, `page` and `shown` for the page without the diff, then
 * `diff` (built), `sent` (sent to the page, once it had drawn and the diff was ready) and `changes` (the page said it
 * drew them), or `failed` when the diff didn't load.
 */
export interface OpenTiming {
  key: string;
  load: number;
  cached: boolean;
  staged: boolean;
  data?: number;
  detail?: number;
  waited?: number;
  page?: number;
  shown?: number;
  diff?: number;
  sent?: number;
  changes?: number;
  failed?: boolean;
  pageMarks?: PageMarks;
  changesMarks?: PageMarks;
  line?: string;
}

/**
 * The log line for an open (OpenTiming), "?" for a time not known (a page that didn't say it drew). One stage:
 *   Opened acme/web#123 in 1210 ms (data 1150 ms, page 20 ms, rendered 40 ms)
 * Two stages, each part with its total from the open:
 *   Opened acme/web#123 in 4210 ms: the page in 980 ms (detail 870 ms, page 20 ms, rendered 90 ms), the changes in 4210 ms (diff 1900 ms, rendered 2300 ms)
 * " (from cache)" ends the line when it opened from a detail fetched earlier.
 */
export function openedLine(t: OpenTiming): string {
  const ms = (n: number | undefined) => (n === undefined ? "?" : `${Math.round(n)}`);
  const span = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : b - a);
  const cache = t.cached ? " (from cache)" : "";
  if (!t.staged) {
    return `Opened ${t.key} in ${ms(t.shown)} ms (data ${ms(t.data)} ms, page ${ms(span(t.data, t.page))} ms, rendered ${ms(span(t.page, t.shown))} ms)${cache}`;
  }
  const page = `the page in ${ms(t.shown)} ms (detail ${ms(t.detail)} ms, page ${ms(span((t.detail ?? 0) + (t.waited ?? 0), t.page))} ms, rendered ${ms(span(t.page, t.shown))} ms)`;
  if (t.failed) return `Opened ${t.key}: ${page}; the changes didn't load${cache}`;
  return `Opened ${t.key} in ${ms(t.changes)} ms: ${page}, the changes in ${ms(t.changes)} ms (diff ${ms(t.diff)} ms, rendered ${ms(span(t.sent, t.changes))} ms)${cache}`;
}

/** A diff ready this soon after GitHub's detail goes in the page at once, rather than a page without it for a moment. */
export const DIFF_GRACE_MS = 150;
/**
 * Pull requests with at least this many changed lines (GitHub's additions plus deletions) always open in two parts, even
 * with the diff ready: drawing a large diff takes seconds, and the rest of the page needn't wait for it.
 */
export const STAGE_LINES = 2000;

/** How long to wait for a page to say it drew before logging the open without it (a hidden panel may not draw). */
const RENDER_WAIT_MS = 60_000;

export class ReviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private current: PrKey | null = null;
  /** The page was opened on its list (Home) and no pull request has been chosen since. */
  private home = false;
  /** The page was opened on the review metrics report, so a reload opens it there again. */
  private view: "metrics" | undefined;
  private loadSeq = 0;
  /** The load whose review page is on screen; differs from loadSeq while a load runs, or when a message is shown. */
  private shownSeq = -1;
  private template: string | null = null;
  /** The pull request as the page on screen shows it, and the last change the page was told about. */
  private shownPr: PrSnapshot | null = null;
  private noticed: string | null = null;
  private readonly extensionUri: vscode.Uri;
  private readonly service: DifflineService;
  private readonly log: (line: string) => void;
  /** Pages that haven't said they drew yet, by "<load>:<stage>". */
  private readonly drawing = new Map<string, (marks: PageMarks | null) => void>();
  /** The last opens, newest last, for the measuring script. */
  readonly timings: OpenTiming[] = [];

  constructor(extensionUri: vscode.Uri, service: DifflineService, log: (line: string) => void) {
    this.extensionUri = extensionUri;
    this.service = service;
    this.log = log;
  }

  /** The page currently shown, for the smoke test. */
  get html(): string {
    return this.panel?.webview.html ?? "";
  }

  get key(): PrKey | null {
    return this.panel ? this.current : null;
  }

  private ui(...parts: string[]) {
    return vscode.Uri.joinPath(this.extensionUri, "media", "ui", ...parts);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = vscode.window.createWebviewPanel("diffline.review", "Diffline", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.ui()],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "diffline.svg");
    panel.onDidDispose(() => {
      this.panel = null;
      this.current = null;
      this.shownSeq = -1;
      this.shownPr = null;
    });
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel = panel;
    return panel;
  }

  /**
   * The sidebar's Home: the page's list of pull requests. A review page on screen switches to its list at once, with a
   * fresh list; otherwise (no panel, a review still loading, or a load that failed) the page loads with the first pull
   * request behind it and starts on the list.
   */
  /** Send an open page the list as the sidebar now groups and orders it. The page redraws only if it's showing the list. */
  async refreshList(): Promise<void> {
    if (!this.panel || !this.current || this.shownSeq !== this.loadSeq) return;
    const key = this.current;
    const groups = await this.service.pageGroups();
    const list = await this.service.listItems(key, undefined, groups);
    if (this.current !== key) return;
    void this.panel?.webview.postMessage({ type: "host-list", groups, list, grouping: this.service.grouping() });
  }

  async showHome(): Promise<void> {
    if (this.panel && this.current && this.shownSeq === this.loadSeq) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
      const groups = await this.service.pageGroups();
      const list = await this.service.listItems(this.current, undefined, groups);
      this.view = undefined;
      void this.panel?.webview.postMessage({ type: "host-view", view: "inbox", groups, list, grouping: this.service.grouping() });
      return;
    }
    const groups = await this.service.pageGroups();
    const first = groups.flatMap((g) => g.keys)[0];
    const key = first ? parseKey(first) : null;
    if (!key) {
      const panel = this.ensurePanel();
      this.loadSeq++; // a review still loading doesn't replace this
      this.current = null;
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
      panel.title = "Diffline";
      panel.webview.html = this.message("No pull requests to show yet. Diffline is checking GitHub; try again in a moment.", false);
      return;
    }
    await this.show(key, { home: true });
  }

  /**
   * The review metrics report (Diffline: Show Review Metrics). A page on screen switches to it at once; otherwise the
   * page loads with the first pull request behind it, as Home does, and starts on the report. The page asks for the
   * numbers itself (metricsReport), so they're read fresh each time it shows them.
   */
  async showMetrics(): Promise<void> {
    if (this.panel && this.current && this.shownSeq === this.loadSeq) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
      this.view = "metrics";
      void this.panel.webview.postMessage({ type: "host-view", view: "metrics" });
      return;
    }
    const groups = await this.service.pageGroups();
    const first = groups.flatMap((g) => g.keys)[0];
    const key = first ? parseKey(first) : null;
    if (!key) {
      const panel = this.ensurePanel();
      this.loadSeq++;
      this.current = null;
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
      panel.title = "Diffline";
      panel.webview.html = this.message("The review metrics open in the Diffline page, which shows once Diffline has a pull request to list. Diffline is checking GitHub; try again in a moment.", false);
      return;
    }
    await this.show(key, { home: true, view: "metrics" });
  }

  /**
   * Show a pull request. The panel shows a loading page at once, the review as soon as GitHub's detail is in, and the
   * diff when it's built: a diff ready with the detail (or within DIFF_GRACE_MS) goes in the page at once, unless the
   * pull request is large (STAGE_LINES); otherwise the page opens without it ("Loading the changes…") and gets it in a
   * "host-data" message once it has drawn, without a reload. The head commit is fetched while GitHub is asked
   * (DifflineService.loadStaged).
   */
  async show(key: PrKey, opts: { home?: boolean; view?: "metrics" } = {}): Promise<void> {
    const panel = this.ensurePanel();
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
    const seq = ++this.loadSeq;
    // Another show started, or the panel was closed (and maybe opened again) while this one waited.
    const stale = () => seq !== this.loadSeq || this.panel !== panel;
    this.current = key;
    this.home = !!opts.home;
    this.view = opts.view;
    const home = this.home;
    const view = this.view;
    const title = this.service.get(key)?.summary?.title;
    panel.title = view === "metrics" ? "Diffline: review metrics" : home ? "Diffline: pull requests" : `#${key.number}${title ? ` ${title}` : ""}`;
    const started = Date.now();
    const since = () => Date.now() - started;
    try {
      // Open at once from what's already known, then check GitHub and update the page only if something changed.
      const cached = this.service.hasCachedDetail(key);
      const timing: OpenTiming = { key: prKeyString(key), load: seq, cached, staged: false };
      if (!cached) panel.webview.html = this.message(`Loading ${prKeyString(key)}…`, true);
      const loading = this.service.loadStaged(key, { cached, home, ...(view ? { view } : {}) });
      let diff: ReviewData | null = null;
      loading.data.then(
        (d) => {
          diff = d;
          timing.diff = since();
        },
        () => undefined,
      );
      const first = await loading.first;
      timing.detail = since();
      if (stale()) return;
      const pr = first.detail.pr;
      const large = (pr.additions ?? 0) + (pr.deletions ?? 0) >= STAGE_LINES;
      if (!diff && !large) await Promise.race([loading.data.catch(() => null), new Promise((r) => setTimeout(r, DIFF_GRACE_MS))]);
      timing.waited = since() - timing.detail;
      if (stale()) return;
      if (!home) panel.title = `#${key.number} ${first.live.pr.title}`;
      const ready: ReviewData | null = large ? null : diff;
      timing.staged = !ready;
      if (ready) timing.data = since();
      const html = await this.page(key, ready ?? pendingReviewData(`${key.owner}/${key.name}`, pr), first.live, seq);
      timing.page = since();
      if (stale()) return;
      const drawn = this.drawn(seq, "page").then((marks) => {
        if (marks) {
          timing.shown = since();
          timing.pageMarks = marks;
        }
      });
      panel.webview.html = html;
      this.shownSeq = seq;
      this.shown(first.live.pr);
      let shownData: ReviewData;
      if (!ready) {
        let data: ReviewData;
        try {
          data = await loading.data;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`Couldn't load the changes of ${prKeyString(key)}: ${message}`);
          timing.failed = true;
          await drawn;
          if (!stale()) void panel.webview.postMessage({ type: "host-data", error: message });
          this.timed(timing);
          return;
        }
        // The page listens once it has drawn; with the list as it is now that the diff is built.
        await drawn;
        if (stale()) return;
        const groups = await this.service.pageGroups();
        const list = await this.service.listItems(key, first.detail, groups);
        if (stale()) return;
        const changes = this.drawn(seq, "changes");
        timing.sent = since();
        void panel.webview.postMessage({ type: "host-data", data, list, groups });
        void changes.then((marks) => {
          if (marks) {
            timing.changes = since();
            timing.changesMarks = marks;
          }
          this.timed(timing);
        });
        shownData = data;
      } else {
        void drawn.then(() => this.timed(timing));
        shownData = ready;
      }
      if (!cached) return;
      const fresh = await this.service.loadReview(key, { home, ...(view ? { view } : {}) });
      if (stale()) return;
      const sig = (l: typeof first.live) => JSON.stringify([l.pr, l.threads, l.agent?.ranAt]);
      if (fresh.data.head.sha !== shownData.head.sha || sig(fresh.live) !== sig(first.live)) {
        const html = await this.page(key, fresh.data, fresh.live, seq);
        if (stale()) return;
        panel.webview.html = html;
        this.shown(fresh.live.pr);
        this.log(`Updated ${prKeyString(key)} with the latest from GitHub`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Couldn't open ${prKeyString(key)}: ${message}`);
      // After a cached page opened, a failed check with GitHub leaves that page up.
      if (stale() || this.shownSeq === seq) return;
      panel.webview.html = this.message(`This pull request didn't load. ${message}`, false);
    }
  }

  /** Resolves when the page of this load says it drew this stage, or with null when it doesn't in time (or is replaced). */
  private drawn(load: number, stage: "page" | "changes"): Promise<PageMarks | null> {
    const id = `${load}:${stage}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), RENDER_WAIT_MS);
      timer.unref?.();
      const done = (marks: PageMarks | null) => {
        clearTimeout(timer);
        if (this.drawing.get(id) === done) this.drawing.delete(id);
        resolve(marks);
      };
      this.drawing.set(id, done);
    });
  }

  /** An open finished: log its line and keep it for the measuring script. */
  private timed(t: OpenTiming): void {
    t.line = openedLine(t);
    this.log(t.line);
    this.timings.push(t);
    if (this.timings.length > 20) this.timings.shift();
  }

  /** A new page is on screen: remember what it shows, so later changes on GitHub can be told apart. */
  private shown(pr: PrSnapshot | null | undefined): void {
    this.shownPr = pr ? { state: pr.state ?? null, headRefOid: pr.headRefOid ?? null, updatedAt: pr.updatedAt ?? null } : null;
    this.noticed = null;
  }

  /**
   * The list's refresh saw a pull request change on GitHub (the service's "pullRequestChanged"). When it's the one on
   * screen and it changed since the page was built, tell the page ("host-pr-changed") so it can offer a refresh; the
   * page isn't reloaded, so the reader keeps their place. Each change is told once. Returns whether a message went.
   */
  noticeChange(key?: PrKey): boolean {
    if (!this.panel || !this.current || this.shownSeq !== this.loadSeq || !this.shownPr) return false;
    if (key && prKeyString(key).toLowerCase() !== prKeyString(this.current).toLowerCase()) return false;
    const change = prChange(this.shownPr, this.service.get(this.current)?.summary);
    if (!change) return false;
    const id = `${change.state}|${change.head}|${change.updatedAt}`;
    if (id === this.noticed) return false;
    this.noticed = id;
    void this.panel.webview.postMessage({ type: "host-pr-changed", key: prKeyString(this.current), change });
    return true;
  }

  /** Reload the current pull request, keeping the panel. */
  async reload(): Promise<void> {
    if (this.current) await this.show(this.current, { home: this.home, ...(this.view ? { view: this.view } : {}) });
  }

  /** A message from the page. Each names the pull request its page shows, which may not be the one loading now. */
  private async onMessage(m: any): Promise<void> {
    const key = m && typeof m === "object" && typeof m.key === "string" ? parseKey(m.key) : null;
    if (!key) return;
    if (m.type === "rendered") {
      if (m.stage === "error") return void this.log(`The page for ${prKeyString(key)} hit an error: ${String(m.error || "unknown")}`);
      const ms = m.ms && typeof m.ms === "object" ? m.ms : {};
      const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0);
      this.drawing.get(`${Number(m.load)}:${m.stage === "changes" ? "changes" : "page"}`)?.({ start: n(ms.start), render: n(ms.render) });
      return;
    }
    if (m.type === "api") {
      try {
        const data = await this.service.api(key, String(m.method), String(m.path), m.body);
        void this.panel?.webview.postMessage({ type: "api-result", id: m.id, ok: true, data });
      } catch (err) {
        void this.panel?.webview.postMessage({ type: "api-result", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (m.type === "metricsReport" || m.type === "metricsExport") {
      const answer = (ok: boolean, data: unknown) => void this.panel?.webview.postMessage({ type: "api-result", id: m.id, ok, ...(ok ? { data } : { error: data }) });
      try {
        answer(true, m.type === "metricsReport" ? await this.service.metricsReport({ days: m.days, groupBy: m.groupBy }) : await this.exportMetrics(m.format, m.days));
      } catch (err) {
        answer(false, err instanceof Error ? err.message : String(err));
      }
    } else if (m.type === "agentMarkdown") {
      const mode = m.mode === "open" || m.mode === "save" ? m.mode : "copy";
      try {
        const data = await exportAgentReview(this.service, key, mode, this.log);
        void this.panel?.webview.postMessage({ type: "api-result", id: m.id, ok: true, data });
      } catch (err) {
        void this.panel?.webview.postMessage({ type: "api-result", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (m.type === "metrics") {
      // Taken in the order the page sent them; the log keeps that order.
      void this.service.metrics(key, m).catch((err) => this.log(`Couldn't write to the review metrics: ${err instanceof Error ? err.message : err}`));
    } else if (m.type === "runAgents") {
      // Through the command, so a run on an unchanged pull request asks first, as it does from the sidebar.
      void vscode.commands.executeCommand("diffline.runAgents", prKeyString(key));
    } else if (m.type === "reload") {
      // A page that's being replaced doesn't get to reload itself over the newer one.
      if (this.current && prKeyString(this.current) === prKeyString(key)) await this.reload();
    } else if (m.type === "open" && typeof m.target === "string") {
      const target = parseKey(m.target);
      if (target) await this.show(target);
    }
  }

  /** Write a review metrics export where the reader picks. Resolves with the file, or null when they cancelled. */
  private async exportMetrics(format: unknown, days: unknown): Promise<{ saved: string | null; events: number }> {
    const out = await this.service.metricsExport(format, days);
    const csv = out.name.endsWith(".csv");
    const uri = await vscode.window.showSaveDialog({
      title: csv ? "Export finding outcomes" : "Export review metrics",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), out.name)),
      filters: csv ? { CSV: ["csv"] } : { JSON: ["json"] },
      saveLabel: "Export",
    });
    if (!uri) return { saved: null, events: out.events };
    await writeFile(uri.fsPath, out.text, { encoding: "utf8", mode: 0o600 });
    this.log(`Exported the review metrics to ${uri.fsPath}`);
    return { saved: uri.fsPath, events: out.events };
  }

  private message(text: string, loading: boolean): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:grid;place-items:center;height:100vh;margin:0}
p{max-width:36rem;text-align:center;line-height:1.5;opacity:.85}.spin{width:18px;height:18px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;margin:0 auto 12px;animation:r .8s linear infinite;opacity:.6}
@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div>${loading ? '<div class="spin"></div>' : ""}<p>${escapeHtml(text)}</p></div></body></html>`;
  }

  private async page(key: PrKey, data: unknown, live: unknown, load = 0): Promise<string> {
    const webview = this.panel!.webview;
    if (!this.template) this.template = await readFile(this.ui("index.html").fsPath, "utf8");
    const nonce = randomBytes(16).toString("base64");
    // Only the extension's own files: no remote images or fonts, so opening a review makes no requests outside VS Code.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const styles = webview.asWebviewUri(this.ui("styles.css")).toString();
    const app = webview.asWebviewUri(this.ui("app.js")).toString();
    return buildPage(this.template, { csp, nonce, stylesUrl: styles, appUrl: app, shim: hostShim(prKeyString(key), load), data, live });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
