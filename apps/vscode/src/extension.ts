import * as vscode from "vscode";

import { GUIDE, shortName } from "./agents/defaults.ts";
import { HARNESS_IDS, HARNESS_NAME, harnessVersion, isHarnessId, listPiModels, PI_THINKING, piModelThinking, type HarnessConfig, type HarnessId } from "./agents/harness.ts";
import { addAgent, agentIdFor, ensureSettings, instructionsFile, loadSettings, removeAgent, resetSettings, setAgentHarness, setAgentModel, settingsDir, settingsFile } from "./agents/settings.ts";
import { Repos } from "./core/repos.ts";
import { approverWords, DifflineService, parseKey, type ApprovedPolicy, type ServiceConfig } from "./core/service.ts";
import { Store } from "./core/store.ts";
import type { AgentFailure } from "./agents/review.ts";
import type { AgentFile, AgentId, PrKey } from "./core/types.ts";
import { timeAgo } from "./core/time.ts";
import { prKeyString } from "./core/types.ts";
import { exportAgentReview, ReviewPanel } from "./vscode/panel.ts";
import { SORT_WORDS, type SidebarConfig } from "./core/grouping.ts";
import { PullRequestTree, type Node } from "./vscode/tree.ts";

function readSidebar(): SidebarConfig {
  const c = vscode.workspace.getConfiguration("diffline.sidebar");
  const groupBy = c.get<string>("groupBy") === "repository" ? "repository" : "relationship";
  const sortBy = (["risk", "created", "updated"] as const).find((x) => x === c.get<string>("sortBy")) || "risk";
  return { groupBy, sortBy, othersLimit: c.get<number>("othersLimit", 10) };
}

function readConfig(): ServiceConfig {
  const c = vscode.workspace.getConfiguration("diffline");
  const harness = (id: HarnessId): HarnessConfig => ({
    id,
    command: c.get<string>(`${id}.path`) || id,
    model: c.get<string>(`${id}.model`) || "",
    extraArgs: c.get<string[]>(`${id}.extraArgs`) || [],
    ...(id === "pi" ? { thinking: c.get<string>("pi.thinking") || "" } : {}),
  });
  const defaultHarness = c.get<string>("harness");
  const approved = c.get<string>("agents.approvedPullRequests");
  return {
    watch: {
      direct: c.get<boolean>("watch.reviewRequested", true),
      team: c.get<boolean>("watch.teamRequests", true),
      assigned: c.get<boolean>("watch.assigned", true),
      reviewed: c.get<boolean>("watch.reviewed", true),
      codeOwners: c.get<boolean>("watch.codeOwners", true),
      others: c.get<boolean>("watch.othersToReview", true),
      authored: c.get<boolean>("watch.authored", true),
      repositories: c.get<string[]>("watch.repositories", []),
      pollSeconds: c.get<number>("watch.pollSeconds", 60),
    },
    agents: {
      autoRun: c.get<boolean>("agents.autoRun", true),
      enabled: (c.get<string[]>("agents.enabled") || []).filter((a) => typeof a === "string" && a.trim()),
      maxParallel: c.get<number>("agents.maxParallel", 5),
      quietPeriodSeconds: c.get<number>("agents.quietPeriodSeconds", 120),
      maxAutomaticRuns: c.get<number>("agents.maxAutomaticRuns", 5),
      skipDrafts: c.get<boolean>("agents.skipDrafts", true),
      timeoutMinutes: c.get<number>("agents.timeoutMinutes", 20),
      autoRunMaxFiles: c.get<number>("agents.autoRunMaxFiles", 100),
      autoRunMaxLines: c.get<number>("agents.autoRunMaxLines", 5000),
      approvedPullRequests: (["ask", "skip", "run"] as const).find((x) => x === approved) || "ask",
    },
    sidebar: readSidebar(),
    metrics: { enabled: c.get<boolean>("metrics.enabled", true) },
    harnesses: { default: isHarnessId(defaultHarness) ? defaultHarness : "claude", claude: harness("claude"), codex: harness("codex"), pi: harness("pi") },
  };
}

/** The pull request a command was invoked on: a tree row, a key string, or the open review. */
function keyFrom(arg: unknown, panel: ReviewPanel): PrKey | null {
  if (typeof arg === "string") return parseKey(arg);
  const node = arg as Node | undefined;
  if (node && node.kind === "pr") return node.record.key;
  return panel.key;
}

/** Returned from activate for the extension-host smoke test. */
export interface DifflineApi {
  service: DifflineService;
  panel: ReviewPanel;
}

export async function activate(context: vscode.ExtensionContext): Promise<DifflineApi> {
  const output = vscode.window.createOutputChannel("Diffline", { log: true });
  const log = (line: string) => output.info(line);
  context.subscriptions.push(output);

  const store = new Store(context.globalStorageUri.fsPath);
  await store.init();
  const repos = new Repos({
    storage: context.globalStorageUri.fsPath,
    configured: () => vscode.workspace.getConfiguration("diffline").get<Record<string, string>>("clones", {}),
    workspaceDirs: () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    log,
  });
  const service = new DifflineService({ store, repos, memory: context.globalState, config: readConfig, log, version: String(context.extension.packageJSON.version || "") || undefined });
  const panel = new ReviewPanel(context.extensionUri, service, log);
  const tree = new PullRequestTree(service);
  const view = vscode.window.createTreeView("diffline.pullRequests", { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view, tree, { dispose: () => service.dispose() }, { dispose: () => panel.dispose() });

  /** The view's subtitle says how the list is grouped and sorted. */
  const showSidebarMode = () => {
    const { groupBy, sortBy } = readSidebar();
    view.description = `${groupBy === "repository" ? "by repository" : "by relationship"} · ${SORT_WORDS[sortBy]}`;
  };

  // Status bar: how many agent runs are going, and GitHub problems.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "diffline.showLog";
  context.subscriptions.push(status);
  const updateStatus = () => {
    const running = service.all().filter((r) => r.run.state === "running" || r.run.state === "queued").length;
    const waiting = service.all().filter((r) => r.run.state === "waiting").length;
    if (service.lastError) {
      status.text = "$(warning) Diffline";
      status.tooltip = `GitHub: ${service.lastError}`;
      status.show();
    } else if (running || waiting) {
      status.text = `$(sync~spin) Diffline: ${running ? `${running} running` : ""}${running && waiting ? ", " : ""}${waiting ? `${waiting} waiting` : ""}`;
      status.tooltip = "Agents are reviewing pull requests. Click for the log.";
      status.show();
    } else status.hide();
    view.badge = running ? { value: running, tooltip: `${running} agent run${running === 1 ? "" : "s"} in progress` } : undefined;
  };
  service.on("change", updateStatus);

  service.on("runFinished", async (key: PrKey, file: AgentFile, failed: AgentFailure[]) => {
    const n = file.findings.length;
    const showing = panel.key && prKeyString(panel.key) === prKeyString(key);
    const setup = failed.filter((f) => f.kind === "missing" || f.kind === "auth");
    const msg =
      `Agents finished #${key.number}: ${n} finding${n === 1 ? "" : "s"}${failed.length ? `, ${failed.length} agent${failed.length === 1 ? "" : "s"} failed` : ""}.` +
      (setup.length ? ` ${setup[0].error}` : "");
    const open = showing ? "Reload review" : "Open review";
    const choice = await vscode.window.showInformationMessage(msg, open, ...(setup.length ? ["Choose harnesses"] : []));
    if (choice === "Choose harnesses") void vscode.commands.executeCommand("diffline.selectHarness");
    else if (choice) await panel.show(key);
  });
  service.on("runFailed", async (key: PrKey, message: string, kind: string) => {
    const actions = kind === "missing" || kind === "auth" ? ["Choose harnesses", "Show log"] : ["Show log"];
    const choice = await vscode.window.showErrorMessage(`Agents failed on #${key.number}: ${message}`, ...actions);
    if (choice === "Choose harnesses") void vscode.commands.executeCommand("diffline.selectHarness");
    if (choice === "Show log") output.show(true);
  });

  service.on("runElsewhere", (key: PrKey) => {
    void vscode.window.showInformationMessage(`Agents are already running on #${key.number} in another VS Code window.`);
  });

  /* Approved pull requests (diffline.agents.approvedPullRequests): automatic runs held to ask first. */

  const setApprovedPolicy = (value: ApprovedPolicy) => vscode.workspace.getConfiguration("diffline").update("agents.approvedPullRequests", value, vscode.ConfigurationTarget.Global);
  const approvers = (key: PrKey) => approverWords(service.approval(key) || [], service.viewer?.login ?? null);
  /** Held pull requests not asked about yet. One notification shows at a time; the ones held meanwhile wait for it. */
  const approvedQueue = new Map<string, PrKey>();
  let askingApproved = false;

  const askApproved = async (key: PrKey) => {
    const choice = await vscode.window.showInformationMessage(
      `${prKeyString(key)} is approved by ${approvers(key)}. Run the agents on it anyway?`,
      "Skip this PR",
      "Run anyway",
      "Always skip approved",
    );
    // Dismissed: the run stays held, and this push isn't asked about again.
    if (choice === "Skip this PR") service.chooseForApproved(key, "skip");
    else if (choice === "Run anyway") service.chooseForApproved(key, "run");
    else if (choice === "Always skip approved") await setApprovedPolicy("skip");
  };

  /** Several at once: one notification, and a pick of which to run. */
  const askApprovedMany = async (keys: PrKey[]) => {
    const choice = await vscode.window.showInformationMessage(`${keys.length} approved pull requests have automatic runs waiting.`, "Review them", "Always skip approved");
    if (choice === "Always skip approved") return void (await setApprovedPolicy("skip"));
    if (choice !== "Review them") return;
    const picks = await vscode.window.showQuickPick(
      keys.map((key) => ({ label: `#${key.number} ${service.get(key)?.summary?.title ?? ""}`.trim(), description: `${key.owner}/${key.name} · approved by ${approvers(key)}`, key })),
      { title: "Run the agents on which approved pull requests?", placeHolder: "Checked ones run now and on later pushes; the rest stay held until you press Run", canPickMany: true },
    );
    for (const p of picks || []) if (service.awaitingApprovedChoice(p.key)) service.chooseForApproved(p.key, "run");
  };

  const askQueuedApproved = async () => {
    if (askingApproved) return;
    askingApproved = true;
    try {
      for (;;) {
        // Skip the ones that changed while they waited (run by hand, no longer approved, setting changed).
        const keys = [...approvedQueue.values()].filter((k) => service.awaitingApprovedChoice(k));
        approvedQueue.clear();
        if (!keys.length) return;
        if (keys.length === 1) await askApproved(keys[0]);
        else await askApprovedMany(keys);
      }
    } finally {
      askingApproved = false;
    }
  };

  service.on("approvedHeld", (keys: PrKey[]) => {
    for (const k of keys) approvedQueue.set(prKeyString(k).toLowerCase(), k);
    void askQueuedApproved();
  });

  service.on("approvedWhileRunning", async (key: PrKey, by: string[], startedAt: number | undefined) => {
    const choice = await vscode.window.showInformationMessage(
      `${prKeyString(key)} was approved while the agents were reviewing it. Stop them to save cost?`,
      "Stop",
      "Let them finish",
    );
    const run = service.get(key)?.run;
    // Only the run that was asked about, if it's still going.
    if (choice === "Stop" && run && (run.state === "queued" || run.state === "running") && run.startedAt === startedAt) {
      log(`Stopping the agents on ${prKeyString(key)}: approved by ${approverWords(by, service.viewer?.login ?? null)} while they ran`);
      service.cancel(key);
    }
  });

  /**
   * After Pi is picked: its model, from the ones Pi is signed in to, then a thinking level. For the default this sets
   * diffline.pi.model and diffline.pi.thinking; for one agent, its model in agents.yml with the level as a :suffix.
   * Falls back to typing the model when Pi can't list them. Returns false when the user backs out.
   */
  const choosePiModel = async (agent: { id: AgentId; name: string; model: string } | null): Promise<boolean> => {
    const pi = readConfig().harnesses.pi;
    const who = agent ? `the ${shortName(agent.name).toLowerCase()} agent` : "agents on Pi";
    const shared = `the other Pi agents' model (${pi.model || "Pi's default"})`;
    const withoutLevel = (m: string) => (piModelThinking(m) ? m.replace(/:[a-z]+$/, "") : m);
    const current = withoutLevel(agent ? agent.model : pi.model);
    const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Listing Pi's models" }, () => listPiModels(pi));
    let model: string;
    let canThink = true;
    if (models === null) {
      const typed = await vscode.window.showInputBox({
        title: `Pi model for ${who}`,
        prompt: `Pi couldn't list its models. Type one as provider/id or a name Pi knows, with an optional :<thinking> suffix. Empty uses ${agent ? shared : "Pi's default"}.`,
        placeHolder: "anthropic/claude-sonnet-5-5",
        value: agent ? agent.model : pi.model,
      });
      if (typed === undefined) return false;
      model = typed.trim();
    } else if (!models.length) {
      void vscode.window.showWarningMessage("Pi has no models to use yet. Run pi in a terminal and use /login, or set a provider's API key, then choose again.");
      return false;
    } else {
      type Item = vscode.QuickPickItem & { value: string; thinking: boolean };
      const items: Item[] = [
        {
          label: agent ? "Same as the other Pi agents" : "Pi's default",
          description: [agent ? pi.model || "Pi's default" : "", current ? "" : "in use"].filter(Boolean).join(" · "),
          detail: agent ? "Uses diffline.pi.model." : "The model you set in Pi, else its first signed-in provider's.",
          value: "",
          thinking: true,
        },
        ...models.map((m): Item => {
          const value = `${m.provider}/${m.id}`;
          return { label: m.id, description: [m.provider, m.thinking ? "" : "no thinking", value === current ? "in use" : ""].filter(Boolean).join(" · "), value, thinking: m.thinking };
        }),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: `Pi model for ${who}`, placeHolder: "Models Pi is signed in to", matchOnDescription: true });
      if (!pick) return false;
      model = pick.value;
      canThink = pick.thinking;
    }
    // The level: asked unless the model can't think (Pi turns thinking off for it), already names one, or the agent
    // shares the other Pi agents' model (and so their level).
    let thinking = "";
    if (canThink && !piModelThinking(model) && (model || !agent)) {
      const now = agent ? piModelThinking(agent.model) || "" : pi.thinking || "";
      const levels = await vscode.window.showQuickPick(
        [
          {
            label: agent ? "Same as the other Pi agents" : "Pi's default",
            description: [agent ? pi.thinking || "Pi's default" : "", now ? "" : "in use"].filter(Boolean).join(" · "),
            detail: agent ? "Uses diffline.pi.thinking." : "The level you set in Pi, else medium.",
            value: "",
          },
          ...PI_THINKING.map((t) => ({ label: t, description: t === now ? "in use" : "", value: t as string })),
        ],
        { title: `Thinking for ${who}`, placeHolder: "Pi lowers a level the model doesn't support" },
      );
      if (!levels) return false;
      thinking = levels.value;
    }
    if (agent) {
      const value = model && thinking ? `${model}:${thinking}` : model;
      await setAgentModel(agent.id, value);
      log(`${agent.name} now runs on Pi with ${value || `the other Pi agents' model`}`);
    } else {
      const c = vscode.workspace.getConfiguration("diffline");
      await c.update("pi.model", model, vscode.ConfigurationTarget.Global);
      await c.update("pi.thinking", thinking, vscode.ConfigurationTarget.Global);
      log(`Pi agents now use ${model || "Pi's default model"}${thinking ? `, thinking ${thinking}` : ""}`);
    }
    return true;
  };

  /** The harness picker: the default for every agent, then one row per agent. Stays open for more changes until dismissed. */
  const chooseHarnesses = async () => {
    const ids = HARNESS_IDS;
    const versions = new Map(await Promise.all(ids.map(async (id) => [id, await harnessVersion(readConfig().harnesses[id])] as const)));
    const harnessRow = (id: HarnessId, current: boolean) => ({
      label: HARNESS_NAME[id],
      description: [versions.get(id) || "not found", current ? "in use" : ""].filter(Boolean).join(" · "),
      detail: versions.get(id) ? undefined : `Install it, or set diffline.${id}.path to where it is.`,
      value: id as "" | HarnessId,
    });
    for (;;) {
      await ensureSettings();
      const cfg = readConfig().harnesses;
      const { settings } = await loadSettings();
      type Row = vscode.QuickPickItem & { agent?: AgentId | "default" };
      const rows: Row[] = [
        { label: "Default for all agents", description: HARNESS_NAME[cfg.default], detail: "Agents without a harness of their own use this one.", agent: "default" },
        { label: "Agents", kind: vscode.QuickPickItemKind.Separator },
        ...Object.entries(settings.agents).map(([id, a]): Row => {
          const own = a.harness;
          const h = own || cfg.default;
          const model = a.model || cfg[h].model || (h === "pi" ? "Pi's default model" : "the CLI's default model");
          // diffline.pi.thinking applies unless the agent's own model names a level.
          const thinking = h === "pi" && cfg.pi.thinking && !piModelThinking(a.model) ? `, thinking ${cfg.pi.thinking}` : "";
          return {
            label: shortName(a.name),
            description: `${HARNESS_NAME[h]}${own ? "" : " (default)"} · ${model}${thinking}${a.enabled ? "" : " · off"}`,
            detail: id === GUIDE ? "Also writes the briefing's opening line." : undefined,
            agent: id,
          };
        }),
      ];
      const pick = await vscode.window.showQuickPick(rows, { title: "Which CLI runs each agent?", placeHolder: "Pick the default or an agent to change it" });
      if (!pick?.agent) return;
      if (pick.agent === "default") {
        const choice = await vscode.window.showQuickPick(ids.map((id) => harnessRow(id, id === cfg.default)), { title: "Default harness for all agents" });
        if (choice) await vscode.workspace.getConfiguration("diffline").update("harness", choice.value, vscode.ConfigurationTarget.Global);
        if (choice?.value === "pi") await choosePiModel(null);
        continue;
      }
      const id = pick.agent;
      const own = settings.agents[id].harness;
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Use the default (${HARNESS_NAME[cfg.default]})`, description: own ? "" : "in use", value: "" as "" | HarnessId },
          ...ids.map((h) => harnessRow(h, own === h)),
        ],
        { title: `Harness for the ${shortName(settings.agents[id].name).toLowerCase()} agent` },
      );
      if (!choice) continue;
      let clearedModel: string | null = null;
      if (choice.value !== own) {
        ({ clearedModel } = await setAgentHarness(id, choice.value));
        log(`${settings.agents[id].name} now runs on ${choice.value || `the default (${cfg.default})`}`);
      }
      // Picking Pi (again) goes on to its model, so the picker is also how a Pi agent's model is changed.
      const pickedModel = choice.value === "pi" && (await choosePiModel({ id, name: settings.agents[id].name, model: choice.value === own ? settings.agents[id].model : "" }));
      if (clearedModel && !pickedModel) {
        const now = choice.value || cfg.default;
        void vscode.window.showInformationMessage(
          `The ${shortName(settings.agents[id].name).toLowerCase()} agent's model "${clearedModel}" was for its old harness, so it now uses diffline.${now}.model. Set a model for it in agents.yml if you want another.`,
        );
      }
    }
  };

  const command = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command("diffline.refresh", async () => {
    await vscode.window.withProgress({ location: { viewId: "diffline.pullRequests" } }, () => service.refresh().catch((err) => vscode.window.showErrorMessage(`Diffline: ${err.message}`)));
  });
  command("diffline.open", async (arg: unknown) => {
    const key = keyFrom(arg, panel);
    if (key) await panel.show(key);
  });
  command("diffline.openPullRequest", async () => {
    const value = await vscode.window.showInputBox({
      title: "Open a pull request",
      prompt: "A GitHub link or owner/name#number",
      placeHolder: "https://github.com/owner/name/pull/123",
      validateInput: (v) => (parseKey(v) ? null : "Use a GitHub pull request link or owner/name#number"),
    });
    const key = value ? parseKey(value) : null;
    if (!key) return;
    await service.pin(key);
    void service.refresh().catch(() => undefined);
    await panel.show(key);
  });
  command("diffline.openOnGitHub", (arg: unknown) => {
    const key = keyFrom(arg, panel);
    if (key) void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${key.owner}/${key.name}/pull/${key.number}`));
  });
  command("diffline.runAgents", async (arg: unknown) => {
    const key = keyFrom(arg, panel);
    if (!key) return void vscode.window.showInformationMessage("Open a pull request first, or pick one in the Diffline sidebar.");
    if (service.isBusy(key)) {
      const where = service.get(key)?.run.state === "elsewhere" ? " in another VS Code window" : "";
      return void vscode.window.showInformationMessage(`Agents are already running on #${key.number}${where}.`);
    }
    // Nothing new since the last review: running again would mostly repeat it, so ask. New commits or activity run at once.
    const fresh = service.freshness(key);
    if (fresh.state === "current" && !fresh.activity) {
      const choice = await vscode.window.showInformationMessage(
        `The agents already reviewed #${key.number} at its latest commit (${fresh.commit?.slice(0, 7)}, ${timeAgo(fresh.ranAt)}), and nothing has changed on GitHub since. Run them again?`,
        { modal: true },
        "Run again",
      );
      if (choice !== "Run again") return;
    }
    // Approved already: the agents' review may not be needed, and it costs tokens, so ask unless the setting says run.
    if (readConfig().agents.approvedPullRequests !== "run" && service.approval(key)) {
      const choice = await vscode.window.showInformationMessage(
        `${prKeyString(key)} is already approved by ${approvers(key)}. Run the agents anyway? This uses your model provider's tokens.`,
        { modal: true },
        "Run anyway",
      );
      if (choice !== "Run anyway") return;
    }
    void service.runAgents(key);
  });
  command("diffline.cancelAgents", (arg: unknown) => {
    const key = keyFrom(arg, panel);
    if (key && service.get(key)?.run.state === "elsewhere") {
      return void vscode.window.showInformationMessage(`#${key.number}'s agents are running in another VS Code window. Stop them there.`);
    }
    if (key) service.cancel(key);
  });
  command("diffline.removePullRequest", async (arg: unknown) => {
    const key = keyFrom(arg, panel);
    if (key) await service.unpin(key);
  });
  /**
   * The agent review as Markdown for another agent: the sidebar row's or the open review's pull request, else one picked
   * from those with an agent review. Copies every finding; the notification offers to save it as a file instead.
   */
  command("diffline.copyAgentReview", async (arg: unknown) => {
    let key = keyFrom(arg, panel);
    if (!key) {
      const rows = service.all().filter((r) => r.agent);
      if (!rows.length) return void vscode.window.showInformationMessage("No pull request has an agent review yet. Run the agents on one first.");
      rows.sort((a, b) => Date.parse(b.agent!.ranAt) - Date.parse(a.agent!.ranAt));
      const pick = await vscode.window.showQuickPick(
        rows.map((r) => {
          const n = r.agent!.findings.length;
          return { label: `#${r.key.number} ${r.summary?.title ?? ""}`.trim(), description: `${r.key.owner}/${r.key.name} · ${n} finding${n === 1 ? "" : "s"} · ${timeAgo(r.agent!.ranAt)}`, key: r.key };
        }),
        { title: "Copy which agent review as Markdown?", placeHolder: "Pull requests the agents reviewed", matchOnDescription: true },
      );
      if (!pick) return;
      key = pick.key;
    }
    try {
      const out = await exportAgentReview(service, key, "copy", log);
      const choice = await vscode.window.showInformationMessage(
        `Copied ${out.chars.toLocaleString("en-US")} characters for ${out.findings} finding${out.findings === 1 ? "" : "s"} from ${prKeyString(key)}'s agent review. Paste it into another agent.`,
        "Save as Markdown…",
      );
      if (choice) await exportAgentReview(service, key, "save", log);
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't copy the agent review: ${err instanceof Error ? err.message : err}`);
    }
  });
  command("diffline.showLog", () => output.show(true));
  command("diffline.openHome", () => panel.showHome());
  command("diffline.showMetrics", () => panel.showMetrics());
  command("diffline.groupBy", async () => {
    const current = readSidebar().groupBy;
    const pick = await vscode.window.showQuickPick(
      [
        { label: "By relationship", description: current === "relationship" ? "current" : "", detail: "Requested from you, assigned, code owner, your teams, yours, watched", value: "relationship" },
        { label: "By repository", description: current === "repository" ? "current" : "", detail: "One group per repository; each row says why it's listed", value: "repository" },
      ],
      { title: "Group pull requests" },
    );
    if (pick) await vscode.workspace.getConfiguration("diffline.sidebar").update("groupBy", pick.value, vscode.ConfigurationTarget.Global);
  });
  command("diffline.sortBy", async () => {
    const current = readSidebar().sortBy;
    const options = [
      { label: "Risk", detail: "Riskiest first", value: "risk" },
      { label: "Newest", detail: "Most recently created first", value: "created" },
      { label: "Recently updated", detail: "Most recent activity first", value: "updated" },
    ].map((o) => ({ ...o, description: o.value === current ? "current" : "" }));
    const pick = await vscode.window.showQuickPick(options, { title: "Sort pull requests" });
    if (pick) await vscode.workspace.getConfiguration("diffline.sidebar").update("sortBy", pick.value, vscode.ConfigurationTarget.Global);
  });
  command("diffline.selectHarness", () => chooseHarnesses());
  /** Add a reviewer agent: name it, say what it looks at, then write its instructions. */
  const newAgent = async () => {
    await ensureSettings();
    const { settings } = await loadSettings();
    const name = await vscode.window.showInputBox({
      title: "New agent (1 of 2): its name",
      prompt: "What the review page calls it",
      placeHolder: "Performance agent",
      validateInput: (v) => (!v.trim() ? "Give it a name" : v.trim().length > 40 ? "Keep it under 40 characters" : null),
    });
    if (!name?.trim()) return;
    const focus = await vscode.window.showInputBox({
      title: "New agent (2 of 2): its focus",
      prompt: "One line on what it looks at. The agent reads this, and the page shows it.",
      placeHolder: "Slow queries, needless work in loops, and memory that grows with input",
      validateInput: (v) => (!v.trim() ? "Say what it looks at" : v.length > 160 ? "Keep it to one line" : null),
    });
    if (!focus?.trim()) return;
    const id = agentIdFor(name, Object.keys(settings.agents));
    const file = await addAgent(id, name.trim(), focus.trim().replace(/\.$/, ""));
    log(`Added the ${name.trim()} (${id}) to ${settingsFile()}`);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    void vscode.window.showInformationMessage(
      `Added "${name.trim()}" as ${id} in agents.yml. Write what it looks for and leaves alone in agents/${id}.md; it runs once that file has instructions.`,
    );
  };

  const removeAnAgent = async () => {
    const { settings } = await loadSettings();
    const items = Object.entries(settings.agents)
      .filter(([id]) => id !== GUIDE)
      .map(([id, a]) => ({ label: shortName(a.name), description: id, detail: a.focus, id }));
    const pick = await vscode.window.showQuickPick(items, { title: "Remove an agent", placeHolder: "Its instruction file stays, so you can add it back" });
    if (!pick) return;
    const ok = await vscode.window.showWarningMessage(
      `Remove the ${settings.agents[pick.id].name} from agents.yml? Its instructions in agents/${pick.id}.md stay. "Reset Agent Settings" brings back the built-in agents.`,
      { modal: true },
      "Remove",
    );
    if (ok !== "Remove") return;
    await removeAgent(pick.id);
    log(`Removed ${pick.id} from ${settingsFile()}`);
  };

  command("diffline.newAgent", () => newAgent());
  command("diffline.removeAgent", () => removeAnAgent());
  command("diffline.editAgentInstructions", async () => {
    await ensureSettings();
    const { settings, problems } = await loadSettings();
    for (const p of problems) log(`Agent settings: ${p}`);
    type Item = vscode.QuickPickItem & { file?: string; run?: () => Promise<void> };
    const items: Item[] = [
      { label: "$(settings) Agent settings", description: "agents.yml", detail: "Which agents run and in what order, names, limits, harnesses and the description rules", file: settingsFile() },
      { label: "Instructions", kind: vscode.QuickPickItemKind.Separator },
      ...Object.entries(settings.agents).map(([id, a]): Item => ({
        label: shortName(a.name),
        description: `agents/${id}.md${a.enabled ? "" : " · off"}`,
        detail: a.focus,
        file: instructionsFile(id),
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(add) New agent…", detail: "A reviewer of your own, with its own instructions", run: newAgent },
      { label: "$(trash) Remove an agent…", detail: "Take one out of agents.yml; its instructions stay", run: removeAnAgent },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Customize the agents (${settingsDir()})`, matchOnDetail: true });
    if (pick?.run) await pick.run();
    else if (pick?.file) await vscode.window.showTextDocument(vscode.Uri.file(pick.file));
  });
  command("diffline.resetAgentSettings", async () => {
    const ok = await vscode.window.showWarningMessage(
      "Replace agents.yml and the built-in agents' instructions with Diffline's defaults? Agents you added leave agents.yml; their instruction files stay.",
      { modal: true },
      "Reset",
    );
    if (ok === "Reset") {
      await resetSettings();
      void vscode.window.showInformationMessage(`Agent settings in ${settingsDir()} are back to the defaults.`);
    }
  });

  command("diffline.deleteMetrics", async () => {
    const ok = await vscode.window.showWarningMessage(
      "Delete your review metrics? They're the record of what you did with agent findings, the reviews you posted and the agent runs, kept only on this computer. This can't be undone.",
      { modal: true, detail: service.metricsLog.file },
      "Delete",
    );
    if (ok !== "Delete") return;
    try {
      const had = await service.metricsLog.delete();
      log(had ? `Deleted the review metrics ${service.metricsLog.file}` : "There were no review metrics to delete");
      void vscode.window.showInformationMessage(had ? "Deleted your review metrics." : "There are no review metrics yet.");
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't delete the review metrics: ${err instanceof Error ? err.message : err}`);
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("diffline.sidebar")) {
        showSidebarMode();
        tree.refresh();
        void panel.refreshList().catch((err) => log(`Couldn't update the review page's list: ${err instanceof Error ? err.message : err}`));
      }
      if (e.affectsConfiguration("diffline")) {
        service.configChanged();
        // What's listed, automatic runs and clones show after a refresh; sorting, grouping and harnesses don't need one.
        if (["diffline.watch", "diffline.agents", "diffline.clones"].some((s) => e.affectsConfiguration(s))) void service.refresh().catch(() => undefined);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => repos.reset()),
  );

  // First run: write the default agent settings.
  if (await ensureSettings()) {
    void vscode.window
      .showInformationMessage(`Diffline set up its review agents in ${settingsDir()}. You can change what they look for, or add your own.`, "Customize")
      .then((c) => c && vscode.commands.executeCommand("diffline.editAgentInstructions"));
  }

  service.start();
  updateStatus();
  showSidebarMode();
  log(`Diffline started. Agents run with ${readConfig().harnesses.default} unless agents.yml says otherwise; data in ${context.globalStorageUri.fsPath}.`);
  return { service, panel };
}

export function deactivate(): void {
  /* subscriptions dispose the service and panel */
}
