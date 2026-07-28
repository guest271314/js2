---
id: 3752
title: "IR i32-pure-bitwise fast path excludes charCodeAt/call-expression leaves — string-hash's hash loop stays on the ToInt32 dance"
status: ready
created: 2026-07-28
priority: low
feasibility: hard
reasoning_effort: high
task_type: performance
area: ir
language_feature: bitwise-operators, strings, loops
goal: performance
related: [3745, 3744, 3740, 2682, 1746]
---

# #3752 — port legacy's #2682 hoisted-in-bounds-read proof to IR's i32-pure-bitwise fast path

## Context

#3745 added an IR-native fast path (`src/ir/i32-pure-bitwise.ts`) that lets
a bitwise/shift operator skip the expensive ToInt32 IEEE-754
bit-decomposition (#3739) when BOTH its operands are provably already
clean int32-range values, using a cheap `i32.trunc_sat_f64_s` instead. It
deliberately excludes call expressions (e.g. `<string>.charCodeAt(i)`) as
leaves of that proof — see `i32-pure-bitwise.ts`'s own doc comment for the
correctness hazard: a NaN-producing out-of-bounds `charCodeAt` collapses
the WHOLE enclosing ToInt32'd sum to 0 (`ToInt32(a + NaN) = ToInt32(NaN) =
0`), but naively fusing a native i32 add with a `trunc_sat_f64_s(NaN) = 0`
leaf would incorrectly preserve `a`'s own bits instead.

This leaves the landing `string-hash` benchmark's hash loop —
`hash = (hash * 31 + text.charCodeAt(i)) | 0;` — on the slow path: its `|
0` still runs the full ToInt32 dance every iteration, and since this loop
runs once per character (vs. the build loop's once-per-2-characters
cadence), it dominates the benchmark's wall-clock cost. #3745 measured the
build loop's fix as a real ~83% reduction in ToInt32-dance instructions
but essentially no change in this benchmark's overall timing, because the
hash loop is untouched.

## What's needed

Legacy's own `isI32PureExpr` (`src/codegen/binary-ops.ts`) has the same
general exclusion, but lifts it in one narrow case via a separate proof —
`matchHoistedCharRead` (#2682) — that a `charCodeAt`/`charAt`/index-read
call's argument is a loop counter PROVABLY bounded by the same string's
`.length` (so the read can never be out-of-bounds, hence never NaN). That
proof is tightly coupled to legacy's codegen context (bounds info threaded
through the emitter), and was NOT ported when #3745 built the IR version.

To close this benchmark's remaining gap, either:

1. Port a version of #2682's hoisted-in-bounds-read proof into
   `src/ir/i32-pure-bitwise.ts` (or a sibling module) — recognize
   `<expr>.charCodeAt(i)` / `<expr>.charAt(i)` where `<expr>` is a `for`
   loop's iterated string and `i` is that same loop's bounded counter
   (`detectI32LoopVar` plus a `text.length`-bound proof), and admit it as
   an i32-pure leaf ONLY under that specific shape.
2. Or find/confirm a different, more general safety argument that doesn't
   require per-callee bounds-proof plumbing (e.g. if `String.charCodeAt`
   could be proven to never return NaN under some IR-visible invariant —
   unlikely in general, since out-of-bounds is a real runtime
   possibility unless the index is provably bounded).

Option 1 mirrors an already-shipped, tested legacy mechanism, so it's the
recommended starting point — this is very likely a "port an existing,
narrow proof" task, not new design work.

## Suggested next step

1. Read `matchHoistedCharRead` and its call sites in
   `src/codegen/binary-ops.ts` to understand exactly what shape it
   requires and how it threads the bounds proof.
2. Reproduce the hash loop in isolation (`let hash = 0; for (let i = 0; i <
text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;`) as a
   standalone minimal repro/test before touching the general fast path.
3. Extend `isI32PureExprIR` (or add a sibling predicate consulted
   alongside it) to accept exactly this bounded-index-read shape as a leaf,
   reusing `detectI32LoopVar` for the bound proof.
4. Re-measure `string-hash`'s wall-clock time; if it closes the remaining
   gap to legacy, consider whether #3744's `JS2WASM_IR_STRING_BUILDER` kill
   switch is still needed at all.

## Non-goals

Not a correctness fix — `string-hash` already produces byte-identical
results through IR (verified in #3744's and #3745's tests). Purely a
residual perf gap, scoped narrowly to the specific hoisted-bounded-read
shape rather than any general call-expression admission (a general
admission would reintroduce the NaN-preservation hazard #3745's doc
comment describes).
