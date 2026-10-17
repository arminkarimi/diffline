// A line-for-line port of computeRisk in packages/review-ui/app.js, so the sidebar shows the same score as the page.
// Change both together; test/risk.test.ts checks they agree.

import type { Risk, RiskInput } from "./types.ts";

const RISK_AREAS = [
  { id: "auth", label: "Sign-in and session code", p: 0.25, extra: /sign-?in|sign-?up|two-?factor/i,
    words: ["auth", "authentication", "authorization", "session", "sessions", "login", "logout", "password", "passwords", "oauth", "jwt", "mfa", "2fa", "cookie", "cookies"] },
  { id: "secrets", label: "Secrets and encryption", p: 0.25, extra: /encrypt|decrypt|cipher|credential|secret/i,
    words: ["crypto", "cipher", "encrypt", "encryption", "decrypt", "credential", "credentials", "secret", "secrets", "kms", "vault"] },
  { id: "payments", label: "Payments", p: 0.25, extra: undefined,
    words: ["payment", "payments", "charge", "charges", "billing", "invoice", "invoices", "stripe", "checkout", "subscription", "subscriptions", "refund", "refunds"] },
  { id: "data", label: "Data migrations", p: 0.2, extra: /\.sql$|(^|\/)migrations?\//i,
    words: ["migration", "migrations", "migrate", "schema"] },
  { id: "api", label: "Public API", p: 0.1, extra: undefined,
    words: ["controller", "controllers", "route", "routes", "api", "graphql", "resolver", "resolvers", "mutation", "mutations", "handler", "handlers"] },
];
const FINDING_WEIGHT: Record<string, number> = { high: 0.25, medium: 0.12, low: 0.04 };
export const RISK_WORD = { low: "Low", medium: "Medium", high: "High" } as const;
const riskLevel = (score: number): Risk["level"] => (score >= 65 ? "high" : score >= 35 ? "medium" : "low");
const pathTokens = (path: string) => path.split(/[\/._-]+|(?=[A-Z][a-z])/).map((t) => t.toLowerCase()).filter(Boolean);
const isTestPath = (path: string) => /\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e[\w-]*|specs?)\//i.test(path);
const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : many || one + "s"}`;

function areasOf(path: string) {
  const tokens = new Set(pathTokens(path));
  return RISK_AREAS.filter((a) => a.words.some((w) => tokens.has(w)) || (a.extra && a.extra.test(path)));
}

export function computeRisk(input: RiskInput): Risk {
  const changed = (input.files || []).filter((f) => !f.generated);
  const source = changed.filter((f) => !isTestPath(f.path));
  const tests = changed.filter((f) => isTestPath(f.path));
  const factors: Risk["factors"] = [];
  const add = (id: string, label: string, detail: string, p: number, extra: { files?: string[] } = {}) => {
    if (p > 0) factors.push({ id, label, detail, p: Math.min(0.95, p), points: 0, ...extra });
  };

  for (const area of RISK_AREAS) {
    const hit = source.filter((f) => areasOf(f.path).includes(area));
    if (hit.length) add(`area-${area.id}`, area.label, hit.length === 1 ? hit[0].path.split("/").pop()! : plural(hit.length, "file"), area.p, { files: hit.map((f) => f.path) });
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
  if (stale.length) add("tests-stale", `${plural(stale.length, "test file")} not updated`, stale.slice(0, 3).map((f) => f.tests!.path.split("/").pop()).join(", "), 1 - Math.pow(0.96, stale.length), { files: stale.map((f) => f.path) });
  const c = input.checks || { total: 0, failed: 0, running: 0 };
  if (c.failed) add("checks-failed", `${plural(c.failed, "check")} failing`, "", 0.12);
  else if (c.running) add("checks-running", `${plural(c.running, "check")} still running`, "", 0.02);

  const score = Math.round(100 * (1 - factors.reduce((keep, f) => keep * (1 - f.p), 1)));
  const weight = factors.reduce((sum, f) => sum - Math.log(1 - f.p), 0) || 1;
  factors.forEach((f) => {
    f.points = Math.round((-Math.log(1 - f.p) / weight) * score);
  });
  const drift = score - factors.reduce((sum, f) => sum + f.points, 0);
  if (factors.length && drift) factors.reduce((a, b) => (b.points > a.points ? b : a)).points += drift;
  factors.sort((a, b) => b.points - a.points);
  return { score, level: riskLevel(score), factors, lines };
}
