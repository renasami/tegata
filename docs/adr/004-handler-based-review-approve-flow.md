# ADR-004: Handler-based Review/Approve Flow

**Status**: Accepted
**Date**: 2026-04-15
**Author**: Ren Asami

## Context

The `review` and `approve` tiers in `runtime.ts` return `status: "pending"` with a "not yet implemented" stub. To progress toward the MCP binding (v0.1 scope), these tiers need functional handler-based approval flows.

The design must address:

1. Where handlers are attached (per-policy vs. global config)
2. How handler requirements are enforced (runtime validation vs. type system)
3. What handlers return (full `DecisionStatus` vs. restricted result)
4. How timeouts are managed
5. How `PolicyRule` accommodates tier-specific fields without optional-field sprawl

## Decision

### PolicyRule as discriminated union

Split `PolicyRule` into three discriminated variants keyed on `tier`:

- `AutoPolicy`: `tier: "auto" | "notify"` — no handler, no timeout
- `ReviewPolicy`: `tier: "review"` — `handler: ReviewHandler` required
- `ApprovePolicy`: `tier: "approve"` — `handler: ApprovalHandler` required

This ensures at the type level that review/approve policies always have a handler. `addPolicy({ match: "db:*:write", tier: "review" })` without a handler is a compile error — no runtime validation needed.

### Handler on policy, not config

Handlers are defined per-policy, not globally on `TegataConfig`. Different policies may route to different review channels (Slack approval for deploys, email for PII access). A global handler would force callers to multiplex internally.

### Restricted handler return type

Handlers return `ReviewResult`: `{ status: "approved" | "denied"; decidedBy: string; reason?: string }`. Escalation (`"escalated"`) and timeout (`"timed_out"`) are not valid handler outputs — these are runtime transitions managed by Tegata. This separation keeps handlers simple and prevents them from bypassing Tegata's governance logic.

### Separate ReviewHandler / ApprovalHandler types

`ReviewHandler` and `ApprovalHandler` are distinct type aliases despite identical shape today. Review (agent-to-agent) and approve (human-in-the-loop) flows will diverge in v0.2+ (e.g., approval may require MFA challenge, review may support delegation). Separate types now prevent a breaking change later.

### Timeout via Promise.race

Tegata manages timeouts with `Promise.race([handler(proposal), timeoutPromise])`. Policy-level `timeoutMs` overrides `TegataConfig.timeoutMs`. On timeout, behavior follows `defaultOnTimeout`: `"deny"` → `timed_out`, `"escalate"` → `escalated`. No retry — the caller can re-propose if needed.

### Decision.decidedBy

`Decision` gains a `decidedBy: string | undefined` field (not optional — `exactOptionalPropertyTypes` requires explicit `undefined` assignment). Set to the handler's `ReviewResult.decidedBy` on review/approve, `undefined` for auto/notify/escalation.

## Alternatives Considered

### Alternative A: Flat PolicyRule with optional handler

Keep `PolicyRule` as a single type with `handler?: ReviewHandler`. Validate at runtime that review/approve policies have a handler.

- Pros: Smaller type diff, backwards-compatible
- Cons: Runtime validation for something the type system should enforce; `handler` being optional means every consumer must null-check; violates the project's TypeScript-strict philosophy (same reasoning as ADR-001)
- Why rejected: The project has established the principle of pushing invariants into types (ADR-001 removed `escalate` from `ApprovalTier` for the same reason). A discriminated union is the idiomatic TypeScript solution.

### Alternative B: Handler on TegataConfig

Single global `reviewHandler` and `approvalHandler` on config.

- Pros: Simple setup for the common case (one review channel for everything)
- Cons: Forces handler multiplexing for multi-channel setups; handler and policy are logically coupled (policy defines _who_ reviews, handler defines _how_); config becomes a bag of unrelated concerns
- Why rejected: Policy-level handlers compose better. A global handler can still be shared by passing the same function reference to multiple policies.

### Alternative C: Handler returns full DecisionStatus

Handler returns `DecisionStatus` including `"escalated"` and `"timed_out"`.

- Pros: Maximum flexibility for handler authors
- Cons: Handlers could return `"escalated"` or `"timed_out"`, bypassing Tegata's timeout management and escalation logic; `"pending"` as a handler return is meaningless; violates separation of concerns
- Why rejected: Handlers answer "should this be approved?", not "what should the governance framework do?". Restricting the return type keeps this boundary clean.

## Consequences

### Positive

- Review/approve policies without handlers are compile errors — impossible to create
- Handler return type is minimal and cannot bypass governance logic
- Policy-level timeout override enables fine-grained control (quick Slack approval vs. slow email approval)
- Discriminated union enables exhaustive switch checks in `resolvePolicy` and `propose()`
- `decidedBy` on Decision provides audit trail attribution

### Negative

- Existing code that constructs `PolicyRule` with `tier: "review"` must now include a `handler` — breaking change (acceptable since v0.1 has no external consumers)
- `structuredClone` cannot clone functions, so `addPolicy` needs a custom `clonePolicyRule` helper that clones data fields and preserves handler references

### Risks

- Handler authors may be surprised that timeout/escalation are not handler concerns. Mitigated by clear JSDoc and error messages.
- Policy-level `timeoutMs` override could lead to inconsistent timeout behavior across policies. This is intentional — different approval channels have different SLAs.

## PR Strategy

Single PR for this changeset. The total diff is ~300 lines across 5 files, and the changes are tightly coupled: types define the discriminated union → policy engine resolves handler/timeoutMs → runtime executes handlers. Splitting types from runtime would leave an intermediate state where `structuredClone` fails on handler-bearing policies.

Structured commits for reviewability:

1. `types.ts` — handler types + PolicyRule discriminated union + `Decision.decidedBy`
2. `policy-engine.ts` + `policy-engine.test.ts` — ResolvedPolicy extension + switch-based resolvePolicy
3. `runtime.ts` + `runtime.test.ts` — `clonePolicyRule`, `executeHandler`, propose() rewrite
4. ADR-004

## References

- Tegata ADR-001: Precedent for pushing invariants into the type system
- Tegata ADR-003: Event-sourcing model that this builds on (`proposed → pending → decided`)
- [HumanLayer](https://github.com/humanlayer/humanlayer): Prior art for handler-based human approval in AI tool calls
