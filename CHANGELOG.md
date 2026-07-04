# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No changes yet._

## [0.1.0] - 2026-07-04

First stable release. The API is now frozen — no breaking changes will ship
until a semver-major bump. This section summarizes what changed since
`0.1.0-preview.0`.

### Added

- `Tegata.create()` validating static factory (ADR-009). Out-of-range config
  (`escalateAbove` outside `[0, 100]`, non-positive `timeoutMs`, unknown
  `mode`) returns `Err` instead of silently corrupting runtime state. `new
Tegata()` remains available with sensible defaults.
- `TegataConfig.mode: "shadow" | "enforce"` execution mode (ADR-006).
  `"enforce"` (default) blocks denied/escalated actions at the binding;
  `"shadow"` records the decision but never blocks. Exposed on the instance
  via `Tegata#mode`.
- Claude Code dogfooding: a `PreToolUse` hook (`tools/claude-code-hook.mjs`)
  that classifies every tool call into a Tegata `Action` and runs it through
  `tegata.propose()`. Classification logic extracted to `tools/lib/classify.mjs`
  and covered by 107 tests. See [docs/dogfooding.md](docs/dogfooding.md).
- Real shadow-mode audit log committed at
  `docs/samples/shadow-mode-claude-code.jsonl`, plus an analyzer
  (`scripts/analyze-audit-log.mjs`) that prints summary stats and an
  execution-mode breakdown, warning when every entry is `shadow` (i.e. verdicts
  are recorded but never enforced).
- ADR-006 (execution modes), ADR-007 (workflow approval vs transport authn —
  the v0.1 scope boundary), ADR-008 (dogfooding via `PreToolUse` hook), and
  ADR-009 (validating factory) accepted under `docs/adr/`.

### Changed

- `AuditEvent` gains a **required** `mode` field. The runtime always populates
  it, so consumers only reading the audit log are unaffected; code that
  constructs or structurally implements `AuditEvent` must now supply `mode`.
- README: corrected the A2A `securitySchemes` citation against the primary
  source, clarified that `proposer` is a required field (ADR-002 rationale),
  and documented the `shadow`/`enforce` execution modes.

[Unreleased]: https://github.com/renasami/tegata/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/renasami/tegata/releases/tag/v0.1.0
