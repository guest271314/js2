---
id: 2920
title: "Standalone: native SYNC-generator resume substrate — widen native generator lowering to eliminate __create_generator / __gen_* host imports"
status: in-progress
assignee: ttraenkler/sr-generators
created: 2026-07-01
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2906, 2413, 2864, 2171, 2170, 2571, 2581, 2203]
umbrella: 2860
---

# Standalone native SYNC-generator resume substrate

## Problem / goal

In standalone mode, `function*` sync generators that fall outside the native
candidate subset lower to the **host-import** eager-buffer path
(`env::__create_generator`, `__gen_next`, `__gen_create_buffer`,
`__gen_yield_star`, `__gen_set_return`, `__gen_result_*`, `__gen_push_*`,
`__gen_return`, `__gen_throw`), plus the trampoline's `__get_caught_exception`.
Widen the **already-existing** native generator resume machine
(`src/codegen/generators-native.ts`) so those shapes lower host-free.

**Scope: SYNC generators only.** Async generators (`__create_async_generator`,
4065 tests) are explicitly OUT of scope.

## MEASUREMENT (done — run 28491700781 standalone merged jsonl)

Corpus extraction from `test262-standalone-results-merged.jsonl` (status==pass,
imports touching the sync-gen suite):

- **7379** tests touch the sync-gen host suite; **4831** of them pass.
- **NO test** has `imports ⊆ gen-suite` alone — **every** gen test also
  co-leaks `env::__get_caught_exception`. That import is emitted by the native
  generator **trampoline's own catch** (the `try { block { loop { if-chain } } }
  catch $exn` dispatch), NOT by user code — it disappears when the generator
  lowers natively. So the honest "fully host-free" corpus is
  `imports ⊆ gen-suite ∪ {__get_caught_exception}`.
- **Honest full-build yield: 1851 PASS tests** flip fully host-free
  (1878 with the looser "no Promise/async co-leak" definition; the delta is a
  handful of tests that also leak `__array_from_iter` / `__get_generator*_prototype`).
- Of the 1851: **1610 are "simple"** (only `__gen_next`/result imports — no
  `yield*`/`.throw`/`.return`/`set_return`); **241 advanced**.

### Dominant root cause (empirically confirmed on current main)

A **mature** native generator machine already exists in `generators-native.ts`
(N-state resume; already handles straight-line `yield`, `let x = yield`,
`try/finally` no-catch, `if`/`else`, `while`/`do`/`for` loops, bare blocks,
numeric `yield*` delegation, and f64 / native-string / boxed-any-externref yield
carriers). The dominant REMAINING bail is the **candidate-gate parameter check**:

```ts
// src/codegen/generators-native.ts:955-957  (isNativeGeneratorCandidate)
for (const param of decl.parameters) {
  if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
}
```

So **destructuring / rest parameters** (`function*([a,b]){}`, `*m({x}){}`,
`function*(...rest){}`) reject → host eager-buffer fallback (or a hard CE #680 in
strict `target:standalone`). Confirmed via probes (`.tmp/2920/probe.mjs`):
plain-param generator → NATIVE (no imports); `[a,b]` / `{a,b}` / `...xs` → CE
#680 (top-level) or `__gen_*` host leak (class/object method).

### Slice-1 target = native destructuring + rest generator params

- **1396 PASS tests** flip host-free (ALL simple next/yield-only; 1082 are
  class/object-method generators, 314 function generators). This is 75% of the
  full-build yield in one bounded slice.
- Remaining **455 non-dstr flippable** tests bail for OTHER reasons (later
  slices — triage the residual candidate-gate / plan-builder bails).

## Architecture notes for the build

- The native generator state struct + factory is built in
  `registerNativeGenerator` (generators-native.ts:1144) from `decl.parameters`,
  currently assuming identifier params (one struct slot per param). Destructuring
  params must: store the **raw incoming param value** (the iterable/object) in a
  frame slot, then run the destructuring **binding** in the entry-state (state 0)
  prelude to produce the bound locals — reusing the existing `compileStatement`
  destructuring-binding machinery that regular functions already use. Bound
  names live across yields become spills (the plan builder's `addSpill` path,
  typed via `spillDecls` — generators-native.ts:314-320). Rest params bind a vec.
- Two consumers share the candidate gate and MUST stay in agreement:
  `registerNativeGenerator` AND `sourceNeedsGeneratorHostImports` (else a
  `funcIdx: undefined` invalid module). Widen the gate in ONE place.
- Class-method vs object-literal-method vs function/decl generators reach the
  factory via different emit sites (class-bodies.ts #2571, literals.ts #2581,
  nested-declarations.ts). Object-literal methods with default/optional params
  already bail (argc trampoline gap, line 966-970) — keep that.

## DISCIPLINE (graveyard-class — MUST hold)

- **Carrier-gated + byte-inert**: the native path is already gated on
  `noJsHostTarget(ctx)` (= `ctx.standalone || ctx.wasi`), so gc/host never reach
  it. Verify gc/host output stays **byte-identical** with sha256 before/after.
- **funcIdx / type-index shift**: register any new struct/vec types late + once
  (memory: project_type_index_shift_and_deadelim); watch late-import funcIdx
  shifts (shiftAsyncSideChannelFuncIdxs / #2918 pattern).
- **Corpus-verify** on the measured 1396-test dstr corpus (a scoped compile
  sweep counting host-import elimination), not just a handful.
- **Slice it**: dstr-array-param first if needed, then obj-pattern, then rest —
  a measurably-flipping partial beats a stranded full build.
