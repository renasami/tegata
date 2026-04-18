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
import { matchesCapability } from "./glob.js";
import { resolvePolicy } from "./policy-engine.js";
import type {
  AgentRegistration,
  AuditEvent,
  AuditEventType,
  AuditQuery,
  Decision,
  DecisionStatus,
  PolicyRule,
  Proposal,
  Result,
  ReviewResult,
  TegataConfig,
} from "./types.js";

const DEFAULT_CONFIG: Required<TegataConfig> = {
  defaultTier: "auto",
  escalateAbove: 70,
  timeoutMs: 30_000,
  defaultOnTimeout: "deny",
};

/**
 * Clone a PolicyRule without breaking function references.
 *
 * `structuredClone` throws on functions, so review/approve
 * policies must be handled specially: data fields are cloned,
 * handler reference is preserved as-is.
 *
 * @param rule - The policy rule to clone.
 * @returns A shallow-safe clone of the rule.
 */
function clonePolicyRule(rule: PolicyRule): PolicyRule {
  switch (rule.tier) {
    case "auto":
    case "notify":
      return structuredClone(rule);
    case "review":
    case "approve": {
      const { handler, ...data } = rule;
      return { ...structuredClone(data), handler } as PolicyRule;
    }
  }
}

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
    this.agents.set(agent.id, structuredClone(agent));
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
    this.policies.push(clonePolicyRule(rule));
    return { ok: true, value: undefined };
  }

  /**
   * Execute a review/approve handler with timeout.
   *
   * Uses `Promise.race` to enforce the timeout. The handler call is
   * wrapped in `Promise.resolve().then(...)` so that synchronous
   * throws (e.g. input validation in a non-async handler) are caught
   * on the same Result path as async rejections.
   *
   * The proposal is deep-cloned before being passed to the handler
   * to prevent mutation of the original object.
   *
   * **Note**: timeout does not cancel the handler — it may continue
   * running after `Promise.race` resolves. Handler authors that need
   * cancellation should accept an `AbortSignal` internally.
   *
   * @param handler - The handler function to invoke.
   * @param proposal - The proposal to pass to the handler (cloned).
   * @param timeoutMs - Timeout in milliseconds.
   * @returns `Ok<ReviewResult>` on success; `Err` on timeout or handler error.
   */
  private executeHandler(
    handler: (proposal: Proposal) => Promise<ReviewResult>,
    proposal: Proposal,
    timeoutMs: number,
  ): Promise<Result<ReviewResult>> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<Result<ReviewResult>>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
    });

    const handlerPromise = Promise.resolve()
      .then(() => handler(structuredClone(proposal)))
      .then(
        (result: unknown): Result<ReviewResult> => {
          const r = result as Record<string, unknown> | null | undefined;
          if (
            r === null ||
            r === undefined ||
            (r.status !== "approved" && r.status !== "denied") ||
            typeof r.decidedBy !== "string" ||
            r.decidedBy === ""
          ) {
            return { ok: false, error: "invalid result" };
          }
          const value: ReviewResult = {
            status: r.status,
            decidedBy: r.decidedBy,
          };
          if (typeof r.reason === "string") {
            value.reason = r.reason;
          }
          return { ok: true, value };
        },
        (_err: unknown): Result<ReviewResult> => ({
          ok: false,
          error: "handler_error",
        }),
      );

    return Promise.race([handlerPromise, timeoutPromise]).then((result) => {
      clearTimeout(timer);
      return result;
    });
  }

  /**
   * Propose an action for approval.
   *
   * Resolves the applicable policy, checks the escalation threshold,
   * and dispatches on the resulting tier. Valid proposals are recorded
   * in the audit log as one or more {@link AuditEvent} records.
   * Every call to propose() is recorded in the audit log, including
   * validation failures.
   *
   * **Escalation threshold**: uses strict greater-than (`>`).
   * `riskScore === escalateAbove` does NOT trigger escalation.
   *
   * **`riskScore` omitted**: threshold comparison is skipped entirely.
   * The tier is determined solely by policy match or `defaultTier`.
   * This distinguishes "unknown risk" from "zero risk" (`riskScore: 0`).
   *
   * **`notify` tier**: returns `status: "approved"`, same as `auto`.
   * Callers should inspect `decision.tier === "notify"` to decide
   * whether to emit post-execution notifications. Tegata does not
   * send notifications itself.
   *
   * **`review` / `approve` tiers**: invokes the handler defined on
   * the matching policy. Subject to timeout via `Promise.race`.
   *
   * @param proposal - The action being proposed.
   * @returns The decision.
   */
  async propose(proposal: Proposal): Promise<Decision> {
    // Deep-clone to prevent external mutation from corrupting audit log / decisions
    proposal = structuredClone(proposal);

    if (proposal.proposer === "") {
      const validationId = crypto.randomUUID();
      const validationTimestamp = new Date().toISOString();
      const decision: Decision = {
        proposalId: validationId,
        proposal,
        status: "denied",
        tier: this.config.defaultTier,
        reviewers: [],
        decidedBy: undefined,
        reason: "proposer must not be empty",
        timestamp: validationTimestamp,
      };
      this.audit.record({
        proposalId: validationId,
        eventType: "decided",
        proposal,
        decision,
        timestamp: validationTimestamp,
      });
      return decision;
    }

    if (proposal.action.type === "") {
      const validationId = crypto.randomUUID();
      const validationTimestamp = new Date().toISOString();
      const decision: Decision = {
        proposalId: validationId,
        proposal,
        status: "denied",
        tier: this.config.defaultTier,
        reviewers: [],
        decidedBy: undefined,
        reason: "action type must not be empty",
        timestamp: validationTimestamp,
      };
      this.audit.record({
        proposalId: validationId,
        eventType: "decided",
        proposal,
        decision,
        timestamp: validationTimestamp,
      });
      return decision;
    }

    const proposalId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Record the "proposed" event
    this.audit.record({
      proposalId,
      eventType: "proposed",
      proposal,
      timestamp,
    });

    const resolved = resolvePolicy(
      proposal.action,
      this.policies,
      this.config.defaultTier,
    );

    // Agent capability check (only if proposer is registered)
    const agent = this.agents.get(proposal.proposer);
    if (agent !== undefined) {
      if (!matchesCapability(agent.capabilities, proposal.action.type)) {
        const capDecision: Decision = {
          proposalId,
          proposal,
          status: "escalated",
          tier: resolved.tier,
          reviewers: [...resolved.reviewers],
          decidedBy: undefined,
          reason: "proposer lacks capability for this action type",
          timestamp,
        };

        this.audit.record({
          proposalId,
          eventType: "escalated",
          proposal,
          decision: capDecision,
          timestamp: new Date().toISOString(),
        });

        return capDecision;
      }

      const agentRiskScore = proposal.action.riskScore;
      if (
        agentRiskScore !== undefined &&
        agentRiskScore > agent.maxApprovableRisk
      ) {
        const riskDecision: Decision = {
          proposalId,
          proposal,
          status: "escalated",
          tier: resolved.tier,
          reviewers: [...resolved.reviewers],
          decidedBy: undefined,
          reason: "riskScore exceeds agent's maxApprovableRisk",
          timestamp,
        };

        this.audit.record({
          proposalId,
          eventType: "escalated",
          proposal,
          decision: riskDecision,
          timestamp: new Date().toISOString(),
        });

        return riskDecision;
      }
    }

    const threshold = resolved.escalateAbove ?? this.config.escalateAbove;
    const riskScore = proposal.action.riskScore;

    // riskScore undefined → skip threshold comparison ("unknown ≠ zero")
    if (riskScore !== undefined && riskScore > threshold) {
      const escalatedDecision: Decision = {
        proposalId,
        proposal,
        status: "escalated",
        tier: resolved.tier,
        reviewers: [...resolved.reviewers],
        decidedBy: undefined,
        reason: "riskScore exceeds threshold",
        timestamp,
      };

      this.audit.record({
        proposalId,
        eventType: "escalated",
        proposal,
        decision: escalatedDecision,
        timestamp: new Date().toISOString(),
      });

      return escalatedDecision;
    }

    let status: DecisionStatus;
    let reason: string;
    let decidedBy: string | undefined = undefined;

    switch (resolved.tier) {
      case "auto":
        status = "approved";
        reason = "auto-approved";
        break;
      // notify: same as auto. Caller inspects decision.tier to decide
      // whether to send post-execution notifications.
      case "notify":
        status = "approved";
        reason = "approved with notification";
        break;
      case "review":
      case "approve": {
        if (resolved.handler === undefined) {
          // Type-level unreachable for TS callers, but JS callers may omit handler
          status = "denied";
          reason = "no handler configured for this policy";
          break;
        }

        // Record "pending" event before invoking handler
        this.audit.record({
          proposalId,
          eventType: "pending",
          proposal,
          timestamp: new Date().toISOString(),
        });

        const timeoutMs = resolved.timeoutMs ?? this.config.timeoutMs;
        const handlerResult = await this.executeHandler(
          resolved.handler,
          proposal,
          timeoutMs,
        );

        if (handlerResult.ok) {
          status = handlerResult.value.status;
          decidedBy = handlerResult.value.decidedBy;
          reason =
            handlerResult.value.reason ??
            `${handlerResult.value.status} by ${handlerResult.value.decidedBy}`;
        } else if (handlerResult.error === "timeout") {
          if (this.config.defaultOnTimeout === "escalate") {
            status = "escalated";
            reason = "review timed out — escalated";
          } else {
            status = "timed_out";
            reason = "review timed out";
          }
        } else if (handlerResult.error === "invalid result") {
          status = "denied";
          reason = "handler returned invalid result";
        } else {
          status = "denied";
          reason = "handler error";
        }
        break;
      }
    }

    const decision: Decision = {
      proposalId,
      proposal,
      status,
      tier: resolved.tier,
      reviewers: [...resolved.reviewers],
      decidedBy,
      reason,
      timestamp,
    };

    const statusToEventType: Record<DecisionStatus, AuditEventType> = {
      approved: "decided",
      denied: "decided",
      escalated: "escalated",
      pending: "pending",
      timed_out: "timed_out",
    };
    const decisionTimestamp = new Date().toISOString();
    this.audit.record({
      proposalId,
      eventType: statusToEventType[status],
      proposal,
      decision,
      timestamp: decisionTimestamp,
    });

    return decision;
  }

  /**
   * Query the audit log.
   *
   * @param query - Optional filters (`since`, `proposer`, `actionType`,
   *   `proposalId`, `limit`).
   * @returns Matching audit events in insertion order.
   */
  getAuditLog(query?: AuditQuery): AuditEvent[] {
    return this.audit.query(query);
  }
}
