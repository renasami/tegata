# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `TegataConfig.mode: "shadow" | "enforce"` execution mode (ADR-006).
  `"enforce"` (default) blocks denied/escalated actions at the binding;
  `"shadow"` records the decision but never blocks. Exposed on the instance
  via `Tegata#mode`.
- `scripts/analyze-audit-log.mjs` now prints an execution-mode breakdown and
  warns when every entry is `shadow` (i.e. verdicts are not being enforced).

### Changed (breaking)

- `AuditEvent` gains a **required** `mode` field. Any external code that
  constructs or structurally implements `AuditEvent` must now supply `mode`.
  The runtime always populates it, so consumers only reading the audit log are
  unaffected. Acceptable under the preview (`0.1.0-preview.x`) API-not-frozen
  policy; called out here for the v0.1.0 GA cut.
