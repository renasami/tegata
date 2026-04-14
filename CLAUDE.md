# Tegata

MCP tool call authorization SDK for multi-agent systems. TypeScript, Apache 2.0.

See @README.md for full project overview and positioning.

## Architecture

```
core/
  types.ts          # Source of truth for all protocol types
  runtime.ts        # Main orchestrator: propose() → evaluate() → decide()
  policy-engine.ts  # Glob-matching policy evaluation
  audit.ts          # Immutable audit log
bindings/
  mcp/              # MCP tool call intercept (v0.1 scope)
examples/
  devops-flow.ts    # DevOps deployment scenario
```

## Code Style

- TypeScript strict mode, no `any`
- ES modules (import/export), never CommonJS
- Named exports, no default exports
- Use `type` exclusively, never `interface`
- All public functions must have JSDoc with @param and @returns
- All public functions must have explicit return type annotations (enforced by `explicit-module-boundary-types`)
- Error handling: Result pattern (`{ ok: true, value } | { ok: false, error }`) — no thrown exceptions in core or bindings

## ESLint

Base: `typescript-eslint/strictTypeChecked`. See `eslint.config.mjs` for full config.

Key rules:
- `consistent-type-definitions`: `type` only, no `interface`
- `consistent-type-imports/exports`: `import type` enforced for tree-shaking
- `switch-exhaustiveness-check`: union の case 漏れ防止（default 不要）
- `strict-boolean-expressions`: `if (x)` での暗黙変換を禁止（nullable object/boolean は許可）
- `prefer-nullish-coalescing`: `||` ではなく `??` を使う
- `functional/no-throw-statements`: `src/**` 全体で throw 禁止（テスト除外）
- `functional/no-try-statements`: `src/core/**` で try/catch 禁止（bindings は許可 — 外部エラーの catch 用）
- `explicit-module-boundary-types`: public 関数の戻り型を明示（`.d.ts` の安定性）
- `require-await`: off（propose() は将来の await ポイントのため意図的に async）

## Commands

- `pnpm run build`: Compile TypeScript
- `pnpm run test`: Run vitest
- `pnpm run test:watch`: Watch mode
- `pnpm run typecheck`: tsc --noEmit
- `pnpm run lint`: eslint + prettier check

## Workflow

- IMPORTANT: Run `pnpm run typecheck` after every series of code changes
- Run single test files, not the full suite, unless asked
- When modifying core/types.ts, check all files that import from it
- Commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:` prefixes

## Design Constraints

- IMPORTANT: Tegata v0.1 scope is Agent→Tool authorization (MCP tool call intercept) ONLY. Do NOT implement Agent↔Agent features — that is v0.3
- Policy engine uses glob matching on ActionType strings. No custom DSL. No Cedar dependency in v0.1
- Trust Score is SHOULD (optional). Tiered Approval MUST work without it
- All config has sensible defaults. `new Tegata()` with zero config must work
- Wire format: JSON-RPC 2.0, same as MCP/A2A

## Kanbi Integration

Task management via Kanbi MCP. When starting a task, check the board for context. When completing work, update task status.

## What NOT to Do

- Never add Cedar/OPA as a dependency — plugin architecture only, planned for v0.2
- Never throw exceptions in core or bindings — use Result pattern (enforced by ESLint `functional/no-throw-statements`)
- Never implement consensus mechanisms without Trust Score types being defined first
- Never modify types.ts without running full typecheck
