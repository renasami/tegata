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
   * Skeleton supports `since`, `proposer`, and `limit` filters.
   * `actionType` glob matching will land with the policy engine.
   *
   * @param q - Optional query filters.
   * @returns Matching entries, deep-cloned, in insertion order.
   */
  query(q?: AuditQuery): AuditEntry[] {
    let results = this.entries;

    if (q?.since !== undefined) {
      const since = q.since;
      results = results.filter((e) => e.timestamp >= since);
    }

    if (q?.proposer !== undefined) {
      const proposer = q.proposer;
      results = results.filter((e) => e.proposer === proposer);
    }

    if (q?.limit !== undefined) {
      results = results.slice(0, q.limit);
    }

    return results.map((e) => structuredClone(e));
  }
}
