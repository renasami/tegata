# ADR-001: Remove `escalate` from ApprovalTier

**Status**: Accepted
**Date**: 2026-04-10
**Author**: Ren Asami

## Context

Tegata's README documents 5 approval tiers: `auto`, `notify`, `review`, `approve`, `escalate`. The initial `types.ts` implemented this as:

```typescript
export type ApprovalTier = "auto" | "notify" | "review" | "approve" | "escalate";
```

However, `auto` through `approve` answer "who decides?" — they describe the authorization level required. `escalate` answers "what happened?" — it describes a runtime transition when the current decision-maker cannot handle the proposal (e.g., riskScore exceeds `escalateAbove`, or the reviewer lacks capability).

This mismatch means `PolicyRule.tier = "escalate"` is semantically meaningless — if you know it needs escalation upfront, you should specify the target tier directly. Allowing it in the type forces runtime validation to reject what the type system should prevent.

## Decision

Remove `escalate` from `ApprovalTier`. Escalation is expressed only through `DecisionStatus = "escalated"`, which already exists.

```typescript
export type ApprovalTier = "auto" | "notify" | "review" | "approve";
```

## Alternatives Considered

### Alternative A: Keep `escalate` in ApprovalTier, validate at runtime

- Description: Leave the 5-member union, add runtime check that rejects `PolicyRule.tier = "escalate"`
- Pros: 1:1 mapping with README's 5-tier table; no documentation drift
- Cons: Relies on runtime validation for something the type system should enforce; violates TypeScript strict-mode philosophy; `TegataConfig.defaultTier = "escalate"` would also need runtime rejection
- Why rejected: Working around the type system is a code smell. README's conceptual table doesn't need to mirror the TypeScript type exactly.

### Alternative B: Model `escalate` as a separate tier type

- Description: `type EscalationTier = "escalate"`, `type AnyTier = ApprovalTier | EscalationTier`, use `AnyTier` in `Decision.tier` and `ApprovalTier` in `PolicyRule.tier`
- Pros: Type-safe distinction; explicit in the type system
- Cons: Two tier types adds complexity for a single variant; `Decision.tier` would need `AnyTier` which leaks `escalate` into places that don't need it
- Why rejected: Over-engineering. `DecisionStatus = "escalated"` already captures this.

## Consequences

### Positive

- `PolicyRule.tier` and `TegataConfig.defaultTier` are guaranteed valid at compile time — no runtime validation needed
- Clear separation: `ApprovalTier` = policy declaration, `DecisionStatus` = runtime outcome

### Negative

- README's 5-tier table no longer maps 1:1 to a single TypeScript type. Documentation must clarify that `escalate` is a runtime behavior, not a configurable tier.

### Risks

- Users reading the README may expect `tier: "escalate"` to work in policy rules. Mitigated by clear error messages if attempted via runtime config objects.

## References

- [MCP Spec — Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation): MCP's approach to requesting additional input, analogous to escalation as a runtime event rather than a declared state
- [CSA Agentic Trust Framework](https://cloudsecurityalliance.org/artifacts/agentic-ai-trust-framework): Maturity levels (Intern→Principal) map to `auto`→`approve`, with escalation as an orthogonal mechanism
