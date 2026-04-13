import { describe, expect, it } from "vitest";

import type { PolicyRule } from "./types.js";
import { globMatch, matchesCapability } from "./glob.js";
import { resolvePolicy } from "./policy-engine.js";
import { Tegata } from "./runtime.js";

// ----------------------------------------------------------------
// globMatch
// ----------------------------------------------------------------

describe("globMatch", () => {
  it("matches exact segments", () => {
    expect(globMatch("ci:staging:deploy", "ci:staging:deploy")).toBe(true);
  });

  it("matches wildcard in first segment", () => {
    expect(globMatch("*:staging:deploy", "ci:staging:deploy")).toBe(true);
  });

  it("matches wildcard in middle segment", () => {
    expect(globMatch("ci:*:deploy", "ci:staging:deploy")).toBe(true);
  });

  it("matches wildcard in last segment", () => {
    expect(globMatch("ci:staging:*", "ci:staging:deploy")).toBe(true);
  });

  it("matches all wildcards", () => {
    expect(globMatch("*:*:*", "ci:staging:deploy")).toBe(true);
  });

  it("rejects mismatched literal segment", () => {
    expect(globMatch("ci:production:deploy", "ci:staging:deploy")).toBe(false);
  });

  it("rejects different segment count (pattern longer)", () => {
    expect(globMatch("ci:staging:deploy:extra", "ci:staging:deploy")).toBe(
      false,
    );
  });

  it("rejects different segment count (value longer)", () => {
    expect(globMatch("ci:staging", "ci:staging:deploy")).toBe(false);
  });

  it("rejects empty pattern", () => {
    expect(globMatch("", "ci:staging:deploy")).toBe(false);
  });

  it("rejects empty value", () => {
    expect(globMatch("ci:staging:deploy", "")).toBe(false);
  });

  it("rejects both empty", () => {
    expect(globMatch("", "")).toBe(false);
  });

  it("rejects empty segment in value", () => {
    expect(globMatch("db:*:write", "db::write")).toBe(false);
  });

  it("rejects empty segment in pattern", () => {
    expect(globMatch("db::write", "db:users:write")).toBe(false);
  });

  it("matches single-segment strings", () => {
    expect(globMatch("read", "read")).toBe(true);
  });

  it("matches single-segment wildcard", () => {
    expect(globMatch("*", "read")).toBe(true);
  });

  it("rejects single-segment mismatch", () => {
    expect(globMatch("read", "write")).toBe(false);
  });
});

// ----------------------------------------------------------------
// matchesCapability
// ----------------------------------------------------------------

describe("matchesCapability", () => {
  it("returns true when a wildcard capability matches", () => {
    expect(
      matchesCapability(
        ["ci:*:read", "ci:staging:deploy"],
        "ci:production:read",
      ),
    ).toBe(true);
  });

  it("returns true on exact match", () => {
    expect(matchesCapability(["ci:staging:deploy"], "ci:staging:deploy")).toBe(
      true,
    );
  });

  it("returns false when no capability matches", () => {
    expect(
      matchesCapability(["ci:staging:deploy"], "ci:production:deploy"),
    ).toBe(false);
  });

  it("returns false for empty capabilities array", () => {
    expect(matchesCapability([], "ci:staging:deploy")).toBe(false);
  });

  it("matches with all-wildcard capability", () => {
    expect(matchesCapability(["*:*:*"], "db:users:delete")).toBe(true);
  });
});

// ----------------------------------------------------------------
// resolvePolicy (glob-aware)
// ----------------------------------------------------------------

describe("resolvePolicy", () => {
  it("matches a glob pattern rule", () => {
    const rules: PolicyRule[] = [{ match: "db:*:write", tier: "approve" }];
    const result = resolvePolicy({ type: "db:users:write" }, rules, "auto");
    expect(result.tier).toBe("approve");
    expect(result.matchedRule).toBe(rules[0]);
  });

  it("uses first-match priority", () => {
    const rules: PolicyRule[] = [
      { match: "ci:*:deploy", tier: "review" },
      { match: "ci:production:deploy", tier: "approve" },
    ];
    const result = resolvePolicy(
      { type: "ci:production:deploy" },
      rules,
      "auto",
    );
    expect(result.tier).toBe("review");
  });

  it("matches exact action type", () => {
    const rules: PolicyRule[] = [
      { match: "ci:staging:deploy", tier: "notify" },
    ];
    const result = resolvePolicy({ type: "ci:staging:deploy" }, rules, "auto");
    expect(result.tier).toBe("notify");
  });

  it("falls back to default tier when no rule matches", () => {
    const rules: PolicyRule[] = [{ match: "db:*:write", tier: "approve" }];
    const result = resolvePolicy(
      { type: "ci:staging:deploy" },
      rules,
      "review",
    );
    expect(result.tier).toBe("review");
    expect(result.matchedRule).toBeUndefined();
  });

  it("matches all-wildcard pattern", () => {
    const rules: PolicyRule[] = [{ match: "*:*:*", tier: "review" }];
    const result = resolvePolicy({ type: "anything:goes:here" }, rules, "auto");
    expect(result.tier).toBe("review");
  });

  it("returns correct ResolvedPolicy shape", () => {
    const rules: PolicyRule[] = [
      {
        match: "db:*:write",
        tier: "approve",
        consensus: "majority",
        reviewers: ["db-admin", "sre-lead"],
        escalateAbove: 80,
      },
    ];
    const result = resolvePolicy({ type: "db:users:write" }, rules, "auto");
    expect(result).toEqual({
      tier: "approve",
      reviewers: ["db-admin", "sre-lead"],
      consensus: "majority",
      escalateAbove: 80,
      matchedRule: rules[0],
    });
  });

  it("does not match when segment count differs", () => {
    const rules: PolicyRule[] = [{ match: "ci:*", tier: "approve" }];
    const result = resolvePolicy({ type: "ci:staging:deploy" }, rules, "auto");
    expect(result.tier).toBe("auto");
    expect(result.matchedRule).toBeUndefined();
  });
});

// ----------------------------------------------------------------
// audit glob integration (via Tegata)
// ----------------------------------------------------------------

describe("audit glob filter", () => {
  it("filters audit log entries with glob actionType", async () => {
    const tegata = new Tegata();

    await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });
    await tegata.propose({
      proposer: "bot",
      action: { type: "db:orders:write" },
    });
    await tegata.propose({
      proposer: "bot",
      action: { type: "ci:staging:deploy" },
    });

    const filtered = tegata.getAuditLog({ actionType: "db:*:write" });
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.action.type)).toEqual([
      "db:users:write",
      "db:orders:write",
    ]);
  });

  it("still supports exact actionType filter", async () => {
    const tegata = new Tegata();

    await tegata.propose({
      proposer: "bot",
      action: { type: "db:users:write" },
    });
    await tegata.propose({
      proposer: "bot",
      action: { type: "db:orders:write" },
    });

    const filtered = tegata.getAuditLog({ actionType: "db:users:write" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.action.type).toBe("db:users:write");
  });
});
