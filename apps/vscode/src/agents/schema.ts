// JSON Schemas for what each agent returns. Every property is required and optional values are nullable, which
// both Claude's --json-schema and Codex's --output-schema (strict structured outputs) accept.

const str = { type: "string" } as const;
const nstr = { type: ["string", "null"] } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: unknown) => ({ type: "array", items });

const ref = obj({ path: str, match: str, end: nstr });

export const reviewerSchema = obj({
  findings: arr(
    obj({
      severity: { type: "string", enum: ["high", "medium", "low"] },
      confidence: { type: "string", enum: ["High confidence", "Worth asking", "Minor"] },
      label: { type: "string", enum: ["blocking", "question", "suggestion", "nit"] },
      path: str,
      match: str,
      title: str,
      body: str,
      steps: arr(obj({ path: nstr, match: str, text: str })),
      fix: nstr,
      comment: str,
    }),
  ),
  checked: arr(obj({ path: nstr, text: str })),
});

export const guideSchema = obj({
  description: obj({
    kind: { type: "string", enum: ["feature", "fix"] },
    why: str,
    items: arr(
      obj({
        rule: str,
        status: { type: "string", enum: ["covered", "partly", "missing", "none"] },
        quote: nstr,
        note: nstr,
        ask: nstr,
        refs: arr(ref),
      }),
    ),
  }),
  chapters: arr(
    obj({
      title: str,
      note: str,
      source: { type: "string", enum: ["commits", "description", "auto"] },
      sourceText: str,
      files: arr(str),
      quiet: { type: "boolean" },
    }),
  ),
  reasons: arr(str),
  diagrams: arr(
    obj({
      id: str,
      title: str,
      short: str,
      summary: str,
      nodes: arr(
        obj({
          id: str,
          label: str,
          detail: nstr,
          kind: { type: "string", enum: ["step", "actor", "data"] },
          change: { type: ["string", "null"], enum: ["added", "changed", "removed", null] },
          beforeLabel: nstr,
          beforeDetail: nstr,
          refs: arr(ref),
        }),
      ),
      edges: arr(
        obj({
          from: str,
          to: str,
          label: nstr,
          change: { type: ["string", "null"], enum: ["added", "changed", "removed", null] },
        }),
      ),
    }),
  ),
  checked: arr(obj({ path: nstr, text: str })),
});

export const ledeSchema = obj({ lede: str });

/** What a reviewer agent returns (before validation). */
export interface ReviewerOutput {
  findings: Array<{
    severity: "high" | "medium" | "low";
    confidence: "High confidence" | "Worth asking" | "Minor";
    label: "blocking" | "question" | "suggestion" | "nit";
    path: string;
    match: string;
    title: string;
    body: string;
    steps: Array<{ path: string | null; match: string; text: string }>;
    fix: string | null;
    comment: string;
  }>;
  checked: Array<{ path: string | null; text: string }>;
}

export interface GuideOutput {
  description: {
    kind: "feature" | "fix";
    why: string;
    items: Array<{
      rule: string;
      status: "covered" | "partly" | "missing" | "none";
      quote: string | null;
      note: string | null;
      ask: string | null;
      refs: Array<{ path: string; match: string; end: string | null }>;
    }>;
  };
  chapters: Array<{ title: string; note: string; source: "commits" | "description" | "auto"; sourceText: string; files: string[]; quiet: boolean }>;
  reasons: string[];
  diagrams: Array<{
    id: string;
    title: string;
    short: string;
    summary: string;
    nodes: Array<{
      id: string;
      label: string;
      detail: string | null;
      kind: "step" | "actor" | "data";
      change: "added" | "changed" | "removed" | null;
      beforeLabel: string | null;
      beforeDetail: string | null;
      refs: Array<{ path: string; match: string; end: string | null }>;
    }>;
    edges: Array<{ from: string; to: string; label: string | null; change: "added" | "changed" | "removed" | null }>;
  }>;
  checked: Array<{ path: string | null; text: string }>;
}
