# Hybrid type-soundness × IR-migration roadmap

> **Decision of record.** The project lead chose the **hybrid** type-soundness
> direction on 2026-06-28 (decision issue
> [`#2755`](../../plan/issues/2755-evaluate-type-soundness-approach.md)). This
> document is the merged implementation roadmap for that decision. It is the
> companion to [`codegen-axes.md`](./codegen-axes.md) (the front-end/back-end
> axes) and [`../../plan/log/ir-adoption.md`](../../plan/log/ir-adoption.md)
> (per-AST-kind IR status). Read both first.

## TL;DR

- **Invariant:** *a TS type may only change the emitted Wasm when the value
  provably cannot violate that type at runtime; otherwise lower the JS-correct
  way.* Correctness is the default; **specialization must be proven**.
- The legacy direct AST→Wasm path (`src/codegen/`) **trusts types inline at
  scattered sites** — that is exactly the old "trust-the-type-and-patch"
  approach the decision rejects. The typed **IR** (`src/ir/`) is the *single
  chokepoint* where a "prove-then-specialize" gate belongs. So the soundness
  finish line and the **#1530 IR-migration** finish line are now the **same
  line**.
- We do **not** rewrite the perf paths up front. We (1) land cheap correctness
  **floor** fixes in legacy now, (2) move the four hybrid-governed kinds onto
  the IR in a test-gated order, and (3) convert each existing type-directed fast
  path to a *proven-safe* specialization opportunistically, regression-gated.

---

## (a) The hybrid invariant, precisely

> **Hybrid invariant (HI).** For every value whose Wasm representation or
> instruction selection is influenced by its TypeScript type `T`, codegen must
> emit one of:
>
> 1. the **SAFE lowering** — the JS-runtime-correct lowering that holds for *any*
>    runtime value the expression could actually produce (the dynamic /
>    `any` / externref path, by construction correct), **or**
> 2. the **FAST lowering** — the `T`-directed specialization (packed array,
>    monomorphic `struct.get`, unboxed `f64`, …) **guarded by a discharged
>    safety predicate** `P(T, site)` that proves the runtime value cannot
>    violate `T` at this site.
>
> The SAFE lowering is the **default**. The FAST lowering is an *optimization*
> that must *justify itself* with `P`. When `P` cannot be discharged, codegen
> falls to the SAFE lowering — it never silently trusts `T`.

Two corollaries make this operational:

- **Every existing fast path is now a thing we must justify, not assume.** The
  audit in §(d) attaches a concrete `P` to each one and classifies whether `P`
  is *already* discharged by existing analysis, easy to discharge, or subtle.
- **`P` is discharged by a *proof*, not by a flag.** "The user wrote `: number`"
  is not a proof (TS is unsound: `as`, covariant arrays, `any`, index access,
  bivariance). A proof is a compiler-checked fact: a counted-loop bound, a
  fresh-allocation with no widening escape, a `ref.test` runtime guard, a
  literal index below a known length, etc.

### Redefining the #1530 IR fallback under HI

Today the IR demote-to-warning escape hatch (`src/codegen/index.ts`, the IR
claim/compile block ~`1372–1595`; historically documented as `889–896`) means:
*"if the IR path throws, keep the **legacy direct-codegen body**."* Under HI that
is wrong in one important way — the legacy body is precisely the trust-the-type
path we are retiring. We therefore **redefine the fallback target**:

> **#1530 finish line (HI form).** When the IR cannot claim or cannot prove a
> specialization for a hybrid-governed kind, it falls to the **SAFE JS-correct
> lowering**, never to a legacy trust-the-type lowering. A kind is "done" when
> (a) its IR rejection buckets are zero **and** (b) the only two outcomes are
> *FAST-with-discharged-`P`* or *SAFE* — there is no third "claimed-then-silently-
> fell-back-to-trusting-`T`" state.

Concretely this means the SAFE lowering for each hybrid-governed kind must exist
**as an IR lowering** (or a shared helper the IR calls), not only as a legacy
branch. The floor fixes in §(c) build those SAFE lowerings; the IR-adoption
order in §(b) routes the kinds through them. This is why the two tracks share a
finish line: you cannot complete #1530 for `ElementAccess` without also making
`ElementAccess` correctness-by-default, and vice versa.

---

## (b) IR-adoption order for the four hybrid-governed kinds

These four kinds are `mixed` on the IR today and are where type-directed
lowering bites (per `ir-adoption.md`):

| Kind | IR today | Type-directed lowering at stake |
|------|----------|--------------------------------|
| `ElementAccessExpression` | mixed (numeric index / const string key) | `vec.get`/`array.get` (OOB), packed reads |
| `PropertyAccessExpression` | mixed | monomorphic `struct.get`, union/`any` receivers |
| `BinaryExpression` | mixed | unboxed `f64`/`i32` arithmetic, `+` string vs number |
| `ArrayLiteralExpression` | mixed | `vec.new_fixed` packed construction |

**Recommended order — `ElementAccess → ArrayLiteral → Binary → PropertyAccess`:**

1. **`ElementAccessExpression` first.** It is the *sharpest* HI violation and has
   the *smallest* SAFE-lowering gap:
   - The IR read (`src/ir/from-ast.ts:1919` `lowerElementAccess` →
     `emitVecGet` → `vec.get`/`array.get`) **traps on OOB** and *explicitly*
     defers JS-correct OOB to the selector (see the comment at
     `from-ast.ts:1952–1960`). That is a pure trust-the-type fast path with **no
     SAFE fallback at all** — strictly worse than legacy, which at least returns
     a (wrong) sentinel.
   - The proof primitive **already exists**: legacy `isSafeBoundsEliminated`
     (`src/codegen/property-access.ts:5371`) + `fctx.safeIndexedArrays` is a
     counted-loop in-bounds proof. Porting that proof into the IR is the model
     for the whole roadmap: *prove in-bounds → keep `vec.get`; else emit a
     SAFE bounds-checked read returning `undefined`.*
   - This is also where the **#2198/S2 rework** lands (§(c), floor fix F1) — so
     ElementAccess gives us the canonical end-to-end example: floor fix in
     legacy + proof-gated specialization in IR.
2. **`ArrayLiteralExpression` second.** Smallest blast radius: a literal is a
   **fresh allocation** with locally-decidable element types (#1804 already does
   `vec.new_fixed` for fixed-length same-typed literals). The safety predicate
   ("all elements same static type, literal not later widened to `any`/
   heterogeneous") is *local* and cheap — a clean second exemplar that the proof
   need not be a whole-function dataflow.
3. **`BinaryExpression` third.** Unboxed `f64`/`i32` arithmetic is high-value and
   mostly safe, but `+` carries the classic unsoundness (string-or-number
   operand). Doing it after ElementAccess/ArrayLiteral means the proof
   infrastructure (operand-type proof, `any`/union detection) is already in
   place.
4. **`PropertyAccessExpression` last.** Largest surface (object / closure /
   string / vec / extern receivers; optional `?.`) and the subtlest predicate
   (monomorphic-receiver proof across unions, subclassing, covariant fields).
   It benefits most from the proof machinery built by the first three.

**Test gating (every step):**
- Byte-neutral on the `.ts` test262 corpus is **not** the bar by itself
  (a correctness fix legitimately changes bytes). The bar is: **no test262
  regression in the `merge_group` re-validation**, and the targeted
  correctness cases (e.g. the map-on-array-like case below) flip **green**.
- The IR ratchet (`pnpm run check:ir-fallbacks`) must not grow any unintended
  bucket; when a kind reaches *FAST-or-SAFE only*, promote its row in
  `ir-adoption.md` and zero its bucket in `scripts/ir-fallback-baseline.json`.
- Each kind keeps a `.ts`/`.js` parity probe (the SAFE lowering must be
  identical whether the source was typed or untyped).

---

## (c) Correctness FLOOR (legacy, now) vs SPECIALIZATION (IR, proof-gated)

The floor fixes are JS-correctness bugs that can land in legacy `src/codegen/`
**today**, independently of the IR migration, and that the IR will later reuse as
its SAFE lowering. The specialization work needs the IR's typed analysis.

### Floor fixes — land in legacy now

| # | Floor fix | Where | Why it is a floor (not a fast path) | Risk |
|---|-----------|-------|--------------------------------------|------|
| F1 | **Plain-array OOB read → JS `undefined`** (the #2198/S2 rework) | `src/codegen/property-access.ts:6303,6352` (the two non-bounds-eliminated `compileElementAccessBody` call sites) | OOB currently returns a *type-default sentinel* (sNaN for `number`, `false` for `boolean`, `ref.null.extern`→JS `null` for externref), **never** `undefined`. JS reads OOB as `undefined`. | **Blast radius** — see below |
| F2 | **`$Hole` → `undefined` on every read boundary** | already present (`emitHoleToUndefined`, `array-methods.ts:481`) — audit for gaps in the typed-element (`number[]`/`boolean[]`) read paths | a hole is "absent", reads as `undefined` per spec | low |
| F3 | **Document `emitThisReceiverGuardConvert` as the HI exemplar** | `src/codegen/property-access.ts:5405` | it already does a **runtime `ref.test`** instead of trusting the static `this` type — this *is* HI done right; make it the reference pattern | none (doc) |

**F1 is the deciding lesson of S2 and must be done HI-style, NOT as the parked
sentinel flip.** PR #2198 set `useUndefinedSentinel=true` on the **shared**
helper `emitBoundsCheckedArrayGet` (`src/codegen/array-methods.ts:386`). That
helper is called by plain-array reads **and** typed-array reads **and** the
`$__subview` path (`property-access.ts:6034`) **and** the array-method
machinery. Flipping it perturbed a generic `Array.prototype.map`-on-array-like
path (`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`) — the data point that
proved "patch the holes" is leaky.

> **F1 HI rework:** make OOB-correctness **fall out of the element-read path
> itself**, not by toggling the shared low-level helper. Either (a) handle the
> OOB→`undefined` decision at the `compileElementAccessBody` level for the
> **dynamic plain-array value read** only — leaving typed-array / subview /
> array-method internal callers on their own (correct) OOB semantics — or
> (b) split the OOB-default policy into an explicit parameter the *call site*
> owns, with plain dynamic reads passing "undefined" and the internal callers
> passing their existing default. The map-on-array-like case must be **green**.
> Do **not** re-land the shared-helper sentinel flip.

### Specialization — needs the IR typed analysis (proof-gated)

| # | Specialization | Proof `P` it now requires | Gating analysis |
|---|----------------|----------------------------|-----------------|
| S1 | IR `vec.get` keeps `array.get` (no bounds check) | index provably in `[0, length)` | counted-loop proof ported from `safeIndexedArrays`; literal-index-below-known-length |
| S2 | Packed-`i32` array reads/writes | every write is an i32-safe integer **and** no read needs the f64 NaN/fractional distinction | `collectI32SpecializedArrays` / `isI32SafeExprForArray` (`array-element-typing.ts`) — already approximates `P` |
| S3 | Monomorphic `struct.get` | receiver provably the nominal struct (not a union arm, not `any`-widened, not a differently-laid-out subclass) | IR receiver-type narrowing; `resolveStructName` + a "no covariant/union escape" check |
| S4 | Unboxed `f64` number path | value never observed as `any`/boxed without an explicit box | IR escape analysis (`src/ir/analysis/escape.ts:92`) at any/union sinks |

---

## (d) Migration-cost sizing — the type-directed fast-path inventory

> **Living checklist (R3 / #2762):** the snapshot table below is tracked, per
> row, as a dispatchable backlog in
> [`../../plan/log/hybrid-fastpath-audit.md`](../../plan/log/hybrid-fastpath-audit.md).
> That doc carries each path's discharged/partial/undischarged proof status, the
> concrete codegen site, and a "what would discharge `P`" note. **Update the
> living checklist, not this snapshot, when proof status changes.**

> **This is the lead's key open question:** *how big is "prove every fast path
> is safe"?* Below is the enumeration. Each row gives the fast path, the safety
> predicate `P` HI now demands, an **easy vs subtle** classification, and a rough
> effort band (**S** ≤ ~1 dev-day · **M** ~2–4 dev-days · **L** ~1–2 dev-weeks,
> including the regression-gated rollout).

| # | Type-directed fast path | Anchor | Safety predicate `P` | Class | Effort |
|---|-------------------------|--------|----------------------|-------|--------|
| 1 | **IR `vec.get` element read** (traps OOB) | `from-ast.ts:1919/1990` | index ∈ `[0,length)` (counted loop / literal < known len) | **easy** where a counted-loop or literal bound exists; **subtle** for general dynamic indices (needs SAFE fallback) | **M** |
| 2 | **Legacy bounds-eliminated read** | `property-access.ts:5371,6333` | counted-loop guarantees index < len | **already discharged** — this path *is* HI-compliant; just make the un-proven default JS-correct (F1) and document | **S** |
| 3 | **Packed-`i32` arrays** | `array-element-typing.ts:44,212` | all writes i32-safe ints; no read needs NaN/fractional/large-magnitude distinction | **subtle** — whole-function flow; misclassification *miscompiles* fractional/`>2³¹` values | **L** |
| 4 | **Monomorphic `struct.get`/`struct.set`** | `property-access.ts` (`resolveStructName`, `emitNullGuardedStructGet`) | receiver provably that nominal type; no union arm / `any` widening / divergent-layout subclass | **subtle** — covariant fields, union narrowing, subclass layout | **L** |
| 5 | **Unboxed `f64`/`i32` number locals** (no-box) | numeric local typing across codegen + IR | value never flows to an `any`/externref sink without an explicit box | **easy** for pure-numeric locals; **subtle** at any/union boundaries | **M** |
| 6 | **`ArrayLiteral` → `vec.new_fixed`** | `from-ast.ts` (#1804) | all elements same static type; literal not later widened to `any`/heterogeneous | **easy** — fresh alloc, local analysis | **S** |
| 7 | **`Binary` unboxed arithmetic** | IR `lowerBinary` (`from-ast.ts:3787`); legacy `binary-ops.ts` | operands provably `number` (not `any`/union/string-coercible); `+` not string-`+` | **easy** for annotated-number operands; **subtle** for `+` with a possibly-string operand | **M** |
| 8 | **`this`-receiver typed read** | `property-access.ts:5405` | (runtime `ref.test` guard) | **already discharged** — exemplar of HI; document as the pattern | **S** |
| 9 | **Typed-array element read** (sentinel semantics) | `property-access.ts:6285–6316`; `array-methods.ts:386` | view length is the bound; OOB → `undefined` per spec | **easy** but entangled with the shared helper (keep separate from F1's plain-array scope) | **S–M** |

### Sizing summary (the answer to the open question)

- **Already HI-compliant (cost ≈ documentation):** rows **2, 8** (proof already
  discharged), and the runtime-guard pattern generally. *These prove the
  approach is tractable — the compiler already contains "prove-then-specialize"
  primitives; HI generalizes them rather than inventing them.*
- **Easy / local proofs:** rows **6, 9** (fresh-array / view-bounded), plus the
  in-bounds half of row **1**. Banded **S–M each**.
- **Medium / boundary proofs:** rows **1 (general), 5, 7** — these need IR escape
  analysis (`escape.ts`) and `any`/union-sink detection, but the analyses exist.
  Banded **M each**.
- **Subtle / whole-function proofs (the real cost):** rows **3 (packed-i32)** and
  **4 (monomorphic struct)**. These are where a wrong `P` *miscompiles* rather
  than merely deoptimizes, so they need the strongest proofs and the most
  regression gating. Banded **L each**.

**Bottom line for the lead:** the migration is **not** a uniform rewrite. Of the
~9 fast-path families, **~2 are free** (already proof-gated), **~4 are S–M**
(local or analysis-backed proofs), and **only ~2–3 are L** (packed-i32,
monomorphic struct, and the substrate work in §(e)). The expensive, risky tail
is small and isolable, which is exactly why the hybrid (do the cheap floors +
proof-gate opportunistically) beats a pure-B up-front rewrite. Rough order-of-
magnitude for the *fast-path* conversion alone: **~2 free + ~4×M + ~2×L ≈ a few
focused dev-weeks**, spread across the IR-adoption steps in §(b), **not** a
big-bang. The substrate workstream §(e) is sized separately below.

---

## (e) The `$Object` / dynamic-reader value-identity substrate workstream

A distinct but **convergent** root cause keeps surfacing: the legacy
`$Object` / dynamic value reader **loses native struct / prototype-value
identity** when a compiled WasmGC value is read back through the dynamic
(`externref`/`any`) path. This is a value-**representation** substrate issue, and
it is the SAFE-path's weak point — the very path HI makes the default. If the
dynamic reader is lossy, "fall back to the dynamic path" is not actually correct,
so **this workstream is a prerequisite for HI's SAFE default to be trustworthy**.

**Three independent converging signals (as of 2026-06-28):**

1. **acorn parser walls — #2681 / #2686.** `acorn`'s `parse` 10th-wall
   ("unexpected on name") and `BinaryExpression` throw both bottom out in the
   `$Object`/dynamic reader dropping native struct/prototype values.
2. **builtins #1627 tail — 18 class-instance set-likes.** The Set-method
   set-like-argument tail is blocked on the same reader losing class-instance
   identity (`size`/`has`/`keys` read back as not-present).
3. **`instanceof` #2740 — 2 of 5 failure clusters are value-rep gaps** (verify-
   first by the instanceof dev; sub-issues being filed substrate/architect-
   scoped):
   - **(3a)** cross-realm `Object`/`Function` globals arrive with **sandbox-realm
     host identity**, so `v instanceof Object` is `false` (and the static fold
     hides the direct case) — a host-identity gap, same `$Object` theme.
   - **(3b)** `.prototype` access on a **dynamic `Function`-typed value traps** —
     a property-access gap on `Function` values, not an `instanceof` bug.

These are the **same substrate**: the dynamic reader's value representation does
not preserve (i) native struct field/prototype-value identity and (ii) host vs
compiled-value / cross-realm identity. Patch-the-symptom in any one of the three
shifts the others (the §(a) blast-radius lesson, again, one layer down).

**Workstream scope (named: `substrate/value-identity`):**
- **Single root fix:** make the `$Object`/dynamic reader **representation-
  preserving** — reading a compiled value back as `any`/externref and re-reading
  it must round-trip native struct identity, prototype-value identity, and host/
  cross-realm identity. (See the prior substrate analyses in MEMORY:
  `project_standalone_any_string_value_read_substrate`,
  `project_s64_value_rep_substrate_next`.)
- **Validation:** the fix must simultaneously unblock #2681/#2686 (acorn),
  the #1627 class-instance tail, and the #2740 (3a)/(3b) clusters — *one fix,
  three corpora green*. If it only fixes one, it is a symptom patch, not the
  substrate fix.
- **Sizing:** **L (1–2 dev-weeks)**, and it is **architect-scoped / senior-dev
  implementation** — it touches the value representation that the SAFE path
  depends on, so it gates the trustworthiness of HI's default. Treat it as the
  highest-leverage non-floor item.

### Assessment of #2758 (architect-first flag) — *does it belong here?*

**#2758** (destructuring default-init side-effect on a falsy value, entangled
with the #1177 / #2692 **closure-box** history) is **a different substrate** from
the `$Object` value-identity reader. #1177 (TDZ propagation through closure
captures) and #2692 (closure-capture ref-cell box must be materialized eagerly at
declaration) are about the **closure-capture ref-cell box** representation, not
the dynamic value reader.

> **Architect verdict:** #2758 does **not** belong in the
> `substrate/value-identity` ($Object reader) workstream. It belongs to the
> **closure-box / ref-cell** lineage (#1177 → #2692). Scope it there, not here.
> It *is* a substrate issue in the broad sense (a representation contract for
> ref-cells: a default-init must observe the *current* box value and only
> side-effect on a genuinely-falsy slot, respecting eager materialization), so it
> shares the roadmap's "fix the representation, don't patch the symptom"
> philosophy — but it is a **sibling sub-workstream** (`substrate/closure-box`),
> tracked under the #2692 follow-ups, not folded into the $Object reader fix.
> Conflating the two would repeat the exact blast-radius mistake this roadmap
> exists to avoid.

---

## Sequencing summary & follow-up issues

| Step | Roadmap issue | What | Effort |
|------|---------------|------|--------|
| 1 (now, legacy floor) | **R1** | F1 (plain-array OOB→`undefined`, HI-style — the #2198/S2 rework, *not* the shared-helper flip) + F2 audit + F3 doc | M |
| 2 (first IR step) | **R2** | `ElementAccessExpression` — port the `safeIndexedArrays` in-bounds proof into the IR; `vec.get` only when in-bounds is proven, else the SAFE bounds-checked read (F1 reused as the SAFE lowering) | M |
| 3 (audit, dispatchable) | **R3** | Migration-cost audit made a living checklist: annotate every §(d) fast path with discharged/undischarged proof status; this is the backlog generator for the M/L items | S |
| 4 (then, in order) | (follow-ons) | `ArrayLiteral` → `Binary` → `PropertyAccess` (§(b)), each proof-gated, each `merge_group`-regression-gated | M each |
| 5 (parallel, architect/senior-dev) | (substrate) | `substrate/value-identity` §(e) (acorn #2681/#2686 + #1627 tail + #2740 clusters), and sibling `substrate/closure-box` (#2758 under #2692) — **not** merged into each other | L each |

The concrete R1/R2/R3 issue IDs are recorded in the disposition note of
[`#2755`](../../plan/issues/2755-evaluate-type-soundness-approach.md) and created
as `sprint: current`, `status: ready`.

### Disposition of the open soundness PRs/issues (recorded in #2755)

- **PR #2198 (S1+S2 code)** — keep S1 (sound flags, corpus-neutral); **rework
  S2** as floor fix **F1** under HI (do *not* re-land the shared-helper sentinel
  flip).
- **PR #2195 / issue #2754 (sound-TS-settings spec)** — revise to the HI framing:
  Prong-1 stays; Prong-2 is reframed from "enumerate & patch holes" to "SAFE
  default + proof-gated specialization" (this doc is the authority).
- **#2698 (checker track) Prong-2** — re-scoped to HI; the codegen Prong-2 work
  is now governed by this roadmap, not a standalone hole catalog.

## See also

- [`codegen-axes.md`](./codegen-axes.md) — front-end (IR) vs back-end (WasmGC/
  linear) axes.
- [`../../plan/log/ir-adoption.md`](../../plan/log/ir-adoption.md) — per-kind IR
  status & ratchet.
- [`#2755`](../../plan/issues/2755-evaluate-type-soundness-approach.md) — the
  decision.
- #1530 — phase out the IR demote-to-warning channel (now: fall to SAFE, not
  legacy-trust).
- #2681 / #2686 / #1627 / #2740 — the substrate-convergence evidence.
