import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { computeRisk } from "../src/risk.ts";
import type { RiskInput } from "../src/types.ts";

test("risk matches the page's computeRisk exactly", async () => {
  const src = await readFile(new URL("../../review-ui/app.js", import.meta.url), "utf8");
  const start = src.indexOf("// Path words that mark code");
  const end = src.indexOf("function currentCheckCounts");
  const sandbox: any = { plural: (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : many || one + "s"}` };
  vm.runInNewContext(`${src.slice(start, end)}; this.pageRisk = computeRisk;`, sandbox);
  const inputs: RiskInput[] = [
    { files: [{ path: "src/auth/session.ts", additions: 120, deletions: 30 }, { path: "src/payments/charge.ts", additions: 40, deletions: 2, tests: { path: "src/payments/charge.test.ts", changed: false } }], findings: [{ severity: "high", state: "open" }, { severity: "low", state: "dismissed" }], checks: { total: 3, failed: 1, running: 0 } },
    { files: [{ path: "README.md", additions: 3, deletions: 1 }], findings: [], checks: { total: 0, failed: 0, running: 0 } },
    { files: Array.from({ length: 25 }, (_, i) => ({ path: `src/api/routes/r${i}.ts`, additions: 50, deletions: 10 })).concat([{ path: "package-lock.json", additions: 900, deletions: 800, generated: true } as any]), findings: [{ severity: "medium", state: "accepted" }], checks: { total: 4, failed: 0, running: 2 } },
  ];
  for (const input of inputs) assert.deepEqual(JSON.parse(JSON.stringify(computeRisk(input))), JSON.parse(JSON.stringify(sandbox.pageRisk(input))));
});
