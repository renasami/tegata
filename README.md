# Tegata

**MCP Tool Call Authorization SDK for Multi-Agent Systems**

Tegata is a lightweight open-source SDK specializing in authorization for tool calls in AI multi-agent systems. While MCP (Anthropic) standardizes Agent-Tool connections and A2A (Google) standardizes Agent-Agent communication, no protocol exists to standardize "who approves what, under which conditions." Tegata fills this gap.

> **Name origin**: Inspired by Edo-period travel permits (通行手形). Tegata certifies an agent's capabilities and determines action authorization.

## What Tegata Does

Tegata handles two concerns:

1. **Capability** — What can this agent do? What can it approve?
2. **Authorization** — Should this specific action be executed? Who decides?

Capabilities are static definitions; authorization is a runtime decision. Both work together.

## Where Tegata Fits

```
MCP    = Agent ↔ Tool   (Connection Layer)
A2A    = Agent ↔ Agent  (Communication Layer)
Tegata = Approval & Auth (Governance Layer) ← NEW
```

Tegata runs on top of both MCP and A2A. It doesn't replace them — it adds the missing layer.

## Core Features

### MUST (Core)

- **Tiered Approval**: 5-level approval — `auto` / `notify` / `review` / `approve` / `escalate`
  - `auto`: Execute immediately (read operations)
  - `notify`: Execute immediately, notify afterward
  - `review`: Agent makes the approval decision (Agent-to-Agent)
  - `approve`: Human makes the approval decision (Human-in-the-Loop)
  - `escalate`: Escalate to a higher authority
- **Capability-based Authorization**: Automatic escalation based on agent capability scope and risk thresholds
- **Policy-as-Code**: Define approval rules in code. Supports ActionType glob matching (e.g., `db:*:write`)
- **Audit Trail**: Immutable audit logs recording every proposal, decision, escalation, and timeout

### SHOULD (Optional)

- **Dynamic Trust Score**: EMA-based inter-agent trust (α=0.3 default, overridable)
- **Consensus Policies**: `single` / `unanimous` / `majority` / `quorum` / `weighted`

## Architecture

```
tegata/
├── spec/                    # Standalone protocol spec (RFC-style)
├── core/                    # Core runtime
│   ├── types.ts             # Protocol type definitions (Source of Truth)
│   ├── policy-engine.ts     # Policy-as-Code engine
│   ├── trust-manager.ts     # Dynamic Trust Score (EMA)
│   ├── consensus.ts         # Consensus mechanisms (5 patterns)
│   ├── runtime.ts           # Main orchestrator
│   └── index.ts             # Entry point
├── bindings/
│   ├── mcp/                 # MCP Extension
│   └── a2a/                 # A2A Extension (v0.2+)
├── adapters/
│   ├── langgraph/           # LangGraph interrupt integration
│   └── agentgateway/        # Solo.io agentgateway (future)
└── examples/
    └── devops-flow.ts       # DevOps scenario (6-case verified)
```

## Key Types

### AgentCard

```typescript
interface AgentCard {
  id: AgentId;
  name: string;
  role: "proposer" | "reviewer" | "supervisor" | "executor" | "observer";
  capabilities: Capability[];           // What the agent can do
  approvableCapabilities: Capability[];  // What the agent can approve
  maxApprovableRisk: RiskScore;          // Max risk level the agent can approve
}
```

### ApprovalRequest

```typescript
interface ApprovalRequest {
  id: ProposalId;
  proposer: AgentId;
  reviewers: AgentId[];
  action: ProposedAction;
  status: "pending" | "approved" | "rejected" | "escalated" | "timeout";
  consensus: ConsensusPolicy;
  decisions: ReviewDecision[];
  timeoutMs: number;
  defaultOnTimeout: "deny" | "allow";
}
```

### ProposedAction

```typescript
interface ProposedAction {
  type: string;                    // e.g., "db:users:write"
  description: string;
  requiredCapability: Capability;
  riskScore: RiskScore;            // 0-100
  reversible: boolean;
  rollbackPlan?: string;
}
```

## Roadmap

- **v0.1**: Agent → Tool authorization (MCP tool call intercept)
- **v0.2+**: Agent ↔ Agent authorization (after A2A spec stabilizes)

## Tech Stack

- **Language**: TypeScript (Source of Truth) → JSON Schema auto-generation
- **Spec**: RFC-style documentation (MUST/SHOULD/MAY)
- **Wire Format**: JSON-RPC 2.0 (same as MCP/A2A)

## Design Principles

- Provide sensible defaults while making everything overridable (`TegataConfig`)
- No custom DSL for the policy engine (Cedar integration under consideration)
- Trust Score is SHOULD (Tiered Approval works without it)
- ActionType is a free-form string; `domain:resource:operation` naming convention is RECOMMENDED
- All config is optional — works with defaults out of the box

## Installation

```bash
npm install tegata
```

## License

[Apache License 2.0](./LICENSE)
