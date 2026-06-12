---
id: 2050
title: "a?.[i] compiled as plain a[i]: index side effects fire and no undefined result on nullish base"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: optional-chaining
goal: core-semantics
related: [2049, 2051]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2050 — optional element access `a?.[i]` is lowered identically to `a[i]`

## Problem

`ElementAccessExpression` with `?.` ignores the optional marker entirely. On a
nullish base, the index expression (and its side effects) still evaluates, and
the result is not `undefined` — violating
[§13.3.9 Optional Chains](https://tc39.es/ecma262/#sec-optional-chains).

## Repro (verified on main)

```ts
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
function getArr(b: boolean): number[] | null { return b ? [4, 5, 6] : null; }
export function t4(): number {
  log = 0; const a = getArr(false);
  const r = a?.[mark(2)];   // spec: a nullish → undefined, mark NOT evaluated
  return log;
}
```

| probe | wasm | node |
|-------|------|------|
| `t4` (side-effect trace) | `2` (index evaluated) | `0` |
| `log*10 + (r===undefined?1:0)` | `20` | `1` |

## Root cause

`compileElementAccess` (`src/codegen/property-access.ts:3590` onward) never
consults `expr.questionDotToken` — the only optional handling in that file is
for PropertyAccessExpression (line 1258). An optional element access is lowered
identically to `a[i]`: base compiled, then either `emitNullCheckThrow`
(3770-3777) or the externref read; the index expression is compiled
unconditionally either way.

## Fix direction

At the top of `compileElementAccess`, branch on `expr.questionDotToken`: tee the
base into a local, `ref.is_null`/undefined-check, and compile the index + read
only in the non-null arm — mirroring `compileOptionalPropertyAccess`. The
short-circuit result value shares #2051's undefined-representation question.

## Acceptance criteria

- `a?.[i++]` with nullish `a` does not evaluate `i++`
- Result of short-circuited `a?.[i]` is undefined-equivalent (with #2051)
- Non-nullish bases unchanged; equivalence suite green
- test262 `optional-chaining` element-access cases net positive

## Dupe check

Grepped `?.\[`, `optional element` over plan/issues/ — zero hits.

## Resolution (2026-06-11)

Added `compileOptionalElementAccess` in `src/codegen/property-access.ts` and
routed `compileElementAccess` to it whenever `expr.questionDotToken` is set —
sibling of the existing `compileOptionalPropertyAccess`. It compiles the base,
tees it into a local, branches on `ref.is_null`, and emits the index
expression + read **only in the non-null arm**, so a nullish base never
evaluates the index. A base that lowers to a non-reference value type (the
compiler's `undefined`/`null` representation) drops and yields the default
without touching the index.

Verified via `tests/equivalence/optional-element-access.test.ts`:
- nullish base does not fire the index side effect (`mark()` / `i++`)
- non-null base evaluates the index and reads the element

**Out of scope / follow-ups:**
- The short-circuit *value* is still `0`/null rather than `undefined`, so
  `a?.[0] ?? fallback` does not fall through on a nullish base. That is the
  shared undefined-representation gap tracked in **#2051**.
- The original repro used `getArr(): number[] | null`; a separate pre-existing
  bug round-trips such a union return through externref and loses the null
  identity (`getArr(false) === null` is already wrong on main with no optional
  chaining), so the tests here use a directly null-typed local instead.
