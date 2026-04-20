#!/usr/bin/env node
// Tegata dogfooding hook for Claude Code's PreToolUse event.
//
// Reads PreToolUse JSON from stdin, classifies the tool call into a Tegata
// Action (ActionType + riskScore), calls tegata.propose(), and appends the
// full decision to ~/.claude/tegata-audit.jsonl.
//
// Default mode: SHADOW — always exits 0 regardless of Tegata's decision.
// Tegata's verdict is recorded but never blocks the tool call. Flip to
// enforce mode by setting TEGATA_HOOK_ENFORCE=1 in the environment.
//
// Setup: see docs/dogfooding.md

import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classify } from "./lib/classify.mjs";

const SHADOW_MODE = process.env["TEGATA_HOOK_ENFORCE"] !== "1";
const AUDIT_PATH = join(homedir(), ".claude", "tegata-audit.jsonl");

// Fail-open: on any unexpected internal error (bad stdin JSON, missing dist,
// etc.) we allow the tool call through even in enforce mode. This is a
// deliberate dogfooding trade-off — a broken hook must never wedge the host
// agent. If Tegata's own evaluation returns denied/escalated, that path is
// handled separately below and DOES block in enforce mode.
const safeExit = (_code) => {
  process.exit(0);
};

// ---------------------------------------------------------------
// Read stdin
// ---------------------------------------------------------------

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

const main = async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    safeExit(0);
    return;
  }

  const toolName = input.tool_name ?? "unknown";
  const toolInput = input.tool_input ?? {};
  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();

  // Import Tegata from the built dist — this exercises the real public API
  // that ships on npm. Hook lives at tools/claude-code-hook.mjs, so
  // dist/index.js is one level up.
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = resolve(here, "..", "dist", "index.js");

  let Tegata;
  try {
    // Convert to file:// URL so `import()` works on Windows too —
    // absolute filesystem paths like `C:\...` are rejected by Node's ESM loader.
    ({ Tegata } = await import(pathToFileURL(distEntry).href));
  } catch {
    // If dist is missing or broken, skip silently. This is dogfooding —
    // a broken local build should not derail ongoing work.
    safeExit(0);
    return;
  }

  const tegata = new Tegata({
    defaultTier: "auto",
    escalateAbove: 70,
  });

  const { type, riskScore } = classify(toolName, toolInput);

  const decision = await tegata.propose({
    proposer: "claude-code",
    action: { type, riskScore },
    params: { tool_name: toolName, cwd, session_id: sessionId },
  });

  // Append audit entry
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true });
    appendFileSync(
      AUDIT_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        session_id: sessionId,
        cwd,
        tool_name: toolName,
        action_type: type,
        risk_score: riskScore,
        proposal_id: decision.proposalId,
        decision_status: decision.status,
        decision_tier: decision.tier,
        decision_reason: decision.reason,
        decision_ts: decision.timestamp,
        mode: SHADOW_MODE ? "shadow" : "enforce",
      }) + "\n",
    );
  } catch {
    // Best-effort logging; never fail the hook over disk IO.
  }

  // Shadow mode: always allow, regardless of Tegata verdict.
  if (SHADOW_MODE) {
    process.exit(0);
    return;
  }

  // Enforce mode: block if Tegata denied or escalated.
  if (decision.status === "denied" || decision.status === "escalated") {
    // Use writeSync — `process.stderr.write()` can be async when piped on
    // POSIX, and `process.exit(2)` will truncate the message mid-flight.
    writeSync(
      process.stderr.fd,
      `Tegata blocked this tool call.\n` +
        `  tool: ${toolName}\n` +
        `  action: ${type} (riskScore=${riskScore})\n` +
        `  status: ${decision.status}\n` +
        `  reason: ${decision.reason ?? "unspecified"}\n`,
    );
    process.exit(2);
    return;
  }

  process.exit(0);
};

main().catch(() => {
  safeExit(0);
});
