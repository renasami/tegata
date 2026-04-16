// ============================================================
// Tegata v0.1 — Core Protocol Types
// Source of truth for all type definitions.
// ============================================================

// ------------------------------------------------------------
// ActionType — "domain:resource:operation" glob-matchable string
// ------------------------------------------------------------

/** Colon-delimited action identifier (e.g. `"ci:production:deploy"`). */
export type ActionType = string;

// ------------------------------------------------------------
// Approval Tiers
// ------------------------------------------------------------

export type ApprovalTier = "auto" | "notify" | "review" | "approve";

// ------------------------------------------------------------
// Decision Status
// ------------------------------------------------------------

export type DecisionStatus =
  | "approved"
  | "denied"
  | "escalated"
  | "timed_out"
  | "pending";

// ------------------------------------------------------------
// Consensus Policy
// ------------------------------------------------------------

export type ConsensusPolicy =
  | "single"
  | "unanimous"
  | "majority"
  | "quorum"
  | "weighted";

// ------------------------------------------------------------
// Timeout Behavior
// ------------------------------------------------------------

export type TimeoutBehavior = "deny" | "escalate";

// ------------------------------------------------------------
// Agent
// ------------------------------------------------------------

export type AgentRole = "proposer" | "reviewer" | "supervisor";

export type AgentRegistration = {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Primary role of this agent. */
  role: AgentRole;
  /** Glob patterns describing actions this agent can perform / approve. */
  capabilities: ActionType[];
  /** Maximum riskScore this agent can approve without escalation. */
  maxApprovableRisk: number;
};

// ------------------------------------------------------------
// Action
// ------------------------------------------------------------

export type Action = {
  /** ActionType string — `domain:resource:operation`. */
  type: ActionType;
  /** Human-readable description of what this action does. */
  description?: string;
  /** Numeric risk score (0–100). Higher = riskier. */
  riskScore?: number;
  /** Whether this action can be rolled back. */
  reversible?: boolean;
  /** Description of how to undo this action. */
  rollbackPlan?: string;
};

// ------------------------------------------------------------
// Proposal
// ------------------------------------------------------------

export type Proposal = {
  /** ID of the agent or caller proposing this action. */
  proposer: string;
  /** The action being proposed. */
  action: Action;
  /** Arbitrary parameters for the tool call. */
  params?: Record<string, unknown>;
};

// ------------------------------------------------------------
// Review / Approval handler types
// ------------------------------------------------------------

/** Result returned by a review or approval handler. */
export type ReviewResult = {
  /** Whether the proposal was approved or denied. */
  status: "approved" | "denied";
  /** Who made the decision (agent ID or human identifier). */
  decidedBy: string;
  /** Optional reason for the decision. */
  reason?: string;
};

/**
 * Handler invoked when a `review` tier policy matches.
 * Returns a decision from an agent reviewer.
 */
export type ReviewHandler = (proposal: Proposal) => Promise<ReviewResult>;

/**
 * Handler invoked when an `approve` tier policy matches.
 * Returns a decision from a human approver.
 */
export type ApprovalHandler = (proposal: Proposal) => Promise<ReviewResult>;

// ------------------------------------------------------------
// Decision (returned by propose())
// ------------------------------------------------------------

export type Decision = {
  /** Unique ID for this proposal/decision pair. */
  proposalId: string;
  /** The original proposal. */
  proposal: Proposal;
  /** Final status after evaluation. */
  status: DecisionStatus;
  /** The approval tier that was applied. */
  tier: ApprovalTier;
  /** IDs of agents/humans that reviewed (if any). */
  reviewers: string[];
  /** Who made the final decision. Set by review/approve handlers; undefined for auto/notify. */
  decidedBy: string | undefined;
  /** Human-readable reason for the decision. */
  reason?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
};

// ------------------------------------------------------------
// Policy Rule (discriminated union on `tier`)
// ------------------------------------------------------------

/** Policy for auto/notify tiers — no handler required. */
export type AutoPolicy = {
  /** Glob pattern matched against ActionType. */
  match: ActionType;
  /** Approval tier. */
  tier: "auto" | "notify";
};

/** Policy for review tier — handler required. */
export type ReviewPolicy = {
  /** Glob pattern matched against ActionType. */
  match: ActionType;
  /** Approval tier. */
  tier: "review";
  /** Agent IDs that should review matching actions. */
  reviewers?: string[];
  /** Consensus policy when multiple reviewers are involved. */
  consensus?: ConsensusPolicy;
  /** Handler invoked to obtain a review decision. */
  handler: ReviewHandler;
  /** Override: escalate if riskScore exceeds this threshold. */
  escalateAbove?: number;
  /** Per-policy timeout override (ms). Falls back to TegataConfig.timeoutMs. */
  timeoutMs?: number;
};

/** Policy for approve tier — handler required. */
export type ApprovePolicy = {
  /** Glob pattern matched against ActionType. */
  match: ActionType;
  /** Approval tier. */
  tier: "approve";
  /** Agent/human IDs that should approve matching actions. */
  approvers?: string[];
  /** Handler invoked to obtain an approval decision. */
  handler: ApprovalHandler;
  /** Override: escalate if riskScore exceeds this threshold. */
  escalateAbove?: number;
  /** Per-policy timeout override (ms). Falls back to TegataConfig.timeoutMs. */
  timeoutMs?: number;
};

export type PolicyRule = AutoPolicy | ReviewPolicy | ApprovePolicy;

// ------------------------------------------------------------
// Tegata Config
// ------------------------------------------------------------

export type TegataConfig = {
  /** Default approval tier when no policy matches. */
  defaultTier?: ApprovalTier;
  /** Auto-escalate when riskScore exceeds this value. */
  escalateAbove?: number;
  /** Timeout in ms for reviewer response. */
  timeoutMs?: number;
  /** What to do when a review times out. */
  defaultOnTimeout?: TimeoutBehavior;
};

// ------------------------------------------------------------
// Audit Log (event-sourcing model)
//
// Each call to propose() emits one or more AuditEvent records.
// Events are append-only — never updated after creation.
// Multiple events share the same proposalId to form a timeline.
// ------------------------------------------------------------

export type AuditEventType =
  | "proposed"
  | "decided"
  | "pending"
  | "escalated"
  | "timed_out";

export type AuditEvent = {
  /** Links this event to the proposal it belongs to. */
  proposalId: string;
  /** What happened. */
  eventType: AuditEventType;
  /** The original proposal. Present on every event for queryability. */
  proposal: Proposal;
  /** The decision made. Present on "decided", "escalated", "timed_out". */
  decision?: Decision;
  /** ISO-8601 timestamp of this event. */
  timestamp: string;
};

export type AuditQuery = {
  /** ISO-8601 date string — return events on or after this date. */
  since?: string;
  /** Filter by proposer agent ID. */
  proposer?: string;
  /** Filter by action type (glob match). */
  actionType?: ActionType;
  /** Filter by proposal ID. */
  proposalId?: string;
  /** Maximum number of events to return. */
  limit?: number;
};

// ------------------------------------------------------------
// Result pattern — used throughout core instead of exceptions
// ------------------------------------------------------------

export type Ok<T> = {
  ok: true;
  value: T;
};

export type Err = {
  ok: false;
  error: string;
};

export type Result<T> = Ok<T> | Err;
