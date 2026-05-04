# ADR-009: Static Factory for `Tegata` Construction & Config Validation

**Status**: Accepted
**Date**: 2026-05-05
**Author**: Ren Asami

## Context

`new Tegata(config)` accepts a `TegataConfig` whose numeric fields have meaningful ranges:

- `escalateAbove` is a riskScore threshold and only makes sense in `[0, 100]`.
- `timeoutMs` must be a positive, finite number — `0` makes every handler time out instantly, negative values make `setTimeout` behave as `0`, and `Infinity`/`NaN` create silent runtime hazards.

The current constructor does no validation:

```typescript
constructor(config?: TegataConfig) {
  this.config = {
    escalateAbove: config?.escalateAbove ?? DEFAULT_CONFIG.escalateAbove,
    timeoutMs:    config?.timeoutMs    ?? DEFAULT_CONFIG.timeoutMs,
    // …
  };
}
```

Out-of-range values (`escalateAbove: -1`, `timeoutMs: 0`) silently corrupt the runtime. For a governance SDK that exists specifically to _prevent_ silent misbehavior, this is contradictory.

There are four ways to surface a validation failure:

1. **Throw from the constructor.** Forbidden by `functional/no-throw-statements` in `src/**`. Adding a single `throw` here would carve a hole in a rule whose value (Result-everywhere) we want to keep.
2. **Silently fall back to defaults + `console.warn`.** Hides the bug, depends on stderr being read, and contradicts the "no silent failures" stance of a governance SDK.
3. **Expose `validateConfig()` as a separate function the caller invokes before `new Tegata()`.** Easy to forget; the constructor still accepts garbage when the caller skips the check.
4. **Static factory `Tegata.create(config): Result<Tegata>` + private constructor.** Validation is unskippable — the type system makes `new Tegata(...)` impossible from outside the module — and the API matches `registerAgent` / `addPolicy`, both of which already return `Result`.

## Decision

Adopt **Option 4**: a static factory.

```typescript
export class Tegata {
  private constructor(config: Required<TegataConfig>) {
    this.config = config;
  }

  static create(config?: TegataConfig): Result<Tegata> {
    const validated = validateConfig(config);
    if (!validated.ok) return validated;
    return { ok: true, value: new Tegata(validated.value) };
  }
}
```

Validation rules (after applying defaults via `??`, so explicit `null`/`undefined` is treated as "use default" — preserves the `JSON.parse('{"escalateAbove": null}')` test case):

| Field              | Rule                                                            |
| ------------------ | --------------------------------------------------------------- |
| `escalateAbove`    | Finite number in `[0, 100]`                                     |
| `timeoutMs`        | Finite number > 0                                               |
| `defaultTier`      | One of `"auto" \| "notify" \| "review" \| "approve"` (JS guard) |
| `defaultOnTimeout` | One of `"deny" \| "escalate"` (JS guard)                        |

`new Tegata()` (zero-config) is no longer callable from outside the module. Callers must use:

```typescript
const result = Tegata.create(); // zero-config
// or
const result = Tegata.create({ escalateAbove: 70 });
if (!result.ok) throw new Error(result.error); // or handle in Result style
const tegata = result.value;
```

## Alternatives Considered

### Alternative A: Throw from the constructor

- Description: Carve out an exception in `functional/no-throw-statements` for the `Tegata` constructor only.
- Pros: Smallest API change — `new Tegata(...)` still works in user code; zero call-site migration.
- Cons: Breaks the "core never throws" invariant that the rest of the codebase relies on. Sets precedent for case-by-case ESLint disables. Constructor failures cannot return structured errors — only `Error` messages.
- Why rejected: The cost of preserving `new Tegata()` as the public API is permanent erosion of the Result-pattern guarantee. We're in preview; breaking the constructor signature now is cheaper than living with the inconsistency forever.

### Alternative B: Silent fallback + `console.warn`

- Description: Accept any value; clamp/replace invalid ones; warn to stderr.
- Pros: Non-breaking; zero-config still works; no migration.
- Cons: Audit logs would still record decisions made under a corrupted config. Warnings are easy to miss in CI / production. A governance SDK that "tries its best" with bad input is the opposite of the value proposition.
- Why rejected: Contradicts the project's stance that misconfiguration is a security incident, not a UX paper cut.

### Alternative C: Free `validateConfig()` function, constructor unchanged

- Description: Export `validateConfig(config): Result<TegataConfig>`; users call it before `new Tegata()`.
- Pros: Non-breaking. Lets users opt into strict validation.
- Cons: Skippable. The constructor still accepts garbage. Equivalent to documentation, not enforcement.
- Why rejected: Same root problem as B — relies on users being disciplined. A type-system-enforced factory removes the choice.

## Consequences

### Positive

- Misconfigured runtimes can never be constructed. Validation is unskippable.
- Constructor errors return structured `Result<Tegata>`, matching `registerAgent` / `addPolicy`.
- The "core never throws" invariant is preserved everywhere — including construction.
- Forces callers to handle the `Err` path, which is the right behavior at the boundary between user input and the runtime.

### Negative

- Breaking change: every `new Tegata(...)` call site in the codebase, README, examples, dogfooding hook, and the published-but-unfrozen v0.1.0-preview API must migrate to `Tegata.create(...)`.
- Slightly more verbose for the trivial `new Tegata()` case.
- Tests need a small `newTegata()` helper to keep the assertion noise down (helpers are allowed to throw; `functional/no-throw-statements` excludes test files).

### Risks

- Users on `tegata@0.1.0-preview.0` will see a breaking change in the next preview release. Mitigated by the explicit "API not frozen until GA" disclaimer in the README and by shipping this change _before_ GA. ADR-002 set the same precedent (made `proposer` required) without incident.
- A future need for asynchronous construction (e.g. loading policies from a file) maps cleanly onto the same `Result`-returning factory pattern (`Tegata.createAsync(): Promise<Result<Tegata>>`), so we are not boxed in.

## References

- [ADR-002: Require `proposer` in Proposal](002-require-proposer-in-proposal.md) — prior breaking-change precedent under the "explicit > implicit for governance" principle.
- Tegata Code Style — `Result` pattern mandated in core; `functional/no-throw-statements` enforced on `src/**`.
