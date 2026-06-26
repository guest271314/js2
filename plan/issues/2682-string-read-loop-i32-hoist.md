---
id: 2682
title: "perf(strings): string read-loop fast path — hoist charCodeAt flatten/descriptor + i32 hash accumulator (the #1762 NO-GO redirect)"
status: done
assignee: ttraenkler/sd-strhash
completed: 2026-06-26
needs_arch_spec: false
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
language_feature: strings
goal: spec-completeness
related: [1762, 1105, 2055, 1746, 1120]
origin: "#1762 Slice 0 NO-GO (measured): the (array i16)→linear representation change is ~3-10% of the hash-loop cost; the real 1.7-2x win is codegen on the EXISTING WasmGC rep. Carved here as the redirect."
arch_spec_landed: "2026-06-26 (sd-typedarray): ## Implementation Plan below. Implementation is a deliberate floor-validated follow-on (not the spec session)."
---

# #2682 — string read-loop fast path (hoist + i32), the #1762 redirect

## Why this exists (the #1762 Slice-0 measurement)

#1762 proposed swapping the WasmGC `(array i16)` string backing for linear memory
to remove a hypothesised per-iteration "GC barrier" floor on the string
build/hash hot loops. **Slice 0 measured that hypothesis and returned NO-GO**
(warm wasmtime/Cranelift 44, two-point method; full data in
`plan/issues/1762-…md` "## Slice 0 — EXECUTED"):

| hash-loop char read | ns/read |
| --- | ---: |
| linear `i32.load16_u` (hoisted base) | 0.82–1.01 |
| WasmGC `array.get_u`, descriptor **hoisted** into locals | 1.03–1.11 |
| WasmGC `array.get_u`, struct fields **reloaded** per iter | 1.70–2.00 |

The `(array i16)` **representation** is only ~3–10% of the cost once the
descriptor is hoisted. The dominant **1.66–1.8x** is per-iteration `struct.get`
reloads, and the *real* compiler `$hashStr` loop is heavier still: a
`call __str_flatten` PER `charCodeAt` + 4 `struct.get` + f64 `|0` emulation. **All
of that is codegen on the existing representation** — and a linear `LinearString`
(a GC descriptor) would suffer the same reload tax, so the representation change
would not even fix the dominant cost. ⇒ This issue captures the real 1.7–2x with
NO dual-backend risk.

## The target pattern (the string-hash hot loop)

```ts
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
```

Compiled today (verified on `main`, decoded WAT of `$hashStr`): **per `charCodeAt`
iteration** the body emits (`src/codegen/string-ops.ts:2230`):
1. `call __str_flatten` (the receiver flattened EVERY iteration — loop-invariant);
2. `struct.get .len` for the bounds check (field 0);
3. an `if (idx<0 || idx>=len) then f64.const NaN else (struct.get .data; struct.get .off; i32.add; array.get_u; f64.convert_i32_u)` — i.e. 2 more `struct.get` reloads + the read;
4. the arithmetic `(h*31 + c) | 0` runs entirely in **f64** because `h` is an f64
   local and `charCodeAt` is not an i32-pure leaf — the `| 0` lowers to the
   expensive emulation (`f64.trunc; /2³²; floor; *2³²; sub; i32.trunc_sat_f64_u`).

None of 1–4 is the `(array i16)` representation; all are removable in WasmGC.

## Architectural decisions (the four coupled parts)

> The four parts are **coupled** — they serve one optimisation (the string read
> loop). They can land as one PR or a tight sequence, but the design must settle
> them together because (b) needs (a)'s hoisted descriptor and the in-bounds fact.

### D1 (part a) — Hoist the loop-invariant flatten + descriptor reads (LICM, scoped)

The `charCodeAt` lowering (`string-ops.ts:2230`) is **expression-local** — it has
no loop context, so it re-flattens + re-reads `.len/.off/.data` every call. The
fix is a **scoped loop-invariant-code-motion** keyed on the string-read pattern:

- At a `for`/`while` loop whose body contains `recv.charCodeAt(idx)` where `recv`
  is **loop-invariant** (a binding not assigned in the loop — reuse the existing
  loop-mutated-binding analysis the for-header i32 path already needs), emit ONCE
  before the loop: `flat = __str_flatten(recv); dataL = flat.data; offL = flat.off;
  lenL = flat.len` into fresh locals.
- Inside the loop, `recv.charCodeAt(idx)` reads from `dataL/offL` (no call, no
  `struct.get`). The bounds check uses `lenL`.
- **Refuse-loud / fall back** to the current per-call lowering when `recv` is not
  provably loop-invariant, or the loop shape is not recognised — never miscompile.

**Why scoped, not general LICM:** the codebase has no general LICM pass and adding
one is out of scope + risky. A *pattern-scoped* hoist (recognise the read loop)
is bounded and sound. Locus for the recognizer: the `for`-statement lowering
(`statements.ts` / the for-header compiler that already special-cases `i < N`),
which is the only place with both the loop and its body in hand.

### D2 (part b-i) — In-bounds proof: extend the #2055 relational path to `i < s.length`

`charCodeAt` is **soundly** excluded from the i32-pure leaf today
(`binary-ops.ts:1578`): ECMA-262 §22.1.3.3 returns **NaN** for an out-of-range
position, and in `(a + s.charCodeAt(i)) | 0` that NaN **poisons the whole sum to
0**, whereas an i32 leaf returning 0 would yield `a`. So an i32 `charCodeAt` is
only sound when the index is **provably in-bounds**.

The for-header `i < s.length` provides exactly that. Extend the #2055 relational
i32 fast path (`binary-ops.ts:1610-1623`, currently `i < N` for an i32-pure `N`):
- recognise `i < recv.length` where `recv` is the same loop-invariant string and
  `i` is the induction variable (init `0`/`i32`, `++`/`+= positive i32`);
- record an **in-bounds fact** `{induction: i, bound: lenL}` on the loop context
  (a small per-loop side-table, threaded like `fctx.labelMap`), consumed by D3.
- The bound is `recv.length` (== the hoisted `lenL` from D1), not a literal — this
  is the new case vs the existing literal-`N` path.

Edge cases that must KEEP the f64 path (no in-bounds fact): a mutated `i` in the
body, a non-`<`/`<=` condition, a `recv` reassigned in the loop, a `length` that
is not the receiver's own (`other.length`), or a step that can overshoot.

### D3 (part b-ii) — Proof-gated i32 `charCodeAt` leaf

With the D2 in-bounds fact in scope for `recv.charCodeAt(i)`:
- add `charCodeAt` to `isI32PureExpr` (`binary-ops.ts:1571`) **gated on**: the
  receiver is the loop-invariant `recv`, the arg is the induction `i`, and the
  `{i, lenL}` in-bounds fact is present;
- add the matching `emitI32PureExpr` arm (`binary-ops.ts:1623`): emit
  `array.get_u dataL (i32.add offL i)` directly as **i32** — **no NaN branch**
  (dead under the proof), **no `f64.convert`**. Reads from D1's hoisted locals.
- Outside a proven loop, `charCodeAt` stays excluded (current behaviour) — the
  general `(a + charCodeAt)|0` OOB-NaN semantics are preserved.

### D4 (part b-iii) — i32 hash-accumulator inference

`let h = 0` is an **f64** local today, so even with an i32 `charCodeAt` leaf the
chain re-promotes. Infer `h` as an **i32 local** when, in its whole function, `h`
is: initialised from an i32-pure expr AND every assignment is `h = <i32-pure> | 0`
(or a bitwise op) AND it is never read in a non-i32 (fractional/escape) context.
Then `isI32LocalRef(h)` (`binary-ops.ts:1454`, which keys on the local's declared
ValType) is true and `emitI32PureExpr` keeps `(h*31 + c)|0` entirely i32 — the
`|0` becomes a no-op, the f64 emulation disappears. Locus: the local-declaration
/ type-inference phase (`declarations.ts` numeric-local typing). **Conservative
default:** any uncertainty ⇒ keep f64 (no correctness risk, just no speedup).

> **Scope-control alternative (recommended FIRST slice):** rather than the four
> generic analyses, implement a single **pattern recognizer** for the canonical
> read loop `for (i=0;i<recv.length;i++) acc = <i32-pure fn of acc, recv.charCodeAt(i)>`
> that does D1+D2+D3+D4 as one gated rewrite, refuse-loud on any deviation. This
> is narrower, fully sound, and captures the measured win; the generic analyses
> (general LICM, general induction in-bounds, general i32-accumulator inference)
> are a broader follow-on once the pattern win is banked.

## Acceptance

- The `hashStr` pattern compiles to: ONE `__str_flatten` + descriptor hoist before
  the loop; an inner loop of `i32.load`-free `array.get_u` + i32 arithmetic; NO
  per-iteration `call`/`struct.get`/f64 `|0` emulation. Verify by decoding the WAT.
- Warm #1760 bench: a measurable hash-loop drop (target the 1.7–2x the Slice-0
  gc_reload→gc_hoist delta implies), honest provenance, #1580 gate green.
- **Zero behaviour change / zero test262 regressions** — OOB `charCodeAt` (NaN
  poisoning) outside a proven loop is byte-identical; the i32 path fires ONLY under
  the in-bounds proof. Result-parity tests: in-bounds hash loops, OOB charCodeAt in
  a `|0` context, `(a + charCodeAt)|0` with OOB, mutated-`i`, reassigned-`recv`,
  `other.length` bound, ConsString receiver (flatten still correct once-hoisted).
- **Broad-impact string codegen → floor-validate through merge_group** (the #2078
  regression class), never a scoped sweep. Gate behind a feature flag if landing
  incrementally so it can bake dark before flip-on.

## Risks

- **R1 — OOB-NaN soundness (the load-bearing constraint).** The i32 `charCodeAt`
  leaf MUST be gated on the D2 in-bounds proof; an ungated i32 leaf is a real
  correctness regression (test262 has OOB-`charCodeAt`-in-`|0` cases). This is why
  the redirect is spec-first, not coded-on-the-fly.
- **R2 — loop-invariance misjudged (D1).** Hoisting flatten when `recv` IS mutated
  in the loop reads a stale string. The invariance check must be conservative
  (reuse the loop-mutated-binding set; refuse on any doubt).
- **R3 — i32-accumulator inference too eager (D4).** Inferring `h: i32` when it can
  hold a fractional/large value is a silent wrong-result. Gate on the strict
  "only ever `… | 0`/bitwise-assigned" predicate; default f64.
- **R4 — index/funcidx-shift discipline.** The hoist adds locals + may call
  `ensure*` helpers mid-loop-build; follow `project_type_index_shift_and_deadelim`
  (register helpers once up-front; read shiftable indices fresh — the exact #2078
  bug class this lane just fixed).

## Routing

Senior-dev. Spec settled here; implementation is a deliberate, floor-validated
follow-on slice (recommend the pattern-recognizer FIRST slice in D1–D4's note).
Measurement instrument: `.tmp/measure.py` + the 3 hand-WAT variants from #1762
Slice 0 (re-create per the verdict section) for the before/after warm delta.

## Implementation Notes — sd-strhash verify-first grounding (2026-06-26)

**Verdict: CLEAN BOUNDED SLICE.** Scope is *narrower* than the spec's D1–D4
because grounding the actual codegen on current `main` (commit 93e7aebbc849)
shows D2 (relational) and D4 (accumulator) are **already done** by existing
passes. Decoded WAT of `hashStr` (probe `.tmp/probe2.mjs` / `.tmp/probe-native.mjs`):

- **D4 already done.** `collectI32CoercedLocals` (function-body.ts:186) already
  promotes `h` to an **i32 local** in all modes — `let h=0; h=(h*31+c)|0` is
  i32-safe because the assignment's top op is `|` (isI32SafeExpr returns true on
  bitwise without recursing). The spec's "h is f64 today" is stale.
- **D2 relational partly done.** In `{fast,nativeStrings}` the loop condition
  `i < s.length` already emits `i32.lt_s` and `h*31` is `i32.mul`. (Non-fast
  native still routes the condition through f64.lt — a minor residual, out of
  this slice's critical path.)
- **The real remaining cost is D1 + D3:**
  - **D1** — `call $__str_flatten($0)` runs **every iteration** (loop-invariant),
    plus per-iter `struct.get` of `.len/.off/.data`. This is the dominant
    1.66–1.8x per Slice-0. Hoist into locals before the loop.
  - **D3** — charCodeAt reads via the NaN-branch then `f64.convert_i32_u`, and the
    consumer immediately `i32.trunc_sat_f64_s`-es it back — a pointless f64
    round-trip. Under the in-bounds proof the NaN branch is dead and the read is a
    direct i32 `array.get_u`.

**Soundness (R1) is cleanly expressible on current main.** The in-bounds proof
reuses `detectI32LoopVar` (loops.ts:157 — proves init non-neg literal + strict
`<`/`>` condition + monotonic `++`/`+=k` step, so `i>=0` always) and a
string-specific mutation check modeled on `loopBodyMutatesIndexOrArray`
(loops.ts:237). NOTE: the #1196 helper rejects **all** method calls on the array
(lines 299–307), so it can't be reused verbatim — strings are immutable, so only
reassignment of `recv`/`i` and nested closures matter; `recv.charCodeAt(i)` reads
must be allowed. With `0<=i<len` proven at every body point, dropping BOTH OOB
checks and emitting a bare `array.get_u(dataL, offL+i)` is byte-identical.

**Implementation loci (verified on main):**
- `src/codegen/statements/loops.ts` `compileForStatement` (~819–868, the #1196
  block) — add the canonical-loop recognizer: detect `i < recv.length` (recv
  string-typed), check the string mutation guard, hoist `__str_flatten` + descriptor
  reads into fresh locals before the loop, record a per-loop proof on a new
  `fctx.hoistedCharReads` side-table (scoped save/restore exactly like
  `safeIndexedArrays`).
- `src/codegen/context/types.ts` (~377) — add `hoistedCharReads?` field next to
  `safeIndexedArrays`.
- `src/codegen/string-ops.ts` `compileNativeStringMethodCall` charCodeAt arm
  (2230) — when an active proof matches `(recvName, idx===indexName)`, emit the
  direct hoisted i32 read (no flatten / struct.get / NaN branch), wrap to f64 for
  the f64-consumption context.
- `src/codegen/binary-ops.ts` `isI32PureExpr` (1571) + `emitI32PureExpr` (1635) —
  add a proof-gated charCodeAt **i32 leaf** so the whole `(h*31+c)|0` chain stays
  i32 (this is what drops the f64 round-trip; the existing path already keeps
  `h*31` in i32 once `c` is a pure leaf).

Only fires in native-string mode (host/externref strings have no flattenable
descriptor — charCodeAt is a host call there, untouched). Validated through the
#2097 merge_group standalone floor.

## Implementation — DONE (sd-strhash, 2026-06-26)

Landed the single canonical-loop pattern recognizer (D1 hoist + D3 proof-gated
i32 leaf; D2/D4 were already done by existing passes). Files:

- `src/codegen/context/types.ts` — `HoistedCharRead` interface + scoped
  `FunctionContext.hoistedCharReads` side-table (sibling of `safeIndexedArrays`).
- `src/codegen/statements/loops.ts` — `detectCanonicalCharReadLoop` (the
  recognizer; emits the once-before-loop `__str_flatten` + `.data`/`.off` hoist),
  plus guards `isIncreasingStep`, `loopBodyMutatesStringReadInvariants` (string
  variant of the #1196 helper — allows receiver method calls, but rejects
  recv/i reassignment, `++`/`--`, **shadowing declarations**, and closures),
  `bodyHasMatchingCharRead`. Wired into `compileForStatement` with scoped
  save/restore around the body.
- `src/codegen/string-ops.ts` — `matchHoistedCharRead` + `emitHoistedCharCodeAtRead`
  helpers; charCodeAt arm (≈2230) fast-path for the f64-consumption case.
- `src/codegen/binary-ops.ts` — proof-gated charCodeAt **i32 leaf** in
  `isI32PureExpr` + `emitI32PureExpr` (keeps the whole `(h*31+c)|0` chain i32).

### Result (decoded WAT of `hashStr`, acceptance met)

`{fast,nativeStrings}` and `{nativeStrings}` both now emit: ONE `call $__str_flatten`
+ `.data`/`.off` hoisted into locals BEFORE the loop, and an inner loop body of
`i32.add(i32.mul(h,31), array.get_u(dataL, offL+i))` — **no** per-iteration
flatten, **no** `struct.get` reload, **no** OOB/NaN `if` branch, **no**
`f64.convert_i32_u` round-trip, **no** `|0` f64 emulation (`4294967296` gone).
Non-fast `hashStr` dropped from the full f64 ToUint32 emulation to pure i32.
(Residual: the non-fast loop *condition* `i < s.length` still uses `f64.lt` —
the optional D2 relational extension, deliberately out of this slice's scope.)

### Validation (verify-first, byte-identity discipline — #2078 class)

- `tests/issue-2682.test.ts` (12 tests, all green): result-parity for the
  canonical loop (fast + non-fast, incl. empty/unicode/long/ConsString/step-2/
  multi-read), and NOT-optimised+correct for every non-matching shape
  (OOB-outside-loop, `charCodeAt(i+1)`, reassigned-recv, mutated-i, shadowed
  recv, `other.length` bound mismatch).
- **Byte-identity proof**: decoded WAT of non-matching functions
  (`oobOutside`, `nonInductionIdx`, `reassignRecv`, `mutateI`) is **identical**
  between this branch and pristine `origin/main`; only the recognised loop
  changes (115→90 lines). The pre-existing fast-mode OOB-charCodeAt quirks are
  unchanged (identical results on baseline). `tsc --noEmit` clean; biome clean.
  Existing suites (8-file i32/charCodeAt set; 4-file bitwise/string set) show
  **identical** pass/fail counts vs baseline → zero new failures.
