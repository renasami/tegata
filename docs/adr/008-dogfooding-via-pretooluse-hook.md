# ADR-008: Dogfood Tegata via Claude Code `PreToolUse` Hook

**Status**: Accepted
**Date**: 2026-05-05
**Author**: Ren Asami

## Context

By the time the core runtime, policy engine, MCP binding, and audit
log were all green in CI (PRs #1–#12), the project had ~250 tests
passing — but no real signal that Tegata classified _real_ workloads
correctly. Synthetic tests prove the implementation matches the spec;
they cannot prove that the spec's `riskScore` table, `escalateAbove`
default, or classification heuristics actually map to behavior an
operator would accept.

The author needed a workload that was:

1. **Adversarial enough to be interesting** — i.e. issuing a
   continuous mix of safe (read), borderline (write), and dangerous
   (`rm -rf`, `git push --force`) calls without prompting.
2. **Real, not synthetic** — so misclassifications would be caught by
   actual annoyance, not by reading audit logs after the fact.
3. **Available daily without setup overhead** — so the dogfooding
   cost stayed near zero per session.

The author's own Claude Code sessions match all three. Claude Code
fires a `Bash`, `Edit`, `Write`, `Read`, `Task`, `WebFetch`, or
`mcp__*__*` call several hundred times per working day across a
representative mix of risk levels, against the actual codebase the
author cares about. If Tegata's classifications and policies don't
match the author's intuitions on _his own work_, they will not match
anyone else's on theirs.

This ADR records the design of the dogfooding integration shipped in
PRs #15–#17 and the published audit sample (PR #17), so the same
constraints carry forward as new bindings (LangGraph, OpenAI Agents
SDK, etc.) get their own dogfooding harnesses.

## Decision

**Run Tegata against the author's Claude Code via a `PreToolUse` hook
that loads the published `dist/`, classifies the call, calls
`tegata.propose()`, and appends the full decision to a JSONL audit
log. Default to shadow mode. Fail open on every error path.**

The implementation lives at
[`tools/claude-code-hook.mjs`](../../tools/claude-code-hook.mjs) and
the operator-facing setup at
[`docs/dogfooding.md`](../dogfooding.md). A real 121-entry sample log
captured from the author's own sessions is committed at
`docs/samples/shadow-mode-claude-code.jsonl`.

### `PreToolUse`, not `PostToolUse`

The hook fires before the tool call executes and can block it (in
enforce mode) by exiting 2.

**Why**: Tegata is a pre-execution approval primitive. Auditing what
already happened is interesting but doesn't exercise the actual
control path. `PreToolUse` lets the dogfooding integration test the
exact code path a production binding would use — propose, evaluate,
return a verdict, and act on it.

### Import from `dist/`, not from source

The hook does `import("../dist/index.js")` rather than running
TypeScript via a loader.

**Why**: The bundle in `dist/` is bit-for-bit what gets published to
npm as `tegata@preview`. Dogfooding the source would catch logic
bugs but miss packaging bugs (missing `exports`, broken type
declarations, accidental dev-dependency imports). Loading from `dist`
catches "ships broken to users" bugs the same day they're introduced.

### Fail-open everywhere except Tegata's own verdicts

Every error path (bad stdin JSON, missing `dist`, broken
`classify.mjs`, disk-full on audit write) exits 0. Only an actual
`denied`/`escalated` `Decision` from `tegata.propose()` can produce a
non-zero exit, and only in enforce mode.

**Why**: Dogfooding a governance SDK must never degrade the host
agent's reliability. If Tegata itself crashes on a malformed
`PreToolUse` payload, the author loses minutes of work and learns to
disable the hook — which kills the dogfooding signal entirely. The
reliability cost of fail-open (a missed log line) is much smaller
than the reliability cost of fail-closed (a wedged Claude Code
session).

This is consistent with the exit-code protocol formalized in
[ADR-006](006-execution-modes.md): exit 2 means "Tegata says no";
any other failure means "fail-open, allow the tool call."

### Default to shadow mode

The hook defaults to `TEGATA_HOOK_ENFORCE` unset → shadow mode.
Operators (including the author on Day 1) opt into enforcement
explicitly.

**Why**: On Day 1 the classification table is unproven. Running
enforce-by-default would block the author's own work the first time
the table is wrong, training the author to disable the hook before
the data is collected. Shadow-by-default lets the operator collect a
representative sample first, _then_ flip to enforce once the
classification matches reality. ADR-006 generalizes this pattern;
this ADR records the original instance that motivated it.

### Classification table lives in a separate, testable module

Tool-name-and-args → `(actionType, riskScore)` mapping is in
`tools/lib/classify.mjs` with 107 dedicated tests in
`tools/lib/classify.test.mjs` (PR #16).

**Why**: The classification table is the part of the dogfooding
integration most likely to drift as Claude Code adds new tool types
or as operator intuition refines. Keeping it in a small, pure module
with its own test suite means the table can be edited by anyone,
reviewed in isolation, and ported to other host harnesses (Cursor,
Aider, etc.) without dragging the hook plumbing along.

### Append-only JSONL audit log at a stable path

The hook writes to `~/.claude/tegata-audit.jsonl`, one JSON object per
line, never updated after write.

**Why**: Append-only JSONL is the lowest-tech format that supports
both ad hoc inspection (`jq` one-liners) and the bundled analyzer
(`scripts/analyze-audit-log.mjs`). The file is safe to truncate or
rotate any time — nothing else reads it. A SQLite database or
proprietary format would buy nothing for the dogfooding use case and
would force operators to install tooling.

### Commit a real sample log to the repo

`docs/samples/shadow-mode-claude-code.jsonl` (121 entries, captured
2026-04-19→04-20) is committed alongside the analyzer and a README
explaining how it was produced.

**Why**: Public material claiming "we run this on ourselves" needs an
artifact to back it up. The sample log is also the best
classification-tuning corpus the project has — anyone proposing a
change to `riskScore` defaults can rerun the analyzer against the
sample and show the delta, instead of arguing from intuition.

## Alternatives Considered

### Alternative A: Synthetic benchmark suite

Build a fixture with 1000 representative tool calls and run
`tegata.propose()` against each.

- Pros: Deterministic, runnable in CI, no host-agent dependency.
- Cons: Proves nothing about real workloads. The fixture itself
  becomes the spec — it can't catch the case where the spec is
  wrong about reality. No usability signal (an author irritated by
  a bad classification is louder feedback than a green test).
- Why rejected: Tegata already has ~250 synthetic tests. Adding a
  thousand more wouldn't surface what dogfooding surfaces.

### Alternative B: MCP server proxy

Build a man-in-the-middle MCP server that intercepts every
`tools/call` going to a real MCP server and runs Tegata on it.

- Pros: Tests the actual MCP binding (`TegataServer`) end-to-end.
- Cons: Only covers MCP traffic. Claude Code's actual workload is
  dominated by `Bash`, `Edit`, `Write`, `Read` — none of which go
  through MCP. A proxy would dogfood ~10% of the surface area.
- Why rejected: The risky calls (`rm -rf`, `git push --force`) are
  the ones that don't go through MCP. Missing them would miss the
  point.

### Alternative C: Wrapper CLI around Claude Code

Ship a `tegata-claude` binary that proxies stdin/stdout to Claude Code
and intercepts tool calls there.

- Pros: Works for any host that exposes a CLI.
- Cons: Intrusive — operator has to change their entry point. Breaks
  the existing Claude Code UX. Couples Tegata's release cadence to
  Claude Code's CLI surface.
- Why rejected: `PreToolUse` is the supported integration point.
  Building a wrapper to avoid a supported hook is reinventing the
  wheel.

### Alternative D: `PostToolUse` only

Use `PostToolUse` to audit what already executed, skip pre-execution
control entirely.

- Pros: Strictly safer — no chance of blocking real work.
- Cons: Doesn't exercise the "Tegata returns denied → host blocks
  the call" code path, which is the whole product. Audit-only is a
  log shipper, not a governance SDK.
- Why rejected: Shadow-mode `PreToolUse` already gives "audit-only
  on Day 1" without giving up the ability to flip to enforce. The
  enforce path is the value.

### Alternative E: Test against a different host (Cursor, Aider)

Pick a host other than Claude Code for the first dogfooding
integration.

- Pros: Avoids any "the author only tests on his own tool" critique.
- Cons: The author doesn't use those tools daily, which kills the
  "real workload" requirement.
- Why deferred: Adding a second host is cheap once `classify.mjs` is
  factored out (PR #16 already did the factoring). The first host
  needs to be the one the author actually uses.

## Consequences

### Positive

- Every commit on `main` has implicitly been governed by Tegata
  during development. The author's own audit log is the project's
  primary "does this thing work?" evidence.
- The published sample log gives prospective users a concrete answer
  to "what does running Tegata feel like?" without making them
  install anything.
- The shadow → enforce rollout pattern (ADR-006) is grounded in the
  real experience of doing it on this hook, not in theoretical
  rollout planning.
- New bindings (LangGraph, OpenAI Agents SDK) inherit a working
  template: load published bundle, classify, propose, log JSONL,
  fail-open, default shadow.

### Negative

- The `dist/` import path means a missing or broken build silently
  no-ops the hook (fail-open), while a stale-but-loadable build runs
  outdated logic against current tool calls. Mitigated by a banner
  in `docs/dogfooding.md` reminding operators to `pnpm run build`
  after pulling. The missing-build case is not a correctness bug —
  just a missed log line — but the stale-build case can produce
  audit entries that disagree with the published runtime, so
  operators rebuilding after pulling matters.
- Each tool call spawns `node` and re-imports `dist/index.js` (~100–
  300 ms). Acceptable for an interactive coding session; not
  acceptable for a high-throughput agent. A long-lived daemon
  binding is anticipated but explicitly not in v0.1 scope.
- The classification table is tuned to the author's intuitions. Other
  operators may legitimately disagree (e.g. `git push` at 71 vs 60).
  Mitigated by the table being in `tools/lib/classify.mjs` —
  operators can fork it without touching the hook plumbing — and by
  Tegata's policy system letting operators override per-action
  without editing the hook at all.

### Risks

- The author's daily workload is not a representative sample of all
  agent workloads. A sample dominated by `git`, `pnpm`, and `Edit`
  may underweight risks that are common in other domains (e.g. SQL
  execution agents, financial-trading agents). Mitigated by
  treating the sample log as illustrative, not normative — it's a
  worked example, not a benchmark.
- Bundling a real audit log in the repo could leak sensitive paths
  or session metadata. The schema records `cwd`, `session_id`, tool
  name, classification, and decision — but never tool args or
  stdout, so the blast radius is limited to filesystem paths and
  opaque session identifiers. Mitigated by manual review before
  commit (PR #17 review pass): the published sample's `cwd` values
  were spot-checked, and operators concerned about path disclosure
  in their own audit logs can rotate or scrub
  `~/.claude/tegata-audit.jsonl` at any time without breaking
  anything.

## References

- PR #15: feat(dogfooding): Claude Code PreToolUse hook that runs Tegata on self
- PR #16: refactor(dogfooding): extract classify logic and add 107 tests
- PR #17: docs: commit real shadow-mode audit log + analyzer
- [ADR-006: Execution modes — shadow vs enforce](006-execution-modes.md) — generalizes the shadow-default-then-enforce pattern this hook originated.
- [Claude Code Hooks documentation](https://docs.claude.com/en/docs/claude-code/hooks) — `PreToolUse` event contract.
- [`docs/dogfooding.md`](../dogfooding.md) — operator-facing setup guide.
- [`docs/samples/shadow-mode-claude-code.jsonl`](../samples/shadow-mode-claude-code.jsonl) — real 121-entry audit log produced by this hook.
