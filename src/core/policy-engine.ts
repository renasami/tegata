// ============================================================
// Tegata — Policy Engine
//
// Pure-function policy resolver. The skeleton implementation
// performs exact-match only; glob matching is deferred to a
// follow-up PR. The Cedar plugin (v0.2) will replace this
// module wholesale, so keep the interface narrow and stable.
// ============================================================

import type {
  Action,
  ApprovalTier,
  ConsensusPolicy,
  PolicyRule,
} from "./types.js";

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
 * Skeleton behavior: returns the first rule whose `match` equals
 * `action.type` exactly. Glob matching will land in a follow-up PR.
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
  const matched = rules.find((r) => r.match === action.type);

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
