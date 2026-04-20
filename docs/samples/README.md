# Sample audit logs

Real shadow-mode output from running Tegata against live Claude Code
sessions. These are committed verbatim (with only the author's username
masked) so readers can reproduce the analysis and use the data as blog /
talk material.

## Files

| File                            | Source                                                   | Range                                   | Entries |
| ------------------------------- | -------------------------------------------------------- | --------------------------------------- | ------- |
| `shadow-mode-claude-code.jsonl` | Claude Code `PreToolUse` hook (see `docs/dogfooding.md`) | 2026-04-19 17:04 → 2026-04-20 16:36 UTC | 121     |

## How it was captured

1. The `tools/claude-code-hook.mjs` PreToolUse hook was wired into Claude
   Code via `~/.claude/settings.json` (see `docs/dogfooding.md`).
2. Every `Bash`, `Edit`, `Write`, `Read`, MCP call, etc. that Claude
   emitted was classified (`tools/lib/classify.mjs`) into an
   `ActionType` + `riskScore` and passed through `tegata.propose()` with
   `proposer: "claude-code"`.
3. Each decision was appended to `~/.claude/tegata-audit.jsonl`.
4. Shadow mode (the default — `TEGATA_HOOK_ENFORCE` was not set) — all
   tool calls were allowed regardless of verdict; the log records what
   Tegata _would_ have blocked in enforce mode.

## Summary (generated from this file)

Run `node scripts/analyze-audit-log.mjs` to reproduce.

```
Total:      121
Approved:   115 (95.0%)  [auto-pass]
Escalated:  6   (5.0%)   [human/senior review required]
Denied:     0
```

Escalations (every single one is a genuinely dangerous action):

| ActionType                  | riskScore | Count |
| --------------------------- | --------- | ----- |
| `shell:git:push-force`      | 95        | 2     |
| `shell:fs:delete-recursive` | 85        | 2     |
| `shell:git:push`            | 71        | 2     |

Top action types by volume:

| ActionType                  | Count |
| --------------------------- | ----- |
| `write:fs:edit`             | 32    |
| `mcp:claude_ai_Kanbi:write` | 12    |
| `shell:exec:generic`        | 12    |
| `read:fs:read`              | 10    |
| `shell:test:run`            | 8     |

## What to take from this

- **Tiered Approval works as designed.** 95% of a real coding session
  passes through without friction. The 5% that escalates is not
  theoretical — it's `git push --force`, `rm -rf`, and `git push` to a
  shared branch, i.e. the exact actions that cause incidents when they
  go wrong.
- **Zero false positives / negatives (by inspection).** Every
  escalation was a real write to a remote or a recursive delete; no
  benign reads were caught. No genuinely destructive action slipped
  through.
- **`git push` alone (not `--force`) is correctly escalated.**
  riskScore 71 exceeds the default `escalateAbove: 70` threshold using
  strict `>`. This is the fix from PR #15 — previously this would have
  auto-approved. Note: a handful of entries earlier in the log still
  show `risk_score: 70 / decision_status: approved` because they were
  captured against the pre-fix classifier. Those rows are kept as
  historical evidence of _why_ the fix was needed, not as current
  behavior.
- **Classification gaps are visible.** `unknown:ToolSearch:exec`
  appears in the log (5 occurrences) — Claude Code's deferred-tool
  lookup isn't in the classifier yet. This is the kind of real-world
  data the dogfooding loop was designed to surface.

## Known warts in the data (do not clean up)

These are preserved intentionally — they're evidence of real-world
issues the project still needs to address:

- **`session_id` variance**: `test`, `unknown`, `post-format`,
  `smoke-test`, and a Claude-generated UUID all appear. This motivates
  ADR-004 on `session_id` semantics (tracked in Kanbi).
- **Schema drift**: early entries lack `proposal_id` / `decision_reason`
  / `decision_ts` because the hook's log format was tightened after PR
  #15. The analyzer handles both shapes.
- **`smoke-test` entry with `cwd: /tmp`**: a one-off manual smoke run,
  not a real session. Left in because removing it would bias the
  dataset toward "clean" data that doesn't match what users will
  actually see.
- **Self-referential entries**: the later half of the log records
  Tegata's own development (editing `classify.mjs`, running
  `pnpm test`, `gh pr create`). This is the point — the author was
  running Tegata on the session that was shipping Tegata.

## Privacy

The only transformation applied is:

```
sed 's|/Users/ren/|/Users/<user>/|g'
```

No other fields are redacted. `session_id` values are either generic
strings (`test`, `unknown`) or a Claude Code-generated UUID that does
not correspond to anything outside this dataset.

## Reproducing

```bash
# 1. Set up the hook (one-time)
#    See docs/dogfooding.md

# 2. Use Claude Code normally. The hook writes to
#    ~/.claude/tegata-audit.jsonl

# 3. Run the analyzer
node scripts/analyze-audit-log.mjs

# 4. Optional: analyze a specific file
node scripts/analyze-audit-log.mjs docs/samples/shadow-mode-claude-code.jsonl
```

## Caveats

- Single author, single machine, single week — this is a qualitative
  "does the classifier match reality" check, not a statistically
  meaningful precision / recall measurement. That belongs to the
  evaluation framework (tracked in Kanbi: false-positive / negative
  measurement).
- Shadow mode only. Enforce-mode friction is a separate experiment.
- The riskScore thresholds were set by the author's intuition; they are
  not validated against an independent reviewer.
