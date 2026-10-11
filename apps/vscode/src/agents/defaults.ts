// The agents Diffline ships with. On first run they're written to ~/.diffline (settings.ts): each agent's name, focus
// and options to agents.yml, its instructions to agents/<id>.md. Users change them, remove them and add their own.
// The guide is the one special agent: it checks the description, sets the reading order and draws the flow. Every
// other agent, built in or added, is a reviewer that reports findings and checked notes.

import type { AgentId } from "../core/types.ts";

export const GUIDE = "guide";

/** Agent ids: what agents.yml and the instruction file names use. "lede" is the briefing's opening line. */
export const AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/;
export const RESERVED_IDS = ["lede"];

/** "Security agent" → "Security", for tight spots on the page and in pickers. */
export const shortName = (name: string): string => name.replace(/\s+agent$/i, "").trim() || name;

export const DESC_RULES: Record<string, { title: string; text: string }> = {
  what: { title: "What changes", text: "What the change is" },
  why: { title: "Why", text: "Why the change is needed" },
  evidence: { title: "Evidence", text: "Usage, metrics or log data that show why the change was needed" },
  diagram: { title: "Diagram", text: "A supporting diagram, such as the architecture or a sequence" },
  rollout: { title: "Rollout", text: "Notes on how it rolls out" },
  dependencies: { title: "Dependencies", text: "Other pull requests it depends on that aren't linked to it, especially in other repositories" },
  risks: { title: "Risks", text: "Any risks, and what's out of scope" },
};

const DESC_DEFAULT_RULES = {
  feature: ["what", "why", "diagram", "rollout", "dependencies", "risks"],
  fix: ["evidence", "diagram", "rollout", "dependencies"],
};

export const CONFIDENCE_ORDER = ["Minor", "Worth asking", "High confidence"] as const;

export interface AgentSettings {
  /** What the page calls it, such as "Security agent". */
  name: string;
  /** One line on what it looks at. The agent reads it too, before its instructions. */
  focus: string;
  enabled: boolean;
  /** At most this many findings from this agent. */
  maxFindings: number;
  /** Drop findings below this confidence: "minor" keeps all, "worth-asking" drops Minor, "high" keeps only High confidence. */
  minConfidence: "minor" | "worth-asking" | "high";
  /** Glob patterns of files this agent ignores. */
  skip: string[];
  /** When non-empty, the agent only runs if a changed file matches one of these globs. */
  runsWhen: string[];
  /** The CLI that runs this agent; empty uses the diffline.harness setting. */
  harness: "" | "claude" | "codex";
  /** Model for this agent, a name its harness knows; empty uses that harness's model setting. */
  model: string;
  /** The agent's instructions from agents/<id>.md: what to look for and what to leave alone (Markdown). */
  instructions: string;
}

export interface ReviewSettings {
  severity: { high: string; medium: string; low: string };
  descriptionRules: { feature: string[]; fix: string[] };
  /** Every agent, in the order they're listed (and run); the guide first. */
  agents: Record<AgentId, AgentSettings>;
}

/** Each built-in agent's agents/<id>.md: what to look for and what to leave alone. Its name and focus live in agents.yml. */
export const DEFAULT_INSTRUCTIONS: Record<string, string> = {
  guide: `## Look for

Start with the description. Decide whether the change is a new feature or a bug fix or improvement, then check the description against the rules for that kind: quote what covers each rule, and say what's missing. Compare it with the diff, so a new flag the rollout notes skip, or another repository's pull request the code needs, counts as missing. Write each gap as a question for the author, and name pull requests as owner/repo#number so GitHub links them when the question is posted.

Then group the diff into chapters a reviewer can read in order. Start from the description's list of changes and the import graph: files that define things come before the files that use them. Put tests and housekeeping in their own chapters at the end.

Then draw the main runtime flow the change touches as a diagram: the steps in the order the code runs, each linked to the diff lines it stands for, marked new, changed or removed. Skip the diagram when the change has no runtime flow, such as docs or configuration only.

## Leave alone

Findings about the code, and the description's style and length.
`,
  architecture: `## Look for

Check that each change sits in the module that owns it and follows the patterns around it. Flag business logic in request handlers, modules that reach into another module's storage, helpers that duplicate existing ones, and new abstractions without a clear owner.

## Leave alone

Naming, formatting and style. Linters handle those.
`,
  correctness: `## Look for

Look for code that gives wrong results: races between concurrent requests, edge cases at limits and boundaries, error paths that leave data half-written, and contracts that callers rely on. Trace callers and the other side of every contract the change touches, including other services.

## Leave alone

Style, and code the pull request didn't change.
`,
  tests: `## Look for

Compare what changed with what the tests exercise. Flag new behavior, new branches and changed edge cases that no test covers, and tests that would still pass if the code were wrong.

## Leave alone

Coverage numbers, and tests for code the pull request didn't change.
`,
  security: `## Look for

Follow untrusted input to where it's used. Look for missing validation, amounts that can go wrong, gaps in sign-in and authorization, secrets in code or logs, and data that could cross between customers.

## Leave alone

Dependency advisories. The dependency scanner in Checks covers those.
`,
};

/**
 * The headings the built-in instruction files had before name and focus moved to agents.yml. A file that is exactly
 * one of these plus today's default is an untouched default, so settings.ts brings it up to date.
 */
export const LEGACY_HEADINGS: Record<string, string> = {
  guide: `# Guide agent

Checks the description, groups the diff into chapters and draws the flow the change touches.

`,
  architecture: `# Architecture agent

Where code lives: boundaries, existing patterns and code that shouldn't exist.

`,
  correctness: `# Correctness agent

Logic errors, races and edge cases.

`,
  tests: `# Test agent

Behavior changes that no test covers.

`,
  security: `# Security agent

Money movement, sign-in and input validation.

`,
};

export const DEFAULT_SETTINGS: ReviewSettings = {
  severity: {
    high: "Breaks production behavior, data or a contract with another service",
    medium: "Worth fixing before merge",
    low: "Minor, or a matter of taste",
  },
  descriptionRules: DESC_DEFAULT_RULES,
  agents: {
    guide: { name: "Guide agent", focus: "Checks the description, sets the reading order and draws the flow the change touches", enabled: true, maxFindings: 0, minConfidence: "minor", skip: [], runsWhen: [], harness: "", model: "", instructions: DEFAULT_INSTRUCTIONS.guide },
    architecture: { name: "Architecture agent", focus: "Where code lives: boundaries, existing patterns and code that shouldn't exist", enabled: true, maxFindings: 3, minConfidence: "worth-asking", skip: ["**/*.lock", "docs/**"], runsWhen: [], harness: "", model: "", instructions: DEFAULT_INSTRUCTIONS.architecture },
    correctness: { name: "Correctness agent", focus: "Logic errors, races and edge cases", enabled: true, maxFindings: 5, minConfidence: "minor", skip: ["**/*.lock", "docs/**"], runsWhen: [], harness: "", model: "", instructions: DEFAULT_INSTRUCTIONS.correctness },
    tests: { name: "Test agent", focus: "Behavior changes that no test covers", enabled: true, maxFindings: 5, minConfidence: "minor", skip: ["**/*.lock", "docs/**"], runsWhen: [], harness: "", model: "", instructions: DEFAULT_INSTRUCTIONS.tests },
    security: { name: "Security agent", focus: "Money movement, sign-in and input validation", enabled: true, maxFindings: 5, minConfidence: "minor", skip: [], runsWhen: [], harness: "", model: "", instructions: DEFAULT_INSTRUCTIONS.security },
  },
};

/** The built-in agents, in order. */
export const BUILT_IN: AgentId[] = Object.keys(DEFAULT_SETTINGS.agents);

/** The instruction file a new agent starts with. Comments are for the reader; agents don't see them. */
export const NEW_AGENT_INSTRUCTIONS = `<!--
Describe what this agent looks for, like a brief for a colleague who'll read the pull request. It also gets its name and
focus from agents.yml, the pull request's description and the diff, and it reports findings like the other reviewers.
Be specific: name the kinds of problems, where to trace them, and what doesn't count. It starts running once there's
text under these headings. Comments like this one are left out.
-->

## Look for

## Leave alone
`;

/** A new agent's options: a reviewer with the usual limits, on the default harness. */
export function newAgentSettings(name: string, focus: string): AgentSettings {
  return { name, focus, enabled: true, maxFindings: 5, minConfidence: "minor", skip: ["**/*.lock"], runsWhen: [], harness: "", model: "", instructions: "" };
}
