# ADR-007: Tegata's Scope — Workflow Approval, Not Transport Authn/Authz

**Status**: Accepted
**Date**: 2026-05-05
**Author**: Ren Asami

## Context

Tegata is repeatedly described — in early drafts of the README, in
conference pitches, and in informal explanations — as "filling the
authorization gap that MCP and A2A leave." This framing is not quite
right and, while writing public material citing MCP and A2A specs
verbatim, the inaccuracy became unignorable:

- **MCP** does specify authorization. The
  [authorization section of the MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
  defines OAuth 2.1, Bearer tokens, and resource-server semantics for
  server-to-server authentication.
- **A2A** does specify authorization. The A2A specification (sections
  3.3.2, 4.5.x, 13.1) defines `securitySchemes` (OAuth2, API key,
  HTTP, OpenID Connect) and explicitly states that
  > "Servers MUST return an authorization error when the authenticated
  > client lacks required permissions."

So the headline "MCP and A2A have no authorization" is false. What
neither protocol defines is the layer Tegata actually targets:

- _Who is allowed to **approve** an action proposed by an agent?_
- _What does an "approval" look like — single reviewer, majority,
  human-in-the-loop, escalation on risk threshold?_
- _Is there an immutable record showing who approved what and why?_
- _Can an agent veto its own proposal? Can a junior agent escalate to
  a senior one?_

These are workflow-level questions. Authn/authz answers "is this
caller allowed to invoke this endpoint at all?" — a different layer.
A correctly-authenticated agent with a valid OAuth token can still
delete a production database; transport authz says nothing about
whether that _decision_ should require human approval.

This ADR records the scope boundary so future contributors, blog
posts, talks, and competitive comparisons stop conflating the two.

## Decision

**Tegata defines a workflow approval primitive. It does not define,
replace, or extend transport-layer authentication or authorization.**

Concretely:

| Concern                                         | Owner              | Tegata's role                                |
| ----------------------------------------------- | ------------------ | -------------------------------------------- |
| Is the caller who they say they are?            | MCP / A2A / OAuth  | None — assume authn already happened         |
| Can this caller invoke this endpoint?           | MCP / A2A / OAuth  | None — assume coarse authz already happened  |
| Should this _specific action_ require approval? | **Tegata**         | `PolicyRule` + `riskScore` + `escalateAbove` |
| Who approves it, and under what consensus?      | **Tegata**         | `tier`, `reviewers`, `consensus`             |
| What's the record of who approved what?         | **Tegata**         | `AuditEvent` event-sourcing log (ADR-003)    |
| What happens on timeout?                        | **Tegata**         | `defaultOnTimeout`, escalation status        |
| When is the binding allowed to actually block?  | **Tegata** binding | `mode: shadow \| enforce` (ADR-006)          |

Tegata's bindings (`TegataServer` for MCP, future A2A binding) sit
_inside_ the authenticated request — after the transport layer has
already verified "this token is valid and allowed to call
`tools/call`" — and answer the next question: "given that this caller
is authorized to make _a_ tool call, should _this specific tool call_
be approved by a human, escalated, or auto-approved?"

The two layers compose. They do not overlap.

### Public-material rule

All public material (README, blog posts, talks, comparison tables, ADR
references) MUST describe Tegata as one of:

- "workflow approval primitive"
- "missing approval layer"
- "approval orchestration"
- "tiered approval governance"

…and MUST NOT describe Tegata as one of:

- "the missing authorization in MCP"
- "filling the authz gap"
- "agent-to-tool authentication"
- "replacing OAuth for agents"

Reviewers should reject PRs that introduce the rejected phrasings.
The current README still contains the inaccurate phrasing on line 7
("A2A explicitly marks authorization as 'implementation-specific'");
the README correction shipping with this ADR removes it.

## Alternatives Considered

### Alternative A: Keep the "missing authorization" framing

- Description: Continue marketing Tegata as the layer that adds
  authorization to MCP/A2A.
- Pros: Stronger-sounding positioning. Easier elevator pitch
  ("authorization for AI agents").
- Cons: Verifiably wrong against both specs. Anyone who reads the
  source specs (auditors, security reviewers, platform teams) will
  catch the inaccuracy and lose trust in the rest of the value
  proposition. Also invites the wrong competitive comparisons —
  Tegata gets benchmarked against OAuth providers and identity
  systems it has no business competing with.
- Why rejected: A governance SDK whose pitch contradicts the specs it
  claims to extend has a credibility problem on its first page.

### Alternative B: Expand scope to include transport authz

- Description: Build out token validation, scope enforcement, and
  identity federation so Tegata _does_ become an authorization
  layer.
- Pros: Removes the scope ambiguity by absorbing the other layer.
- Cons: Reinvents OAuth 2.1 / OIDC inside an SDK that has no business
  doing so. Massively expands the threat model. Forces every
  Tegata adopter to migrate their identity stack.
- Why rejected: Workflow approval is unsolved; transport authz is
  thoroughly solved. Building the unsolved thing is the opportunity;
  rebuilding the solved thing is the trap.

### Alternative C: Scope to MCP only, drop A2A claims entirely

- Description: Remove all A2A mentions from the README and roadmap;
  position Tegata as MCP-only.
- Pros: Eliminates the inaccurate A2A claim by removing the topic.
- Cons: A2A is the long-term destination — agent-to-agent approval
  is genuinely the most interesting use case for tiered consensus.
  Dropping it now means abandoning the most differentiated v0.3
  scope.
- Why rejected: The fix for an inaccurate A2A claim is to make an
  accurate A2A claim, not to delete the topic.

## Consequences

### Positive

- Marketing copy, ADRs, and code comments converge on the same
  vocabulary, which makes positioning legible to security reviewers
  reading any one of them.
- Competitive comparisons get framed against the right neighbors:
  approval-workflow systems (PagerDuty change approvals, GitHub
  CODEOWNERS, ServiceNow change requests) — not OAuth providers.
- Future contributors have a written rule for evaluating "should
  Tegata add feature X?": if X is transport authn/authz, the answer
  is no by default; if X is approval workflow, it's in scope.

### Negative

- Pitches need a sentence to disambiguate Tegata from OAuth/OIDC
  every time MCP authorization comes up. Mitigated by the
  scope-table above being copy-pasteable.
- The "missing authorization" elevator pitch is stronger than "missing
  approval primitive" for non-technical audiences. We accept the
  weaker pitch in exchange for accuracy.

### Risks

- A reviewer or contributor who hasn't read this ADR may reintroduce
  the inaccurate phrasing in a future PR. Mitigated by the
  reviewer-checklist line in the public-material rule above and by
  the README correction shipping concurrently.
- If MCP or A2A later adds a workflow-approval primitive of its own,
  Tegata's scope shrinks. Mitigated by Tegata's plugin posture
  (Cedar/OPA integration in v0.2): if the protocol layer absorbs
  approval semantics, Tegata becomes the policy-engine glue rather
  than the primitive itself. Either way, the ADR's scope boundary
  remains a useful invariant.

## References

- [MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) — the OAuth 2.1 layer Tegata sits above.
- [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) — sections 3.3.2 / 4.5.x / 13.1 define `securitySchemes` and authz error semantics.
- [OWASP LLM06 — Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/): "Authorization must be controlled by downstream systems rather than the model's output." — the workflow-approval gap this ADR scopes Tegata to fill.
- [ADR-003: Audit event-sourcing model](003-audit-event-sourcing-model.md) — the "who approved what" record half of the workflow primitive.
- [ADR-006: Execution modes (shadow vs enforce)](006-execution-modes.md) — the binding-side enforcement contract.
