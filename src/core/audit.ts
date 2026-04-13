// ============================================================
// Tegata — Audit Store
//
// Append-only in-memory event log. Each event is immutable once
// recorded. Multiple events share a proposalId to form a
// timeline. Exposed as a class so that later versions can swap
// the backing store (SQLite, OpenTelemetry, etc.) without
// touching the runtime.
// ============================================================

import type { AuditEvent, AuditQuery } from "./types.js";
import { globMatch } from "./glob.js";

/**
 * In-memory append-only audit store.
 *
 * Events are deep-cloned on insertion and on read so that callers
 * cannot mutate the log after the fact.
 */
export class AuditStore {
  private readonly events: AuditEvent[] = [];

  /**
   * Append an event to the audit log.
   *
   * @param event - The audit event to record. Deep-cloned before storage.
   */
  record(event: AuditEvent): void {
    this.events.push(structuredClone(event));
  }

  /**
   * Query the audit log.
   *
   * Supports `since`, `proposer`, `actionType` (glob match),
   * `proposalId`, and `limit` filters.
   *
   * @param q - Optional query filters.
   * @returns Matching events, deep-cloned, in insertion order.
   */
  query(q?: AuditQuery): AuditEvent[] {
    let results = this.events;

    if (q?.since !== undefined) {
      const parsed = new Date(q.since);
      if (Number.isNaN(parsed.getTime())) {
        return [];
      }
      const sinceIso = parsed.toISOString();
      results = results.filter((e) => e.timestamp >= sinceIso);
    }

    if (q?.proposer !== undefined) {
      const proposer = q.proposer;
      results = results.filter((e) => e.proposal.proposer === proposer);
    }

    if (q?.actionType !== undefined) {
      const actionType = q.actionType;
      results = results.filter((e) =>
        globMatch(actionType, e.proposal.action.type),
      );
    }

    if (q?.proposalId !== undefined) {
      const proposalId = q.proposalId;
      results = results.filter((e) => e.proposalId === proposalId);
    }

    if (q?.limit !== undefined) {
      results = results.slice(0, Math.max(0, q.limit));
    }

    return results.map((e) => structuredClone(e));
  }
}
