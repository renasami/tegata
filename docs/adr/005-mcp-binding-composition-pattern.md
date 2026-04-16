# ADR-005: MCP Binding — Composition Pattern

**Status**: Accepted
**Date**: 2026-04-17
**Author**: Ren Asami

## Context

Tegata v0.1's primary deliverable is MCP tool call interception. The core runtime (propose/policy/audit) is complete. This ADR records the design decisions for `TegataServer`, the binding that connects Tegata's authorization flow to the MCP SDK's `McpServer`.

Key constraints:

1. MCP Server developers should need minimal code to adopt Tegata
2. The binding must not couple Tegata to MCP SDK internals
3. Denied tool calls must be visible to the LLM (not silent failures)
4. The MCP SDK is a peer dependency — core-only users should not need it

## Decisions

### Composition over inheritance

`TegataServer` holds an `McpServer` instance and delegates `tool()` and `connect()`. It does not extend `McpServer`.

**Why**: The MCP SDK's `McpServer` is a high-level convenience class that may change method signatures or internal state management across versions. Inheritance would create tight coupling — any SDK refactor could break Tegata. Composition isolates Tegata from SDK internals and makes the delegation surface explicit.

### actionType separated from MCP tool name

Each tool registration requires an explicit `actionType` (e.g. `"db:users:delete"`) independent of the MCP tool name. The `actionType` is what Tegata's policy engine glob-matches against.

**Why**: MCP tool names are display identifiers chosen by server authors. Tegata's policy system uses `domain:resource:operation` patterns for glob matching. Coupling these would force awkward tool naming or limit policy expressiveness. Separation means `tool("delete-user", ..., { actionType: "db:users:delete" }, ...)` works naturally.

### Fixed proposer per TegataServer

The `proposer` ID is set once at construction and used for all tool calls through that server instance.

**Why**: In v0.1, each MCP server represents a single agent. Per-call proposer selection adds complexity for a use case (multi-agent MCP servers) that doesn't exist yet. If needed in v0.3 (A2A binding), `proposer` can be made a function `(toolName, args) => string` without breaking the v0.1 API.

### isError: true for denials

Denied, escalated, and timed-out tool calls return `CallToolResult` with `isError: true` and a text content block explaining the denial.

**Why**: MCP's `isError` flag is the standard mechanism for signaling tool call failures to the LLM. Setting it ensures the LLM sees the denial and can adjust (e.g., request a lower-risk alternative). Silent denial (returning success with no output) would confuse the LLM; throwing an exception would crash the server.

### proposalId in denial messages

The denial text includes the Tegata `proposalId` (e.g. `"Tegata denied: riskScore exceeds threshold (proposal: abc-123)"`).

**Why**: This links the LLM-visible error to Tegata's immutable audit log. Operators can search the audit log by proposalId to understand why a tool call was denied, who proposed it, and what policy matched.

### peerDependency + optional

`@modelcontextprotocol/sdk` is a `peerDependency` (>=1.12.0) with `optional: true` in `peerDependenciesMeta`.

**Why**: Users who only use Tegata's core runtime (propose/policy/audit) should not be forced to install the MCP SDK. The `optional` flag prevents npm/pnpm from warning when the SDK is absent. The `"./mcp"` export entry is only usable when the SDK is installed.

### Handler error catching in bindings

The wrapped handler uses try/catch to prevent tool handler crashes from taking down the MCP server. Errors are returned as `isError: true` results.

**Why**: `no-try-statements` is enforced only in `src/core/**`. Bindings interact with user-supplied handlers that may throw. Letting exceptions propagate would crash the MCP server process. Catching and returning `isError: true` keeps the server running and gives the LLM a meaningful error.

### Constructor does not validate proposer

Empty `proposer` is not validated in the `TegataServer` constructor.

**Why**: `no-throw-statements` is enforced across all `src/**`. The constructor cannot throw. Instead, `Tegata.propose()` returns `status: "denied"` with `"proposer must not be empty"` — the denial flows through the same path as any other policy denial, appears in the audit log, and is visible to the LLM.

## Alternatives Considered

### Alternative A: Subclass McpServer

Extend `McpServer` and override `tool()` / `registerTool()`.

- Pros: Feels more native to McpServer users; no need for a separate class
- Cons: Tightly coupled to McpServer internals (private fields, method signatures); TypeScript private members aren't overridable; SDK version updates could break the subclass
- Why rejected: Composition provides the same API ergonomics without coupling risk

### Alternative B: Middleware / hook pattern

Register a global "before tool call" hook on McpServer instead of wrapping individual tools.

- Pros: Simpler API (one line instead of per-tool registration); applies to all tools automatically
- Cons: McpServer has no middleware/hook API; would require monkeypatching internals; per-tool `actionType` and `riskScore` metadata would need a side-channel registry; less explicit than per-tool options
- Why rejected: No SDK support for middleware; per-tool options are clearer and more flexible

### Alternative C: Derive actionType from tool name

Auto-generate `actionType` from the MCP tool name (e.g. `"delete-user"` → `"delete:user"`).

- Pros: Less boilerplate per tool registration
- Cons: MCP tool names don't follow `domain:resource:operation`; auto-mapping heuristics would be fragile; policy patterns would depend on tool naming conventions; breaks the separation principle
- Why rejected: Explicit is better than implicit. One extra field per tool is minimal overhead for full policy control.

## Consequences

### Positive

- MCP Server developers add ~3 lines to get full authorization governance
- Core Tegata users are unaffected (no new required dependency)
- Denial messages are LLM-visible with audit trail linkage
- SDK version changes only require updating the composition delegation, not rewriting inheritance chains

### Negative

- `TegataServer.tool()` has a different signature from `McpServer.tool()` (extra `tegataOpts` parameter) — not a drop-in replacement
- Users must learn Tegata's `actionType` concept in addition to MCP tool names

### Risks

- MCP SDK may add its own authorization/governance layer in the future, potentially overlapping with Tegata. Mitigated by Tegata's position as a governance layer _above_ MCP, not a replacement.
- `registerTool` API may change across MCP SDK versions. Mitigated by peerDependency version range and composition pattern (only `registerTool` and `connect` are delegated).
