// The review panel: one webview that hosts the Diffline page (packages/review-ui, copied to media/ui) for one pull request
// at a time. The page's server calls arrive as messages and go to the service.

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { parseKey, type DifflineService } from "../core/service.ts";
import type { PrKey } from "../core/types.ts";
import { prKeyString } from "../core/types.ts";
import { buildPage, hostShim } from "./page.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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
  private readonly extensionUri: vscode.Uri;
  private readonly service: DifflineService;
  private readonly log: (line: string) => void;

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

  /** Show a pull request. The panel shows a loading page at once and the review when its data is ready. */
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
    try {
      // Open at once from what's already known, then check GitHub and update the page only if something changed.
      const cached = this.service.hasCachedDetail(key);
      if (!cached) panel.webview.html = this.message(`Loading ${prKeyString(key)}…`, true);
      const first = await this.service.loadReview(key, { cached, home, ...(view ? { view } : {}) });
      if (stale()) return;
      if (!home) panel.title = `#${key.number} ${first.live.pr.title}`;
      const html = await this.page(key, first.data, first.live);
      if (stale()) return;
      panel.webview.html = html;
      this.shownSeq = seq;
      this.log(`Opened ${prKeyString(key)} in ${Date.now() - started} ms${cached ? " (from cache)" : ""}`);
      if (!cached) return;
      const fresh = await this.service.loadReview(key, { home, ...(view ? { view } : {}) });
      if (stale()) return;
      const sig = (l: typeof first.live) => JSON.stringify([l.pr, l.threads, l.agent?.ranAt]);
      if (fresh.data.head.sha !== first.data.head.sha || sig(fresh.live) !== sig(first.live)) {
        const html = await this.page(key, fresh.data, fresh.live);
        if (stale()) return;
        panel.webview.html = html;
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

  /** Reload the current pull request, keeping the panel. */
  async reload(): Promise<void> {
    if (this.current) await this.show(this.current, { home: this.home, ...(this.view ? { view: this.view } : {}) });
  }

  /** A message from the page. Each names the pull request its page shows, which may not be the one loading now. */
  private async onMessage(m: any): Promise<void> {
    const key = m && typeof m === "object" && typeof m.key === "string" ? parseKey(m.key) : null;
    if (!key) return;
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

  private async page(key: PrKey, data: unknown, live: unknown): Promise<string> {
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
    return buildPage(this.template, { csp, nonce, stylesUrl: styles, appUrl: app, shim: hostShim(prKeyString(key)), data, live });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
