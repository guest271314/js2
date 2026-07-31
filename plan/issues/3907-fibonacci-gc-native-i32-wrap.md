---
id: 3907
title: "correctness: `fast` mode lowers EVERY TypeScript `number` to a Wasm i32 — gc-native does not implement JS number semantics (mixed/fibonacci returns -269,534,592 instead of 8,320,400,000)"
status: done
created: 2026-07-31
updated: 2026-07-31
completed: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: numeric-types
goal: performance
sprint: current
horizon: m
es_edition: multi
related: [3898, 1948, 3917, 3912, 323, 3673, 1236, 2789, 1825, 2682, 3931]
loc-budget-allow:
  # (#3102 gate) `binary-ops.ts` +19: comment-only. The two `ctx.fast ⇒ i32`
  # numeric hints removed here are the ones that made every arithmetic node in
  # fast mode evaluate in 32 bits; the replacement comments enumerate the four
  # proof-carrying terms that remain and say plainly why `ctx.fast` must never
  # rejoin that list. A one-line diff with no explanation is exactly how this
  # gets reintroduced.
  - src/codegen/binary-ops.ts
  # `from-ast.ts` +16: the `i = i + <int literal>` counter-step lowering arm
  # (mirror of the existing `i += <lit>` arm) plus its soundness note. Without
  # it the planner would admit a write shape the lowerer cannot emit, which is
  # a demotion, not a miscompile — but the two must stay in agreement.
  - src/ir/from-ast.ts
---

# #3907 — `fast` mode lowers every `number` to a Wasm i32

## Status: fixed

**The title as originally filed was too narrow.** It was not an accumulator
narrowing and there was no `|0`/`&`/`>>` matcher involved. `fast` mode (= the
`gc-native` benchmark lane) lowered **every** TypeScript `number` — local,
parameter, return, array element, object field — to a Wasm `i32`. The
fibonacci wrap was one symptom of a mode-wide representation choice.

## Problem

`mixed/fibonacci` on the published performance page returns **different results
per lane**:

| lane        | returned value  |
| ----------- | --------------- |
| `js`        | 8,320,400,000   |
| `gc-native` | **−269,534,592**|

Fast mode infers **i32** for the accumulator and wraps past 2³¹, while every
other lane carries f64. In TypeScript the variable is `number`, i.e. IEEE-754
double — wrapping is simply wrong, not a permitted approximation.

The benchmark source (`benchmarks/suites/mixed.ts:141-163`) sums `fib(30)`
10,000 times: `fib(30)` is 832,040, so the total is 8,320,400,000 — well past
`Number.MAX_SAFE_INTEGER`? No: it is under 2⁵³ and exactly representable as an
f64. It only overflows if the accumulator is narrowed to i32.

## Why it matters beyond correctness

This invalidated a **published benchmark result**. `mixed/fibonacci` gc-native
was reported as 1.59× faster than JS — but it was comparing wrapping i32 adds
against f64 adds. That is not the same computation, so the number never meant
what the page claimed. Any i32-narrowing win elsewhere is suspect until we
know how far this reaches.

## Scope

1. Find where fast mode decides the accumulator is i32. The narrowing is
   presumably justified by a syntactic `|0`/`&`/`>>`-style matcher or a
   range/`typeof`-based inference; establish which. #1948 tracks the shared
   numeric lattice that should own this decision.
2. The narrowing is only sound when the value **provably** stays in i32 range.
   A `+` accumulation in an unbounded loop does not. Either prove the bound or
   do not narrow.
3. Sweep for other instances: any `number` local that fast mode narrows to i32
   and then accumulates. This is unlikely to be unique to fibonacci.
4. Add a regression test asserting cross-lane result equality, not just
   non-trapping.

## Acceptance criteria

1. `mixed/fibonacci` returns 8,320,400,000 in **every** lane.
2. A test asserts lane-result equality for the numeric benchmarks.
3. The issue documents how many other narrowing sites were found and whether
   any is similarly unsound.
4. Re-measure `mixed/fibonacci` — the honest gc-native number may be slower
   than the 1.59× currently published, and that is the correct outcome.

## Notes

- #3898 worked around this **in the benchmark only** so its baseline run could
  proceed. The compiler bug is untouched and is what this issue is for.
- The cross-lane result assertion #3898 added is what caught this. It had
  never been checked before, which is why a wrong-answer benchmark sat on the
  public page. That guard is now the thing to extend, not to remove.

---

# Investigation and fix (2026-07-31)

## The narrowing site

**`src/checker/type-mapper.ts:47-49`** — one line, reached from
`resolveWasmType`'s tail (`src/codegen/index.ts:7225`, the only caller that
passes `fast`):

```ts
if (type.flags & ts.TypeFlags.Number || type.flags & ts.TypeFlags.NumberLiteral) {
  return { kind: fast ? "i32" : "f64" };
}
```

Two more unconditional `ctx.fast ⇒ i32` decisions made the *arithmetic* i32 as
well, so a value that escaped the storage narrowing was narrowed again at the
operator:

- **`src/codegen/binary-ops.ts` ~247** (`compileFlattenedNumericChain`) —
  `numericHint = { kind: (ctx.fast || allNativeI32) && !isDivOrPow ? "i32" : "f64" }`.
  Worse, the guard above it (`if (allNativeI32 && !ctx.fast)`) *skipped* the
  native-annotation proof in fast mode, leaving `allNativeI32` at its
  optimistic `true`.
- **`src/codegen/binary-ops.ts` ~1931** (`compileBinaryExpression`) — `ctx.fast`
  sat at the head of the term list
  `(ctx.fast || bothNativeI32 || hasI32LocalOperand || arithI32WithToInt32Wrap || bitwiseI32)`.
  The other four terms all carry a proof; `ctx.fast` carries none.

### This is a design decision with unsound consequences, not a slipped bug

`src/index.ts:321` documents the option as **"Enable fast mode — i32 default
numbers, performance optimizations"**, and
`src/ir/module-bindings.ts:797-804` states it as settled fact ("Fast mode
stores ordinary numbers as i32 in the legacy ABI"). `src/codegen/native-type-annotations.ts`
noticed the consequence in passing — "The feature only appeared to work in
`fast` mode, where *every* `number` becomes `i32` regardless of annotation" —
but treated it as background, not as a defect.

Whoever reviews this is therefore **reversing an intent**, not patching a slip.
The intent is unsound: a TS `number` is an IEEE-754 double, and a mode that
silently makes it a wrapping 32-bit integer is not compiling the source
language. It cannot be benchmarked against JS either, because it is not the
same computation.

## Useful negative result: the three proof-carrying matchers were NOT the cause

The issue pointed at a syntactic `|0`-style matcher and at #1948's numeric
lattice. That is where the next person would look, so record that it is clear:

| matcher | file | verdict on `sum = sum + fib(30)` |
| --- | --- | --- |
| `collectI32CoercedLocals` (Q-CANON) | `src/codegen/analysis/i32-coerced-locals.ts` | **rejects** — `+`/`-`/`*` explicitly excluded since #1236, exactly because a long-running accumulator saturates |
| `detectI32LoopVar` | `src/codegen/statements/loop-analysis.ts` | not applicable — `sum` is not a loop counter |
| `planI32Slots` (IR) | `src/ir/analysis/i32-slots.ts` | **rejects** — `isCanonI32Lowerable` refuses a `+` RHS |

All three already implement "prove the bound or do not narrow", and all three
were already correct. #1236 and #2789 had hardened them for precisely this
failure mode. The bug was upstream of every one of them, in the type mapping
that made the proof irrelevant.

## Divergence table (base branch, `host-call` = correct)

| source | `host-call` | `gc-native` (before) |
| --- | --- | --- |
| `mixed/fibonacci` (published benchmark) | 8,320,400,000 | **−269,534,592** |
| `let sum=0; 10000×(sum = sum + 832040)` | 8,320,400,000 | **−269,534,592** |
| same with `sum += 832040` | 8,320,400,000 | **2,147,483,647** (saturated) |
| `let a=100000,b=100000; a*b` | 10,000,000,000 | **1,410,065,408** |
| `let n=3000000000; n` | 3,000,000,000 | **2,147,483,647** |
| `let n=3.5; n` | 3.5 | **3** |
| `let a=7,b=2; a/b` | 3.5 | **3** |
| `Math.sqrt(2)` | 1.4142135623730951 | **1** |
| `const a:number[]=[1.5,2.5]; a[0]+a[1]` | 4 | **3** |
| `id(3.5)` (parameter carrier) | 3.5 | **3** |
| `{v:3.5}.v` (object field carrier) | 3.5 | **3** |
| `1/2` | 0.5 | **0** (f64 division truncated by the i32 *return* type) |

Every carrier truncates, not just locals.

### The literal-vs-variable trap, one level deeper

`const n = 3.5; n === 3.5` returns **1** under `fast`, but `const n = 3.5;
return n` returns **3**. The comparison is constant-folded at compile time and
never reaches the narrowed slot; the read does. A probe that only tests
comparisons will report the lane healthy. (#3917 recorded the comparison
result as evidence that the local was *not* narrowed — it was.)

## Shared root cause with #3917

#3917 (`String(3.5)` → `"3"`, `(3.14159).toFixed(2)` → `"3.00"`) is the same
line. The value never reaches the formatter as 3.5 because it was never stored
as 3.5, and the emitted `number_toString` body is byte-identical between
configs — which is why the search there came up empty. After this fix
`const n = 3.5; String(n)` is correct under `fast`. #3917's remaining half
(#3912: the `import-collector.ts` gate and the template
`emitNativeStringRefFromExternref` fix) is genuinely independent and stays with
that issue.

## The fix — i32 by INFERENCE, never by default

The design is not "fast mode is f64 now". It is:

> Never force i32. **Seed** i32 from an explicit `type i32 = number` annotation
> or from a binding initialised with an integer literal (`const a = 3`).
> **Widen** to f64 the moment the i32 assumption cannot be sustained — an
> assignment that is or could be non-integer, or an operation whose result is
> not provably representable in i32.

The narrowing decision moves **out** of the type mapper (which knows only that
the TS type is `number`, and can therefore prove nothing) and **into** the
analyses that already carry proofs. Those analyses were already correct — see
the negative result above — so the fix is to stop bypassing them, then to close
one provable gap they had.

### Where the proofs live

| proof | seeds i32 for |
| --- | --- |
| `nativeTypeFromTypeNode` (#323/#3673) | an explicit `type i32 = number` binding — author-asserted range, wrap/truncate is the documented point |
| `collectI32CoercedLocals` (#1120/#1236/#2789) | a local whose **every** write is a canonical int32: integer literal in range, bitwise/shift result, comparison result, or another such local. Fixpoint-iterated so `a = b; b = t` cycles resolve together |
| `detectI32LoopVar` | a for-counter with an integer-literal init in range, a condition that bounds it, and a compile-time-constant step |
| `planI32Slots` (#3741) | the IR-path equivalent of the two above, keyed on the declaration node so sibling loops do not collide |
| `bothNativeI32` / `allNativeI32` | an arithmetic chain whose every operand is annotation-proven |
| `hasI32LocalOperand` | relational operators only, both operands proven i32 |
| `arithI32WithToInt32Wrap` | `+`/`-`/gated `*` under an enclosing ToInt32, which makes the wrap observationally equal |
| `bitwiseI32` | the operator itself is ToInt32-defined |

### The widening rules, and why each is required

`collectI32CoercedLocals` and `planI32Slots` already implement the user's rule
verbatim: a candidate starts in the i32 set and is **removed** if any write
fails the canonical-int32 proof.

- `let a = 3; a = 3.5;` → widened. `3.5` is not an integer literal.
- `let s = 0; … s = s + x;` → widened. `+` is rejected outright (#1236): the
  f64 result is stored through `i32.trunc_sat_f64_s`, which **saturates**, so a
  long-running accumulator silently returns 2147483647. This is the fibonacci
  shape.
- `let a = 1e5, b = 1e5; a * b` → widened. Two unbounded i32s can need 62 bits.
- `a / b` → widened. `isDivOrPow` never takes the i32 hint.
- `let n = 3000000000` → widened. The literal is outside i32 range.
- `let y = -x` → widened unless `x` is a non-zero integer literal (#2789):
  `-0` is observable and i32 collapses it to `+0`.

### The one provable gap this exposed, and closed

`for (let i = 0; i < n; i = i + 1)` — the spelling the benchmark suite and much
real code use — was **not** recognised as a bounded counter.
`detectI32LoopVar` accepted `i++`, `--i`, `i += <lit>` and `i -= <lit>` but not
the desugared `i = i + <lit>`, and `planI32Slots`'s write-shape check had the
same hole. Under the old blanket narrowing the spelling never mattered; with
the blanket gone, the counter demoted to f64 — and took the vec element
specialisation and the whole loop body with it, emitting the ~25-instruction
JS-ToInt32 emulation sequence per iteration.

Nothing in the proof depends on the spelling: `i = i + <int literal>` **is**
`i += <int literal>`. Fixed in three places that must agree —
`detectI32LoopVar` (`src/codegen/statements/loop-analysis.ts`),
`writeShapesAreLowerable` (`src/ir/analysis/i32-slots.ts`) and
`writePromotedI32Slot` (`src/ir/from-ast.ts`) — deliberately NOT generalised to
an accumulator, since the counter proof is what makes it sound.

This is the "provable but needs work → do the work" case, and it is what keeps
the array benchmarks from collapsing.

### Per-shape outcome

| shape | outcome |
| --- | --- |
| `type i32 = number` binding | **kept i32** (both modes) |
| `const a = 3` / integer-literal-seeded local | **kept i32** |
| `for (let i = 0; i < N; i++)` counter | **kept i32** |
| `for (let i = 0; i < N; i = i + 1)` counter | **kept i32** — restored here |
| `h = (h * 31 + c) \| 0` (ToInt32-wrapped chain) | **kept i32** |
| bitwise / shift / comparison results | **kept i32** |
| `number[]` with all-canonical-i32 writes | **kept i32** vec elements |
| `.length`, `indexOf`, byte offsets | **kept i32** (cannot leave range) |
| `let a = 3; a = 3.5` | **widened — unprovable** (assignment is non-integer) |
| `sum = sum + f()` in a loop | **widened — unprovable** (unbounded accumulation) |
| `a * b` on two unbounded i32s | **widened — unprovable** (needs 62 bits) |
| `a / b` | **widened — unprovable** (result generally non-integral) |
| literal outside i32 range | **widened — unprovable** |
| `-x` where `x` may be `0` | **widened — unprovable** (`-0` is observable) |
| `let s = 0; for (let i = 0; i < 10; i++) s = s + i;` | **widened pending follow-up** — this one IS provable (max 45) but needs loop-bounded interval inference over the induction variable, which does not exist yet. Named below, not silently dropped. |

`type i32 = number` — the documented, legitimate way to ask for i32 — still
works, in **both** modes: `let a: i32 = 100000; let b: i32 = 100000; a * b`
emits `i32.mul` and yields the wrapped `1410065408` under `fast: true` and
`fast: false` alike, while the unannotated `number` version yields the
spec-correct `10000000000` in both.

### Follow-up worth filing: loop-bounded accumulator range inference

`let s = 0; for (let i = 0; i < 10; i++) s = s + i;` is provably ≤ 45, so `s`
could stay i32. Establishing that needs interval tracking over the induction
variable and the loop trip count — real dataflow the compiler does not have
today. `collectI32CoercedLocals` correctly refuses it in the meantime (#1236),
because the same syntax with an unbounded or data-dependent step is the
fibonacci miscompile. Recorded here so the performance is recovered
deliberately rather than lost by default.

## Sweep result

**One narrowing site, reached from one caller, amplified by two operator-level
hints — and it was unsound for every `number` in the program, not for a
particular accumulator shape.** There is no separate list of "other unsound
accumulators" to enumerate: the sweep's answer is that the narrowing was
universal. The ~35 remaining `ctx.fast ? {kind:"i32"} : {kind:"f64"}` sites in
`property-access-dispatch.ts` / `array-methods.ts` / `dataview-native.ts` are
**not** in this class — they type genuinely-int32 producers (`.length`,
`indexOf`, `lastIndexOf`, byte offsets) whose values cannot leave int32 range,
and their results are widened by `coerceType` at the consumer. They are left
alone.

## Re-measurement — and a SECOND wrong published benchmark

`mixed/fibonacci` was not the only one. **`array/reduce` gc-native returned
704,982,704 where JS returns 4,999,950,000** — the same 2³¹ wrap, also on the
published page, also never compared, published as **2.68× faster than JS**.

All 14 numeric benchmarks in `mixed` + `arrays` were checked for lane
agreement. Exactly two disagreed; both are fixed. The only remaining
disagreement is `array/sort-i32`, whose gc-native lane fails with `illegal
cast` **identically before and after** — pre-existing and unrelated, worth its
own issue.

Back-to-back A/B on one box, final (inference) design. The JS baseline lane is
noisy run-to-run, so the **gc-native absolute ms** column is the reliable
signal and the ratio column should be read loosely (this box measured
fibonacci at 1.84× on the base branch where the page says 1.59×):

| benchmark | gc-native ms before → after | ratio before → after | value was wrong? |
| --- | --- | --- | --- |
| mixed/fibonacci | 0.154 → 0.215 | 1.84× → **1.38×** | YES (−269,534,592) |
| array/reduce | 1.52 → 3.96 | 2.51× → **1.03×** | YES (704,982,704) |
| array/map-filter | 0.115 → 0.952 | 2.91× → **0.44×** | no |
| array/push-pop | 1.36 → 3.53 | 2.00× → **0.77×** | no |
| array/slice | 0.036 → 0.154 | 1.61× → **0.40×** | no |
| array/forEach | 0.066 → 0.188 | 1.54× → **0.73×** | no |
| mixed/matrix-multiply | 0.304 → 0.901 | 0.82× → **0.30×** | no |
| array/indexOf | 5.20 → 6.71 | 1.01× → **0.77×** | no |
| mixed/sieve | 2.05 → 2.63 | 1.27× → **1.02×** | no |
| array/reverse | 6.73 → 6.82 | 1.38× → **1.41×** | no |
| mixed/csv-parse | 2.13 → 2.03 | — (js lane too noisy) | no |
| mixed/text-search | 2.48 → 2.35 | 0.22× → **0.27×** | no |

**gc-native loses its lead across most of the array suite, and that is the
correct result.** The "no" rows matter as much as the two wrong ones: those
benchmarks produced *correct* values but reached them with 32-bit integer
arithmetic while the JS baseline did IEEE-754 doubles — the same answer by a
different and cheaper computation, which is not a like-for-like comparison.
`array/map-filter` at 2.91× was the most flattering number on the page and is
really 0.44×.

Restoring the `i = i + 1` counter proof (above) is what keeps this from being
much worse: without it every one of these loops also paid the
~25-instruction JS-ToInt32 emulation sequence per iteration.

### A pre-existing gap that bounds how much of this is recoverable

The remaining array-suite cost is dominated by the `number[]` **element**
representation, not by the loop bodies. `#3734`'s narrowing
("int-only push loop narrows" — `const arr: number[] = []` written only with
canonical i32 values gets an i32 element vector) would apply to
`push-pop`/`map-filter`/`reduce`/`slice`/`forEach`, whose writes are exactly a
proven i32 counter.

**`tests/issue-3734-i32-array-elements.test.ts` fails on the base branch, before
this change** — 5 of its cases, including the narrowing gate itself. A targeted
A/B over that file plus `issue-3501`, `i32-loop-inference`, `issue-1236`,
`issue-1120`, `native-i32-type`, `labeled-loops`, `arrays-enums`,
`typed-array-basic` and `array-capacity` produced **byte-identical failure sets
before and after (61 = 61)**, so this change neither caused nor worsened it.
Recovering the array element narrowing is a separate, pre-existing piece of
work and is the highest-value follow-up for these numbers.

The page should be regenerated from a post-fix run before it is shown again.
(`benchmarks/results/*` is deliberately untouched here — a filtered run
truncates those whole-suite artifacts.)

## Known capability gap this exposes (needs a follow-up issue)

`detectCanonicalCharReadLoop` (#2682 — hoist the loop-invariant
`__str_flatten` + descriptor out of a canonical `charCodeAt` read loop) lives
**only** in the legacy AST front-end (`src/codegen/statements/loops.ts`). The
IR front-end has no equivalent, so the optimisation is lost for every body the
IR overlay owns.

Measured on the base branch, *before* this work: the hoist already failed to
fire for `nativeStrings` alone, `target: "standalone"`, and `target: "wasi"` —
IR had taken those over. It survived in exactly **one** configuration,
`fast + nativeStrings`, and only because fast mode's i32 grounding created the
ABI drift that kept the IR selector out of those bodies. Removing the grounding
closes the last pocket.

So this is **not** a capability #3907 deleted; it is a pre-existing IR-adoption
gap whose last hiding place was propped up by the bug. Re-keying it on the
`type i32 = number` opt-in would not help — the loop is
`(h * 31 + s.charCodeAt(i)) | 0` on plain `number`, and the blocker is body
*ownership*, not the i32 proof. **Follow-up: port the recogniser into the IR
front-end**; standalone and wasi have needed it independently of this issue.

`tests/issue-2682.test.ts` keeps every result assertion (all still
byte-faithful) and now carries a `⚠️ KNOWN CAPABILITY GAP` block plus a pinned
owner assertion, so a future port flips the test and must be handled
deliberately rather than silently.

## Tests

`tests/issue-3907-cross-lane-number-equality.test.ts` — 10 cases × 3 wasm
lanes (`host-call`, `gc-native`, `linear-memory`), each compared against the
**same source transpiled and run as JavaScript**, so the reference cannot drift
from the benchmark. `mixed/fibonacci` is imported from
`benchmarks/suites/mixed.ts` itself rather than copied.

Result equality is the guard that matters here. "The module instantiates and
does not trap" would have passed on every one of the twelve divergences above.

### Tests that encoded the old approximation and were updated

- `tests/i32-fast-mode.test.ts` — the suite's whole premise ("fast mode: i32
  default numbers") is what this issue reverses; the WAT-shape assertions were
  rewritten to the sound contract. (Both were already red on the base branch.)
- `tests/issue-1825.test.ts` — asserted `10 % 0 === 0` under `fast` with the
  comment "JS yields NaN; i32 fast mode has no NaN". Fast mode now has NaN, so
  these assert the spec values. The trapping-`i32.rem_s` guard the issue added
  is still required for the `type i32 = number` opt-in and is NOT removed.
- `tests/gradual-typing.test.ts` / `tests/equivalence/gradual-typing.test.ts` —
  `negAny(0)` now returns `-0`, which is what `-(0)` is in the spec. `toBe`
  is `Object.is`, so the old `toBe(0)` had encoded the i32 collapse of `-0`.
- `tests/issue-3521-prepared-free-function-routing.test.ts` — its two pins are
  named "keeps fast-mode numeric ABI drift on the post-direct overlay". The
  drift **was** this bug (legacy fast grounded `number` to i32 while IR's
  semantic `number` is f64, so the signatures disagreed and the IR patch was
  refused). With the representations equal the IR body legitimately patches, so
  both pins now assert the opposite outcome, with the reasoning inline. The
  first also gains `add(4e9, 4e9) === 8e9` — the shape the old i32 ABI could
  not represent.
- `tests/issue-2682.test.ts` — see the capability-gap section above.

### A/B over the fast-mode corpus (43 files, one checkout)

**Baseline 54 failures. Final state: 38.**

Of the baseline 54, 10 are this issue's own cross-lane guard — it fails on the
base branch, which is the proof that it catches the bug — so the comparable
pre-existing number is 44. The fix additionally repairs `issue-1817`'s two
fast-mode `>>>`-unsigned cases. Every one of the 38 remaining failures is on
the pre-existing list (notably `tests/native-arrays.test.ts` ×14 and
`tests/issue-2856-*` ×4) and is untouched by this change.

The four clusters this change did disturb — `gradual-typing` ×2 (`-0`),
`issue-1825` ×3 (NaN / `-0`), `issue-2682` ×3, `issue-3521` ×2 — are all
resolved above, each by making the test assert the spec-correct or
newly-honest outcome rather than the i32 approximation.

A second, wider targeted A/B over `native-i32-type`, `i32-loop-inference`,
`issue-1236`, `issue-1120`, `issue-3734`, `issue-3501`, `labeled-loops`,
`arrays-enums`, `typed-array-basic` and `array-capacity` — the files most
exposed to the `detectI32LoopVar` / `planI32Slots` / `from-ast` edits — gave
**byte-identical failure sets before and after (61 = 61)**. Those 61 are all
pre-existing on `claude/performance-benchmark-optimization-4ebyuz`.
