import { describe, expect, it } from "vitest";

import { Tegata } from "./runtime.js";

describe("Tegata runtime (skeleton)", () => {
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

  it("records every proposal in the audit log", async () => {
    const tegata = new Tegata();

    await tegata.propose({
      proposer: "bot",
      action: { type: "x:y:read" },
    });

    const log = tegata.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.proposer).toBe("bot");
    expect(log[0]?.decisions).toHaveLength(1);
  });

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

  it("clones policy rules so external mutation has no effect", async () => {
    const tegata = new Tegata();
    const rule: Record<string, unknown> = {
      match: "db:users:write",
      tier: "review",
    };
    tegata.addPolicy(rule as never);

    // Mutate the original object after registration
    rule.tier = "auto";

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });

    expect(decision.tier).toBe("review");
  });

  it("filters audit log by actionType", async () => {
    const tegata = new Tegata();

    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });
    await tegata.propose({ proposer: "bot", action: { type: "a:b:write" } });

    const filtered = tegata.getAuditLog({ actionType: "a:b:write" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.action.type).toBe("a:b:write");
  });

  it("handles negative limit gracefully", async () => {
    const tegata = new Tegata();
    await tegata.propose({ proposer: "bot", action: { type: "x:y:read" } });

    const log = tegata.getAuditLog({ limit: -1 });
    expect(log).toHaveLength(0);
  });

  it("preserves defaults when config has explicit undefined", async () => {
    // Simulate a JS caller bypassing strict types
    const config = JSON.parse('{"escalateAbove": null}');
    const tegata = new Tegata(config);

    const decision = await tegata.propose({
      proposer: "bot",
      action: { type: "ci:production:deploy", riskScore: 85 },
    });

    // Default escalateAbove is 70, so 85 should still escalate
    expect(decision.status).toBe("escalated");
  });

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
});
