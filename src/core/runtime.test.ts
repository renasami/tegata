import { describe, expect, it } from "vitest";

import type {
  ApprovalHandler,
  PolicyRule,
  ReviewHandler,
  TegataConfig,
} from "./types.js";
import { Tegata } from "./runtime.js";

/**
 * Test helper: construct a Tegata from a known-valid config.
 * Throws on validation failure so callers don't need to thread
 * `Result` through every test setup. See ADR-009.
 */
function newTegata(config?: TegataConfig): Tegata {
  const r = Tegata.create(config);
  if (!r.ok) throw new Error(`test setup: ${r.error}`);
  return r.value;
}

// ----------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------

const noopReviewHandler: ReviewHandler = async () => ({
  status: "approved",
  decidedBy: "test-reviewer",
});

const denyingHandler: ReviewHandler = async () => ({
  status: "denied",
  decidedBy: "test-reviewer",
  reason: "policy violation",
});

const slowHandler =
  (delayMs: number): ReviewHandler =>
  () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ status: "approved", decidedBy: "slow-reviewer" });
      }, delayMs);
    });

const throwingHandler: ReviewHandler = () =>
  Promise.reject(new Error("connection refused"));

const syncThrowingHandler: ReviewHandler = (() => {
  // Non-async function that throws synchronously before returning a Promise
  return (_proposal) => {
    throw new Error("sync validation failed");
  };
})();

describe("Tegata runtime", () => {
  // ----------------------------------------------------------------
  // Basic approval flow
  // ----------------------------------------------------------------

  it("zero-config propose auto-approves a low-risk action", async () => {
    const tegata = newTegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });

    expect(decision.status).toBe("approved");
    expect(decision.tier).toBe("auto");
    expect(decision.proposalId).toBeTruthy();
    expect(decision.decidedBy).toBeUndefined();
  });

  it("escalates when riskScore exceeds the default threshold", async () => {
    const tegata = newTegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 85 },
    });

    expect(decision.status).toBe("escalated");
  });

  // ----------------------------------------------------------------
  // Validation
  // ----------------------------------------------------------------

  it("denies empty proposer in propose()", async () => {
    const tegata = newTegata();

    const decision = await tegata.propose({
      proposer: "",
      action: { type: "x:y:read" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toContain("proposer must not be empty");
    expect(decision.proposalId).toBeTruthy();
  });

  it("denies empty action type in propose()", async () => {
    const tegata = newTegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toContain("action type must not be empty");
    expect(decision.proposalId).toBeTruthy();
  });

  it("records audit event for empty proposer denial", async () => {
    const tegata = newTegata();

    const decision = await tegata.propose({
      proposer: "",
      action: { type: "x:y:read" },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.eventType).toBe("decided");
    expect(log[0]?.proposalId).toBe(decision.proposalId);
    expect(log[0]?.decision?.status).toBe("denied");
  });

  it("records audit event for empty action type denial", async () => {
    const tegata = newTegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "" },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.eventType).toBe("decided");
    expect(log[0]?.proposalId).toBe(decision.proposalId);
    expect(log[0]?.decision?.status).toBe("denied");
  });

  // ----------------------------------------------------------------
  // riskScore undefined vs zero
  // ----------------------------------------------------------------

  it("skips threshold comparison when riskScore is omitted", async () => {
    const tegata = newTegata({ escalateAbove: 0 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });

    // escalateAbove is 0, but riskScore is undefined → no escalation
    expect(decision.status).toBe("approved");
  });

  it("escalates when riskScore is 1 and escalateAbove is 0", async () => {
    const tegata = newTegata({ escalateAbove: 0 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read", riskScore: 1 },
    });

    expect(decision.status).toBe("escalated");
  });

  it("does not escalate when riskScore is explicitly 0", async () => {
    const tegata = newTegata({ escalateAbove: 70 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read", riskScore: 0 },
    });

    expect(decision.status).toBe("approved");
  });

  // ----------------------------------------------------------------
  // Escalation boundary (strict >)
  // ----------------------------------------------------------------

  it("does NOT escalate when riskScore equals escalateAbove", async () => {
    const tegata = newTegata({ escalateAbove: 70 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 70 },
    });

    expect(decision.status).toBe("approved");
  });

  it("escalates when riskScore is escalateAbove + 1", async () => {
    const tegata = newTegata({ escalateAbove: 70 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 71 },
    });

    expect(decision.status).toBe("escalated");
  });

  // ----------------------------------------------------------------
  // notify tier semantics
  // ----------------------------------------------------------------

  it("notify tier returns approved with tier=notify", async () => {
    const tegata = newTegata();
    tegata.addPolicy({ match: "slack:channel:post", tier: "notify" });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "slack:channel:post" },
    });

    expect(decision.status).toBe("approved");
    expect(decision.tier).toBe("notify");
  });

  it("auto and notify both return approved but differ in tier", async () => {
    const tegata = newTegata();
    tegata.addPolicy({ match: "slack:channel:post", tier: "notify" });

    const autoDecision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });
    const notifyDecision = await tegata.propose({
      proposer: "bot",
      action: { type: "slack:channel:post" },
    });

    expect(autoDecision.status).toBe("approved");
    expect(notifyDecision.status).toBe("approved");
    expect(autoDecision.tier).toBe("auto");
    expect(notifyDecision.tier).toBe("notify");
  });

  // ----------------------------------------------------------------
  // Audit log (event-sourcing model)
  // ----------------------------------------------------------------

  it("records proposed + decided events for each proposal", async () => {
    const tegata = newTegata();

    await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0]?.eventType).toBe("proposed");
    expect(log[1]?.eventType).toBe("decided");
    expect(log[0]?.proposalId).toBe(log[1]?.proposalId);
  });

  it("records proposed + pending + decided events for review tier", async () => {
    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: noopReviewHandler,
    });

    await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(3);
    expect(log[0]?.eventType).toBe("proposed");
    expect(log[1]?.eventType).toBe("pending");
    expect(log[2]?.eventType).toBe("decided");
  });

  it("records escalated event type when escalated", async () => {
    const tegata = newTegata();

    await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 85 },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0]?.eventType).toBe("proposed");
    expect(log[1]?.eventType).toBe("escalated");
  });

  it("filters audit log by actionType", async () => {
    const tegata = newTegata();

    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });
    await tegata.propose({ proposer: "bot", action: { type: "a:b:write" } });

    const filtered = tegata.getAuditLog({ actionType: "a:b:write" });
    expect(filtered).toHaveLength(2); // proposed + decided
    expect(filtered[0]?.proposal.action.type).toBe("a:b:write");
  });

  it("filters audit log by proposalId", async () => {
    const tegata = newTegata();

    const d1 = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });
    await tegata.propose({
      proposer: "bot",
      action: { type: "a:b:write" },
    });

    const filtered = tegata.getAuditLog({ proposalId: d1.proposalId });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.proposalId === d1.proposalId)).toBe(true);
  });

  it("handles negative limit gracefully", async () => {
    const tegata = newTegata();
    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });

    const log = tegata.getAuditLog({ limit: -1 });
    expect(log).toHaveLength(0);
  });

  it("preserves defaults when config has explicit undefined", async () => {
    // Simulate a JS caller bypassing strict types
    const config: unknown = JSON.parse('{"escalateAbove": null}');
    const tegata = newTegata(config as TegataConfig);

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 85 },
    });

    // Default escalateAbove is 70, so 85 should still escalate
    expect(decision.status).toBe("escalated");
  });

  // ----------------------------------------------------------------
  // Agent registration
  // ----------------------------------------------------------------

  it("rejects duplicate agent registration", () => {
    const tegata = newTegata();
    const agent = {
      id: "deploy-bot",
      name: "Deploy Bot",
      role: "proposer" as const,
      capabilities: ["ci:*:read"],
      maxApprovableRisk: 40,
    };

    const first = tegata.registerAgent(agent);
    const second = tegata.registerAgent(agent);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("clones agent on registration so external mutation has no effect", () => {
    const tegata = newTegata();
    const agent = {
      id: "deploy-bot",
      name: "Deploy Bot",
      role: "proposer" as const,
      capabilities: ["ci:*:read"],
      maxApprovableRisk: 40,
    };

    tegata.registerAgent(agent);
    agent.maxApprovableRisk = 100;
    agent.capabilities.push("admin:*:*");

    // Internal state should be unaffected (agent is used in v0.2+)
    const second = tegata.registerAgent({
      ...agent,
      id: "deploy-bot",
    });
    expect(second.ok).toBe(false);
  });

  // ----------------------------------------------------------------
  // Immutability / safety
  // ----------------------------------------------------------------

  it("clones policy rules so external mutation has no effect", async () => {
    const tegata = newTegata();
    const rule: PolicyRule = {
      match: "db:users:write",
      tier: "review",
      handler: noopReviewHandler,
    };
    tegata.addPolicy(rule);

    // Mutate the original object after registration
    (rule as Record<string, unknown>).tier = "auto";

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.tier).toBe("review");
  });

  it("does not leak internal reviewers array via decision", async () => {
    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      reviewers: ["alice"],
      handler: noopReviewHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    // Mutate the returned reviewers
    decision.reviewers.push("hacker");

    // A second proposal should still see the original reviewers
    const decision2 = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision2.reviewers).toEqual(["alice"]);
  });

  it("returns empty results for invalid since string", async () => {
    const tegata = newTegata();
    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });

    const log = tegata.getAuditLog({ since: "not-a-date" });
    expect(log).toHaveLength(0);
  });

  // ----------------------------------------------------------------
  // Agent capabilities check in propose()
  // ----------------------------------------------------------------

  it("registered agent with matching capability proceeds normally", async () => {
    const tegata = newTegata();
    tegata.registerAgent({
      id: "ci-bot",
      name: "CI Bot",
      role: "proposer",
      capabilities: ["ci:staging:deploy"],
      maxApprovableRisk: 80,
    });

    const decision = await tegata.propose({
      proposer: "ci-bot",
      action: { type: "ci:staging:deploy", riskScore: 30 },
    });

    expect(decision.status).toBe("approved");
    expect(decision.reason).toBe("auto-approved");
  });

  it("registered agent without matching capability is escalated", async () => {
    const tegata = newTegata();
    tegata.registerAgent({
      id: "ci-bot",
      name: "CI Bot",
      role: "proposer",
      capabilities: ["ci:staging:deploy"],
      maxApprovableRisk: 80,
    });

    const decision = await tegata.propose({
      proposer: "ci-bot",
      action: { type: "ci:production:deploy", riskScore: 30 },
    });

    expect(decision.status).toBe("escalated");
    expect(decision.reason).toContain("lacks capability");
  });

  it("registered agent with riskScore exceeding maxApprovableRisk is escalated", async () => {
    const tegata = newTegata();
    tegata.registerAgent({
      id: "ci-bot",
      name: "CI Bot",
      role: "proposer",
      capabilities: ["ci:*:deploy"],
      maxApprovableRisk: 40,
    });

    const decision = await tegata.propose({
      proposer: "ci-bot",
      action: { type: "ci:production:deploy", riskScore: 50 },
    });

    expect(decision.status).toBe("escalated");
    expect(decision.reason).toContain("maxApprovableRisk");
  });

  it("unregistered proposer skips capability check (zero-config)", async () => {
    const tegata = newTegata();
    // No agent registered — "unknown-bot" is not in the agent registry

    const decision = await tegata.propose({
      proposer: "unknown-bot",
      action: { type: "ci:production:deploy", riskScore: 30 },
    });

    // Should proceed to normal flow (auto-approved since riskScore < 70)
    expect(decision.status).toBe("approved");
    expect(decision.reason).toBe("auto-approved");
  });

  it("registered agent with wildcard capability matches everything", async () => {
    const tegata = newTegata();
    tegata.registerAgent({
      id: "admin-bot",
      name: "Admin Bot",
      role: "supervisor",
      capabilities: ["*:*:*"],
      maxApprovableRisk: 100,
    });

    const decision = await tegata.propose({
      proposer: "admin-bot",
      action: { type: "db:users:delete", riskScore: 50 },
    });

    expect(decision.status).toBe("approved");
    expect(decision.reason).toBe("auto-approved");
  });

  it("registered agent still respects global escalateAbove after agent checks pass", async () => {
    const tegata = newTegata({ escalateAbove: 70 });
    tegata.registerAgent({
      id: "ci-bot",
      name: "CI Bot",
      role: "proposer",
      capabilities: ["ci:*:deploy"],
      maxApprovableRisk: 90,
    });

    const decision = await tegata.propose({
      proposer: "ci-bot",
      action: { type: "ci:production:deploy", riskScore: 80 },
    });

    // capability matches, riskScore (80) < maxApprovableRisk (90),
    // but riskScore (80) > global escalateAbove (70) → escalated
    expect(decision.status).toBe("escalated");
    expect(decision.reason).toContain("threshold");
  });

  // ----------------------------------------------------------------
  // Review / Approve handler flow
  // ----------------------------------------------------------------

  it("review handler approved → Decision.status=approved with decidedBy", async () => {
    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: noopReviewHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("approved");
    expect(decision.tier).toBe("review");
    expect(decision.decidedBy).toBe("test-reviewer");
  });

  it("review handler denied → Decision.status=denied", async () => {
    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: denyingHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.decidedBy).toBe("test-reviewer");
    expect(decision.reason).toBe("policy violation");
  });

  it("approve handler approved → tier=approve", async () => {
    const approveHandler: ApprovalHandler = async () => ({
      status: "approved",
      decidedBy: "human-admin",
      reason: "looks good",
    });

    const tegata = newTegata();
    tegata.addPolicy({
      match: "finance:*:transfer",
      tier: "approve",
      handler: approveHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "finance:account:transfer" },
    });

    expect(decision.status).toBe("approved");
    expect(decision.tier).toBe("approve");
    expect(decision.decidedBy).toBe("human-admin");
    expect(decision.reason).toBe("looks good");
  });

  it("handler timeout + defaultOnTimeout=deny → timed_out", async () => {
    const tegata = newTegata({
      timeoutMs: 50,
      defaultOnTimeout: "deny",
    });
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: slowHandler(500),
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("timed_out");
    expect(decision.reason).toContain("timed out");
  });

  it("handler timeout + defaultOnTimeout=escalate → escalated", async () => {
    const tegata = newTegata({
      timeoutMs: 50,
      defaultOnTimeout: "escalate",
    });
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: slowHandler(500),
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("escalated");
    expect(decision.reason).toContain("timed out");
  });

  it("policy-level timeoutMs overrides config", async () => {
    const tegata = newTegata({
      timeoutMs: 10_000, // config: long timeout
      defaultOnTimeout: "deny",
    });
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: slowHandler(500),
      timeoutMs: 50, // policy: short timeout
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("timed_out");
  });

  it("escalateAbove bypasses handler (handler not called)", async () => {
    let handlerCalled = false;
    const trackingHandler: ReviewHandler = async () => {
      handlerCalled = true;
      return { status: "approved", decidedBy: "test-reviewer" };
    };

    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: trackingHandler,
      escalateAbove: 50,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write", riskScore: 60 },
    });

    expect(decision.status).toBe("escalated");
    expect(handlerCalled).toBe(false);
  });

  it("handler error → denied with error reason", async () => {
    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: throwingHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toBe("handler error");
  });

  it("handler without reason → generates default reason", async () => {
    const noReasonHandler: ReviewHandler = async () => ({
      status: "approved",
      decidedBy: "auto-reviewer",
    });

    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: noReasonHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.reason).toBe("approved by auto-reviewer");
  });

  it("auto/notify tier → decidedBy is undefined", async () => {
    const tegata = newTegata();
    tegata.addPolicy({ match: "slack:*:post", tier: "notify" });

    const autoDecision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });
    const notifyDecision = await tegata.propose({
      proposer: "bot",
      action: { type: "slack:channel:post" },
    });

    expect(autoDecision.decidedBy).toBeUndefined();
    expect(notifyDecision.decidedBy).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Handler safety (LLM/agent hardening)
  // ----------------------------------------------------------------

  it("handler that throws synchronously → denied (not unhandled rejection)", async () => {
    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: syncThrowingHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toBe("handler error");
  });

  it("handler cannot mutate the proposal object", async () => {
    const mutatingHandler: ReviewHandler = async (p) => {
      // Attempt to mutate the proposal
      p.action.riskScore = 0;
      (p as Record<string, unknown>).proposer = "hacked";
      return { status: "approved", decidedBy: "reviewer" };
    };

    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: mutatingHandler,
    });

    const original = {
      proposer: "bot",
      action: { type: "db:users:write" as const, riskScore: 50 },
    };
    const decision = await tegata.propose(original);

    expect(decision.status).toBe("approved");
    // The original proposal in the decision must be unmodified
    expect(decision.proposal.proposer).toBe("bot");
    expect(decision.proposal.action.riskScore).toBe(50);
  });

  it("handler returning invalid status → denied", async () => {
    const badStatusHandler: ReviewHandler = async () =>
      // Simulate JS caller returning invalid shape
      ({ status: "escalated", decidedBy: "reviewer" }) as never;

    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: badStatusHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toBe("handler returned invalid result");
  });

  it("handler returning empty decidedBy → denied", async () => {
    const emptyDeciderHandler: ReviewHandler = async () => ({
      status: "approved",
      decidedBy: "",
    });

    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: emptyDeciderHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toBe("handler returned invalid result");
  });

  it("handler error does not leak raw error message into decision", async () => {
    const leakyHandler: ReviewHandler = () =>
      Promise.reject(new Error("secret-api-key-12345: auth failed"));

    const tegata = newTegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      handler: leakyHandler,
    });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toBe("handler error");
    expect(decision.reason).not.toContain("secret");
  });
});

// ----------------------------------------------------------------
// Tegata.create() — config validation (ADR-009)
// ----------------------------------------------------------------

describe("Tegata.create config validation", () => {
  it("returns Ok for zero-config", () => {
    const result = Tegata.create();
    expect(result.ok).toBe(true);
  });

  it("returns Ok for fully-specified valid config", () => {
    const result = Tegata.create({
      defaultTier: "review",
      escalateAbove: 50,
      timeoutMs: 5_000,
      defaultOnTimeout: "escalate",
    });
    expect(result.ok).toBe(true);
  });

  it("treats explicit null as use-default (preserves nullish coalescing)", () => {
    const config = JSON.parse(
      '{"escalateAbove": null, "timeoutMs": null}',
    ) as TegataConfig;
    const result = Tegata.create(config);
    expect(result.ok).toBe(true);
  });

  // escalateAbove boundaries

  it("accepts escalateAbove = 0 (boundary)", () => {
    const result = Tegata.create({ escalateAbove: 0 });
    expect(result.ok).toBe(true);
  });

  it("accepts escalateAbove = 100 (boundary)", () => {
    const result = Tegata.create({ escalateAbove: 100 });
    expect(result.ok).toBe(true);
  });

  it("rejects escalateAbove = -1", () => {
    const result = Tegata.create({ escalateAbove: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escalateAbove");
    }
  });

  it("rejects escalateAbove = 101", () => {
    const result = Tegata.create({ escalateAbove: 101 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("escalateAbove");
    }
  });

  it("rejects escalateAbove = NaN", () => {
    const result = Tegata.create({ escalateAbove: Number.NaN });
    expect(result.ok).toBe(false);
  });

  it("rejects escalateAbove = Infinity", () => {
    const result = Tegata.create({ escalateAbove: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
  });

  // timeoutMs boundaries

  it("accepts timeoutMs = 1 (smallest positive)", () => {
    const result = Tegata.create({ timeoutMs: 1 });
    expect(result.ok).toBe(true);
  });

  it("rejects timeoutMs = 0 (must be strictly positive)", () => {
    const result = Tegata.create({ timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timeoutMs");
    }
  });

  it("rejects timeoutMs = -100", () => {
    const result = Tegata.create({ timeoutMs: -100 });
    expect(result.ok).toBe(false);
  });

  it("rejects timeoutMs = NaN", () => {
    const result = Tegata.create({ timeoutMs: Number.NaN });
    expect(result.ok).toBe(false);
  });

  it("rejects timeoutMs = Infinity", () => {
    const result = Tegata.create({ timeoutMs: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
  });

  // String enum guards (JS callers)

  it("rejects unknown defaultTier (JS caller)", () => {
    const config = { defaultTier: "bogus" } as unknown as TegataConfig;
    const result = Tegata.create(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("defaultTier");
    }
  });

  it("rejects unknown defaultOnTimeout (JS caller)", () => {
    const config = { defaultOnTimeout: "bogus" } as unknown as TegataConfig;
    const result = Tegata.create(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("defaultOnTimeout");
    }
  });

  // Defense-in-depth: TypeScript's `private` modifier is compile-time only.
  // A JS caller (or a TS caller using `as any`) can still reach `new
  // Tegata(...)`. The constructor must re-validate so `this.config` is
  // never left undefined / corrupt. See ADR-009 + Codex P1 review on PR #19.

  it("survives JS-bypass `new Tegata()` (no config)", async () => {
    // Cast through `unknown` to bypass the TS `private` modifier the way
    // a JS caller would at runtime.
    const Ctor = Tegata as unknown as new (config?: TegataConfig) => Tegata;
    const tegata = new Ctor();
    const decision = await tegata.propose({
      proposer: "tester",
      action: { type: "demo:read", riskScore: 5 },
    });
    expect(decision.status).toBe("approved");
  });

  it("survives JS-bypass `new Tegata(garbage)` by falling back to defaults", async () => {
    // Garbage that would fail validation in `Tegata.create()`. The
    // constructor must NOT crash — it falls back to defaults.
    const Ctor = Tegata as unknown as new (config?: TegataConfig) => Tegata;
    const garbage = { escalateAbove: 999 } as TegataConfig;
    const tegata = new Ctor(garbage);
    const decision = await tegata.propose({
      proposer: "tester",
      action: { type: "demo:read", riskScore: 5 },
    });
    expect(decision.status).toBe("approved");
  });
});
