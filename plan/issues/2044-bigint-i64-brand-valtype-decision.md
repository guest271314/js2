---
id: 2044
title: "architect decision: BigInt value representation — i64-bigint-brand ValType vs TS-type-driven boxing (gates #1644 slices, implicated in #2039 i64 ABI bucket)"
status: done
completed: 2026-07-03
# was blocked_by: [2167] (fable-model gate) — resolved; decision ratified below
sprint: 71
created: 2026-06-10
updated: 2026-07-13
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: planning
area: codegen, ir
language_feature: bigint
goal: core-semantics
related: [1644, 1349, 2039, 1852]
origin: "Standing gate recorded since sprint 50: #1349/#1644 BigInt slices are blocked on an architect ratifying the i64-bigint-brand ValType design; the 2026-06-10 standalone gap review surfaced ~230 async-generator invalid-Wasm rows with `call[0] expected i64, found extern.convert_any` (#2039), which sit on the same representation boundary."
---

# #2044 — BigInt representation decision (i64-bigint-brand)

## Problem

BigInt values currently ride as externref (host-boxed) while native `i64`
numeric code uses raw i64 — and the type system cannot tell a "BigInt-shaped"
value from either neighbor. Consequences:

- Typed paths emit `f64.add` on externref BigInt operands → `illegal_cast`
  (#1644's core bucket; `built-ins/BigInt` pass rate stuck at 39%).
- `BigInt(x)`, `asIntN`/`asUintN`, mixed-operand TypeError semantics
  (`1n + 1` must throw) have no brand to dispatch on.
- Boxing *all* i64→externref as BigInt would break native i64 numeric code
  (the `type i64 = number` annotation feature), so the distinction must be
  carried in the type system, not guessed at coercion sites.
- The #2039 standalone bucket (`call[0] expected type i64, found
  extern.convert_any` in async-generator destructuring, ~230 tests) sits on
  this same i64↔externref ABI boundary — diagnose whether it is the same
  representation confusion or an unrelated async-gen ABI bug, and record the
  answer here either way.

## Decision to ratify (from #1644's analysis)

Choose and specify one:

- **(a) `bigint`-branded ValType** — `{kind: "i64", bigint: true}` threaded
  through type inference and **every coercion site** (`coerceType`,
  `__typeof`, truthiness, arithmetic dispatch, boxing round-trips). Honest
  and explicit; the cost is the cross-cutting thread through
  `src/codegen/type-coercion.ts` and the IR ValType union.
- **(b) TS-type-driven boxing decisions** — use `ctx.checker` at call sites
  to decide boxing; `coerceType` keeps seeing plain ValType. Cheaper to
  introduce, but pushes brand knowledge to call sites and risks divergence
  (the exact pattern that produced the #2039-style mismatches).

Constraints the ratified design must satisfy:

- GC/host mode and standalone mode lower **identically** at this boundary
  (the #1644 "ratify once, both modes" invariant).
- Native `i64` annotation code keeps raw-i64 performance (no boxing).
- `typeof 1n === "bigint"`, mixed-arithmetic TypeError, and `asIntN/asUintN`
  wrap semantics are all expressible via the brand.
- Standalone mode has a pure-Wasm story (i64 pair / struct for >64-bit
  values is out of scope; document the supported range honestly).

Deliverable: `## Implementation Plan` in this issue with the chosen
representation, the list of consultation sites (boxing, `__typeof`,
truthiness, arithmetic, equality/`isSameValue`), and re-sized #1644 slices.

## Why model: fable

One-shot, expensive-to-reverse representation decision that ripples through
every coercion site and both backends — the same class of decision as #1852
(per-backend value representation), with which it must stay consistent.

## Acceptance criteria

- A ratified representation design recorded here; #1644 unblocked with
  re-sized slices referencing it.
- The #2039 `i64`/`extern.convert_any` async-gen bucket is attributed (same
  root cause or explicitly ruled out), with the evidence cited.
- No regression in native-i64 benchmark code paths
  (`benchmarks/` numeric suites) under the chosen design.

---

## Architect Decision (2026-07-03, fable) — RATIFIED: option (a), the `bigint`-branded ValType

**Decision: `{kind:"i64", bigint?: boolean}` is the permanent BigInt
representation.** This ratifies the design **as-built**: while this issue sat
behind the #2167 model gate, #1644 implemented option (a) end-to-end and is
`done` on main (#1349 is wont-fix). The decision is therefore a ratification
with evidence, not a fork in the road — re-grounded against current main
(2026-07-03):

### Evidence the design is landed and satisfies every stated constraint

| Constraint | Where satisfied (current main) |
|---|---|
| Brand in the type lattice | `src/ir/types.ts:180` — `{ kind: "i64"; bigint?: boolean }` |
| Producers brand at birth | declared storage: `src/checker/type-mapper.ts:41-45`; bigint literals: `src/codegen/expressions.ts:967`; arithmetic re-brands both-bigint results: `src/codegen/binary-ops.ts:1483-1488` |
| Boxing consults the brand | `coerceType` i64→externref honours `from.bigint` → `__box_bigint` (`src/codegen/type-coercion.ts:1816-1822`) |
| Unboxing / ToBigInt | externref→branded-i64 → `__to_bigint` (§7.1.13 ToBigInt) at `type-coercion.ts:1680-1690` |
| `typeof 1n === "bigint"` | `__typeof_bigint` dispatch (`binary-ops.ts:2298`) |
| Mixed-operand semantics | mixed bigint/number comparison + TypeError paths (`binary-ops.ts:1256-1330`) |
| `BigInt(x)` ctor semantics | `__bigint_ctor` (NumberToBigInt RangeError, StringToBigInt, Symbol TypeError) |
| Native i64 keeps raw perf | brand is **optional + inert** — an unbranded `{kind:"i64"}` (the `type i64 = number` annotation) matches every `.kind === "i64"` check and keeps raw-i64 codegen; no boxing introduced |
| Both modes identical at the boundary | the brand lives in the front-end ValType, not in a backend; host `__box_bigint` is identity under JS-BigInt-integration, standalone carries the raw i64 payload |

### Why (a) over (b), recorded for posterity

Option (b) (TS-checker consultation at call sites) distributes the brand
decision across every boxing site — exactly the divergence pattern that
produces silent number-vs-bigint confusion. Landed history vindicates (a):
the same inert-brand mechanism generalized cleanly to **boolean**
(`i32.boolean`, #1788/#2795) and **symbol** (`i32.symbol`, #2785), so the
lattice now has a uniform rule — **JS types that ride a scalar Wasm carrier
get an optional, structurally-inert brand on the carrier's ValType, branded
at production and consulted only at the box/unbox choke points**
(`coerceType` + the #1917 coercion engine). See the paired #2712 decision
(same date), which ratifies the boolean lane on this same pattern and
declines a first-class `{kind:"bool"}`.

### #2039 attribution (acceptance item) — NOT BigInt

The ~230-row `call[0] expected type i64, found extern.convert_any`
async-generator bucket is **ruled out as BigInt-related** — the attribution
is recorded in `plan/issues/2039-standalone-invalid-wasm-residual-bucket.md`
("Attribution: the ~230-row i64 bucket is NOT BigInt", 2026-06-10, citing
this issue): the i64 in the validator message is an async-generator **resume
ABI** slot (state/brand param) receiving an externref, i.e. an async-gen ABI
bug that shares the physical i64↔externref boundary but not the
representation-brand confusion. No action lands under this issue; the bucket
stays with #2039 / the async-gen ABI work.

### Risks / open edges (recorded, not blocking)

- **>64-bit BigInt is out of scope.** Values are a single i64; arithmetic
  wraps rather than growing arbitrary-precision. Documented honestly: the
  supported range is `[-2^63, 2^63)`; `asIntN`/`asUintN` are exact for
  bits ≤ 64. A future arbitrary-precision plan replaces the **carrier**
  (i64 → limb array/struct) while keeping the same brand seam — the brand
  is what makes that swap localized.
- **Optional brands cannot force exhaustive switches.** The compensating
  control is architectural: box/unbox decisions are legal ONLY in
  `coerceType`/the #1917 engine (single choke point). Same mitigation as
  #2712 invariant I2.

### Downstream

- #1644 / #1349: the historical gate this issue existed for — already
  resolved (done / wont-fix); no re-sizing needed.
- #2712: the boolean analog — unblocked by this ratification (paired
  decision written 2026-07-03).
- #2039: i64 bucket attributed away from BigInt (above).
