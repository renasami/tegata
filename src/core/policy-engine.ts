// ============================================================
// Tegata — Policy Engine
//
// Pure-function policy resolver with segment-level glob matching.
// ActionType strings use `domain:resource:operation` format;
// `*` matches exactly one segment. The Cedar plugin (v0.2) will
// replace this module wholesale, so keep the interface narrow.
// ============================================================

import type {
  Action,
  ApprovalTier,
  ConsensusPolicy,
  PolicyRule,
} from "./types.js";

/**
 * Segment-level glob match. `*` matches exactly one segment.
 * Segments are delimited by `:`.
 *
 * @param pattern - Glob pattern (e.g. `"ci:*:deploy"`).
 * @param value - Concrete ActionType string to test.
 * @returns `true` if the pattern matches the value.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "" || value === "") return false;

  const patternSegments = pattern.split(":");
  const valueSegments = value.split(":");

  if (
    patternSegments.some((s) => s === "") ||
    valueSegments.some((s) => s === "")
  ) {
    return false;
  }

  if (patternSegments.length !== valueSegments.length) return false;

  return patternSegments.every(
    (seg, i) => seg === "*" || seg === valueSegments[i],
  );
}

/**
 * Check whether any capability pattern matches the given action type.
 *
 * @param capabilities - Array of glob patterns an agent holds.
 * @param actionType - The concrete ActionType to check.
 * @returns `true` if at least one capability matches.
 */
export function matchesCapability(
  capabilities: readonly string[],
  actionType: string,
): boolean {
  return capabilities.some((cap) => globMatch(cap, actionType));
}

/**
 * Result of resolving a policy for a given action.
 * `matchedRule` is `undefined` when no rule matches and defaults are used.
 */
export type ResolvedPolicy = {
  tier: ApprovalTier;
  reviewers: string[];
  consensus: ConsensusPolicy;
  escalateAbove: number | undefined;
  matchedRule: PolicyRule | undefined;
};

/**
 * Resolve which policy rule applies to an action.
 *
 * Returns the first rule whose `match` glob-matches `action.type`.
 * Rules are evaluated in insertion order (first match wins).
 *
 * @param action - The action being proposed.
 * @param rules - Registered policy rules, in insertion order.
 * @param defaultTier - Tier to use when no rule matches.
 * @returns The resolved policy for this action.
 */
export function resolvePolicy(
  action: Action,
  rules: PolicyRule[],
  defaultTier: ApprovalTier,
): ResolvedPolicy {
  const matched = rules.find((r) => globMatch(r.match, action.type));

  if (matched === undefined) {
    return {
      tier: defaultTier,
      reviewers: [],
      consensus: "single",
      escalateAbove: undefined,
      matchedRule: undefined,
    };
  }

  return {
    tier: matched.tier,
    reviewers: matched.reviewers ?? [],
    consensus: matched.consensus ?? "single",
    escalateAbove: matched.escalateAbove,
    matchedRule: matched,
  };
}
