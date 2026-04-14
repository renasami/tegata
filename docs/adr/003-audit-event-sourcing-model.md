# ADR-003: Audit Event-Sourcing Model

**Status**: Accepted
**Date**: 2026-04-14
**Author**: Ren Asami

## Context

The initial `AuditEntry` type represented one proposal as a single mutable record:

```typescript
type AuditEntry = {
  proposalId: string;
  proposer: string;
  action: Action;
  decisions: Decision[];
  finalStatus: DecisionStatus;
  timestamp: string;
};
```

This design has three problems:

1. **`finalStatus` is a lie for pending proposals.** When a `review`/`approve` tier returns `pending`, `finalStatus: "pending"` is recorded. There is no mechanism to update it when a reviewer later approves or denies. The field name implies finality that the system cannot deliver.

2. **Mutability breaks the immutability contract.** The `AuditStore` header comments describe an "append-only in-memory audit log," and all inputs/outputs are deep-cloned via `structuredClone()`. But supporting `decisions[]` accumulation requires updating an existing entry — an `UPDATE`, not an `INSERT`. This contradicts the append-only guarantee.

3. **Incompatible with future backing stores.** The v0.2+ roadmap includes swapping the in-memory store for SQLite or OpenTelemetry. OTel spans are immutable once exported. Event-sourcing databases (e.g., EventStoreDB) are INSERT-only by design. An entry-update model forces `UPDATE` semantics that these systems either don't support or handle poorly.

The codebase uses the Result pattern (`{ ok, value } | { ok, error }`) and `structuredClone()` throughout — a functional, immutable-first design. The audit store was the only component that implied mutability.

## Decision

Replace `AuditEntry` with `AuditEvent`. Each call to `propose()` emits multiple append-only events sharing a `proposalId`. No event is ever updated after creation.

```typescript
type AuditEventType =
  | "proposed"
  | "decided"
  | "pending"
  | "escalated"
  | "timed_out";

type AuditEvent = {
  proposalId: string;
  eventType: AuditEventType;
  proposal: Proposal;
  decision?: Decision;
  timestamp: string;
};
```

A single `propose()` call emits:

1. `eventType: "proposed"` — records the proposal itself
2. `eventType: "decided" | "pending" | "escalated"` — records the outcome

The latest event for a `proposalId` represents the current state. `AuditQuery` gains a `proposalId` filter for timeline queries.

## Alternatives Considered

### Alternative A: Add `updateEntry()` to AuditStore

- Append a new `Decision` to an existing entry's `decisions[]` array and update `finalStatus`
- Pros: Simple query model (1 proposal = 1 entry), `getAuditLog()` returns current state directly
- Cons: Breaks append-only guarantee, requires `UPDATE` in SQL-backed stores, incompatible with OTel span model, contradicts the immutable-first design of the rest of the SDK
- Why rejected: Introducing mutability into the one component that MUST be tamper-evident is the wrong tradeoff for a governance SDK

### Alternative B: Rename `finalStatus` to `initialStatus`, defer decision

- Minimal change — fix the naming lie now, decide the update mechanism later
- Pros: Smallest diff, keeps options open
- Cons: Defers the architectural decision to v0.2 when the type is already in the wild, `initialStatus` may become redundant if event-sourcing is adopted later, risks a breaking change at a worse time
- Why rejected: The type shape sets API expectations. Shipping `AuditEntry` with `decisions[]` implies accumulation semantics that we know we cannot deliver without mutability. Better to fix the model before any external consumers exist.

## Consequences

### Positive

- True append-only: no `UPDATE`, no mutation, no race conditions
- Natural fit for OpenTelemetry spans, EventStoreDB, and append-only SQL tables
- Event timeline is fully reconstructable — every state transition is recorded
- Aligns with the functional/immutable design of the rest of the codebase
- `AuditEventType` discriminated union enables exhaustive switch checks (enforced by ESLint `switch-exhaustiveness-check`)

### Negative

- List queries (`getAuditLog({ since: "..." })`) return raw events, not per-proposal summaries. Callers must group by `proposalId` to get the latest status for each proposal.
- More events per proposal (2 today, more when review/approve flows land) increases storage volume. For the in-memory store this is negligible; for persistent stores, indexing on `proposalId` is required.

### Risks

- If we later need aggregate views (e.g., "show me all denied proposals this week"), we may need a `queryLatestByProposal()` convenience method. This is additive and non-breaking.
- The `proposal` field is duplicated on every event for queryability. This is a deliberate denormalization — the alternative (only on the "proposed" event) would require joins that the in-memory store cannot perform.

## References

- [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [OpenTelemetry Span data model](https://opentelemetry.io/docs/concepts/signals/traces/#spans) — spans are immutable after export
- [EventStoreDB — append-only by design](https://www.eventstore.com/event-sourcing)
- Tegata CLAUDE.md: "Error handling: Result pattern — no thrown exceptions in core"
- Tegata ADR-001: `escalate` is a runtime transition, not a tier — same principle applies here: `finalStatus` conflated "current state" with "terminal state"
