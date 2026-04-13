// ============================================================
// Tegata — Glob Matching Utilities
//
// Segment-level glob matching for ActionType strings.
// Shared by policy-engine.ts and audit.ts. Extracted to avoid
// coupling the audit store to the policy engine (which will be
// replaced wholesale by the Cedar plugin in v0.2).
// ============================================================

/**
 * Segment-level glob match. `*` matches exactly one non-empty segment.
 * Segments are delimited by `:`. Multi-segment wildcards (`**`) are
 * not supported.
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
