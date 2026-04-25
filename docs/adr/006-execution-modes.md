# ADR-006: Execution Modes — Shadow vs Enforce

**Status**: Accepted
**Date**: 2026-04-26
**Author**: Ren Asami

## Context

Dogfooding Tegata against Claude Code (PR #15-#17) surfaced a recurring
question: when a `decision.status` comes back `denied` or `escalated`,
should the host harness actually block the action, or just log what
Tegata _would_ have done?

Both answers are valid for different stages of adoption:

- **Day 1**: an operator wants to install Tegata on a real workload to
  see whether the classification table and policies match reality, _without_
  risking blocking legitimate work. They need observation, not enforcement.
- **Day N**: once the policies are tuned, the operator wants Tegata's
  verdicts to actually fire — denied means denied.

The Claude Code hook (`tools/claude-code-hook.mjs`) already implements
this split via the `TEGATA_HOOK_ENFORCE` environment variable, with
"shadow" being the default. The published sample log
(`docs/samples/shadow-mode-claude-code.jsonl`, 121 entries, 95% auto-
approved / 5% escalated, captured 2026-04-19→04-20) is the artifact that
made shadow mode valuable: the operator could ship Tegata, observe
behavior on real traffic, and only then decide whether to enforce.

This ADR formalizes the contract so the same pattern applies to other
bindings (the future LangGraph adapter, OpenAI Agents SDK adapter, MCP
server binding) and so the semantics aren't reinvented per integration.

## Decisions

### Two named modes: `shadow` and `enforce`

The execution mode is a first-class concept with exactly two values in
v0.1:

- **`enforce`** (default): callers MUST honor `decision.status`. If
  Tegata returns `denied` or `escalated`, the host harness blocks the
  action. This is the mode that delivers the governance guarantee.
- **`shadow`**: callers MUST allow the action through regardless of
  `decision.status`. The decision is recorded for analysis. No action
  is ever blocked by Tegata in this mode.

**Why**: Two modes covers the "observe → enforce" rollout that emerged
naturally from dogfooding. Three or more modes (e.g. an "advisory" mode
that warns but doesn't block) add operator-facing complexity for
marginal benefit — `shadow` already supports observation. Keeping the
set small means binding authors have an unambiguous contract.

A future `dry-run` mode (skip side effects but execute policy
evaluation against a synthetic state) is anticipated but explicitly out
of scope for v0.1 — see Alternatives.

### Mode lives on `TegataConfig` (not on each `propose()` call)

`TegataConfig` gains a `mode?: "shadow" | "enforce"` field. The default
when omitted is `"enforce"`.

```typescript
export type TegataConfig = {
  defaultTier?: ApprovalTier;
  escalateAbove?: number;
  timeoutMs?: number;
  defaultOnTimeout?: TimeoutBehavior;
  mode?: "shadow" | "enforce"; // NEW — default "enforce"
};
```

**Why**: Mode is a deployment-time decision, not a per-call decision.
A caller flipping mode mid-run would produce an incoherent audit log
("did we actually block this one or not?"). Pinning mode to the
`Tegata` instance also matches the operator's mental model: the same
service runs in shadow during rollout, then the operator restarts with
enforce. Per-call override is rejected for the same reason a
per-statement DB transaction isolation override is rejected — it lets
inconsistency leak into the system of record.

### Tegata core does NOT alter `decision.status` based on mode

Even in shadow mode, `tegata.propose()` returns the same
`Decision.status` it would in enforce mode. Mode is metadata; it does
not change the verdict.

**Why**: The whole point of shadow mode is to capture _what would have
happened_. If shadow mode rewrote `denied` → `approved` inside core,
the audit log would lose the signal that motivates running in shadow
mode in the first place. Putting the decision in the core's hands and
the _enforcement_ in the binding's hands keeps the two responsibilities
separate and testable.

This means binding authors are responsible for honoring mode. The
contract is:

| Mode      | Binding behavior on `denied` / `escalated`       |
| --------- | ------------------------------------------------ |
| `enforce` | Block the action (exit 2, throw, return error).  |
| `shadow`  | Allow the action. Log the decision. Never block. |

### Audit log writes are mode-independent (MUST)

Every `Decision` is written to the audit log in both modes, with no
omitted fields. The audit entry MUST include the mode it was decided
under so log readers can unambiguously distinguish "this was approved"
from "this was denied but allowed because shadow mode."

**Why**: The audit log is the system of record. Skipping writes in
shadow mode would defeat the purpose of running in shadow mode (you
literally cannot analyze what happened). Skipping writes in enforce
mode would create a governance gap. Mode is data, not a feature flag
on logging.

The current Claude Code hook already does this — every line in
`docs/samples/shadow-mode-claude-code.jsonl` carries `"mode": "shadow"`
and the full decision payload, regardless of verdict.

### Bindings expose mode through a binding-native channel

Each binding chooses how the operator selects mode, but the mapping to
`TegataConfig.mode` is mechanical:

- **Claude Code hook**: `TEGATA_HOOK_ENFORCE=1` env var sets
  `mode: "enforce"`; absent means `mode: "shadow"`. (Current behavior;
  ADR-006 documents it as the formal contract rather than an ad hoc
  choice.)
- **MCP binding (`TegataServer`)**: the operator constructs a `Tegata`
  instance with the desired `mode` and passes it to the
  `TegataServer(mcp, tegata, config)` constructor. Mode is read off
  the supplied instance — there is no separate `TegataServer`-level
  mode option. (Today the wrapper denies all non-`approved` decisions
  unconditionally; honoring `mode` here is the follow-up implementation
  work tracked alongside `TegataConfig.mode`.)
- **Programmatic users**: pass `mode` directly in `new Tegata({ mode })`.

**Why**: Operators interact with bindings, not core. A hook user
shouldn't have to learn `TegataConfig` to flip enforcement; an env var
is enough. But under the hood, every binding routes to the same
`TegataConfig.mode`, so the semantics stay identical.

### Hook exit-code protocol (informative)

For exec-style bindings (Claude Code's `PreToolUse`, generic CLI
adapters), the convention is:

| Exit code | Meaning                                             |
| --------- | --------------------------------------------------- |
| `0`       | Allow the tool call.                                |
| `2`       | Block the tool call. Stderr explains why.           |
| Other     | Treated as fail-open (allow). Hook bug, not a deny. |

In `shadow` mode, exit is always `0`. In `enforce` mode, exit is `2`
when `decision.status` is `denied` or `escalated`.

**Why**: This matches Claude Code's existing hook exit-code semantics
and keeps the failure mode safe — a buggy hook that crashes does not
wedge the host agent. The fail-open default is a conscious tradeoff:
availability beats enforcement when the enforcement layer itself is
broken. Operators who need fail-closed should run Tegata as a daemon
with a separate health check, not as a per-call exec hook.

## Alternatives Considered

### Alternative A: Single mode (always enforce)

Drop shadow mode entirely. Operators wanting observation can wrap
`propose()` themselves and ignore the verdict.

- Pros: Simpler core API; one fewer config knob.
- Cons: Every binding author would invent its own shadow mechanism,
  with subtly different semantics (does shadow log? does it skip the
  policy evaluation? does it still consume `timeoutMs`?). The Claude
  Code hook already proved the demand exists.
- Why rejected: Centralizing the contract is the whole reason this is
  a protocol-level concern, not a per-binding concern.

### Alternative B: Three modes (shadow / advisory / enforce)

Add an `advisory` mode that returns the verdict but emits a warning
instead of blocking, distinct from shadow's "silent observation."

- Pros: Could match enterprise rollout patterns (warn-then-enforce).
- Cons: Distinction between shadow and advisory is a UI concern of the
  host harness, not a Tegata concern. A binding can implement
  "advisory" by running in shadow mode and printing a warning when
  `status !== "approved"` — no protocol change needed.
- Why rejected: Advisory mode is implementable on top of shadow mode
  by any binding that wants it. Adding it to core would inflate the
  contract without adding capability.

### Alternative C: Per-call `mode` parameter

Allow `tegata.propose({ ..., mode: "shadow" })` for ad hoc overrides.

- Pros: Lets a single Tegata instance serve mixed traffic (e.g. shadow
  for one agent, enforce for another).
- Cons: Audit log readers can no longer answer "was Tegata enforcing
  at time T?" without inspecting every entry. Reasoning about the
  system becomes case-by-case rather than property-of-the-deployment.
- Why rejected: Mixed-mode deployments can be modeled as two Tegata
  instances with different configs sharing one audit sink. The
  per-call override imports the complexity of mixed mode into every
  caller, even those that don't need it.

### Alternative D: `dry-run` mode in v0.1

Add a third mode where Tegata evaluates policies but the host harness
also skips the action's side effects (used for testing policy changes
against a synthetic workload).

- Pros: Useful for policy authoring.
- Cons: Requires the host harness to know how to "skip side effects"
  — which is action-specific (e.g. how do you dry-run an `Edit`?).
  This is a host-harness concern, not a Tegata-core concern.
- Why deferred: Out of scope for v0.1. May reappear as a binding-level
  feature once we have more bindings and can see if the pattern
  generalizes.

## Consequences

### Positive

- New bindings have an unambiguous mode contract — no rediscovering
  shadow/enforce semantics per integration.
- The Day-1-observe / Day-N-enforce rollout that worked well for the
  Claude Code hook is now a documented pattern, not a happy accident.
- Audit log analysis tools (`scripts/analyze-audit-log.mjs`) can rely
  on `mode` being present in every entry to bucket shadow vs enforce
  decisions.
- Operators get a single mental model: pick a mode at deploy time, the
  binding handles the rest.

### Negative

- `TegataConfig` gains a field — a minor API surface increase. Mitigated
  by the field being optional with a sensible default (`"enforce"`).
- Binding authors have a new contract to honor. The Claude Code hook
  is the only binding that implements shadow/enforce today; the MCP
  binding currently denies all non-`approved` decisions unconditionally
  and will need follow-up work to read `mode` off its `Tegata` instance.
  Future bindings will need to honor the contract from day one, and
  reviewers must check for it.
- The default of `"enforce"` differs from the Claude Code hook's
  default of `"shadow"`. This is intentional — programmatic users
  reaching for `new Tegata()` typically want governance to fire, while
  hook users typically want to observe first. The discrepancy is
  resolved at the binding layer, not in core.

### Risks

- Operators may forget to flip from shadow to enforce after rollout,
  leaving themselves with audit-only "governance" indefinitely.
  Mitigated today only by the binding-specific docs
  (`docs/dogfooding.md`) explicitly calling out the flip step.
  `scripts/analyze-audit-log.mjs` does not yet surface the `mode`
  field in its summary — adding a mode-bucketed breakdown is a small
  follow-up that should ship with the `TegataConfig.mode`
  implementation PR so the mitigation actually exists in code.
- A binding that incorrectly ignores mode (e.g. enforces in shadow, or
  fails to enforce in enforce) silently breaks the contract. Mitigated
  by binding-level integration tests that assert mode-honoring
  behavior — to be added alongside each binding.
