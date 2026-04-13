// ============================================================
// Tegata — Audit Store
//
// Append-only in-memory audit log. Exposed as a class so that
// later versions can swap the backing store (SQLite, OpenTelemetry,
// etc.) without touching the runtime.
// ============================================================

import type { AuditEntry, AuditQuery } from "./types.js";

/**
 * In-memory append-only audit store.
 *
 * Entries are deep-cloned on insertion and on read so that callers
 * cannot mutate the log after the fact.
 */
export class AuditStore {
  private readonly entries: AuditEntry[] = [];

  /**
   * Append an entry to the audit log.
   *
   * @param entry - The audit entry to record. Deep-cloned before storage.
   */
  record(entry: AuditEntry): void {
    this.entries.push(structuredClone(entry));
  }

  /**
   * Query the audit log.
   *
   * Supports `since`, `proposer`, `actionType` (exact match),
   * and `limit` filters. Glob matching for `actionType` will
   * land with the policy engine.
   *
   * @param q - Optional query filters.
   * @returns Matching entries, deep-cloned, in insertion order.
   */
  query(q?: AuditQuery): AuditEntry[] {
    let results = this.entries;

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
      results = results.filter((e) => e.proposer === proposer);
    }

    if (q?.actionType !== undefined) {
      const actionType = q.actionType;
      results = results.filter((e) => e.action.type === actionType);
    }

    if (q?.limit !== undefined) {
      results = results.slice(0, Math.max(0, q.limit));
    }

    return results.map((e) => structuredClone(e));
  }
}
