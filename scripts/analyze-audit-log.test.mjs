import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("./analyze-audit-log.mjs", import.meta.url),
);

const dir = mkdtempSync(join(tmpdir(), "tegata-analyze-"));

// Run the analyzer script against a JSONL fixture and return its stdout.
const run = (entries) => {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
  return execFileSync("node", [scriptPath, file], { encoding: "utf8" });
};

const entry = (mode, status = "approved") => ({
  ts: "2026-04-19T17:04:47.832Z",
  tool_name: "Read",
  action_type: "read:fs:read",
  risk_score: 5,
  decision_status: status,
  mode,
});

describe("analyze-audit-log: execution mode breakdown", () => {
  it("warns when every entry is shadow", () => {
    const out = run([entry("shadow"), entry("shadow"), entry("shadow")]);
    expect(out).toContain("Shadow:     3 (100.0%)");
    expect(out).toContain("Enforce:    0 (0.0%)");
    expect(out).toContain("verdicts are NOT being enforced");
  });

  it("does not warn when any entry is enforce", () => {
    const out = run([entry("shadow"), entry("enforce")]);
    expect(out).toContain("Shadow:     1 (50.0%)");
    expect(out).toContain("Enforce:    1 (50.0%)");
    expect(out).not.toContain("NOT being enforced");
  });

  it("buckets missing/unknown mode under (other)", () => {
    const out = run([
      entry("enforce"),
      entry(undefined), // pre-ADR-006 entry: no mode field
      { ...entry("dry-run"), mode: "dry-run" }, // unknown future value
    ]);
    expect(out).toContain("(other):    2");
    expect(out).toContain("[no/unknown mode]");
  });

  it("omits the (other) line when all entries have a known mode", () => {
    const out = run([entry("enforce"), entry("shadow")]);
    expect(out).not.toContain("(other):");
  });
});
