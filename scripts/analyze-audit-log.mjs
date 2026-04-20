#!/usr/bin/env node
// Analyze a Tegata shadow-mode audit log (JSONL) and print summary stats.
//
// Usage:
//   node scripts/analyze-audit-log.mjs [path]
//
// Defaults to docs/samples/shadow-mode-claude-code.jsonl. Prints a summary
// table (totals, approval vs escalation rate, top action types by count,
// escalations grouped by action type) that is easy to copy into blog
// posts, READMEs, or Dev Summit slides.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(
  process.argv[2] ?? "docs/samples/shadow-mode-claude-code.jsonl",
);

const lines = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0);

const entries = lines.map((l) => JSON.parse(l));

const total = entries.length;
if (total === 0) {
  console.log(`File:         ${path}`);
  console.log("Range:        (empty)");
  console.log("Total:        0");
  console.log("Approved:     0 (n/a)  [auto-pass]");
  console.log("Escalated:    0 (n/a)  [human/senior needed]");
  console.log("Denied:       0 (n/a)");
  process.exit(0);
}
const approved = entries.filter((e) => e.decision_status === "approved").length;
const escalated = entries.filter(
  (e) => e.decision_status === "escalated",
).length;
const denied = entries.filter((e) => e.decision_status === "denied").length;

const countBy = (key) => {
  const m = new Map();
  for (const e of entries) m.set(e[key], (m.get(e[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const firstTs = entries[0]?.ts;
const lastTs = entries[entries.length - 1]?.ts;

const pct = (n) => ((n / total) * 100).toFixed(1);

console.log(`File:         ${path}`);
console.log(`Range:        ${firstTs} → ${lastTs}`);
console.log(`Total:        ${total}`);
console.log(`Approved:     ${approved} (${pct(approved)}%)  [auto-pass]`);
console.log(
  `Escalated:    ${escalated} (${pct(escalated)}%)  [human/senior needed]`,
);
console.log(`Denied:       ${denied} (${pct(denied)}%)`);
console.log();

console.log("Action types (all):");
for (const [type, n] of countBy("action_type")) {
  console.log(`  ${String(n).padStart(4)}  ${type}`);
}
console.log();

const escalations = entries.filter((e) => e.decision_status === "escalated");
const escByType = new Map();
for (const e of escalations) {
  escByType.set(e.action_type, (escByType.get(e.action_type) ?? 0) + 1);
}
console.log("Escalations by action type:");
for (const [type, n] of [...escByType.entries()].sort((a, b) => b[1] - a[1])) {
  const sample = escalations.find((e) => e.action_type === type);
  console.log(
    `  ${String(n).padStart(4)}  ${type} (riskScore=${sample.risk_score})`,
  );
}
console.log();

const tools = countBy("tool_name");
console.log(`Distinct tools: ${tools.length}`);
console.log("Top 5 by volume:");
for (const [name, n] of tools.slice(0, 5)) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}
