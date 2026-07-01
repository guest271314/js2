---
id: 2872
title: "Standalone: TypedArray.prototype.* cluster (294 host-pass/standalone-fail, de-masked from #2862)"
status: blocked
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2651, 2885, 2876, 2893]
umbrella: 2860
blocked_on: 2893
---

## Measure-first verdict (2026-07-01, sdev-tail) — CONFIRMED BLOCKED, brand not on main

Do **not** dispatch the residual TypedArray.prototype *method* native-body work
yet. The dependency #2893 (distinct %TypedArray% view brand) is **NOT on main** —
its implementation lives in **OPEN PR #2395** (`feat(#2901,#2893): standalone
%TypedArray% intrinsic ctor chain + integer-view accessor getters`, by
sr-typedarray). Only the #2893 *docs/spec* PR (#2376) merged; the brand runtime
has not. Marked `status: blocked` to stop it being pulled off the `current`
TaskList before the brand lands.

**Measured** on current main (leak-probe over `built-ins/TypedArray/prototype/fill`,
51 files): the method leaks that remain are **not** brand-independent. `.fill()`
on a **statically-typed** concrete TA (`Int8Array` etc.) already lowers host-free
(20/51 host-free). The residual leaks are on an **`any`/opaque-externref** receiver
(the `testWithTypedArrayConstructors(TA => …)` callback form): `.fill` there
dispatches through the generic extern-method resolver and leaks
`CanvasRenderingContext2D_fill` (a name-collision host import) — 12/51. A native
body for that path needs a **runtime brand** to classify an opaque externref as a
TA view vs a plain `number[]` (TA views share the `$Vec` type with plain arrays,
no tag — the exact #2893 gap). So the method work is **brand-gated too**, not just
the reflective getter/descriptor subset. Building it now (branching off main
without the brand) risks the plain-array-vs-view mis-dispatch regression this
umbrella already warns about.

**Unblock condition:** PR #2395 (#2893 brand) merges to main. Then predecessor-stack
the method native bodies on that landed work (or branch fresh from the post-#2395
main). Until then this stays `blocked`.

> **Blocked on #2893** (distinct %TypedArray% view brand). Traced 2026-06-30: the
> #2885 gOPD synthesis + #2876 reflective `.call` machinery light up the reflective
> accessor subset for free once the §23.2.3 getter bodies exist — but those bodies
> need a runtime brand to classify an opaque `externref` as a view vs a plain array
> (TA views share `$Vec` types with `number[]`, no tag — see #2893). The "just needs
> per-cluster glue" framing was optimistic; the glue is gated on that representation
> change. The `verifyProperty`/`*.name` subset also needs lever-2 + mutable
> descriptor semantics.

> **Unblocked machinery (#2885 + #2876, both merged):** the reflective-accessor
> subset (`verifyProperty` / `prop-desc` over `%TypedArray%.prototype` accessor
> members — `byteLength`, `byteOffset`, `length`, `buffer`, `@@toStringTag`) now
> has its shared lever: gOPD builtin-proto accessor descriptor SYNTHESIS (#2885)
> and the brand-agnostic reflective `.call`/`.apply` recovery of a
> descriptor-retrieved getter (#2876, `emitReflectiveNativeProtoClosureCall` +
> the `gOPD(...).get.call(R)` data-flow trace in `calls.ts`). The remaining
> TypedArray work is the **per-cluster glue**: wire the `%TypedArray%`/view
> getter `emitMemberBody` arms + their proto-identity opt-in; the gOPD +
> reflective-call surfaces then apply for free. (NB: the view brands carry
> vec/runtime entanglement — see #2375.)

# Standalone: TypedArray.prototype.\* failures (de-masked)

## Problem

The single largest concrete standalone cluster surfaced by the #2870 de-mask:
~**294** `built-ins/TypedArray/prototype/**` tests are host-pass but
standalone-fail (previously mis-recorded under the phantom "Cannot convert object
to primitive value" signature, #2862). Plus ~39 `TypedArrayConstructors/**`.

## Representative repros

- `test/built-ins/TypedArray/prototype/fill/length.js` — `verifyProperty`
  /`propertyHelper` over `%TypedArray%.prototype.fill` (arity/name + descriptor).
- `test/built-ins/TypedArray/prototype/toLocaleString/prop-desc.js`.

These hit `propertyHelper.js`/`verifyProperty` reflective descriptor reads over
TypedArray prototype members and throw a Wasm exception in standalone.

## Root cause (to triage)

Likely a mix of: (a) `%TypedArray%.prototype` member descriptor reflection not
materialised standalone (overlaps the native-proto glue work #2651/#2861), and
(b) `ToIndex`/`ToNumber` coercion of object args (`fill(value,start,end)` with
object bounds). Triage per sub-path with `runTest262File(file,cat,undefined,"standalone")`,
group by the exact assertion that throws.

## Test plan

`test/built-ins/TypedArray/prototype/**` standalone fail → pass; full
`merge_group` + standalone high-water. `ctx.standalone` only.

(Large — split into sub-tasks per failing member family if the root causes
diverge.)
