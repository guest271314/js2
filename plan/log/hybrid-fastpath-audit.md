# Hybrid fast-path safety-predicate audit (living checklist)

> **Owner: Architect. Status: living document (#2762, R3 of the hybrid
> roadmap).** This is the backlog generator for the hybrid type-soundness
> migration. It turns the migration-cost _estimate_ in
> [`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md)
> §(d) into an _actionable, per-fast-path_ checklist: each row is a dispatchable
> next-window slice with a tracked proof state. Read the roadmap §(a) (the
> Hybrid Invariant) and §(d) (the inventory) first.

## The contract every row must satisfy (Hybrid Invariant, HI)

For every value whose Wasm representation or instruction selection is influenced
by its TypeScript type `T`, codegen must emit **either**:

1. the **SAFE lowering** — JS-runtime-correct for _any_ value the expression
   could actually produce (the dynamic / `any` / externref path), **or**
2. the **FAST lowering** — the `T`-directed specialization, **guarded by a
   discharged safety predicate `P(T, site)`** that proves the runtime value
   cannot violate `T` at this site.

The SAFE lowering is the default. A fast path that _assumes_ `T` without
discharging `P` is an HI violation. `P` is discharged by a compiler-checked
**proof** (counted-loop bound, fresh-alloc with no widening escape, runtime
`ref.test`, literal index below a known length), **never** by a flag or by the
mere presence of a `: number` annotation (TS is unsound: `as`, `any`, covariant
arrays, index access, bivariance).

## Status legend

| Status         | Meaning                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `discharged`   | `P` is already proven by existing analysis; the path **is** HI-compliant. Cost ≈ documentation.                         |
| `partial`      | A proof exists for the common case (local / annotated), but the general arm still trusts `T` and needs a SAFE fallback. |
| `undischarged` | No real proof today; the path trusts `T`. **Subtle rows here can _miscompile_, not merely deoptimize.**                 |

## Effort bands

`S` ≤ ~1 dev-day · `M` ~2–4 dev-days · `L` ~1–2 dev-weeks (incl. regression-
gated rollout). Bands are for the _fast-path conversion only_; the §(e)
`substrate/value-identity` workstream is sized separately in the roadmap.

---

## The checklist

> **Anchors are against `origin/main` as of 2026-06-28** (`d0339428259cb`). Line
> numbers drift — the symbol name is authoritative, the line is a hint. Re-grep
> the symbol before working a row.

| #   | Fast path (anchor)                                                                                                                                                                                                        | Unsound assumption it makes                                                                                                                                                                         | Proof `P` that makes it HI-safe                                                                                                                                                                                    | Status                                                                                                                         | Class                                                  | Effort  | Follow-up                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | **IR `vec.get` element read** — `src/ir/from-ast.ts` `lowerElementAccess` → `emitVecGet` (FAST) / `emitSafeVecGet` (SAFE)                                                                                                 | ~~traps on OOB with NO SAFE fallback~~ → **fixed**: prove-then-specialize                                                                                                                           | index ∈ `[0, len)` via the (lower-bound-stricter) ported counted-loop proof; **else** the SAFE bounds-checked read (no trap, JS-correct OOB default)                                                               | `partial → counted-loop proof + SAFE fallback LANDED #2766` (literal-index P1 + non-null-`ref`/externref-`undefined` deferred) | easy (in-bounds half) / subtle (general dynamic index) | **M**   | **#2766 ✅ (folds #2760)**                                                                                              |
| 2   | **Legacy bounds-eliminated read** — `src/codegen/property-access.ts:5409` `isSafeBoundsEliminated` + `fctx.safeIndexedArrays`; checked at `:6321`/`:6371` in `compileElementAccessBody`                                   | none _in the proven case_ — but the **un-proven default** returns a type-default sentinel, not `undefined`                                                                                          | counted-loop in-bounds proof (`safeIndexedArrays`) — the canonical proof primitive                                                                                                                                 | `discharged` (proof side)                                                                                                      | already-HI-compliant                                   | **S**   | F1 (#2760) makes the _un-proven default_ JS-correct; F3 doc                                                             |
| 3   | **Packed-`i32` arrays** — `src/codegen/array-element-typing.ts:212` `collectI32SpecializedArrays`, `:44` `isI32SafeExprForArray`                                                                                          | every value stored is an i32-safe integer **and** no read needs the f64 NaN / fractional / `>2³¹` distinction — `number[]` guarantees none of this (`as`, `any`, fractional literal, big magnitude) | whole-function flow proving **every** write i32-safe **and** **no** read observes a distinction i32 erases; a wrong `P` **MISCOMPILES**                                                                            | `undischarged` (subtle)                                                                                                        | subtle                                                 | **L**   | — (spin from this row)                                                                                                  |
| 4   | **Monomorphic `struct.get`/`struct.set`** — `src/codegen/property-access.ts:990` `resolveStructName`, `:1392` `emitNullGuardedStructGet`                                                                                  | receiver is exactly that nominal struct layout — TS permits union arms, `any`-widening, covariant fields, divergent-layout subclasses                                                               | receiver provably the single nominal type (IR receiver-type narrowing) **and** no union / `any` / covariant / subclass-layout escape; **else** SAFE dynamic property read (or `ref.test`-guarded read, à la row 8) | read `discharged` (#2791) · write→#2793                                                                                        | subtle                                                 | **L**   | — (spin from this row)                                                                                                  |
| 5   | **Unboxed `f64`/`i32` number locals (no-box)** — IR `src/ir/from-ast.ts` `lowerVarDecl` → `proveUnboxedNumberLocal` (#2782); escape edge `coerceReturnValue`. (legacy numeric-local typing diffuse across `src/codegen/`) | a number-typed local stays unboxed and never needs identity/boxing at an `any`/externref sink                                                                                                       | TS-type proof (`classifyPrimitiveProof`) that the local is a pure number → keep unboxed; demote to SAFE boxed legacy at the proven `any` escape edge                                                               | `discharged` (f64 arm) / `partial` (i32 arm deferred)                                                                          | easy (pure-numeric) / subtle (any-union boundary)      | **M**   | **#2782** (f64 arm); i32-number arm deferred                                                                            |
| 6   | **`ArrayLiteral` → `vec.new_fixed`** — `src/ir/from-ast.ts:1516` `lowerArrayLiteral` (#1804)                                                                                                                              | all elements share one static type **and** the literal is not later widened to `any`/heterogeneous                                                                                                  | **local** proof: fresh allocation, all elements same static type, no widening escape — cheap, no whole-function dataflow                                                                                           | `discharged` (local)                                                                                                           | easy                                                   | **S**   | **#2780** (`arrayLiteralWideningEscapes` gate; FAST only when the contextual sink is not `any`/`unknown`/heterogeneous) |
| 7   | **`Binary` unboxed arithmetic** — IR `src/ir/from-ast.ts:3787` `lowerBinary`; legacy `src/codegen/binary-ops.ts:254` `compileBinaryExpression` / `:3660` `compileNumericBinaryOp`                                         | both operands are `number` so emit an `f64`/`i32` op, and `+` is a numeric add — TS allows `any`/union/string-coercible operands and `+` can be string concat                                       | operands provably `number` (not `any`/union/string-coercible) and `+` provably not string-`+`; **else** SAFE `emitAnyAdd` (`binary-ops.ts:3296`) / `emitAnyRelational` (`:3469`)                                   | `partial` (`+` arm discharged)                                                                                                 | easy (annotated-number) / subtle (`+` possibly-string) | **M**   | **#2781** (`+` proof-gate landed; relational/arith general arm reuses the same `classifyPrimitiveProof` helper)         |
| 8   | **`this`-receiver typed read** — `src/codegen/property-access.ts:5443` `emitThisReceiverGuardConvert`                                                                                                                     | **none** — it does a runtime `ref.test` instead of trusting the static `this` type                                                                                                                  | runtime `ref.test` guard (the canonical runtime-guard discharge of `P`)                                                                                                                                            | `discharged` (exemplar)                                                                                                        | already-HI-compliant                                   | **S**   | F3: document as the HI reference pattern                                                                                |
| 9   | **Typed-array element read** — `src/codegen/property-access.ts` typed-array site `~:6341` in `compileElementAccessBody`; shared helper `src/codegen/array-methods.ts:386` `emitBoundsCheckedArrayGet`                     | view-length is the bound and OOB → `undefined` per spec, **but** the read is entangled with the **shared** helper (the S2 blast-radius lesson)                                                      | view length is the bound; OOB → `undefined`; **must stay scoped separately from F1's plain-array scope** — do NOT flip the shared helper default                                                                   | `discharged` (#2798)                                                                                                           | easy but entangled                                     | **S–M** | **#2798** (landed: dedicated `emitTypedArrayUndefinedOobGet`, shared helper untouched, host+standalone)                  |

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

#### The F1 box must be TYPE-AWARE (#2785 — landed; unblocks the i32 arms)

F1's OOB→`undefined` widening boxes the in-bounds element via
`coerceType(<wasm kind> → externref)`. That box was **type-blind** —
`i32 → __box_number` always — which corrupts the non-number `i32`s the carrier
is overloaded with (boolean `true` → number 1; symbol handle → a number). This
cost **two R1 merge_group parks** and forced #2766 to narrow F1 to the `f64`
(`number[]`) element ONLY, deferring `boolean[]`/`symbol[]`.

**#2785 builds the type-aware box** — `coerceType(i32 → externref)` now picks the
helper from the value's BRAND (`boolean → __box_boolean`, `symbol →
__box_symbol`, else `__box_number`). The brand is structural-only and is **erased
in `arrDef.element`** (arrays dedupe by structure), so the F1 call sites
reconstruct it from the receiver TS element type (`f1ElementBoxType`).
**Landed in #2785:** `boolean[]` OOB→`undefined` re-enabled (host + standalone).
**Fast-follow (still deferred):**

- `symbol[]` OOB→`undefined` at the array-read site — needs a **native
  standalone `__box_symbol`** (host already works); until then `symbol[]` falls
  through (keeps `Object/values/symbols-omitted.js` green). The primitive's
  symbol arm is already wired in `coerceType`.
- broad symbol branding in `type-mapper.ts` (symbol locals/params/returns
  coerced to `externref`).
- the **Row 5 i32-number-local** box arm (#2782) — now unblocked by the
  type-aware box.
- `coercionInstrs` (the #1917 coercion-table path) brand routing — parallel to
  the imperative `coerceType` fix.

### Row 3 — Packed-`i32` arrays (miscompile risk)

A sound proof requires **both**:

- **(write side)** a whole-function value-range / flow analysis proving every
  store into the array is i32-safe — no fractional literal, no `|x| ≥ 2³¹`, no
  `NaN`, no value sourced from an `any`/union/division/`*`/`/` that can produce
  a non-integer or out-of-range magnitude; **and**
- **(read side)** no read site observes a distinction i32 erases — no
  `Number.isInteger`, no comparison to `NaN`, no division producing a fractional
  result, no stringification of a value that could be fractional / large.

`collectI32SpecializedArrays` + `isI32SafeExprForArray` only _approximate_ the
write side and ignore the read side, so today this is `undischarged`. Make the
specialization a **deopt**: any write that can't be proven i32-safe demotes the
whole array to the f64-backed SAFE representation. Until both halves hold, lower
as f64. \*\*L — wrong `P` miscompiles fractional / `>2³¹` values; strongest proof

- most regression gating.\*\*

### Row 4 — Monomorphic `struct.get`/`struct.set` (miscompile risk)

Discharge `P` with **IR receiver-type narrowing** that proves the receiver SSA
value's concrete type is the single nominal struct at the access site —
explicitly rejecting (a) union arms, (b) `any`-widened values, (c) covariant
field reads where the runtime field type differs from the static one, and (d)
subclasses whose field layout diverges from the parent's. Two SAFE fallbacks,
in preference order: a runtime `ref.test`-guarded struct read (row 8's pattern —
SAFE but not free) when the receiver is _probably_ the nominal type, and the
fully-dynamic property read (SAFE-always) otherwise. **L.**

> **Update 2026-06-28 (#2791): split into read (discharged) + write (re-scoped).**
> A verify-first investigation (23 adversarial probes, host + standalone) found
> the **READ** side is already HI-compliant — `emitNullGuardedStructGet` /
> `emitExternrefToStructGet` route every ref/externref receiver through the
> runtime `ref.test` multi-struct dispatch (#778/#2674), and the one monomorphic
> shortcut is Wasm-type-proven. (c) covariant-mutable-field divergence and (d)
> divergent-layout subclasses are **structurally impossible**: every subclass is
> laid out `[...parentFields, ...ownFields]` as a Wasm subtype
> (`class-bodies.ts:759/815`), so the parent's fields are a strict prefix.
> The genuine **silent miscompile** is a **structural-narrowing struct COPY at
> the call-argument boundary** (`type-coercion.ts`
> `getStructNarrowInfo`/`emitStructNarrowBody`): passing a value to a param of a
> _different_ nominal struct type (a structurally-compatible distinct class, or
> an `interface`) materializes a fresh `struct.new` copy, so a mutating callee
> updates the copy, not the caller's object. This is **NOT** the Row-4 lane
> (`resolveStructName`/`emitNullGuardedStructGet`) and no in-lane gate can fix it
> (the receiver is already disconnected). Recommend: flip the read side to
> `discharged`; file the write miscompile as its own type-coercion/param-typing
> issue. Full analysis + repro tests in **#2791**.

### Row 5 — Unboxed number locals, any/union boundary — **#2782 (f64 arm landed)**

Pure-numeric locals are already easy (no sink → no box). The subtle arm is a
number local that _also_ flows to an `any`/union/externref sink: discharge with
a TS-type proof and **box at the proven escape edge only**, keeping the value
unboxed everywhere else. Misplacing the box (boxing too late) is the failure
mode.

**#2782** discharged the **`f64` arm**, reusing #2781's `classifyPrimitiveProof`
(NOT `analyzeEscape` — the TS-type proof is the cheaper, sufficient discharge,
and the audit's `escape.ts` pointer was aspirational): (a) a **declaration
gate** (`proveUnboxedNumberLocal` in `lowerVarDecl`) keeps an `f64` local
unboxed only when its TS type is provably a pure number, else demotes to the
SAFE boxed legacy lowering; (b) the **escape edge** (`coerceReturnValue`) demotes
an unboxed `f64` returned into an `any` result to the SAFE boxed lowering. The
declaration gate is a forward-looking ratchet (a `: any` local is rejected
pre-claim, so it does not fire on today's scope — like #2780's primary gate);
the escape edge is the reachable, firing arm.

**The `i32`-number arm is DEFERRED.** `classifyPrimitiveProof` deliberately
reports the intrinsic `boolean` (= `true | false`) as `unprovable`, and
`boolean` collapses to the same `i32` kind as a native-`i32` number — so gating
`i32` locals on the number proof would demote every boolean local (the trap that
parked two prior attempts). The i32-number arm (`arr.length`, native-`i32` typed
numbers) needs its own TS-type proof that distinguishes i32-number from boolean.
**M.**

### Row 6 — ArrayLiteral, widening-escape check

`#1804` already emits `vec.new_fixed` for fixed-length same-typed literals. The
gap is the **"not later widened"** half: add a local check that the literal's
SSA result does not flow into an `any`/heterogeneous sink (assignment to an
`any[]`/`unknown[]`, passed where a wider element type is expected, pushed a
differently-typed element). It is a _local_ proof (fresh alloc), so this is the
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
2. **Row 6 — ArrayLiteral widening-escape check** (S, **#2780 — landed**).
   Smallest blast radius, a _local_ proof on a fresh allocation, no
   whole-function dataflow. The clean second exemplar that a proof need not be
   global. `arrayLiteralWideningEscapes` in `lowerArrayLiteral` gates the fast
   `vec.new_fixed` on the literal's TS contextual type: FAST only when the sink
   is not `any`/`unknown`/heterogeneous, else the SAFE boxed legacy lowering.
3. **Row 7 — Binary `+` string-or-number proof-gate** (M, **#2781 — landed**).
   Built the reusable operand-type-proof (`classifyPrimitiveProof` /
   `proveAdditiveOperand` in `from-ast.ts`) that rows 3, 5 reuse. Proof-gates the
   `+` fast path in IR `lowerBinary` on the TS _type_ (never the Wasm kind): both
   operands provably `number` → unboxed numeric add; both provably `string` →
   `emitStringConcat`; otherwise (`any` / union / mixed) demote to the SAFE legacy
   dynamic `+` (`emitAnyAdd`). The relational/arith general arm can now adopt the
   same helper without new infrastructure.

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
  `P` _miscompiles_. Small, isolable, and gated last.

**~2 free + ~4×(S/M) + ~2×L** ≈ a few focused dev-weeks, spread across the
IR-adoption steps (§(b) of the roadmap), **not** a big-bang rewrite.

---

## Maintaining this doc

- When a row is **claimed**, file its proof-gated issue (use
  `node scripts/claim-issue.mjs --allocate`) and record the id in the
  `Follow-up` column.
- When a follow-up **lands**, flip the row's `Status` (`undischarged`/`partial`
  → `discharged`), and — if the kind reaches _FAST-or-SAFE only_ — promote its
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
- [#2785](../issues/2785-hybrid-type-aware-box-primitive.md) — the **type-aware
  box primitive** (box keyed on the TS type, not the Wasm kind); re-enables F1's
  `boolean[]` OOB→`undefined` that #2766 deferred. Unblocks the i32 arms.
- [#2780](../issues/2780-hybrid-ir-arrayliteral-widening-escape.md) — the row-6
  follow-up (ArrayLiteral widening-escape gate).
- [ir-adoption.md](./ir-adoption.md) — per-AST-kind IR status & ratchet.
