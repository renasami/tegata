// ============================================================
// Tegata MCP Binding — Types
//
// Configuration types for TegataServer, the MCP tool call
// intercept that adds authorization to every tool invocation.
// ============================================================

import type { ActionType } from "../../core/types.js";

/**
 * Tegata-specific options attached to each tool registration.
 * These map the MCP tool to Tegata's policy engine.
 */
export type TegataToolOptions = {
  /** ActionType for policy glob matching (e.g. `"db:users:delete"`). */
  actionType: ActionType;
  /** Numeric risk score (0–100). Higher = riskier. */
  riskScore?: number;
  /** Whether this action can be rolled back. */
  reversible?: boolean;
  /** Description of how to undo this action. */
  rollbackPlan?: string;
  /** Human-readable description. Falls back to MCP tool description if omitted. */
  description?: string;
};

/**
 * Configuration for TegataServer.
 */
export type TegataServerConfig = {
  /** Fixed proposer ID for all tool calls through this server. */
  proposer: string;
};
