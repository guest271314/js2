---
id: 3014
title: "any-receiver .forEach/.some first-match TypedArray extern class → Uint8ClampedArray_forEach/some host leak"
status: done
created: 2026-07-03
updated: 2026-07-03
completed: 2026-07-03
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: arrays
goal: standalone-host-free
sprint: 69
horizon: s
assignee: ttraenkler/agent-opus
origin: "2026-07-03 leak-analysis round 6 §sole-lever ranking — Uint8ClampedArray_forEach/some 16 sole-import passes (GENUINE)"
related: [2379, 1712, 1062]
---

# #3014 — `any`-receiver `.forEach`/`.some` mis-routes to `Uint8ClampedArray_forEach/some`

## Problem

`tryExternClassMethodOnAny` (`src/codegen/expressions/calls-closures.ts`) resolves
a method call on an **`any`-typed receiver** by first-match iteration over
`ctx.externClasses`. Every TypedArray extern class (`Uint8ClampedArray`,
`Int8Array`, …) declares `forEach` / `some` with an all-externref signature. When
a TypedArray (or a DOM type whose `lib.d.ts` pulls the TypedArray declarations
in) has registered its extern class before the call is compiled, first-match
binds an `any` receiver's `xs.forEach(cb)` / `xs.some(pred)` to
`env.Uint8ClampedArray_forEach` / `_some` — a host import the standalone runtime
cannot satisfy. The import name is a pure routing artifact; the receiver is not a
`Uint8ClampedArray`.

Round-6 leak analysis (`plan/log/investigations/2026-07-03-leak-analysis-round6.md`
§sole-lever ranking) found **16 execution-verified sole-import** standalone
passes leaking exactly this import — all `built-ins/Array/prototype/forEach/*` and
`built-ins/Array/prototype/some/*` (the `length`-overridden-to-0 array-subclass
tests). Confirmed GENUINE via inject-throw.

This is distinct from #2379 (typed `Uint8ClampedArray` **receivers** mis-dispatching
because the type was omitted from `BUILTIN_TYPES`; already fixed). Here the
receiver is `any`, not a TypedArray.

## Fix

Mirror the existing `.slice` (#1062) and `.replace`/`.replaceAll` (#1712)
ambiguity refusals in `tryExternClassMethodOnAny`: refuse extern-class dispatch
for `forEach` / `some` and let the call resolve by the receiver's real runtime
shape. On an `any` receiver in untyped JS these are overwhelmingly Array
operations; a genuinely-`Uint8ClampedArray`-typed receiver never reaches this
`any` fallback (it is claimed by the native array-method path earlier).

## Test Results

Verified with the runner's exact flags (`target: "standalone"`,
`skipSemanticDiagnostics: true`) on the actual test bodies:

- All 16 target tests: `env=[Uint8ClampedArray_forEach|_some]` → **`env=[]`**
  (host-free) with correct runtime results (`callCnt=0` / `some=false`).
- Host lane (`gc`): reroutes host→host, results unchanged (verified correct).
- No regression across the 367 passing `forEach/some/every/find` tests — only
  these 16 used the Uint8ClampedArray path; all convert cleanly.

## Acceptance criteria

- The 16 sole-import standalone passes become host-free.
- Flag-off (host `gc` mode) behaviour and results unchanged.
- No new standalone-floor regressions in `merge_group`.
