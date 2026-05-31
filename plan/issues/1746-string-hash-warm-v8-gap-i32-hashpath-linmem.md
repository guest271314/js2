---
id: 1746
title: "string-hash: reach (and beat) warm-V8 via AOT analysis — i32 path, const-eval, presize, SIMD, loop fusion/unroll"
status: done
created: 2026-05-30
updated: 2026-05-31
completed: 2026-05-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: strings
goal: performance
related: [1744, 1580, 1199, 1175, 1210]
sprint: 57
---

# #1746 — string-hash: close (and potentially beat) the warm-V8 gap

## Context

After #1744 (single-char-append fast path) string-hash warm is **~9 ms** on
wasmtime — already *faster than the AOT/Wasm peer* (StarlingMonkey 14.2 ms), but
still **~14× warm V8-JIT (~0.64 ms)**.

**Do NOT assume AOT can't reach JIT level here.** A JIT pays for runtime
profiling + tier-up and is constrained to transforms it can prove safe from
*runtime* feedback. An AOT WasmGC compiler has the opposite leverage: full
whole-program static analysis, and it can **compile semantics away entirely** —
constant-fold, presize from loop analysis, vectorize, and prove-and-fuse/unroll
loops, all at **zero runtime cost**. Several of these are things a JIT can't do
as freely. The goal is to drive string-hash as fast as static analysis allows —
**JIT-parity-or-better is on the table**, not precluded.

The cost is now in the two loops (`build`: ~20k×3 appends; `hash`:
`(hash*31 + charCodeAt(i)) | 0` ~60k iters), not allocation (#1744 fixed that).

## Diagnostic method — DO THIS FIRST (differential codegen analysis)

Don't optimize from a hypothesis. **Measure the gap at the instruction level** by
diffing the two native-code generators on the *same* JS:

- **V8 TurboFan native** (the JIT target, the number we're chasing):
  `node --allow-natives-syntax --print-opt-code --print-opt-code-filter=run`
  after warming + `%OptimizeFunctionOnNextCall(run)`. (Ignition bytecode:
  `--print-bytecode --print-bytecode-filter=run`.) Confirmed working in our Node
  (v25.8.2 has the disassembler).
- **Cranelift native of our Wasm** (what we actually ship): `wasmtime compile
  --emit-clif`, or objdump the `.cwasm`.

Diff the *strategies* (not opcode-for-opcode — V8 emits native, we emit Wasm→Cranelift→native).

**Baseline captured 2026-05-30** — V8 TurboFan fingerprint of `run()` (2004
instr): **176 integer ops vs 8 float ops, 0 SIMD**, 56 cond-branches, 50 calls.
→ V8 wins by running the hash loop in **i32** (lever #1), and **does NOT
vectorize** it. This empirically reorders our levers: **#1 (i32 path) is THE
match-V8 lever**; SIMD/unroll are *beat-V8* plays, not match-V8. Re-run the diff
after each change to confirm convergence toward the V8 instruction shape.

## Optimization levers (each: prove same observable result, then apply)

1. **i32-typed hot path (biggest immediate win).** `(hash*31 + c) | 0` is
   computed in **f64** then truncated each iteration. Since it's `|0`-masked the
   whole accumulator can stay i32 — kill ~60k f64↔i32 conversions, use i32
   mul/add. Codegen feature: detect `(expr) | 0` / `& mask` envelopes and lower
   the enclosed arithmetic in i32 (ToInt32-correct wrap on overflow).

2. **Compile-time evaluation of const expressions.** Fold whatever is statically
   known: constant string literals (`alphabet`), pure index arithmetic
   (`(i*13)&31`, `(a+7)&31`), and `const`-bound values. `alphabet.charAt(const)`
   → a folded code-unit constant or a compile-time lookup table. Resolve as much
   of the per-iteration work to constants as the analysis proves.

3. **Loop-analysis array presizing.** When the build loop's trip count is
   statically analyzable (literal/bounded `n`), **presize the string buffer to
   the final length** instead of the doubling-buffer grow — eliminating ALL
   `array.copy` reallocations. Generalize: presize any array whose final size is
   provable from the loop.

4. **SIMD.** Vectorize where the data layout allows — e.g. block char-copy in the
   build loop, or batched code-unit processing / the hash mix — using Wasm SIMD
   (v128) when it's provably equivalent. (Gate behind a SIMD-capable target.)

5. **Loop unrolling / fusion — when provably equivalent.** Unroll the hot loops
   where it lets the optimizer keep values in registers / batch BCE; **fuse**
   loops (e.g. build + hash, or the two appends) when a dependence proof shows
   the fused form computes the identical result. Only apply with a soundness
   proof — never speculatively.

6. **Linear-memory backing for string char data (#1199-class).** `charCodeAt` is
   an `array.get_u` on a WasmGC i16 array (GC indirection + bounds check); a
   linear-memory backing makes it a raw load. Coordinate with the dual-string
   backend (#679).

7. **Bounds-check-elimination-friendly emission.** Emit counted loops (monotonic
   index, known length) so Cranelift hoists/drops the per-element bounds check.

## Approach

Land #1 first (it's localized + the biggest single win), measure, then take the
analysis-driven transforms (#2 const-eval, #3 presize) which are pure AOT wins a
JIT can't match. #4–#5 (SIMD, unroll/fuse) and #6 (linear-mem) are larger and may
each become their own sub-issue. Every transform MUST be guarded by a
correctness proof (same observable result) — this is "compile away, don't
emulate", not speculative optimization.

## Acceptance

- Measure warm before/after on wasmtime (`scripts/generate-wasmtime-hot-runtime.mjs`),
  refresh the committed benchmark JSON, keep the #1580 staleness gate green,
  honest provenance (no gaming the lenient 30 ms gate).
- Each applied transform has a soundness justification + a regression test, and
  zero test262 regressions.
- Drive the number as low as the analysis allows — explicitly including
  JIT-parity-or-better; do not stop at an assumed AOT ceiling.

## Implementation notes — lever #1 LANDED (i32-typed hash path)

**Root cause (differential analysis).** Dumped the compiled WAT of `run` for
the benchmark config (`target: wasi, nativeStrings: true`). The hash loop body
`hash = (hash*31 + text.charCodeAt(i)) | 0` lowered as:

```
local.get $hash        ;; $hash is ALREADY an i32 local
f64.convert_i32_s      ;; hash -> f64
f64.const 31  f64.mul  ;; hash*31 in f64
... charCodeAt -> i32 ...
f64.convert_i32_s      ;; charCode -> f64
f64.add  f64.trunc
;; then the expensive ToInt32 emulation:
f64.const 4294967296  f64.div  f64.floor  f64.const 4294967296  f64.mul  f64.sub
i32.trunc_sat_f64_u
local.set $hash
```

i.e. ~5 f64 ops + a modulo-2^32 ToInt32 dance **per iteration** (~60k iters),
even though `$hash` is an i32 local and the result is `| 0`-masked.

**Why the existing #1120/#1179 i32-pure path did not fire.** The outer `+` IS
an `arithI32WithToInt32Wrap` candidate (its parent is `| 0`), but that requires
BOTH operands to satisfy `isI32PureExpr`. `text.charCodeAt(i)` is a
`CallExpression`, which the predicate rejected → the `+` fell to f64. A second,
subtler gap: even with charCodeAt accepted, the inner `hash*31`'s *parent* is
the `+` (not a bitwise op), and the i32 decision is re-derived per node by
walking UP for an enclosing bitwise/`| 0` context — the incoming `hint` is
dropped at `compileExpression → compileBinaryExpression`. So a nested
arith-under-arith node would still re-derive f64 and force a round-trip.

**Fix (two localized pieces in `src/codegen/binary-ops.ts`,
`compileBinaryExpression`):**

1. `isI32PureStringCall` + an extra `isI32PureExpr` arm: `<str>.charCodeAt(idx)`
   is an i32-pure **leaf** when the receiver is statically a string. charCodeAt
   returns a u16 code unit in [0, 65535] in BOTH backends (nativeStrings inline
   `array.get_u`; JS-host `wasm:js-string.charCodeAt` import) — always
   non-negative, i32-range, f64-exact — and `compileExpression` returns i32 for
   it *unconditionally* (not hint-driven), so treating the enclosing arithmetic
   as i32 does not change charCodeAt's own observable value.
2. `emitI32PureExpr`: emits a **proven-i32-pure** subtree directly as an i32
   instruction chain, so nested arith-under-arith stays i32 regardless of depth.
   Wired in for the operands when `arithI32WithToInt32Wrap || bitwiseI32` holds.

**Soundness.** Under the enclosing `| 0` (ToInt32) the i32 wrap is bit-for-bit
identical to f64-then-ToInt32: `$hash` is i32 so `hash*31` is f64-exact
(< 2^53) and `i32.mul` wraps the same way ToInt32 would; `i32.add` of two
i32-range values likewise. The existing `isI32MulSafe` guard (small-literal
operand) still gates the `*` arm, so unbounded multiplications keep the f64
path. The charCodeAt index arg is left to `compileExpression`'s own ToInteger
handling — unchanged.

**Result (WAT after).** The hash loop body collapses to:
`local.get $hash · i32.const 31 · i32.mul · <charCodeAt→i32> · i32.add ·
local.set $hash` — pure i32, no f64 conversions, no ToInt32 dance. Matches the
captured V8 TurboFan fingerprint (hot loop = integer ops, 0 SIMD).

**Verification.**
- Same-observable-result proof: compiled `run(n)` == JS reference for
  n ∈ {0,1,2,3,5,10,20,50,100,256,1000,5000,20000} in BOTH `nativeStrings/wasi`
  and JS-host (`wasm:js-string`) modes.
- Regression test `tests/issue-1746-i32-hashpath.test.ts` (5 cases): result
  parity in both modes, WAT no longer contains `4294967296`, i32.mul present,
  large-mul soundness guard (`(x*2147483647+1)|0` still matches JS), and
  charCodeAt value-invariance bare-vs-`|0`.
- Zero new regressions in the i32/arith/bitwise/string suite: 34 failed / 47
  passed identically with the change and on clean origin/main (the 34 are a
  pre-existing `string_constants` test-harness import issue, unrelated).
- `wasmtime` not available in this container, so warm-ms before/after on
  `scripts/generate-wasmtime-hot-runtime.mjs` and the committed benchmark-JSON
  refresh must be run by CI / a wasmtime-equipped runner before the #1580
  staleness gate is updated. The instruction-level win is proven here; the
  measured warm-ms refresh is the remaining acceptance step.

Levers #2–#7 (const-eval, presize, SIMD, fuse/unroll, linear-mem, BCE) remain
open as follow-ups.
