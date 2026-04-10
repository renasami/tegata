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
