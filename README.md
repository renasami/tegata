# Tegata

**Enforceable authorization for MCP tool calls.**

MCP tool annotations like `readOnlyHint` are just hints — nothing stops a malicious server from declaring `readOnlyHint: true` and deleting your database. A2A explicitly marks authorization as ["implementation-specific"](https://github.com/a2aproject/A2A/blob/main/docs/specification.md). OWASP, NIST, and CSA all flag this gap but define no solution. Tegata fills it.

> **Name origin**: Tegata (手形) — Edo-period travel permits that certified a traveler's identity and authorized passage through checkpoints. Tegata does the same for AI agents.

## Before / After

```typescript
// ❌ Before: No governance — any agent can call any tool
await mcpClient.callTool("db:users:delete", { userId: "all" });
// Hope nothing goes wrong...

// ✅ After: Tegata intercepts and enforces approval
import { Tegata } from "tegata";

const tegata = new Tegata();

const result = await tegata.propose({
  action: { type: "db:users:delete", riskScore: 90, reversible: false },
  params: { userId: "all" },
});
// → riskScore 90 exceeds threshold → auto-escalated to human reviewer
// → Decision logged to immutable audit trail
```

## Where Tegata Fits

```
MCP    = Agent ↔ Tool    (Connection)
A2A    = Agent ↔ Agent   (Communication)
Tegata = Approval & Auth  (Governance) ← NEW
```

Tegata sits on top of MCP and A2A. It doesn't replace them — it adds the missing authorization layer.

### What Tegata is NOT

- **Not a gateway** — Solo.io agentgateway, MintMCP are infrastructure. Tegata defines the approval _rules_ that gateways enforce.
- **Not a policy engine** — Cedar, OPA evaluate policies. Tegata orchestrates the _approval workflow_ around them (Cedar plugin planned for v0.2).
- **Not a communication protocol** — A2A delivers messages. Tegata defines the _semantics of approval_ on top of those messages.

## Quick Start

```bash
npm install tegata
```

```typescript
import { Tegata } from "tegata";

const tegata = new Tegata({
  defaultTier: "review", // Default approval level
  escalateAbove: 70, // Auto-escalate when riskScore > 70
  timeoutMs: 30_000, // 30s timeout for reviewer response
  defaultOnTimeout: "deny", // Deny if no response
});

// Register an agent
tegata.registerAgent({
  id: "deploy-bot",
  name: "Deploy Bot",
  role: "proposer",
  capabilities: ["ci:*:read", "ci:staging:deploy"],
  maxApprovableRisk: 40,
});

// Propose an action
const decision = await tegata.propose({
  proposer: "deploy-bot",
  action: {
    type: "ci:production:deploy",
    description: "Deploy v2.3.1 to production",
    riskScore: 85,
    reversible: true,
    rollbackPlan: "Revert to v2.3.0 via CI rollback pipeline",
  },
});

// decision.status: "escalated"
// → deploy-bot lacks capability for ci:production:*
// → riskScore 85 > maxApprovableRisk 40
// → Escalated to supervisor agent or human reviewer
```

## Core Features

### Tiered Approval (MUST)

5-level approval that adapts to risk and capability:

| Tier       | Who Decides                  | When to Use                                                    |
| ---------- | ---------------------------- | -------------------------------------------------------------- |
| `auto`     | No one (pass-through)        | Read operations, cached queries                                |
| `notify`   | No one (log after execution) | Non-destructive writes (creating a draft, adding a comment)    |
| `review`   | Another agent                | Agent-to-agent approval (senior agent reviews junior's action) |
| `approve`  | Human                        | Human-in-the-loop (financial transaction > $10K, PII access)   |
| `escalate` | Higher authority             | Risk threshold exceeded or reviewer lacks capability           |

Tier selection is automatic based on `riskScore`, agent capabilities, and policy rules. Override per-action or globally via `TegataConfig`.

### Capability-based Authorization (MUST)

Agents declare what they _can do_ and what they _can approve_. If an agent proposes an action outside its capability scope, Tegata auto-escalates. No agent can approve its own proposals.

```typescript
// Agent can read all CI data but only deploy to staging
capabilities: ["ci:*:read", "ci:staging:deploy"];
// Agent can approve deployments up to riskScore 40
maxApprovableRisk: 40;
```

ActionType follows `domain:resource:operation` convention with glob matching (`ci:*:deploy` matches `ci:staging:deploy`).

### Policy-as-Code (MUST)

Define approval rules programmatically. No custom DSL — just TypeScript/JSON.

```typescript
tegata.addPolicy({
  match: "db:*:write",
  tier: "approve", // All DB writes require human approval
  consensus: "single",
  reviewers: ["db-admin"],
});

tegata.addPolicy({
  match: "ci:production:*",
  tier: "review",
  consensus: "majority", // Majority of reviewers must agree
  reviewers: ["senior-dev", "sre-lead", "security-bot"],
  escalateAbove: 80,
});
```

### Audit Trail (MUST)

Every proposal, decision, escalation, and timeout is logged immutably. Each entry includes who proposed, who reviewed, what was decided, and why.

```typescript
const logs = tegata.getAuditLog({ since: "2026-04-01" });
// [{ proposalId, proposer, action, decisions[], finalStatus, timestamp }]
```

### Dynamic Trust Score (SHOULD)

EMA-based inter-agent trust scoring. Agents that make good decisions see their trust rise; agents that cause incidents see it fall. Higher trust → more actions auto-approved.

```
TrustScore(t) = α × Performance(t) + (1 - α) × TrustScore(t-1)
// α = 0.3 default (configurable per domain)
```

Trust Score is optional — Tiered Approval works without it.

### Consensus Policies (SHOULD)

When multiple reviewers are involved:

| Policy      | Rule                        |
| ----------- | --------------------------- |
| `single`    | Any one reviewer approves   |
| `unanimous` | All reviewers must approve  |
| `majority`  | >50% of reviewers approve   |
| `quorum`    | N of M reviewers approve    |
| `weighted`  | Trust-score-weighted voting |

## Regulatory Alignment

Tegata's design maps directly to emerging AI governance requirements:

- **EU AI Act Article 14** (Aug 2026): Requires "effective human oversight" for high-risk AI. Tegata's `approve` and `escalate` tiers provide structured human intervention points.
- **California SB-833** (Jul 2026): Mandates pre-execution review of AI-proposed actions in critical infrastructure. Tegata's tiered approval fulfills this with `review`/`approve` tiers.
- **NIST NCCoE**: Asks "how does an agent prove it is authorized to perform a specific action?" — this is exactly what Tegata defines.

See [docs/regulatory-alignment.md](docs/regulatory-alignment.md) for detailed mapping.

## Design Decisions

Key architectural choices are documented as ADRs:

- [ADR-001: Why Tiered Approval over binary allow/deny](docs/adr/001-tiered-approval.md)
- [ADR-002: Why no custom DSL — Cedar as future plugin](docs/adr/002-no-custom-dsl.md)
- [ADR-003: Why Trust Score is SHOULD, not MUST](docs/adr/003-trust-score-optional.md)
- [ADR-004: Why ActionType uses free-form strings with glob matching](docs/adr/004-actiontype-glob.md)

## Roadmap

- **v0.1** (Current): Agent → Tool authorization (MCP tool call intercept)
- **v0.2**: Cedar policy engine plugin + MCP Extension (SEP proposal)
- **v0.3**: Agent ↔ Agent authorization (A2A binding, after A2A spec stabilizes)

## Tech Stack

- **Language**: TypeScript (source of truth) → JSON Schema auto-generation
- **Wire Format**: JSON-RPC 2.0 (same as MCP/A2A)
- **Spec Style**: RFC (MUST/SHOULD/MAY)
- **License**: Apache 2.0

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

If you're working on MCP security, A2A authorization, or agent governance, open an issue — let's talk.

## License

[Apache License 2.0](LICENSE)
