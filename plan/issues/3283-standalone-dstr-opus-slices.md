---
id: 3283
title: "standalone dstr runtime-semantics — Opus-now unblocked slices (lazy-defaults, obj-rest ToPrimitive, abrupt-step errors, gen brand-check)"
status: in-progress
sprint: current
created: 2026-07-14
priority: high
feasibility: medium
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: destructuring, generators
goal: standalone-mode
subtask_of: 2040
related: [2602, 3132, 3164, 3086]
---

# #3283 — the Opus-executable unblocked slices carved out of #2040

Carved 2026-07-14 from #2040's 2026-07-12 re-ground plan so the standalone dstr
cluster can progress under Opus without waiting for fable. #2040 stays the
fable-gated parent for its A1 headline (the ~382 `assert.notSameValue(x,values)`
rest-identity rows), which is **explicitly BLOCKED on the #2580 M2 / #3032 / #3053
tag-5 substrate track — NOT staffable here** (two shelved landings + a −162 eject;
do not re-litigate the classifier). This issue owns ONLY the four independent,
grounded, non-substrate slices below.

Source of truth for the specs: the "RE-GROUND + RESTAFFING PLAN (architect,
2026-07-12)" section of `plan/issues/2040-standalone-generator-dstr-runtime-semantics.md`.
Read that section first. All four slices are independent per that plan; slices
1/2/3 all touch `src/codegen/destructuring-params.ts` so they are worked SERIALLY
here (stacked PRs), one per slice. Acceptance is per-slice + dstr standalone fail
count trending toward ≤1,800.

## Slice 1 (START HERE, ~198 rows): lazy default evaluation
`§8.6.2 IteratorBindingInitialization`, SingleNameBinding step 5: the Initializer
is evaluated ONLY when the bound value is `undefined`/iterator-done. Standalone
evaluates it (or bumps its counter) when a value is PRESENT.
Repro: `language/expressions/function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js`
(`function f([x = (initCount += 1)]) {}` called with a present value → `assert.sameValue(initCount, 0)`).
Ground in `src/codegen/destructuring-params.ts` param-pattern element lowering
(#2574 added default-on-`undefined`; the residual is the CONVERSE — default emitted
eagerly, or the presence/`done` guard mis-read for iterator-driven bindings).
Diagnose ONE file's WAT first. Acceptance: the `dflt-*-init-skipped` / `initCount, 0`
family flips (~198); zero host-lane byte delta.

## Slice 2 (~190 rows): object-rest copy ToPrimitive
`{...rest}` CopyDataProperties (§14.7.5.6) copies property VALUES as-is; the
standalone lane wrongly routes them through a primitive coercion.
Repro: `language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-rest-skip-non-enumerable.js`
(`Cannot convert object to primitive value`). Check `__extern_rest_object` / the
object-rest lowering in `destructuring-params.ts` + `object-runtime.ts`. #2602
(the assignment-rest arm) is DONE — take the binding-pattern arm here.

## Slice 3 (~115 rows): abrupt iterator-step errors must be catchable
A throwing `next()`/`return()` during IteratorBindingInitialization must surface
as a catchable typed error completion, not a Wasm trap.
Repro: `language/expressions/class/dstr/async-gen-meth-ary-ptrn-elision-step-err.js`.
Wrap the step call in the dstr drive loop with try/catch (native `__exn` tag),
rethrow-as-JS-error. Ground where the binding-init loop calls `__iterator_next`
(iterator-native.ts consumers + destructuring-params.ts).

## Slice 4 (~48 rows): Generator.prototype method brand check
`Generator.prototype.next.call(g)` on a native driven-gen frame fails the brand
test. Extend brand-check admission to the native frame structs (the
`ctx.nativeGenerators` per-producer `ref.test` arms — same pattern as
`__iter_hof_open`'s driven-frame admission in `iter-hof-native.ts`). Different
file from slices 1-3, so it may be worked last or in parallel if budget allows.

## Acceptance
Per-slice: the named assertion family flips to ~0; scoped repro test added; NO
host-lane regression; merge_group standalone-floor green. A1 (rest-identity) is
out of scope and stays with #2040.
