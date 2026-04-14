import { describe, expect, it } from "vitest";

import type { PolicyRule, TegataConfig } from "./types.js";
import { Tegata } from "./runtime.js";

describe("Tegata runtime", () => {
  // ----------------------------------------------------------------
  // Basic approval flow
  // ----------------------------------------------------------------

  it("zero-config propose auto-approves a low-risk action", async () => {
    const tegata = new Tegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });

    expect(decision.status).toBe("approved");
    expect(decision.tier).toBe("auto");
    expect(decision.proposalId).toBeTruthy();
  });

  it("escalates when riskScore exceeds the default threshold", async () => {
    const tegata = new Tegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 85 },
    });

    expect(decision.status).toBe("escalated");
  });

  it("returns pending for review tier (not yet implemented)", async () => {
    const tegata = new Tegata();
    const added = tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
    });
    expect(added.ok).toBe(true);

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.status).toBe("pending");
    expect(decision.tier).toBe("review");
    expect(decision.reason).toContain("not yet implemented");
  });

  // ----------------------------------------------------------------
  // Validation
  // ----------------------------------------------------------------

  it("denies empty proposer in propose()", async () => {
    const tegata = new Tegata();

    const decision = await tegata.propose({
      proposer: "",
      action: { type: "x:y:read" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toContain("proposer must not be empty");
  });

  it("denies empty action type in propose()", async () => {
    const tegata = new Tegata();

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "" },
    });

    expect(decision.status).toBe("denied");
    expect(decision.reason).toContain("action type must not be empty");
  });

  // ----------------------------------------------------------------
  // riskScore undefined vs zero
  // ----------------------------------------------------------------

  it("skips threshold comparison when riskScore is omitted", async () => {
    const tegata = new Tegata({ escalateAbove: 0 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });

    // escalateAbove is 0, but riskScore is undefined → no escalation
    expect(decision.status).toBe("approved");
  });

  it("escalates when riskScore is 1 and escalateAbove is 0", async () => {
    const tegata = new Tegata({ escalateAbove: 0 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read", riskScore: 1 },
    });

    expect(decision.status).toBe("escalated");
  });

  it("does not escalate when riskScore is explicitly 0", async () => {
    const tegata = new Tegata({ escalateAbove: 70 });

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
    const tegata = new Tegata({ escalateAbove: 70 });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 70 },
    });

    expect(decision.status).toBe("approved");
  });

  it("escalates when riskScore is escalateAbove + 1", async () => {
    const tegata = new Tegata({ escalateAbove: 70 });

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
    const tegata = new Tegata();
    tegata.addPolicy({ match: "slack:channel:post", tier: "notify" });

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "slack:channel:post" },
    });

    expect(decision.status).toBe("approved");
    expect(decision.tier).toBe("notify");
  });

  it("auto and notify both return approved but differ in tier", async () => {
    const tegata = new Tegata();
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
    const tegata = new Tegata();

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

  it("records pending event type for review tier", async () => {
    const tegata = new Tegata();
    tegata.addPolicy({ match: "db:users:write", tier: "review" });

    await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0]?.eventType).toBe("proposed");
    expect(log[1]?.eventType).toBe("pending");
  });

  it("records escalated event type when escalated", async () => {
    const tegata = new Tegata();

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
    const tegata = new Tegata();

    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });
    await tegata.propose({ proposer: "bot", action: { type: "a:b:write" } });

    const filtered = tegata.getAuditLog({ actionType: "a:b:write" });
    expect(filtered).toHaveLength(2); // proposed + decided
    expect(filtered[0]?.proposal.action.type).toBe("a:b:write");
  });

  it("filters audit log by proposalId", async () => {
    const tegata = new Tegata();

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
    const tegata = new Tegata();
    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });

    const log = tegata.getAuditLog({ limit: -1 });
    expect(log).toHaveLength(0);
  });

  it("preserves defaults when config has explicit undefined", async () => {
    // Simulate a JS caller bypassing strict types
    const config: unknown = JSON.parse('{"escalateAbove": null}');
    const tegata = new Tegata(config as TegataConfig);

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
    const tegata = new Tegata();
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
    const tegata = new Tegata();
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
    const tegata = new Tegata();
    const rule: PolicyRule = { match: "db:users:write", tier: "review" };
    tegata.addPolicy(rule);

    // Mutate the original object after registration
    rule.tier = "auto";

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.tier).toBe("review");
  });

  it("does not leak internal reviewers array via decision", async () => {
    const tegata = new Tegata();
    tegata.addPolicy({
      match: "db:users:write",
      tier: "review",
      reviewers: ["alice"],
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
    const tegata = new Tegata();
    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });

    const log = tegata.getAuditLog({ since: "not-a-date" });
    expect(log).toHaveLength(0);
  });
});
