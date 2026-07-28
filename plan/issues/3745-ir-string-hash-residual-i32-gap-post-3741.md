---
id: 3745
title: "string-hash under IR still uses i64 ToInt32 bit-manipulation, not native i32, even after #3741's loop-accumulator inference"
status: done
created: 2026-07-28
completed: 2026-07-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: performance
area: ir
language_feature: bitwise-operators, loops
goal: performance
related: [3740, 3744, 3741, 3739, 1948, 3752]
---

# #3745 — string-hash residual IR-vs-legacy gap survives #3741

## Context

#3744 promoted the #1210 string-builder optimization into the IR pipeline
and made IR claim the landing `string-hash` benchmark by default. Measuring
that fix found IR ~16x slower than legacy for this specific benchmark, and
attributed the gap to IR lacking legacy's i32-coerced-local promotion for
loop arithmetic (`(i * 13) & 31` etc.) — pointing at #1948.

While #3744 was in flight, **#3741** ("IR path has no equivalent to
legacy's #1120 i32-coerced-local promotion") landed independently on `main`
(PR #3718), fixing exactly this class of gap for the `loop.ts` benchmark
accumulator pattern (`let s = 0; for (...) s = (s + i) | 0;`). Merging it in
and re-measuring `string-hash` showed real improvement — warm avg dropped
from ~3.1ms to ~1.8ms — narrowing the gap from ~16x to ~9x. **But a
substantial gap remains**: legacy still measures ~0.18ms for the same
input.

## Finding: #3741's inference doesn't reach this specific loop shape

Disassembling the current default-IR-compiled `run` (optimize 3) shows
**zero** `i32.mul` anywhere in the function body — despite three
multiplications needing it (`i * 13`, `hash * 31`, twice: once in the build
loop, once in the hash loop). Instead there are 100+ `i64.*` instructions —
the newer #3739 "ToInt32 via IEEE-754 bit manipulation" technique
(`i64.reinterpret_f64` + exponent/mantissa extraction), which is faster than
the OLD div/floor/mul-by-2^32 float dance #3739 replaced, but still nowhere
near native `i32.mul`/`i32.and`.

So #3741's fix, while real and independently valuable (confirmed on
`loop.ts`), does not generalize to `string-hash`'s shape:

- **Build loop**: TWO locals (`a`, `b`) each derived from a bitwise
  expression over the SAME loop counter `i` (`a = (i * 13) & 31; b = (a + 7)
& 31;`), then used as array-index arguments to `charAt`. #3741's pattern
  is (per its own issue) a single accumulator reassigned via `s = (s + i) |
0`, i.e. one local, one enclosing bitwise/`| 0` context, no downstream
  index use. `string-hash`'s shape has two chained bitwise-derived locals
  per iteration, feeding a call argument rather than being returned/re-used
  as the SAME accumulator.
- **Hash loop**: a genuine single accumulator (`hash = (hash * 31 +
text.charCodeAt(i)) | 0`) that LOOKS like #3741's target shape, but its
  RHS is `hash * 31 + charCodeAt(i)`, not the simpler `s + i` #3741 was
  built against — worth checking in isolation (a minimal repro
  `let hash = 0; for (...) hash = (hash * 31 + arr[i]) | 0;` without the
  string-builder loop) to see whether #3741 covers accumulator-with-multiply
  at all, or only accumulator-with-add.

## Suggested next step

1. Reproduce and bisect the two loops SEPARATELY (in isolation, without
   string-building) to find out whether #3741's inference is missing the
   _build loop's_ two-chained-bitwise-locals shape, the _hash loop's_
   multiply-then-add shape, or both.
2. Extend #3741's i32-inference (or generalize its underlying analysis) to
   cover whichever shape(s) are missing. This is very likely NOT a new
   epic-scale feature — #3741 already proved the core mechanism works for
   one shape; this is about widening its recognized pattern set.
3. Re-measure `string-hash` after the extension; if it closes the remaining
   ~9x gap, consider whether #3744's `JS2WASM_IR_STRING_BUILDER` kill switch
   is still needed at all (it currently exists so anyone can force legacy
   for A/B comparison, independent of whether IR reaches parity).

## Non-goals

This is scoped to closing the measured perf gap, not to any correctness
issue — `string-hash` already produces byte-identical results through IR
today (verified in #3744's tests); this is purely about the residual
constant-factor slowdown from i64-bit-manipulation ToInt32 instead of
native i32 ops.

## Fix — the build loop's shape (partial)

New module `src/ir/i32-pure-bitwise.ts`: `computeI32PureNames(fn)` unions
legacy's own `collectI32CoercedLocals` (`src/codegen/function-body.ts`) with
every canonical `for(let i=INT;...;i++)` counter `detectI32LoopVar`
(`src/codegen/statements/loop-analysis.ts`) accepts — the SAME two proofs
legacy's #1120/#1236 i32-local promotion already relies on, reused verbatim
rather than re-derived. `isI32PureExprIR(expr, names)` then recognizes
whether a source EXPRESSION (not a local's storage) is built entirely from
values already proven clean int32s: a name in `names`, an in-range integer
literal, `+`/`-`/guarded-`*` of two such operands, or a nested bitwise/shift
of two such operands.

`src/ir/from-ast.ts`'s `LowerCtx` gets a new `i32PureNames` field (computed
once per top-level/nested/closure function body, mirroring `mutatedLets` —
**never** used to retype any local's declared `IrType`, unlike the reverted
#3741 attempt). `lowerBinary` now lowers a bitwise/shift operator's operands
through the unchanged existing f64 machinery as always, then — only when
`isI32PureExprIR` holds for BOTH raw operand expressions — wraps each
resulting f64 value with a cheap `i32.trunc_sat_f64_s` unary instead of
letting the expensive ToInt32 IEEE-754 bit-decomposition (#3739) run. This
is exact: `trunc_sat_f64_s(x) === ToInt32(x)` precisely when `x` is already
an integer in `[-2^31, 2^31)`, which is exactly what the reused proofs
establish. `ir/lower.ts` already had a fast path that emits a native
`i32.*` op (instead of the ToInt32 dance) whenever both `js.bit*` operands
carry `IrType.kind === "i32"` (#1126 Stage 3) — this fix is entirely about
making `from-ast.ts` actually produce that i32-typed operand for ordinary
un-annotated locals, so that existing fast path becomes reachable.

**Deliberately excludes call expressions** (e.g. `charCodeAt`) as leaves —
see the file's own doc comment for the NaN-preservation correctness hazard
this avoids (`ToInt32(a + NaN) = 0` collapses the WHOLE sum, but naively
fusing a native i32 add with a `trunc_sat_f64_s(NaN) = 0` leaf would
incorrectly preserve `a`'s bits instead). Legacy only lifts that exception
behind a separate, narrower "provably in-bounds hoisted read" proof (#2682,
tightly coupled to legacy's own codegen context) that this fix does not
port.

### What this closes vs. leaves open in `string-hash`

- **Build loop** (`const a = (i*13)&31; const b = (a+7)&31;`): CLOSED. Both
  `a` and `b` are proven i32-coerced locals (their only writes are bitwise
  expressions), and their bitwise expressions' operands are entirely
  identifiers/literals — no calls — so both `&` ops now take the native
  fast path. The final `return hash | 0;` also qualifies (`hash` is
  i32-coerced; `0` is an in-range literal).
- **Hash loop** (`hash = (hash * 31 + text.charCodeAt(i)) | 0;`): NOT
  closed. `text.charCodeAt(i)` is a call expression, excluded by design —
  see the correctness hazard above. This is the dominant cost in this
  specific benchmark (a per-character loop, vs. the build loop's coarser
  per-2-characters cadence), so despite closing the build loop's gap this
  benchmark's overall wall-clock time does not measurably improve. Filed as
  a separate follow-up, **#3752**, since safely admitting a call-expression
  leaf needs the harder, narrower "provably in-bounds hoisted read" proof
  (#2682-style) that this fix intentionally did not attempt.

### Measured

Disassembly of `run` (optimize 3, target wasi, nativeStrings): the ToInt32
i64-bit-manipulation instruction count drops from **156 to 26** (an ~83%
reduction) — the remaining 26 are entirely the hash loop's still-unclosed
`| 0`. `i32.trunc_sat_f64_s` count rises from 3 to 6 (one pair added for
each of the build loop's two `&` ops, plus one pair for the final
`return hash | 0`). `i32.mul` count stays 0 in both — arithmetic itself
(`i*13`, `hash*31`) is unaffected; only the bitwise operators' ToInt32 step
changed. Node warm wall-clock for the full benchmark (`n=20000`, median of
15 runs after 20 warmup iterations) is unchanged within noise (~1.5-2.2ms
both before and after this fix, vs. legacy's ~0.17-0.27ms) — consistent
with the hash loop (unaffected by this fix) dominating this particular
benchmark's runtime. The fix is still a genuine, general win for any
program whose hot path matches the build loop's shape (chained
bitwise-derived locals with no call-expression leaves), and a real,
measurable reduction in emitted Wasm instruction count for `string-hash`
itself; full wall-clock parity with legacy on this specific benchmark
requires #3752.

### Validation

- `tests/issue-1746-i32-hashpath.test.ts`, `tests/issue-3744-ir-owned-append-string-builder.test.ts`,
  `tests/issue-1761.test.ts`: all pass unchanged (18 tests).
- Full `tests/ir-*.test.ts` sweep (the same broad regression net #3741's
  reverted attempt was caught by) plus the full `tests/equivalence/` suite
  (1646 tests): identical pre-existing failures (32; same test names,
  reproduced byte-for-byte against the unmodified baseline via `git stash`)
  — no new failures introduced.
- `pnpm run check:ir-fallbacks`: no change.
- Direct correctness check of the actual `string-hash` benchmark source
  against a JS reference, `n` from 0 to 20000: exact match.
