// ============================================================
// Tegata — Core Runtime
//
// `Tegata` class: the main orchestrator. It owns agent registry,
// policy rules, and the audit store, and exposes the public API
// documented in the README Quick Start.
//
// v0.1 scope: Agent → Tool authorization only. Agent ↔ Agent
// features (A2A binding) are v0.3.
// ============================================================

import { AuditStore } from "./audit.js";
import { resolvePolicy } from "./policy-engine.js";
import type {
  AgentRegistration,
  AuditEntry,
  AuditQuery,
  Decision,
  DecisionStatus,
  PolicyRule,
  Proposal,
  Result,
  TegataConfig,
} from "./types.js";

const DEFAULT_CONFIG: Required<TegataConfig> = {
  defaultTier: "auto",
  escalateAbove: 70,
  timeoutMs: 30_000,
  defaultOnTimeout: "deny",
};

/**
 * Main Tegata runtime.
 *
 * Use {@link Tegata.propose} to submit an action for approval.
 * See the README Quick Start for end-to-end usage.
 */
export class Tegata {
  private readonly config: Required<TegataConfig>;
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly policies: PolicyRule[] = [];
  private readonly audit = new AuditStore();

  /**
   * Construct a new Tegata runtime.
   *
   * @param config - Optional configuration. All fields have sensible
   *   defaults — `new Tegata()` with zero config is supported.
   */
  constructor(config?: TegataConfig) {
    this.config = {
      defaultTier: config?.defaultTier ?? DEFAULT_CONFIG.defaultTier,
      escalateAbove: config?.escalateAbove ?? DEFAULT_CONFIG.escalateAbove,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      defaultOnTimeout:
        config?.defaultOnTimeout ?? DEFAULT_CONFIG.defaultOnTimeout,
    };
  }

  /**
   * Register an agent with the runtime.
   *
   * @param agent - The agent to register.
   * @returns `Ok` on success; `Err` if the id is empty or already registered.
   */
  registerAgent(agent: AgentRegistration): Result<void> {
    if (agent.id === "") {
      return { ok: false, error: "agent id must not be empty" };
    }
    if (this.agents.has(agent.id)) {
      return { ok: false, error: `agent "${agent.id}" already registered` };
    }
    this.agents.set(agent.id, agent);
    return { ok: true, value: undefined };
  }

  /**
   * Register a policy rule.
   *
   * Rules are evaluated in insertion order; the first match wins.
   *
   * @param rule - The policy rule to add.
   * @returns `Ok` on success; `Err` if `match` is empty.
   */
  addPolicy(rule: PolicyRule): Result<void> {
    if (rule.match === "") {
      return { ok: false, error: "policy match pattern must not be empty" };
    }
    this.policies.push(structuredClone(rule));
    return { ok: true, value: undefined };
  }

  /**
   * Propose an action for approval.
   *
   * Resolves the applicable policy, checks the escalation threshold,
   * and dispatches on the resulting tier. Every proposal is recorded
   * in the audit log before the decision is returned.
   *
   * @param proposal - The action being proposed.
   * @returns The decision. Status may be `approved`, `escalated`, or
   *   `pending` (for tiers not yet implemented in the skeleton).
   */
  async propose(proposal: Proposal): Promise<Decision> {
    if (proposal.proposer === "") {
      throw new Error("proposer must not be empty");
    }

    const proposalId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const resolved = resolvePolicy(
      proposal.action,
      this.policies,
      this.config.defaultTier,
    );

    const threshold = resolved.escalateAbove ?? this.config.escalateAbove;
    const riskScore = proposal.action.riskScore ?? 0;

    let status: DecisionStatus;
    let reason: string;

    if (riskScore > threshold) {
      status = "escalated";
      reason = "riskScore exceeds threshold";
    } else {
      switch (resolved.tier) {
        case "auto":
          status = "approved";
          reason = "auto-approved";
          break;
        case "notify":
          status = "approved";
          reason = "approved with notification";
          break;
        case "review":
        case "approve":
          status = "pending";
          reason = "tier not yet implemented in skeleton";
          break;
      }
    }

    const decision: Decision = {
      proposalId,
      proposal,
      status,
      tier: resolved.tier,
      reviewers: resolved.reviewers,
      reason,
      timestamp,
    };

    const auditEntry: AuditEntry = {
      proposalId,
      proposer: proposal.proposer,
      action: proposal.action,
      decisions: [decision],
      finalStatus: status,
      timestamp,
    };
    this.audit.record(auditEntry);

    return decision;
  }

  /**
   * Query the audit log.
   *
   * @param query - Optional filters (`since`, `proposer`, `limit`).
   * @returns Matching audit entries in insertion order.
   */
  getAuditLog(query?: AuditQuery): AuditEntry[] {
    return this.audit.query(query);
  }
}
