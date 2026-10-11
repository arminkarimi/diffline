// The user's agent settings: ~/.diffline/agents.yml lists the agents (name, focus, options) and agents/<id>.md holds
// each one's instructions. Written with the defaults on first run; anything missing or invalid falls back to a default.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import type { AgentId } from "../core/types.ts";
import {
  AGENT_ID,
  BUILT_IN,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_SETTINGS,
  DESC_RULES,
  GUIDE,
  LEGACY_HEADINGS,
  NEW_AGENT_INSTRUCTIONS,
  newAgentSettings,
  RESERVED_IDS,
  type AgentSettings,
  type ReviewSettings,
} from "./defaults.ts";

export const settingsDir = (): string => process.env.DIFFLINE_HOME || path.join(os.homedir(), ".diffline");
export const settingsFile = (): string => path.join(settingsDir(), "agents.yml");
export const instructionsFile = (id: AgentId): string => path.join(settingsDir(), "agents", `${id}.md`);

const exists = (p: string) => access(p).then(() => true, () => false);
/** Keep long values such as a focus line on one line when agents.yml is rewritten. */
const YAML_OUT = { lineWidth: 0 };
const list = (xs: string[]) => (xs.length ? `[${xs.map((x) => JSON.stringify(x)).join(", ")}]` : "[]");

/** The comment that explains the agents section, in new files and added to older ones. */
const AGENTS_HELP = [
  "# agents: every agent Diffline runs, in this order. The guide checks the description, sets the reading order and",
  "#   draws the flow; every other agent reviews the code and reports findings. Add one with \"Diffline: New Agent…\"",
  "#   (or a block here plus agents/<id>.md); remove one by deleting its block. Ids are lowercase letters, digits, dashes.",
  "# name: what the review page calls it. focus: one line on what it looks at; the agent reads it before its instructions.",
];

function agentLines(id: AgentId, a: AgentSettings): string[] {
  return [
    `  ${id}:`,
    `    name: ${JSON.stringify(a.name)}`,
    `    focus: ${JSON.stringify(a.focus)}`,
    `    enabled: ${a.enabled}`,
    `    max-findings: ${a.maxFindings}`,
    `    min-confidence: ${a.minConfidence}`,
    `    skip: ${list(a.skip)}`,
    `    runs-when: ${list(a.runsWhen)}`,
    `    harness: ${JSON.stringify(a.harness)}`,
    `    model: ${JSON.stringify(a.model)}`,
  ];
}

function defaultYaml(): string {
  const d = DEFAULT_SETTINGS;
  const lines = [
    "# Diffline agent settings. Edit freely; run \"Diffline: Reset Agent Settings\" to restore the defaults.",
    "# Each agent's instructions (what to look for and what to leave alone) live in agents/<id>.md next to this file.",
    "",
    "# What each severity means. Agents read these when they rate a finding.",
    "severity:",
    `  high: ${JSON.stringify(d.severity.high)}`,
    `  medium: ${JSON.stringify(d.severity.medium)}`,
    `  low: ${JSON.stringify(d.severity.low)}`,
    "",
    "# The rules the guide agent checks the pull request description against, per kind of change.",
    `# Rules: ${Object.entries(DESC_RULES).map(([id, r]) => `${id} (${r.title})`).join(", ")}.`,
    "description-rules:",
    `  feature: ${list(d.descriptionRules.feature)}`,
    `  fix: ${list(d.descriptionRules.fix)}`,
    "",
    ...AGENTS_HELP,
    "# enabled: run this agent. max-findings: at most this many findings.",
    "# min-confidence: minor (keep all), worth-asking (drop Minor) or high (keep only High confidence).",
    "# skip: files the agent ignores. runs-when: only run when a changed file matches (empty means always).",
    "# harness: claude or codex runs this agent; empty uses the diffline.harness setting in VS Code.",
    "#   \"Diffline: Choose Agent Harnesses…\" sets it. The lede (the briefing's opening line) uses the guide's harness.",
    "# model: a model for this agent, a name its harness knows (sonnet for claude, for example); empty uses that",
    "#   harness's model setting in VS Code.",
    "agents:",
  ];
  for (const id of BUILT_IN) lines.push(...agentLines(id, d.agents[id]));
  return lines.join("\n") + "\n";
}

/**
 * Bring files from before name and focus moved into agents.yml up to date: untouched default instruction files lose
 * their old heading, and agents.yml gets the agents section's help and each built-in agent's name and focus. Edited
 * instruction files are left as they are.
 */
async function migrate(): Promise<void> {
  for (const id of BUILT_IN) {
    const file = instructionsFile(id);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null && text === LEGACY_HEADINGS[id] + DEFAULT_INSTRUCTIONS[id]) await writeFile(file, DEFAULT_INSTRUCTIONS[id], "utf8");
  }
  const text = await readFile(settingsFile(), "utf8").catch(() => null);
  if (text === null) return;
  let next = text;
  if (!next.includes("# name: what the review page calls it")) {
    next = next.replace(/^# enabled: run this agent\./m, (m) => `${AGENTS_HELP.join("\n")}\n${m}`);
  }
  const doc = YAML.parseDocument(next);
  const agents = doc.get("agents", true);
  let changed = next !== text;
  if (YAML.isMap(agents)) {
    for (const id of BUILT_IN) {
      const block = agents.get(id, true);
      if (!YAML.isMap(block) || block.has("name")) continue;
      // Name and focus go first, where people look for them.
      block.items.unshift(doc.createPair("focus", DEFAULT_SETTINGS.agents[id].focus), doc.createPair("name", DEFAULT_SETTINGS.agents[id].name));
      block.items.unshift(block.items.splice(1, 1)[0]);
      changed = true;
    }
  }
  if (changed) await writeFile(settingsFile(), doc.toString(YAML_OUT), "utf8");
}

/** Write the default settings files that don't exist yet, and update older ones. Returns true on first run. */
export async function ensureSettings(): Promise<boolean> {
  await mkdir(path.join(settingsDir(), "agents"), { recursive: true });
  let wrote = false;
  if (!(await exists(settingsFile()))) {
    await writeFile(settingsFile(), defaultYaml(), "utf8");
    wrote = true;
  } else {
    await migrate();
  }
  for (const id of BUILT_IN) {
    if (!(await exists(instructionsFile(id)))) {
      await writeFile(instructionsFile(id), DEFAULT_SETTINGS.agents[id].instructions, "utf8");
      wrote = true;
    }
  }
  return wrote;
}

/** Overwrite agents.yml and the built-in agents' instructions with the defaults. Added agents' instruction files stay. */
export async function resetSettings(): Promise<void> {
  await mkdir(path.join(settingsDir(), "agents"), { recursive: true });
  await writeFile(settingsFile(), defaultYaml(), "utf8");
  for (const id of BUILT_IN) await writeFile(instructionsFile(id), DEFAULT_SETTINGS.agents[id].instructions, "utf8");
}

const strings = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;

/** Instructions as the agent gets them: without HTML comments, which are notes for the person editing the file. */
const cleanInstructions = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();

/** Whether instructions say anything beyond their headings. */
const hasInstructions = (text: string): boolean => text.replace(/^#+.*$/gm, "").trim().length > 0;

/** "performance-review" → "Performance review agent" */
const nameFromId = (id: string) => `${id[0].toUpperCase()}${id.slice(1).replace(/-/g, " ")} agent`;

/** Read the settings, falling back to the defaults for anything missing or invalid. Problems are returned, not thrown. */
export async function loadSettings(): Promise<{ settings: ReviewSettings; problems: string[] }> {
  const problems: string[] = [];
  let raw: Record<string, any> = {};
  try {
    const text = await readFile(settingsFile(), "utf8");
    const parsed = YAML.parse(text);
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch (err: any) {
    if (err?.code !== "ENOENT") problems.push(`${settingsFile()}: ${err?.message || err}`);
  }
  const d = DEFAULT_SETTINGS;
  const sev = raw.severity || {};
  const rules = raw["description-rules"] || {};
  const knownRules = (xs: string[], fallback: string[]) => {
    const ok = xs.filter((r) => r in DESC_RULES);
    if (ok.length !== xs.length) problems.push(`Unknown description rules ignored: ${xs.filter((r) => !(r in DESC_RULES)).join(", ")}`);
    return ok.length ? ok : fallback;
  };
  // agents.yml lists the agents; without an agents section, the built-in ones run. The guide always comes first.
  const listed = raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents) ? (raw.agents as Record<string, any>) : null;
  const ids = [GUIDE, ...(listed ? Object.keys(listed) : BUILT_IN).filter((id) => id !== GUIDE)];
  const agents: Record<AgentId, AgentSettings> = {};
  for (const id of ids) {
    if (!AGENT_ID.test(id) || RESERVED_IDS.includes(id)) {
      problems.push(`Agent "${id}" skipped: an id is 2 to 32 lowercase letters, digits or dashes, starting with a letter${RESERVED_IDS.includes(id) ? `, and "${id}" is taken` : ""}.`);
      continue;
    }
    const a = (listed?.[id] && typeof listed[id] === "object" ? listed[id] : {}) as Record<string, any>;
    const builtIn = d.agents[id];
    const def = builtIn || newAgentSettings(nameFromId(id), "");
    let instructions = builtIn ? builtIn.instructions : "";
    try {
      instructions = cleanInstructions(await readFile(instructionsFile(id), "utf8")) || instructions;
    } catch (err: any) {
      if (err?.code !== "ENOENT") problems.push(`${instructionsFile(id)}: ${err?.message || err}`);
      else if (!builtIn) problems.push(`${id}: ${instructionsFile(id)} is missing, so the agent doesn't run.`);
    }
    const conf = a["min-confidence"];
    const harness = typeof a.harness === "string" ? a.harness.trim() : "";
    if (harness && harness !== "claude" && harness !== "codex") problems.push(`${id}: unknown harness "${harness}" ignored; use claude or codex`);
    let enabled = typeof a.enabled === "boolean" ? a.enabled : def.enabled;
    if (enabled && !hasInstructions(instructions)) {
      if (!builtIn) problems.push(`${id}: agents/${id}.md has no instructions yet, so the agent doesn't run.`);
      enabled = false;
    }
    agents[id] = {
      name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : def.name,
      focus: typeof a.focus === "string" && a.focus.trim() ? a.focus.trim() : def.focus,
      enabled,
      maxFindings: Number.isInteger(a["max-findings"]) && a["max-findings"] >= 0 ? a["max-findings"] : def.maxFindings,
      minConfidence: conf === "minor" || conf === "worth-asking" || conf === "high" ? conf : def.minConfidence,
      skip: strings(a.skip, def.skip),
      runsWhen: strings(a["runs-when"], def.runsWhen),
      harness: harness === "claude" || harness === "codex" ? harness : def.harness,
      model: typeof a.model === "string" ? a.model.trim() : def.model,
      instructions,
    };
  }
  return {
    settings: {
      severity: {
        high: typeof sev.high === "string" ? sev.high : d.severity.high,
        medium: typeof sev.medium === "string" ? sev.medium : d.severity.medium,
        low: typeof sev.low === "string" ? sev.low : d.severity.low,
      },
      descriptionRules: {
        feature: knownRules(strings(rules.feature, d.descriptionRules.feature), d.descriptionRules.feature),
        fix: knownRules(strings(rules.fix, d.descriptionRules.fix), d.descriptionRules.fix),
      },
      agents,
    },
    problems,
  };
}

/** An id for a new agent from its name: "Performance agent" → "performance", unique among the ones listed. */
export function agentIdFor(name: string, taken: string[]): string {
  let base = name.toLowerCase().replace(/\bagent\b/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(base)) base = `agent-${base}`.replace(/-+$/, "");
  base = base.slice(0, 28).replace(/-+$/, "") || "agent";
  if (base.length < 2) base = `${base}-agent`;
  let id = base;
  for (let n = 2; taken.includes(id) || RESERVED_IDS.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Add a reviewer agent: its block at the end of agents.yml, and agents/<id>.md to fill in. Returns the instruction file. */
export async function addAgent(id: AgentId, name: string, focus: string): Promise<string> {
  if (!AGENT_ID.test(id) || RESERVED_IDS.includes(id)) throw new Error(`"${id}" can't be an agent id.`);
  await ensureSettings();
  const doc = YAML.parseDocument(await readFile(settingsFile(), "utf8"));
  if (doc.hasIn(["agents", id])) throw new Error(`There's already an agent called "${id}".`);
  const a = newAgentSettings(name, focus);
  const block = YAML.parseDocument(agentLines(id, a).map((l) => l.slice(2)).join("\n")).contents;
  if (!YAML.isMap(doc.get("agents", true))) doc.set("agents", doc.createNode({}));
  doc.setIn(["agents", id], (block as YAML.YAMLMap).get(id, true));
  await writeFile(settingsFile(), doc.toString(YAML_OUT), "utf8");
  const file = instructionsFile(id);
  if (!(await exists(file))) await writeFile(file, NEW_AGENT_INSTRUCTIONS, "utf8");
  return file;
}

/** Remove an agent from agents.yml. Its instruction file stays, so adding it back keeps the instructions. */
export async function removeAgent(id: AgentId): Promise<void> {
  if (id === GUIDE) throw new Error("The guide can't be removed; turn it off with enabled: false instead.");
  const doc = YAML.parseDocument(await readFile(settingsFile(), "utf8"));
  if (!doc.hasIn(["agents", id])) return;
  doc.deleteIn(["agents", id]);
  await writeFile(settingsFile(), doc.toString(YAML_OUT), "utf8");
}

/**
 * Set the harness one agent runs on, keeping the rest of agents.yml (comments included) as it is. A model set for the
 * agent belongs to its old harness, so it's cleared when the harness changes; returns the model that was cleared.
 */
export async function setAgentHarness(id: AgentId, harness: "" | "claude" | "codex"): Promise<{ clearedModel: string | null }> {
  await ensureSettings();
  const doc = YAML.parseDocument(await readFile(settingsFile(), "utf8"));
  const before = doc.getIn(["agents", id, "harness"]);
  const model = doc.getIn(["agents", id, "model"]);
  let clearedModel: string | null = null;
  if ((typeof before === "string" ? before : "") !== harness && typeof model === "string" && model.trim()) {
    clearedModel = model.trim();
    doc.setIn(["agents", id, "model"], "");
  }
  doc.setIn(["agents", id, "harness"], harness);
  await writeFile(settingsFile(), doc.toString(YAML_OUT), "utf8");
  return { clearedModel };
}

/** Glob matching for skip and runs-when patterns: `**` crosses folders, `*` and `?` don't. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (filePath: string, globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(filePath));
