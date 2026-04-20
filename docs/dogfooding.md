# Dogfooding Tegata on Claude Code

Tegata's author runs Tegata against his own Claude Code tool calls. This
document shows how to replicate the setup on your machine.

## What it does

[`tools/claude-code-hook.mjs`](../tools/claude-code-hook.mjs) is a
[`PreToolUse`](https://docs.claude.com/en/docs/claude-code/hooks) hook. For
every tool call Claude Code makes (Bash, Edit, Write, Read, MCP servers,
subagents, ...), the hook:

1. Classifies the call into a Tegata `Action` — `ActionType` + `riskScore`
2. Calls `tegata.propose({ proposer: "claude-code", action, ... })`
3. Appends the full decision to `~/.claude/tegata-audit.jsonl`
4. In **shadow mode** (default): exits 0 regardless of the verdict
5. In **enforce mode**: exits 2 if Tegata denied or escalated — Claude Code
   blocks the tool call and shows the reason to the model

Shadow mode is the safe starting point. You collect real data about what
Tegata _would_ have done without interrupting any work. Flip to enforce
mode once you trust the classification table.

## Setup

### 1. Build Tegata

The hook imports `Tegata` from this repo's `dist/` directory — the exact
same bundle shipped to npm as `tegata@preview`. Build it once:

```bash
pnpm install
pnpm run build
```

If you want the hook to survive `pnpm run build` clobbering `dist/`,
install `tegata` as a normal dependency somewhere and change the
`distEntry` path in the hook file.

### 2. Register the hook

Add a `PreToolUse` entry to your Claude Code settings. For project-scoped
dogfooding, edit `.claude/settings.local.json` in your project root (this
file is gitignored by default):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/tegata/tools/claude-code-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

For machine-wide dogfooding, put the same block in `~/.claude/settings.json`.

### 3. (Later) Turn on enforcement

Once you've reviewed `~/.claude/tegata-audit.jsonl` and tuned the
classification table to your taste, set `TEGATA_HOOK_ENFORCE=1` in the
environment where Claude Code runs:

```json
{
  "command": "TEGATA_HOOK_ENFORCE=1 node /path/to/tegata/tools/claude-code-hook.mjs"
}
```

In enforce mode, tool calls with `decision.status === "denied"` or
`"escalated"` are blocked with exit code 2. The reason is piped to stderr
so Claude sees it.

## Classification table (current defaults)

| Tool                      | ActionType                  | riskScore |
| ------------------------- | --------------------------- | --------- |
| `Read`/`Glob`/`Grep`      | `read:fs:*`                 | 5         |
| `Edit`/`MultiEdit`        | `write:fs:edit`             | 40        |
| `Write`                   | `write:fs:write`            | 45        |
| `Bash` `git status`       | `shell:git:read`            | 5         |
| `Bash` `git commit`       | `shell:git:write`           | 40        |
| `Bash` `git push`         | `shell:git:push`            | 71        |
| `Bash` `git push -f`      | `shell:git:push-force`      | 95        |
| `Bash` `git reset --hard` | `shell:git:reset-hard`      | 85        |
| `Bash` `rm -rf`           | `shell:fs:delete-recursive` | 85        |
| `Bash` `pnpm test` etc    | `shell:test:run`            | 10        |
| `Bash` `pnpm publish`     | `shell:pkg:mutate`          | 55        |
| `WebFetch`/`WebSearch`    | `web:*:request`             | 20        |
| `Task` (subagent)         | `agent:subagent:spawn`      | 30        |
| `mcp__*__read*`           | `mcp:<server>:read`         | 10        |
| `mcp__*__write*`          | `mcp:<server>:write`        | 40        |

With the default `escalateAbove: 70`, only `git push`, `git push --force`,
`git reset --hard`, and `rm -rf` cross the threshold. Note that `escalateAbove`
uses strict `>` — that's why `git push` is pinned at `71`, not `70`. Override
per-action types with Tegata policies inside `tools/claude-code-hook.mjs`.

## Reading the audit log

Each line in `~/.claude/tegata-audit.jsonl` is a JSON object:

```json
{
  "ts": "2026-04-19T17:05:36.221Z",
  "session_id": "abc123",
  "cwd": "/Users/ren/projects/tegata",
  "tool_name": "Bash",
  "action_type": "shell:git:push-force",
  "risk_score": 95,
  "proposal_id": "prop_01HW...",
  "decision_status": "escalated",
  "decision_tier": "auto",
  "decision_reason": "riskScore 95 exceeds escalateAbove 70",
  "decision_ts": "2026-04-19T17:05:36.219Z",
  "mode": "shadow"
}
```

Count tool types:

```bash
cat ~/.claude/tegata-audit.jsonl | jq -r '.tool_name' | sort | uniq -c | sort -rn
```

Find calls that would have been blocked in enforce mode:

```bash
cat ~/.claude/tegata-audit.jsonl \
  | jq 'select(.decision_status=="denied" or .decision_status=="escalated")'
```

## Safety guarantees

- The hook **never** throws into Claude Code. Every error path falls
  through to `exit 0`. Worst case: you lose a log line.
- Missing or broken `dist/` → hook silently no-ops.
- Audit log writes are best-effort; disk errors don't break the hook.

This is deliberately conservative: dogfooding Tegata should never degrade
the host agent's reliability. If Tegata itself has a bug, Claude Code keeps
running as if the hook weren't there.
