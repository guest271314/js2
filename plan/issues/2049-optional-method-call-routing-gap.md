---
id: 2049
title: "o?.m(args) never routed to optional-call codegen: args evaluated on nullish receiver, null class receiver traps"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: optional-chaining
goal: core-semantics
related: [16, 409, 785, 1281, 1375, 1392, 2050, 2051]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2049 — `o?.m(args)` never routed to optional-call codegen

## Problem

The most common optional-call form, `o?.m(args)`, is compiled by the **regular**
method-call machinery instead of `compileOptionalCallExpression`. Two observable
spec violations when the receiver is nullish:

1. **Arguments are evaluated** even though the chain must short-circuit
   (spec: [§13.3.9 Optional Chains](https://tc39.es/ecma262/#sec-optional-chains) —
   nothing after `?.` evaluates).
2. **Class-instance receivers trap**: the regular path emits a receiver deref
   (`ref.as_non_null`) which traps with an uncatchable
   `ref.as_non_null to a null reference` instead of producing `undefined`.

## Repro (verified on main)

```ts
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
type Obj = { f: (x: number) => number; v: number };
function getObj(b: boolean): Obj | null { if (b) return { f: (x: number) => x * 2, v: 9 }; return null; }
export function t3(): number {            // closure-field receiver
  log = 0; const o = getObj(false);
  const r = o?.f(mark(5));                // spec: short-circuits, mark NOT called
  return log;
}
class K { m(x: number): number { return x + 1; } }
function getK(b: boolean): K | null { return b ? new K() : null; }
export function t5(): number {            // class-method receiver
  log = 0; const k = getK(false);
  const r = k?.m(mark(7));
  return log;
}
```

| fn | wasm | node |
|----|------|------|
| `t3` | `5` (mark executed) | `0` |
| `t5` | **trap** `ref.as_non_null to a null reference` | `0`, `r === undefined` |

Also: `"" + o?.f(1)` with null receiver via the `?.()` form (which IS routed)
gives `"null"` vs node `"undefined"` (that result-value half is #2051).

## Root cause

`src/codegen/expressions/calls.ts:1879-1881`:

```ts
if (expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
  return compileOptionalCallExpression(ctx, fctx, expr);
}
```

In the TS AST, `o?.f(x)` puts `questionDotToken` on the
**PropertyAccessExpression**, not the CallExpression (verified with the repo's
TypeScript: only `o?.f?.(5)` sets it on the call). So `o?.m(args)` never reaches
`compileOptionalCallExpression` (`calls-optional.ts`) and falls into the regular
method-call machinery, which (a) evaluates arguments unconditionally and (b) for
class instances emits the receiver deref near calls.ts:6427/6578 that traps on
null.

## Fix direction

Gate on the chain, not the call token:
`expr.questionDotToken || (ts.isPropertyAccessExpression(expr.expression) && expr.expression.questionDotToken)`
— or simply `ts.isOptionalChain(expr)`. Then extend
`compileOptionalCallExpression` to handle the closure-field callee case (it
currently only resolves named methods).

## Acceptance criteria

- `o?.f(sideEffect())` with nullish `o` does NOT evaluate the argument; returns undefined-equivalent
- `k?.m(x)` with `k: K | null = null` does not trap; behaves as short-circuit
- Non-null receivers keep current behavior (no regression in equivalence tests)
- test262 `language/expressions/optional-chaining/` net positive

## Dupe check

Grepped `optional chain`, `questionDot`, `short-circuit`, `optional call`,
`uncatchable` over plan/issues/: #16, #409, #1281, #1375, #1392 (done; IR-path
or other forms), #1820 (IR `&&`/`||`), #1298 (fn-typed field call). None cover
the questionDotToken routing gap or arg evaluation on short-circuit.

## Resolution (2026-06-11)

Three changes in `src/codegen/expressions/`:

1. **`calls.ts`** — routing gate now keys on `ts.isOptionalChain(expr)` instead
   of `expr.questionDotToken`, so `o?.m(args)` (token on the inner
   PropertyAccessExpression) reaches `compileOptionalCallExpression`.
2. **`calls-optional.ts`** — strip receiver nullability with
   `checker.getNonNullableType(...)` before method resolution; the receiver is
   `K | null` by construction, so `getSymbol()` on the raw union never resolved
   the class/struct.
3. **`calls-optional.ts`** — added a closure-field fallback: when no named
   method resolves, delegate the non-null branch to
   `compileCallablePropertyCall` (which already extracts the closure field,
   pushes self + args, and `call_ref`s, handling a nullable receiver via a
   guarded cast). Gated on a side-effect-free receiver so the re-evaluation is
   sound.

### Test results (`tests/issue-2049.test.ts`, all pass)

| case | before | after | node |
|------|--------|-------|------|
| `o?.f(mark(5))` null receiver — arg eval | `5` (mark ran) | `0` | `0` |
| `k?.m(mark(7))` null class receiver | **trap** | `0` | `0` |
| `o?.f(mark(5))` non-null closure field | `1005` | `1005` | `1005` |
| `k?.m(mark(7))` non-null class method | `807` | `807` | `807` |
| `o.f?.()` / `o?.f?.()` dynamic-call form | ok | ok | ok |
| void method side effect via `k?.m()` | n/a | `7` | `7` |

The **undefined-vs-NaN result-value** half of the short-circuit (e.g.
`o?.f(x) ?? -1` yielding NaN instead of -1) is out of scope here — tracked as
**#2051**. Nested `a?.b?.c()` previously threw an uncatchable host TypeError on
the inner `a?.b`; it now returns a (NaN-encoded) value, a strict improvement,
with the encoding likewise deferred to #2051.
