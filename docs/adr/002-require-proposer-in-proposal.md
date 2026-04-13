# ADR-002: Require `proposer` in Proposal

**Status**: Accepted
**Date**: 2026-04-10
**Author**: Ren Asami

## Context

The initial `Proposal` interface had `proposer?: string` — optional to support the README's Before/After example where `tegata.propose()` is called without specifying a proposer:

```typescript
const result = await tegata.propose({
  action: { type: "db:users:delete", riskScore: 90, reversible: false },
  params: { userId: "all" },
});
```

This creates a problem downstream: `AuditEntry.proposer` becomes `string | undefined`, meaning audit logs can have entries with no attribution. For a governance SDK, unattributed actions undermine the audit trail — one of Tegata's four MUST features.

## Decision

Make `proposer` a required `string` field on `Proposal`. Callers must always identify themselves, even if not a registered agent (e.g., `"human"`, `"ci-runner"`).

```typescript
export interface Proposal {
  proposer: string;
  action: Action;
  params?: Record<string, unknown>;
}
```

## Alternatives Considered

### Alternative A: Keep optional, assign anonymous ID at runtime

- Description: `proposer?: string`, runtime fills in `"anonymous"` when omitted
- Pros: Lower friction for quick prototyping; matches README's Before/After example exactly
- Cons: Hidden runtime behavior — callers don't know their actions will be attributed to `"anonymous"`; audit logs become less useful when multiple callers omit proposer; `"anonymous"` grouping creates false correlation
- Why rejected: Implicit behavior in a governance SDK is a liability. Explicitness is worth the extra field.

### Alternative B: Use a branded type `AgentId` instead of `string`

- Description: `type AgentId = string & { __brand: "AgentId" }`, require `proposer: AgentId`
- Pros: Prevents accidental assignment of arbitrary strings; enforces agent registration
- Cons: Branded types add friction (`as AgentId` casts everywhere); proposer doesn't have to be a registered agent — humans and external systems also propose actions
- Why rejected: Over-constraining. The proposer namespace is open — any string identifier is valid. Registration check is a runtime concern.

## Consequences

### Positive

- Every audit entry has attribution — no `undefined` proposers
- Type-safe: `AuditEntry.proposer` is `string`, not `string | undefined`
- Forces callers to think about identity upfront, which is the right behavior for a governance SDK

### Negative

- README's Before/After zero-proposer example no longer compiles. Must be updated to include `proposer`.
- Slightly higher API surface for the simplest use case.

### Risks

- Callers may pass meaningless strings like `""` or `"x"` to satisfy the requirement. Mitigated by runtime validation (non-empty string check in `propose()`).

## References

- [OWASP Agentic Top 10 — ASI03: Identity & Privilege Abuse](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/): Unattributed actions are a direct vector for privilege abuse
- [NIST NCCoE — Agent Authorization](https://www.nccoe.nist.gov/ai/multi-agent-systems): "How does an agent prove it is authorized?" — requires knowing _who_ is acting
