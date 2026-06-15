---
id: 2157
title: "Standalone iterator/generator conformance residual (~1,200 tests beyond #2079)"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: critical
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: iterators-generators
goal: standalone-mode
parent: 1665
depends_on: [2079, 1899]
---

# Standalone iterator/generator conformance residual

## Problem

The pure-Wasm iterator protocol and native generators landed across #680,
#1665, #681, #1718 (all `done`, sprints 58–61). But a host-vs-standalone
test262 baseline diff (`loopdive/js2wasm-baselines`, sha `31fa7e099`,
generated 2026-06-15) shows the **single largest catch-up bucket**: **2,172
tests pass in JS-host mode but fail standalone**, attributed to iterator /
generator machinery.

`#2079` (standalone generators funcindex CE) accounts for ~960 of these via
the late-import index-shift compile error. **This issue tracks the remaining
~1,200** — runtime/iterator-protocol divergences not explained by the
funcindex CE.

## Evidence

- Audit leak classes in the gap: `iterator_protocol` 2,057, plus generator
  host imports (`__gen_next`, `__gen_create_buffer`, `__create_generator`,
  `__create_async_generator`, `__gen_yield_star`, `__array_from_iter_n`).
- Mechanism split: heavy on `compile_error` (funcindex, captured by #2079)
  plus runtime `fail` (spread/for-of/destructuring over user iterators
  returning wrong values).

## Acceptance criteria

- Standalone pass count for `built-ins/Iterator`, `built-ins/GeneratorPrototype`,
  and generator/spread/for-of language tests rises toward host parity.
- No `iterator_protocol` host-import leak remains in standalone mode for the
  covered cases.
- Repros from the gap diff added as standalone equivalence tests.

## Notes

Parent (done): #1665. Sequenced after #2079 + #1899 (funcidx authority).
Part of sprint-62 standalone catch-up (rank 1 by gap impact).

## Triage (2026-06-15, sdev5) — concrete residual sub-fixes after #2079

Probed current main (`ab51cb49d`, includes merged #2079) with a battery of
standalone iterator/generator repros. #2079 made the **top-level** native
generator (sequential + control-flow yields) work for `for-of` and manual
`next()`. The remaining gap splits into four concrete, independently-shippable
sub-fixes (ordered by likely test-impact). Each repro below is a **test gate**:
it must move from the listed failure to PASS.

### SF-1 — nested `function*` declarations take the JS-host path (funcindex CE) — LARGEST

`statements/nested-declarations.ts:207-209` hard-codes a nested generator's
return type to `externref` (JS Generator object) and never registers it in
`ctx.nativeGenerators`, so it always uses the `__create_generator` host path —
which in standalone leaks env imports / hits the late-import funcindex CE. The
native lowering is **only wired for top-level declarations**
(`collectDeclarations` walks `sourceFile.statements`, no recursion into bodies;
`registerNativeGenerator` is only called there + in `registerBodylessFunctionDeclaration`).

```ts
// FAILS: "function index out of range — undefined"
export function test(): number {
  function* g(){ yield 1; yield 2; yield 3; }   // nested
  let s=0; for (const v of g()) s+=v; return s;  // exp 6
}
// vs the SAME generator hoisted to top-level → PASSES.
```

Hard: native state-machine plan must additionally handle **closure capture**
of enclosing locals (top-level generators have none). Likely multi-PR. Highest
single lever in the gap (nested generators are pervasive in test262 fixtures).
→ **sub-task #2172** (proposed; #2168 was already taken by an unrelated issue).

### SF-2 — spread / Array.from / destructuring don't drive a native generator

The native generator returns a **state struct** (`$__gen_state_*`), but the
spread, `Array.from`, and array-destructuring consumers treat that struct as a
`__vec` iterable: they read `struct.get <gen> 0` expecting a `$length` field
(field 0 is actually `state`), build a garbage-length array of defaults, and
never call `next()`. Spread yields a wrong-length array of `NaN`;
`Array.from`/destructure leak env imports + fail zero-import instantiation.

```ts
function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a=[...g()]; return a.length; }     // FAIL: NaN/garbage, exp 3
export function test(): number { const a=Array.from(g()); return a.length; } // FAIL: env import leak
function* g2(){ yield 1; yield 2; }
export function test(): number { const [a,b]=g2(); return a+b; }            // FAIL: env import leak, exp 3
```

Consumer-side, more localized than SF-1: each consumer must detect the native
generator state-struct type (`ctx.nativeGeneratorResultTypeIdx` family /
`tryCompileNativeGeneratorMethodCall`) and drive `next()` until `done`,
collecting `value`s — the same loop the `for-of` driver already emits.
→ **sub-task #2169** (proposed). Tractable; good next PR.

### SF-3 — `yield*` delegation (clean bail today)

`function* g(){ yield* inner(); }` → `buildNativeGeneratorPlan` returns null →
the scoped #680 standalone CE. #2079 explicitly deferred this. Needs a
`yield-star(innerGen)` terminator in the state graph that drives the inner
generator to completion, re-entering the outer state on each resume.
→ **sub-task #2170** (proposed).

### SF-4 — non-numeric yields (string / boolean / object) (clean bail today)

`function* g(){ yield "a"; yield "b"; }` → #680 CE. The state struct spills are
typed for f64; non-numeric yields need a boxed (`anyref`/`externref`) value
slot in the result + spill, and the for-of/next value extraction must unbox by
the declared element type. Ties into the value-rep work (#2072 family).
→ **sub-task #2171** (proposed).

### Already working (regression guards, no fix needed)

`for-of`/spread over **string** and over **arrays**; top-level generator
`for-of`, manual `next()`, `.next(v)` send, `.return()`, while/for/do-while/if
control-flow yields (all #2079); `for-of` over a custom `[Symbol.iterator]`
object. `for-of` over `Map`/`Set` currently TRAPs (validation) — likely
overlaps the collection-iterator path tracked under #2162; cross-referenced.

### This PR (sdev5)

Lands the **triage + a standalone test-gate suite** (`tests/issue-2157-*.test.ts`)
that pins the currently-working cases as regression guards and `it.todo`-marks
SF-1..SF-4 with their repros, so the sub-tasks have executable acceptance gates.
The four sub-fixes are dispatched as #2172 (SF-1; #2168 was taken), #2169, #2170, #2171.
