// The sidebar: pull requests grouped by why they're listed, each with its risk score and agent status.

import * as vscode from "vscode";

import { formatTokens } from "../agents/harness.ts";
import { reviewFreshness } from "@diffline/core/freshness";
import { WHY } from "@diffline/core/grouping";
import { RISK_WORD } from "@diffline/core/risk";
import { agentLines, agentStatus, approvalsLine, rowDescription, stateLine, yourReviewLines } from "@diffline/core/row-text";
import type { DifflineService, PrRecord } from "../core/service.ts";
import type { Risk } from "../core/types.ts";
import { prKeyString } from "../core/types.ts";

type Group = { kind: "group"; id: string; label: string; rows: Row[]; description?: string; collapsed?: boolean };
type Row = { kind: "pr"; record: PrRecord; risk: Risk | null; tag?: string; inRepoGroup?: boolean };
export type Node = Group | Row;

const RISK_COLOR = { high: "charts.red", medium: "charts.yellow", low: "charts.green" } as const;

export class PullRequestTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly service: DifflineService;
  private timer: NodeJS.Timeout | null = null;

  private readonly onChange = () => this.refresh();

  constructor(service: DifflineService) {
    this.service = service;
    service.on("change", this.onChange);
  }

  dispose(): void {
    this.service.off("change", this.onChange);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emitter.dispose();
  }

  /** Coalesce bursts of changes (agent progress) into one repaint. */
  refresh(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emitter.fire(undefined);
    }, 150);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return node.kind === "group" ? node.rows : [];
    const groups = await this.service.groups();
    return groups.map((g): Group => ({ kind: "group", ...g, rows: g.rows.map((r) => ({ kind: "pr" as const, ...r })) }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.label, node.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.description;
      if (node.id === "others") item.tooltip = "Open, ready pull requests in your repositories that aren't yours, weren't requested from you or your teams, and aren't approved yet.";
      if (node.id === "closed") item.tooltip = "Pull requests you reviewed or wrote that were merged or closed recently (diffline.watch.recentlyClosedDays), and ones you opened here that aren't open any more.";
      item.contextValue = "group";
      item.id = `group:${node.id}`;
      return item;
    }
    const r = node.record;
    const s = r.summary;
    const key = prKeyString(r.key);
    const item = new vscode.TreeItem(`#${r.key.number} ${s?.title ?? key}`, vscode.TreeItemCollapsibleState.None);
    item.id = `pr:${key}`;
    const status = agentStatus(r);
    item.description = rowDescription(r, node);
    const running = r.run.state === "running" || r.run.state === "queued" || r.run.state === "elsewhere";
    // The shape says whether the agents reviewed it (a check; an outline check when commits landed since, an empty
    // circle when they haven't), and the color is the risk.
    const fresh = reviewFreshness(r.agent, s);
    const shape = fresh.state === "current" ? "pass-filled" : fresh.state === "behind" ? "pass" : "circle-large-outline";
    item.iconPath = running
      ? new vscode.ThemeIcon("sync~spin")
      : r.run.state === "failed"
        ? new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"))
        : new vscode.ThemeIcon(shape, new vscode.ThemeColor(node.risk ? RISK_COLOR[node.risk.level] : "disabledForeground"));
    // Runs in another window are stopped there, so their rows get neither Run nor Stop.
    const context = r.run.state === "elsewhere" ? "elsewhere" : running || r.run.state === "waiting" ? "running" : "idle";
    // ".agent": it has an agent review to copy.
    item.contextValue = `pr.${context}${r.agent ? ".agent" : ""}${r.pinned ? ".pinned" : ""}`;
    item.command = { command: "diffline.open", title: "Open Review", arguments: [key] };
    item.tooltip = this.tooltip(node, status.text);
    return item;
  }

  private tooltip(node: Row, status: string): vscode.MarkdownString {
    const r = node.record;
    const s = r.summary;
    // Text from GitHub (titles, names, paths) and error messages goes in with appendText, which escapes it, so a pull
    // request title can't add links or load images in the hover.
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**");
    md.appendText(s?.title || prKeyString(r.key));
    md.appendMarkdown("**  \n");
    md.appendText(`${prKeyString(r.key)}${s?.author?.login ? ` by ${s.author.login}` : ""}`);
    md.appendMarkdown("  \n");
    const why = (s?.reasons || []).map((x) => WHY[x]).filter(Boolean);
    if (why.length) md.appendMarkdown(`Listed because ${why.join(", ")}.  \n`);
    if (s) md.appendMarkdown(`+${s.additions} −${s.deletions} in ${s.changedFiles} files${s.checks.failed ? ` · ${s.checks.failed} checks failing` : s.checks.running ? ` · ${s.checks.running} checks running` : ""}  \n`);
    // The pull request's state, approvals and your review: branch names and dates from GitHub, so as text.
    if (s) {
      md.appendMarkdown("\n");
      for (const line of [stateLine(s), approvalsLine(s), ...yourReviewLines(s)]) {
        md.appendText(line);
        md.appendMarkdown("  \n");
      }
    }
    if (node.risk) {
      md.appendMarkdown(`\n**${RISK_WORD[node.risk.level]} risk, ${node.risk.score}/100**  \n`);
      for (const f of node.risk.factors.slice(0, 4)) {
        md.appendMarkdown("- ");
        md.appendText(`${f.label}${f.detail ? `: ${f.detail}` : ""} (+${f.points})`);
        md.appendMarkdown("\n");
      }
    }
    const busy = ["waiting", "queued", "running", "elsewhere", "held", "failed"].includes(r.run.state);
    if (busy && status) md.appendMarkdown(`\nAgents: ${status}  \n`);
    const agents = agentLines(r);
    agents.forEach((line, i) => {
      md.appendMarkdown(i ? "  \n" : "\n");
      md.appendText(line);
    });
    if (r.run.state === "done" && (r.run.tokens || r.run.costUsd != null)) {
      const parts = [r.run.tokens ? formatTokens(r.run.tokens) : "", r.run.costUsd != null ? `$${r.run.costUsd.toFixed(2)}${r.run.tokens ? " for the agents that report one" : ""}` : ""];
      md.appendMarkdown(`  \nLast run: ${parts.filter(Boolean).join(", ")}`);
    }
    if (r.run.note) {
      md.appendMarkdown("  \n");
      md.appendText(r.run.note);
    }
    if (r.run.error) {
      md.appendMarkdown("  \n");
      md.appendText(r.run.error.slice(0, 300));
    }
    return md;
  }
}
