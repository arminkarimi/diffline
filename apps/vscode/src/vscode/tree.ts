// The sidebar: pull requests grouped by why they're listed, each with its risk score and agent status.

import * as vscode from "vscode";

import { formatTokens } from "../agents/harness.ts";
import { reviewFreshness, type DifflineService, type PrRecord } from "../core/service.ts";
import { WHY } from "../core/grouping.ts";
import { timeAgo } from "../core/time.ts";
import { RISK_WORD } from "../core/risk.ts";
import type { Risk } from "../core/types.ts";
import { prKeyString } from "../core/types.ts";

type Group = { kind: "group"; id: string; label: string; rows: Row[]; description?: string; collapsed?: boolean };
type Row = { kind: "pr"; record: PrRecord; risk: Risk | null; tag?: string; inRepoGroup?: boolean };
export type Node = Group | Row;

const RISK_COLOR = { high: "charts.red", medium: "charts.yellow", low: "charts.green" } as const;

/** A short agent status for the row, and whether the agents are behind the head. */
function agentStatus(r: PrRecord): { text: string; behind: boolean } {
  const run = r.run;
  const head = r.summary?.headRefOid;
  const behind = !!r.agent && !!head && r.agent.commit !== head;
  switch (run.state) {
    case "waiting": {
      const secs = Math.max(0, Math.round(((run.dueAt || Date.now()) - Date.now()) / 1000));
      return { text: secs ? `agents in ${secs < 60 ? `${secs}s` : `${Math.ceil(secs / 60)}m`}` : "agents starting", behind };
    }
    case "queued":
      return { text: "agents queued", behind };
    case "running": {
      const states = Object.values(run.progress?.agents || {});
      const done = states.filter((a) => a && (a.state === "done" || a.state === "failed")).length;
      const total = states.filter((a) => a && a.state !== "skipped").length;
      return { text: total ? `agents ${done}/${total}` : "agents starting", behind };
    }
    case "elsewhere":
      return { text: "agents running in another window", behind };
    case "held":
      return { text: `large, press Run for agents${r.agent ? `; ${r.agent.findings.length} findings${behind ? ", behind" : ""}` : ""}`, behind };
    case "failed":
      return { text: "agents failed", behind };
  }
  if (!r.agent) return { text: "", behind: false };
  const n = r.agent.findings.length;
  const findings = `${n} finding${n === 1 ? "" : "s"}`;
  return { text: behind ? `agents: ${findings}, new commits since` : `✓ agents: ${findings}`, behind };
}

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
    const parts = [
      node.tag || "",
      node.risk ? `${node.risk.score} ${RISK_WORD[node.risk.level].toLowerCase()}` : "",
      status.text,
      s?.isDraft ? "draft" : "",
      s?.viewerReview === "APPROVED" ? "you approved" : s?.viewerReview === "CHANGES_REQUESTED" ? "you requested changes" : "",
      node.inRepoGroup ? "" : r.key.name,
    ].filter(Boolean);
    item.description = parts.join(" · ");
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
    item.contextValue = `pr.${context}${r.pinned ? ".pinned" : ""}`;
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
    md.appendText(`${prKeyString(r.key)}${s?.author?.login ? ` by ${s.author.login}` : ""}${s?.isDraft ? " · draft" : ""}`);
    md.appendMarkdown("  \n");
    const why = (s?.reasons || []).map((x) => WHY[x]).filter(Boolean);
    if (why.length) md.appendMarkdown(`Listed because ${why.join(", ")}.  \n`);
    if (s) md.appendMarkdown(`+${s.additions} −${s.deletions} in ${s.changedFiles} files${s.checks.failed ? ` · ${s.checks.failed} checks failing` : s.checks.running ? ` · ${s.checks.running} checks running` : ""}  \n`);
    if (node.risk) {
      md.appendMarkdown(`\n**${RISK_WORD[node.risk.level]} risk, ${node.risk.score}/100**  \n`);
      for (const f of node.risk.factors.slice(0, 4)) {
        md.appendMarkdown("- ");
        md.appendText(`${f.label}${f.detail ? `: ${f.detail}` : ""} (+${f.points})`);
        md.appendMarkdown("\n");
      }
    }
    const fresh = reviewFreshness(r.agent, s);
    const busy = ["waiting", "queued", "running", "elsewhere", "held", "failed"].includes(r.run.state);
    if (busy && status) md.appendMarkdown(`\nAgents: ${status}  \n`);
    if (fresh.state === "none") md.appendMarkdown(`\nNo agent review yet.`);
    else {
      const n = r.agent!.findings.length;
      md.appendMarkdown(`\nAgents reviewed \`${fresh.commit?.slice(0, 7)}\` ${timeAgo(fresh.ranAt)}: ${n} finding${n === 1 ? "" : "s"}.  \n`);
      md.appendMarkdown(
        fresh.state === "behind"
          ? "New commits since: Run reviews the latest."
          : fresh.activity
            ? "Updated on GitHub since (description, comments or reviews): Run starts a fresh review."
            : "Nothing has changed since: Run asks before reviewing again.",
      );
    }
    if (r.run.state === "done" && (r.run.tokens || r.run.costUsd != null)) {
      const parts = [r.run.tokens ? formatTokens(r.run.tokens) : "", r.run.costUsd != null ? `$${r.run.costUsd.toFixed(2)}${r.run.tokens ? " for the Claude agents" : ""}` : ""];
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
