# Hybrid fast-path safety-predicate audit (living checklist)

> **Owner: Architect. Status: living document (#2762, R3 of the hybrid
> roadmap).** This is the backlog generator for the hybrid type-soundness
> migration. It turns the migration-cost *estimate* in
> [`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md)
> §(d) into an *actionable, per-fast-path* checklist: each row is a dispatchable
> next-window slice with a tracked proof state. Read the roadmap §(a) (the
> Hybrid Invariant) and §(d) (the inventory) first.

## The contract every row must satisfy (Hybrid Invariant, HI)

For every value whose Wasm representation or instruction selection is influenced
by its TypeScript type `T`, codegen must emit **either**:

1. the **SAFE lowering** — JS-runtime-correct for *any* value the expression
   could actually produce (the dynamic / `any` / externref path), **or**
2. the **FAST lowering** — the `T`-directed specialization, **guarded by a
   discharged safety predicate `P(T, site)`** that proves the runtime value
   cannot violate `T` at this site.

The SAFE lowering is the default. A fast path that *assumes* `T` without
discharging `P` is an HI violation. `P` is discharged by a compiler-checked
**proof** (counted-loop bound, fresh-alloc with no widening escape, runtime
`ref.test`, literal index below a known length), **never** by a flag or by the
mere presence of a `: number` annotation (TS is unsound: `as`, `any`, covariant
arrays, index access, bivariance).

## Status legend

| Status | Meaning |
|--------|---------|
| `discharged` | `P` is already proven by existing analysis; the path **is** HI-compliant. Cost ≈ documentation. |
| `partial` | A proof exists for the common case (local / annotated), but the general arm still trusts `T` and needs a SAFE fallback. |
| `undischarged` | No real proof today; the path trusts `T`. **Subtle rows here can *miscompile*, not merely deoptimize.** |

## Effort bands

`S` ≤ ~1 dev-day · `M` ~2–4 dev-days · `L` ~1–2 dev-weeks (incl. regression-
gated rollout). Bands are for the *fast-path conversion only*; the §(e)
`substrate/value-identity` workstream is sized separately in the roadmap.

---

## The checklist

> **Anchors are against `origin/main` as of 2026-06-28** (`d0339428259cb`). Line
> numbers drift — the symbol name is authoritative, the line is a hint. Re-grep
> the symbol before working a row.

| # | Fast path (anchor) | Unsound assumption it makes | Proof `P` that makes it HI-safe | Status | Class | Effort | Follow-up |
|---|--------------------|-----------------------------|---------------------------------|--------|-------|--------|-----------|
| 1 | **IR `vec.get` element read** — `src/ir/from-ast.ts` `lowerElementAccess` → `emitVecGet` (FAST) / `emitSafeVecGet` (SAFE) | ~~traps on OOB with NO SAFE fallback~~ → **fixed**: prove-then-specialize | index ∈ `[0, len)` via the (lower-bound-stricter) ported counted-loop proof; **else** the SAFE bounds-checked read (no trap, JS-correct OOB default) | `partial → counted-loop proof + SAFE fallback LANDED #2766` (literal-index P1 + non-null-`ref`/externref-`undefined` deferred) | easy (in-bounds half) / subtle (general dynamic index) | **M** | **#2766 ✅ (folds #2760)** |
| 2 | **Legacy bounds-eliminated read** — `src/codegen/property-access.ts:5409` `isSafeBoundsEliminated` + `fctx.safeIndexedArrays`; checked at `:6321`/`:6371` in `compileElementAccessBody` | none *in the proven case* — but the **un-proven default** returns a type-default sentinel, not `undefined` | counted-loop in-bounds proof (`safeIndexedArrays`) — the canonical proof primitive | `discharged` (proof side) | already-HI-compliant | **S** | F1 (#2760) makes the *un-proven default* JS-correct; F3 doc |
| 3 | **Packed-`i32` arrays** — `src/codegen/array-element-typing.ts:212` `collectI32SpecializedArrays`, `:44` `isI32SafeExprForArray` | every value stored is an i32-safe integer **and** no read needs the f64 NaN / fractional / `>2³¹` distinction — `number[]` guarantees none of this (`as`, `any`, fractional literal, big magnitude) | whole-function flow proving **every** write i32-safe **and** **no** read observes a distinction i32 erases; a wrong `P` **MISCOMPILES** | `undischarged` (subtle) | subtle | **L** | — (spin from this row) |
| 4 | **Monomorphic `struct.get`/`struct.set`** — `src/codegen/property-access.ts:990` `resolveStructName`, `:1392` `emitNullGuardedStructGet` | receiver is exactly that nominal struct layout — TS permits union arms, `any`-widening, covariant fields, divergent-layout subclasses | receiver provably the single nominal type (IR receiver-type narrowing) **and** no union / `any` / covariant / subclass-layout escape; **else** SAFE dynamic property read (or `ref.test`-guarded read, à la row 8) | `undischarged` (subtle) | subtle | **L** | — (spin from this row) |
| 5 | **Unboxed `f64`/`i32` number locals (no-box)** — IR `src/ir/analysis/escape.ts:92` `analyzeEscape`; legacy numeric-local typing diffuse across `src/codegen/` | a number-typed local stays unboxed and never needs identity/boxing at an `any`/externref sink | escape analysis proving the value never flows to an `any`/union/externref sink without an explicit box | `partial` | easy (pure-numeric) / subtle (any-union boundary) | **M** | — (spin general arm) |
| 6 | **`ArrayLiteral` → `vec.new_fixed`** — `src/ir/from-ast.ts:1444` `lowerArrayLiteral` (#1804) | all elements share one static type **and** the literal is not later widened to `any`/heterogeneous | **local** proof: fresh allocation, all elements same static type, no widening escape — cheap, no whole-function dataflow | `partial` (local) | easy | **S** | — (spin from this row) |
| 7 | **`Binary` unboxed arithmetic** — IR `src/ir/from-ast.ts:3787` `lowerBinary`; legacy `src/codegen/binary-ops.ts:254` `compileBinaryExpression` / `:3660` `compileNumericBinaryOp` | both operands are `number` so emit an `f64`/`i32` op, and `+` is a numeric add — TS allows `any`/union/string-coercible operands and `+` can be string concat | operands provably `number` (not `any`/union/string-coercible) and `+` provably not string-`+`; **else** SAFE `emitAnyAdd` (`binary-ops.ts:3296`) / `emitAnyRelational` (`:3469`) | `partial` | easy (annotated-number) / subtle (`+` possibly-string) | **M** | — (spin general arm) |
| 8 | **`this`-receiver typed read** — `src/codegen/property-access.ts:5443` `emitThisReceiverGuardConvert` | **none** — it does a runtime `ref.test` instead of trusting the static `this` type | runtime `ref.test` guard (the canonical runtime-guard discharge of `P`) | `discharged` (exemplar) | already-HI-compliant | **S** | F3: document as the HI reference pattern |
| 9 | **Typed-array element read** — `src/codegen/property-access.ts` typed-array site `~:6341` in `compileElementAccessBody`; shared helper `src/codegen/array-methods.ts:386` `emitBoundsCheckedArrayGet` | view-length is the bound and OOB → `undefined` per spec, **but** the read is entangled with the **shared** helper (the S2 blast-radius lesson) | view length is the bound; OOB → `undefined`; **must stay scoped separately from F1's plain-array scope** — do NOT flip the shared helper default | `partial` | easy but entangled | **S–M** | kept separate from #2760 |

---

## "What would discharge `P`" — the subtle / undischarged rows

These notes are the seed for each row's own proof-gated follow-up issue.

### Row 1 — IR `vec.get`, general dynamic index
Discharge with the in-bounds proof (counted-loop bound / literal index below a
known length) ported from legacy `safeIndexedArrays` into the IR. When the proof
is absent, emit the **SAFE bounds-checked read returning `undefined`** — the
shared SAFE lowering F1 (#2760) builds (planned helper, e.g.
`emitPlainArrayUndefinedOobGet`). This is the canonical end-to-end exemplar:
floor fix in legacy reused as the IR's SAFE lowering, fast path proof-gated.
**Already has an issue: #2766** (depends on #2760).

### Row 3 — Packed-`i32` arrays (miscompile risk)
A sound proof requires **both**:
- **(write side)** a whole-function value-range / flow analysis proving every
  store into the array is i32-safe — no fractional literal, no `|x| ≥ 2³¹`, no
  `NaN`, no value sourced from an `any`/union/division/`*`/`/` that can produce
  a non-integer or out-of-range magnitude; **and**
- **(read side)** no read site observes a distinction i32 erases — no
  `Number.isInteger`, no comparison to `NaN`, no division producing a fractional
  result, no stringification of a value that could be fractional / large.

`collectI32SpecializedArrays` + `isI32SafeExprForArray` only *approximate* the
write side and ignore the read side, so today this is `undischarged`. Make the
specialization a **deopt**: any write that can't be proven i32-safe demotes the
whole array to the f64-backed SAFE representation. Until both halves hold, lower
as f64. **L — wrong `P` miscompiles fractional / `>2³¹` values; strongest proof
+ most regression gating.**

### Row 4 — Monomorphic `struct.get`/`struct.set` (miscompile risk)
Discharge `P` with **IR receiver-type narrowing** that proves the receiver SSA
value's concrete type is the single nominal struct at the access site —
explicitly rejecting (a) union arms, (b) `any`-widened values, (c) covariant
field reads where the runtime field type differs from the static one, and (d)
subclasses whose field layout diverges from the parent's. Two SAFE fallbacks,
in preference order: a runtime `ref.test`-guarded struct read (row 8's pattern —
SAFE but not free) when the receiver is *probably* the nominal type, and the
fully-dynamic property read (SAFE-always) otherwise. **L.**

### Row 5 — Unboxed number locals, any/union boundary
Pure-numeric locals are already easy (no sink → no box). The subtle arm is a
number local that *also* flows to an `any`/union/externref sink: discharge with
`analyzeEscape` (`escape.ts:92`) at every such sink and **box at the proven
escape edge only**, keeping the value unboxed everywhere else. Misplacing the
box (boxing too late) is the failure mode. **M.**

### Row 6 — ArrayLiteral, widening-escape check
`#1804` already emits `vec.new_fixed` for fixed-length same-typed literals. The
gap is the **"not later widened"** half: add a local check that the literal's
SSA result does not flow into an `any`/heterogeneous sink (assignment to an
`any[]`/`unknown[]`, passed where a wider element type is expected, pushed a
differently-typed element). It is a *local* proof (fresh alloc), so this is the
cleanest second exemplar after row 1. **S.**

### Row 7 — Binary `+` (string-or-number)
Annotated-number arithmetic is already easy. The subtle arm is `+` where an
operand could be a string: discharge with an operand-type proof that **neither**
operand is `string` / `any` / a union containing `string`; only then emit the
unboxed numeric add. Otherwise fall to the SAFE `emitAnyAdd`
(`binary-ops.ts:3296`). The same operand-type-proof infrastructure also gates
the relational ops (`emitAnyRelational`, `:3469`). **M.**

---

## Dispatchable next-window slices (priority order)

The slices below are ordered to build proof infrastructure cheapest-first, so
the expensive L tail (rows 3, 4) inherits the machinery the S/M rows establish.

1. **Row 1 — ElementAccess prove-then-specialize → already #2766** (M, depends
   on #2760). The sharpest HI violation (IR `vec.get` traps OOB with no SAFE
   fallback) and the canonical end-to-end exemplar. Port `safeIndexedArrays`
   into the IR; `vec.get` only when in-bounds is proven, else the SAFE
   bounds-checked `undefined` read. **No new issue needed — track #2766.**
2. **Row 6 — ArrayLiteral widening-escape check** (S, *needs an issue*).
   Smallest blast radius, a *local* proof on a fresh allocation, no
   whole-function dataflow. The clean second exemplar that a proof need not be
   global. Add the "not later widened to `any`/heterogeneous" check to
   `lowerArrayLiteral`.
3. **Row 7 — Binary `+` string-or-number proof-gate** (M, *needs an issue*).
   Builds the operand-type-proof / `any`-union-sink detection that rows 3, 5
   reuse. Proof-gate the unboxed numeric op in IR `lowerBinary`; SAFE-fall to
   `emitAnyAdd` when a `+` operand could be a string.

After these three, the L tail (rows **3** packed-i32 and **4** monomorphic
struct) is architect-scoped / senior-dev implementation — the two paths where a
wrong `P` miscompiles, so they take the strongest proofs and the most
regression gating. Rows **2** and **8** are `discharged` (cost ≈ doc, folded
into F1/F3 of #2760). Row **5** general arm and row **9** typed-array follow
once the row-7 boundary machinery exists.

### Sizing summary (the lead's open question, made dispatchable)

- **Already HI-compliant (≈ doc):** rows **2, 8**.
- **Easy / local proofs (S–M):** rows **6, 9**, plus the in-bounds half of **1**.
- **Boundary proofs (M):** rows **1 general, 5, 7** — need IR escape analysis +
  `any`/union-sink detection, which exist.
- **Subtle / whole-function proofs (L, the real cost):** rows **3, 4** — wrong
  `P` *miscompiles*. Small, isolable, and gated last.

**~2 free + ~4×(S/M) + ~2×L** ≈ a few focused dev-weeks, spread across the
IR-adoption steps (§(b) of the roadmap), **not** a big-bang rewrite.

---

## Maintaining this doc

- When a row is **claimed**, file its proof-gated issue (use
  `node scripts/claim-issue.mjs --allocate`) and record the id in the
  `Follow-up` column.
- When a follow-up **lands**, flip the row's `Status` (`undischarged`/`partial`
  → `discharged`), and — if the kind reaches *FAST-or-SAFE only* — promote its
  row in [`plan/log/ir-adoption.md`](./ir-adoption.md) and zero its bucket in
  `scripts/ir-fallback-baseline.json` per the roadmap §(b) test-gating rule.
- Keep the anchors honest: re-grep the symbol (not the line) when you touch a
  row.

## See also

- [hybrid-soundness-ir-roadmap.md](../../docs/architecture/hybrid-soundness-ir-roadmap.md)
  §(d) — the inventory this checklist tracks; §(a) — the Hybrid Invariant.
- [#2762](../issues/2762-hybrid-fastpath-safety-audit-checklist.md) — this doc's
  tracking issue (R3).
- [#2760](../issues/2760-hybrid-floor-plain-array-oob-undefined.md) — R1 floor
  fix (the SAFE lowering rows 1/2 reuse).
- [#2766](../issues/2766-hybrid-ir-elementaccess-prove-then-specialize.md) — R2,
  the row-1 follow-up.
- [ir-adoption.md](./ir-adoption.md) — per-AST-kind IR status & ratchet.
