---
id: 2949
title: "IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType (make untyped JS claimable)"
status: in-progress
assignee: ttraenkler/fable-2949
sprint: current
created: 2026-07-02
updated: 2026-07-04
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [1852, 1926, 2138, 2135, 2855]
origin: "2026-07-02 July Fable audit (plan/log/analysis-2026-07/00-ir-async-standalone-audit.md §1)"
---

# #2949 — the IR's type system is Wasm types, not JS types

## Problem

`IrType`'s leaf is `{kind: "val", val: ValType}` (`src/ir/nodes.ts:56ff`).
There is **no dynamic / any / JsTag representation inside the IR**. Every
value the front-end cannot statically resolve to a concrete Wasm type causes
whole-function rejection (`param-type-not-resolvable`,
`type-resolution-failure`, most of `body-shape-rejected` transitively).

Measured consequence (#2138 slice-2 measurement): the IR claimed **8 bodies
across 4 of 233 corpus files** on a JS-heavy corpus. The bucket-to-zero
program (#2855/#2856–#2859) is measured against 13 typed playground
examples; zeroing those buckets leaves the test262-scale claim rate in
single digits. **"IR as the only front-end" is arithmetically unreachable
without dynamic values in the IR type lattice.** This is the north star's
true critical path and previously had no filed issue.

The codegen-level D1 value-rep program (JsTag enum, brands, boxed-any
carriers — #1852/#1926/#2040 family) is done or in flight, but it lives
below the IR: the IR and the value-rep model have never met.

## Approach (architect spec first — this issue starts as the spec)

1. **Spec slice (this issue, first deliverable):** extend the `IrType`
   lattice with `{kind: "dynamic", tag?: JsTag}` (statically-known-tag
   refinement optional), define verifier rules (what ops accept dynamic
   operands, where explicit `IrInstrBox`/`IrInstrUnbox`/`IrInstrTagTest`
   nodes are required), and define the lowering contract: dynamic maps to
   the existing boxed-any carrier on WasmGC (per #1852 carrier policy) and
   to the f64-value+i32-tag cell on linear (deferred, #1852-G4/#2956).
   The trait methods `emitBox`/`emitUnbox`/`emitTagLoad` already exist
   (declared-optional) on `BackendEmitter` — this spec makes them
   load-bearing (coordinate with #2953).
2. **Slice 2:** `from-ast.ts` emits dynamic-typed IR for unresolvable
   locals/params instead of throwing; selector capability rows widen
   accordingly (#2135 table, claim instead of defer for
   `param-type-not-resolvable` / `type-resolution-failure` shapes).
3. **Slice 3:** lower dynamic ops via the canonical boxed-any helpers
   (reuse `addUnionImportsViaRegistry` / native classifier paths — do NOT
   mint a second boxing engine; June audit D4 rule).
4. **Slice 4:** measure claim-rate delta on the 233-file corpus + full
   test262 (`ir_first` lane, #2947); ratchet buckets down with the
   measurement as evidence.

## Acceptance criteria

- IrType has a dynamic kind with documented verifier rules; verify.ts
  enforces them (hard-fail lane stays on).
- A function with an unannotated `any` param round-trips: claimed by the
  selector, IR-built, lowered, byte-behavior-equal to legacy on the
  equivalence suite.
- Claim-rate measurement recorded here (corpus + test262 scale), with the
  before/after bucket counts.
- No second boxing implementation: lowering routes through the existing
  boxed-any registry helpers.

## Risks

- Blast radius is the whole IR pipeline; keep slices flag-free but
  additive (a dynamic-typed function that would previously reject is the
  only behavior change).
- Interaction with #2138 skip-set: a claimed-because-dynamic function must
  still satisfy the skipped-slot hard-error contract.

## Implementation Plan — Slice 1 (RATIFIED, fable-1, 2026-07-02)

### 0. What slice 1 ships (and what it deliberately does not)

Slice 1 is the **type-lattice + verifier + lowering-contract** slice. It is
**byte-inert by construction**: no producer (`from-ast.ts`, selector,
propagation) emits `dynamic`-typed IR yet, so no compiled module changes.
Producers land in slice 2 (coordinated with #2138's skip-set contract, which
is in flight on `issue-2138-ir-first-slice1`); box/unbox/tag.test _lowering_
for dynamic operands lands in slice 3 (via the emitter contract, coordinated
with #2953). Slice-1 lowering arms throw staged
`"… lands in #2949 slice 3"` errors so a premature producer fails loudly.

### 1. The lattice extension (`src/ir/nodes.ts`)

```ts
| { readonly kind: "dynamic"; readonly tag?: JsTag }
```

- `dynamic` is the **TOP** of the IrType lattice: every other IrType enters
  it only via an explicit `box` node and leaves it only via an explicit
  `unbox` (after a `tag.test` proof). **No implicit conversions** — this is
  what keeps the typed mainline unboxed (#1852 §3 invariant).
- `tag?: JsTag` is an optional **static refinement**: the producer proved
  the runtime partition (e.g. inside a `tag.test`-guarded branch). It never
  changes the carrier; it only licenses checked unboxes without a runtime
  re-test. `irTypeEquals` is **exact** on the refinement (both absent or
  both equal) — producers must widen to bare `dynamic` before joins
  (branch args, slot writes), because silently merging two refinements
  would keep whichever tag came first.
- `JsTag` is the **existing** canonical tag enum (#2104), extracted verbatim
  to the dependency-free leaf `src/codegen/js-tag.ts` (re-exported from
  `value-tags.ts` so all existing imports are unchanged). One tag table for
  codegen and IR — the June-audit D4 rule (no second tag/boxing engine)
  holds at the type level too. The extraction exists because `ir/nodes.ts`
  is a pure leaf imported by both layers; importing `value-tags.ts` (which
  pulls `ts-api` + codegen context types) from it would knot the module
  graph.

### 2. Node contracts (`box` / `unbox` / `tag.test` widened, not duplicated)

One boxing concept in the IR, discriminated by the operand/target **type**
(the type system carries representation, not the node kind — same principle
as `string`/`object`/`closure` resolver-deferred kinds):

- `box{ value, toType }` — `toType` may now be `dynamic` (erasure into the
  carrier). The operand must NOT itself be dynamic (re-box is provably
  redundant; verifier R1 rejects).
- `unbox{ value, tag?, jsTag? }` — `tag: ValType` became optional; it is
  REQUIRED for union operands (V1 contract, verifier-enforced) while
  dynamic operands use `jsTag: JsTag` (REQUIRED there). `jsTag` must have a
  payload (`jsTagUnboxKind(jsTag) !== null`) — Null/Undefined are singleton
  partitions and cannot be unboxed (R2). If both fields are present they
  must be consistent (scalar partitions exact, String/Object/Function
  ref-shaped).
- `tag.test{ value, tag?, jsTag? }` — same field discipline; `jsTag` may be
  ANY partition including Null/Undefined (testing for them is the point)
  (R3).

`jsTagUnboxKind(tag)` (in `js-tag.ts`) is the canonical partition→payload
mapping, derived from the `$AnyValue` layout
(`{tag, i32val, f64val, refval, externval}`): NumberI32/Boolean → `"i32"`,
NumberF64 → `"f64"`, String/Object/Function → `"ref"` (exact ValType is a
backend decision at lowering), Null/Undefined → `null` (no payload).

### 3. Verifier rules (`src/ir/verify.ts`, all enforced in slice 1)

- **R1 (box):** `toType` union (existing member rule) or dynamic (operand
  must not be dynamic).
- **R2 (unbox):** operand union (existing rules + `tag` now required-if-
  union) or dynamic (`jsTag` required, payload-bearing, `tag` consistent).
- **R3 (tag.test):** operand union (as R2) or dynamic (`jsTag` required,
  any partition).
- **R4 (scalar ops):** ALL `binary`/`unary` ops reject dynamic operands
  ("requires an explicit unbox"). Note `valKindOf` returns `null` for
  non-`val` kinds, which would have silently _skipped_ the existing kind
  rule — the explicit dynamic check closes that hole. Conservative on
  purpose (`ref.is_null` included); relax per-op when a slice needs it.
  Loop `condValue` (must-be-i32) already rejects dynamic via the existing
  #1980 rule.
- **R5 (joins):** enforced structurally by exact `irTypeEquals` in the
  existing branch-arg type checks; producers widen refinements first.
- **R6 (returns):** existing `returnTypeAssignable` already behaves
  correctly for dynamic (it is reference-shaped: scalar→dynamic result
  flags "needs a box the IR doesn't emit"; dynamic→scalar flags; ref→
  dynamic passes) — no change needed, documented here.

### 4. Lowering contract (`src/ir/lower.ts` + `integration.ts`)

- `IrLowerResolver.resolveDynamic?(): ValType` — returns the module's
  canonical **boxed-any carrier**, and MUST equal legacy
  `resolveWasmType`'s any/unknown arm so IR-claimed and legacy functions
  agree on the `any` ABI:
  - WasmGC **fast/standalone** → `ref_null $AnyValue` (via the idempotent,
    append-only `ensureAnyValueType`).
  - WasmGC **host (non-fast)** → `externref`.
  - **Linear** → deferred (#1852-G4/#2956); method omitted, lowering throws.
- `lowerIrTypeToValType` gains the dynamic arm (resolver-deferred, like
  string/object/closure). The `tag` refinement never changes the carrier.
- Dynamic box/unbox/tag.test **op** lowering is slice 3: it must route
  through the emitter contract (`emitBox`/`emitUnbox`/`emitTagLoad`,
  promoted from optional per #1852-G1) and the existing `__any_box_*` /
  classifier helper family — never a second boxing engine. Slice 3 keys the
  layout-handle union on `IrUnionLowering | IrDynamicLowering` (new handle:
  `{ carrier: ValType, anyValueTypeIdx, tagFieldIdx, payloadFieldIdx(jsTag) }`)
  — spec'd here so #2953's `pushRaw`-routing can anticipate the shape.

### 5. Slice-1 file inventory

- `src/codegen/js-tag.ts` (new leaf): `JsTag` moved verbatim +
  `jsTagUnboxKind`. `value-tags.ts` re-exports both.
- `src/ir/nodes.ts`: dynamic kind, `irDynamic`/`isDynamic`, `irTypeEquals`
  arm, widened box/unbox/tag.test contracts.
- `src/ir/verify.ts`: R1–R4.
- `src/ir/lower.ts`: `resolveDynamic` contract, type-lowering arm, staged
  slice-3 errors, union-path `tag` guard.
- `src/ir/integration.ts`: `makeResolver().resolveDynamic` (additive; no
  overlap with #2138's in-flight diff, which touches only
  `codegen/index.ts`).
- `src/ir/{from-ast,passes/monomorphize}.ts` + `lower.ts`/`integration.ts`
  describe/key helpers: dynamic arms (refinement-distinct keys).
- NOT touched: `select.ts` (capability rows are slice 2), `emitter.ts`
  (#2953's surface), `propagate.ts` (its lattice `dynamic` maps onto
  `IrType.dynamic` in slice 2).

## Test Results — Slice 1 (2026-07-02, fable-1)

- `tests/issue-2949-ir-dynamic-type.test.ts` — 19/19 pass (tag-table
  identity, lattice equality, verifier R1–R4 positive+negative, lowering
  contract incl. missing-resolver and staged-slice-3 failures).
- **Byte-inertness PROVEN** (not just argued):
  `scripts/prove-emit-identity.mjs` baseline captured on clean main
  (`affc55523`), `check` on this branch → **IDENTICAL, all 39
  (file,target) hashes match** across gc/standalone/wasi targets.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket (no
  selector change, as designed).
- Related suites: `issue-2104-value-tags` (JsTag move), `ir/phase3c`
  (union box/unbox/tag.test V1 path), `ir-frontend-widening`,
  `ir-backend-emitter` — all pass. `ir-scaffold.test.ts` has 2 failures
  that reproduce identically on clean main (pre-existing, unrelated —
  `__unbox_number` link error + `func.params not iterable`).
- `npx tsc --noEmit` clean; the new IrType variant surfaced exactly 4
  boxed-fallthrough describe/key helpers + 2 optional-`tag` consumers,
  all fixed with explicit dynamic arms.

- **Equivalence-suite classification** (`tests/equivalence/`, 211 files /
  1638 tests): a triple-concurrent run showed 56 failures — re-run SOLO the
  count collapses to **4 failures in 2 files**
  (`arguments-nested-and-loops` 1, `iife-and-call-expressions` 3), and
  clean main (`affc55523`) solo on the same 2 files shows the **identical
  2-files / 4-failed / 112-passed** result. Verdict: 4 pre-existing main
  failures + ~52 load flakes (the known pass→compile-timeout mode under
  CPU contention). **Zero equivalence regressions from this branch**,
  consistent with the 39/39 byte-identity proof.

## Handoff — Slice 2+ (written at 2026-07-02 budget wind-down, fable-1)

Slice 1 is complete and PR'd from branch `issue-2949-ir-dynamic-value-rep`
(worktree was `agent-a581bd5866af72b4b`, disposable). The claim lock will be
released at termination so the next window's senior-dev can pick this up.

**Slice 2 (producers + selector) — start here:**

1. `src/ir/propagate.ts` already computes a `dynamic` lattice top; today
   from-ast REJECTS when it converges there. Map lattice-`dynamic` →
   `irDynamic()` for params/locals/returns instead of throwing
   (`param-type-not-resolvable` / `type-resolution-failure` /
   `return-type-not-resolvable` shapes first).
2. Widen the #2135 capability rows in `select.ts` to claim those shapes.
   **Coordinate with #2138 first** — sr-irfirst's
   `issue-2138-ir-first-slice1` (in flight at wind-down, touches
   `src/codegen/index.ts`) owns the skip-set contract; a
   claimed-because-dynamic function must still satisfy the skipped-slot
   hard-error rules. Merge their landed work before touching select.ts.
3. The verifier is already strict (R1–R4 enforced, hard-fail lane on) —
   producers that emit un-unboxed dynamic uses will fail verify, which is
   the designed backstop while slice 3 lowering is absent. Until slice 3,
   producers may only emit MOVE-shaped dynamic flows (param→return,
   param→call-arg with dynamic signature) — the lowering arms for dynamic
   box/unbox/tag.test throw staged errors on purpose.

**Slice 3 (lowering):** route dynamic box/unbox/tag.test through
`emitBox`/`emitUnbox`/`emitTagLoad` + a new `IrDynamicLowering` handle
(shape spec'd in §4 above) backed by the `__any_box_*`/`$AnyValue` family
(`ensureAnyValueType` / `boxToAny` / `__any_from_extern`). Coordinate with
#2953 (BackendEmitter pushRaw routing — unowned at wind-down).

**Slice 4 (measurement):** 233-file corpus + `ir_first` test262 lane
(#2947); record claim-rate + bucket deltas HERE per acceptance criteria.

**Gotchas discovered:** (a) `resolveWasmType`'s any-arm is mode-split
(`ctx.fast` → `ref_null $AnyValue`, else externref) — `resolveDynamic` in
`integration.ts` mirrors it and MUST stay in lockstep; (b) `valKindOf`
returns null for non-val IrTypes, so any new per-op verifier rule must
explicitly check `kind === "dynamic"` or it silently skips; (c)
`prove-emit-identity.mjs` (baseline on main, check on branch) is the cheap
byte-inertness oracle — use it on every producer-free slice.

## Implementation Notes — Slice 2 (fable-2949, 2026-07-04, branch `issue-2949-jstag-dynamic`)

Slice 2 ships the first **producers**: unannotated params/returns whose
propagated lattice type is `unknown` (no evidence) or `dynamic` (top) now
resolve to `IrType.dynamic` and CLAIM, instead of rejecting the whole
function. The surface is deliberately **move-only** (no box/unbox/tag.test
lowering exists until slice 3), enforced by a new selector gate.

### What changed (and the WHY behind each decision)

1. **`select.ts` — `ResolvedKind` gains `"dynamic"`.**
   `resolveParamType`/`resolveReturnType` return it when: no annotation AND
   the TypeMap entry EXISTS and its lattice kind is `unknown`/`dynamic`.
   The `mapped !== undefined` requirement is load-bearing: class methods
   don't participate in TypeMap propagation (`entry` is undefined there) and
   must NOT silently become dynamic-claimable — method claiming carries the
   typeIdx-parity contract with `class-bodies.ts`. Lattice `union` stays
   rejected (that shape belongs to #2135's union rows, which have a real
   V1 boxing path). Binding patterns with a dynamic verdict stay rejected
   (destructuring a dynamic needs dynamic property access — slice 3+).
   Generators with dynamic params stay rejected (no dynamic arm in the
   gen prologue/yield machinery).

2. **`select.ts` — `dynamicUsesAreMoveOnly` (the precision gate).** Claim
   only when every dynamic value strictly MOVES:
   - `return <dyn>` (iff the return resolved dynamic; dually, a dynamic
     return REQUIRES every return argument to be dyn-shaped — a concrete
     value there would need a box);
   - dyn-arg → dyn-param of a DIRECT call to a local function, where the
     callee's per-param verdict is computed by the SAME `resolveParamType`
     the callee's own claim check uses (selector↔override drift is
     impossible by construction);
   - `const`/`let` alias (`const y = x`) — the alias joins the dyn set;
     re-assignment `y = <expr>` scans the RHS against the LHS's dyn-ness;
   - statement-position calls (a DROPPED dynamic result is fine — `drop`
     of the carrier ref validates).
   Everything else — arithmetic, truthiness, property access, calling the
   dyn value, mixed concrete/dynamic returns, dyn-into-concrete-param,
   spread over a dyn-param callee — keeps the EXISTING rejection bucket
   (`param-type-not-resolvable` / `return-type-not-resolvable`).

   **Why precision instead of claim-then-demote:** (a) under
   `JS2WASM_IR_FIRST=1` a claimed+skipped function that build-demotes is a
   HARD compile error (the #2138 skipped-slot contract); (b) the #1923
   post-claim metering treats demotions as regressions-in-waiting; (c) the
   unannotated population is the MAJORITY of JS code — claiming it all and
   demoting most would double-compile the world for nothing. The scan
   mirrors what from-ast can actually build; the demotion channel remains
   as the backstop for scan bugs, and slice-2 testing shows ZERO demotions
   across every claimed shape.

3. **`codegen/index.ts` — `resolvePositionType` dynamic arm**, predicate-
   identical to the selector arms (`!node && mapped && unknown|dynamic` →
   `irDynamic()`). Positioned AFTER the concrete/object lattice arms so
   nothing previously resolvable changes. Existing lowering from slice 1
   (`lowerIrTypeToValType` → `resolveDynamic()`) does the rest.

4. **`codegen/index.ts` — IR-first skip-set gate 6**: functions whose
   override signature contains a dynamic type stay compile-twice under
   `JS2WASM_IR_FIRST=1`. Insurance while the move-only scan is new — a
   scan↔builder divergence demotes benignly instead of becoming a
   skipped-slot hard error. Lift in slice 3/4 with an `ir_first`-lane
   measurement.

5. **from-ast / verify / lower: ZERO changes needed.** The move-shaped
   surface is entirely type-driven through existing code: params take the
   override (`resolveIrType` prefers override when no annotation),
   identifier loads are type-agnostic, the direct-call path checks
   `irTypeEquals(argType, expected)` (dynamic==dynamic exact),
   `coerceReturnValue` passes non-`val` declared results through, and R6
   `returnTypeAssignable` accepts dynamic→dynamic. This is the payoff of
   slice 1 putting `dynamic` in the TYPE lattice instead of minting new
   node kinds.

### Measured facts worth keeping (probes on main @ 4f68ed670)

- **The explicit-`any` annotation path has a REAL fast-mode ABI divergence
  today**: `export function f(x: any): any { return x; }` compiled
  `fast: true` emits `(param externref) (result externref)` on the IR path
  but `(param (ref null $AnyValue))` on the legacy path (`experimentalIR:
  false`) — `resolvePositionType`'s AnyKeyword arm predates the mode split.
  WAT-diff evidence in the slice-2 session. `dynamic` does NOT inherit
  this: `resolveDynamic()` mirrors `resolveWasmType`'s mode split, and the
  slice-2 tests assert the claimed function's `func $f` header is
  byte-equal to the legacy header in BOTH modes. Unifying `any` onto
  `dynamic` (slice 3b below) fixes the divergence.
- **The IR claim FIXES a live legacy miscompile**: host-mode legacy
  compiles `function g(x){return x} export function f(x){return g(x)}`
  such that `f("hello")` → null, `f(null)` → 0, `f({a:1})` → garbage
  (legacy call-site/return coercion mangles non-number args through the
  pass-through). The IR-claimed version returns identity for all six
  test values. Expect small test262 IMPROVEMENTS from pass-through-shaped
  helpers, not just neutrality.
- Lattice facts: unannotated params sit at `unknown` unless call-site
  evidence narrows them (propagation flows `g(1)` → g's param f64 — such
  functions claim CONCRETELY, not dynamically, which is why
  `f(){return g(1)}` still claims with zero dynamic involvement).

## Test Results — Slice 2 (2026-07-04, fable-2949)

- `tests/issue-2949-slice2-dynamic-producers.test.ts` — **22/22 pass**:
  claims (identity / pass-through chain / const alias / unused param /
  statement-position dyn call), precision rejections (arith, truthiness,
  property access, mixed returns, dyn→concrete arg, dyn-callee call,
  destructured dyn param — all keep their buckets), run-behavior identity
  across number/string/null/bool/object in host mode, fast-mode compile
  with zero demotions, ABI lockstep (IR `func $f` header == legacy header
  in host AND fast mode; fast carrier is the $AnyValue ref, NOT externref),
  IR-first gate 6 (dynamic claim not skipped, typed sibling still skipped).
- **Zero post-claim demotions** on every claimed shape (asserted in every
  compile test — `irPostClaimErrors` empty).
- **Byte-identity vs main**: `prove-emit-identity.mjs` baseline on clean
  main (4f68ed670), check on branch → IDENTICAL, all 39 (file,target)
  hashes across gc/standalone/wasi. The playground corpus contains no
  claimable unannotated move-only functions, so slice 2 is byte-inert
  there by construction.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket and no
  post-claim entries.
- Related suites: `issue-2949-ir-dynamic-type` (slice 1) 19/19,
  `issue-1228` (any/void selector) 9/9, `ir-frontend-widening` +
  `ir-backend-emitter` pass; `ir-scaffold` has the same 2 failures as
  clean main (pre-existing, verified side-by-side).
- `npx tsc --noEmit` clean; prettier + biome clean.

## Claim-rate measurement — Slice 2, corpus scale (2026-07-04, fable-2949)

Production-exact sweep (captures the `[ir-fallback]` selector telemetry from
real `compile()` calls) over the #2138-style corpus: 287 files = 13 playground
examples + `examples/` + stride-200 test262 sample. Script pattern banked in
the slice-2 session (`.tmp/claim-sweep.mts`, gitignored; STRIDE=200).

| metric | main (4f68ed670) | slice 2 | delta |
| --- | --- | --- | --- |
| files compiled OK | 248/287 | 248/287 | 0 |
| top-level fns (claim denominator) | 178 | 178 | 0 |
| **claimed** | **13** | **13** | **0 (identical claim SET, per-file diff)** |
| `return-type-not-resolvable` | 30 | 14 | **−16** |
| `param-type-not-resolvable` | 3 | 1 | **−2** |
| `body-shape-rejected` | 50 | 67 | **+17** |
| `destructuring-param-complex` | 1 | 2 | +1 (re-bucket) |
| post-claim demotions | 0 | 0 | 0 |

**The honest reading — the type gate was NOT the binding constraint at
test262 scale; the body-shape gate is.** Unlocking dynamic types converts
type-resolution rejections into shape rejections nearly 1:1 on this corpus
(the −18 type buckets reappear as +17 shape / +1 destructuring); the bodies
that pass Phase-1 shape were mostly typed already. The claim mechanism itself
is proven (targeted tests + equivalence-corpus shapes claim, build, run), but
the audit's "dynamic values make untyped JS claimable" is **necessary, not
sufficient**: the measured claim-rate delta materializes only as (a) slice-3
producers widen past move-only (real bodies USE their params — truthiness,
arith, property access), and (b) the #1370/#2855 shape surface widens. Plan
slice-4's measurement against BOTH levers, and expect the near-term needle to
move from (a).

Risk implication (good news): slice 2's test262/merge-group exposure is
minimal — identical claim sets on the 287-file sample means the behavioral
flips are confined to move-only-shaped helpers (rare in test bodies, more
common in harness-style pass-throughs).

---

## Implementation Plan — Slice 3: dynamic op lowering (Opus-executable)

**Goal**: lower `box{toType: dynamic}`, `unbox{jsTag}`, `tag.test{jsTag}`
so producers can widen past move-only. This replaces the staged
`"… lands in #2949 slice 3"` errors in `lower.ts`.

1. **`IrDynamicLowering` handle** (shape ratified in §4 above): extend the
   layout-handle union in `lower.ts` with
   `{ carrier: ValType, anyValueTypeIdx: number, tagFieldIdx: 0, payloadFieldIdx(jsTag): number }`
   provided by a new `IrLowerResolver.resolveDynamicLowering?()` in
   `integration.ts`. WasmGC fast/standalone: derives from
   `ensureAnyValueType` ($AnyValue = `{tag:i32, i32val, f64val, refval:eqref,
   externval:externref}`; payload field by `jsTagUnboxKind`: i32→1, f64→2,
   ref→3 for native refs / 4 for externref-shaped). Host (non-fast): the
   carrier is externref — box/unbox route through the EXISTING
   `__box_number`/`__unbox_number`/classifier import family, NOT struct
   fields. Do not mint a second boxing engine (June-audit D4): every emit
   goes through `emitBox`/`emitUnbox`/`emitTagLoad` on `BackendEmitter`
   (promoted from optional; coordinate with #2953 if still unowned) or the
   `__any_box_*` helper family.
2. **`box(value, dynamic)`**: scalar f64/i32(+bool brand) → struct.new
   $AnyValue with the right tag (fast) / `__box_number`-family (host).
   String/object/closure refs → tag Function/Object/String + refval (fast)
   / `extern.convert_any` (host). Null/undefined singletons per #2106.
3. **`unbox(value, jsTag)`**: fast → `struct.get` payload field AFTER the
   producer's `tag.test` proof (verifier R2 already enforces the field
   discipline); host → `__unbox_number` / cast family.
4. **`tag.test(value, jsTag)`**: fast → `struct.get tag` + `i32.eq`
   (Null/Undefined test via tag too); host → classifier import
   (`__typeof`-family) — reuse the tag-5 field-4 three-way classifier rules
   (memory `reference_2040_tag5_field4_three_way_classifier`).
5. **R6 hardening (REQUIRED before any producer emits ref→dynamic)**: the
   verifier currently PASSES ref-shaped→dynamic returns (slice-1 doc), but
   the LOWERING of that flow is only valid with an explicit box (a bare
   `(ref $C)` is not a $AnyValue subtype; in host mode it needs
   `extern.convert_any`). Slice 3 must either make the verifier reject
   un-boxed ref→dynamic returns or teach `coerceReturnValue` a dynamic arm
   that emits the box. Slice 2 never produces this flow (the move-only
   scan rejects it) — do not widen the scan before this lands.
6. **Producer widening** (same PR or a follow-up, each with its own
   claim-rate delta): `if (x)` truthiness via tag.test+unbox; `x === lit`
   via tag.test; `return <concrete>` under dynamic return via box;
   concrete-arg → dyn-param via box; `typeof x` via tag read. Each widening
   is a `dynamicUsesAreMoveOnly` arm flip + a from-ast lowering arm — keep
   the scan and the builder in lockstep (they are the same capability row,
   #2135).
7. **Lift gate 6** (`computeIrFirstSkipSet`) only after an `ir_first`-lane
   test262 run shows zero dynamic-claim build demotions.

**Verification protocol**: prove-emit-identity (39-hash corpus) must stay
IDENTICAL for any slice that adds only lowering arms (no producer change);
each producer widening re-runs the claim sweep (below) + full CI.

## Implementation Plan — Slice 3b: unify explicit `any` onto `dynamic`

`resolvePositionType`'s AnyKeyword arm (`codegen/index.ts:592`) and the
selector's `"any"` kind currently map `x: any` to **externref in ALL
modes**, which diverges from legacy's fast-mode $AnyValue ABI (measured,
see slice-2 notes — a claimed `f(x: any): any` has a DIFFERENT fast-mode
signature than its legacy callers expect). Change both arms to `dynamic`
(and delete the `"any"` ResolvedKind) once slice 3's box/unbox lands, so
`any`-annotated and unannotated positions are the same type. **Blast
radius**: currently-claimed any-functions change fast-mode signatures
(that's the FIX) and host-mode stays byte-equal (dynamic lowers to
externref there). Needs: the #1228 tests updated, a fast-mode cross-call
probe (legacy caller → IR callee), and full CI. Do NOT fold into slice 3's
lowering PR — separate, revertible.

## Banked adoption slices (unlocked by this substrate; Opus-tier)

### A. #2963 Phase 2 — any-callable scalar-param dispatch

Phase 2 is blocked on value-call dispatch mis-selecting same-ARITY
candidates for scalar-param reified builtins (`Number.isInteger` traps —
see #2963 "value-call-path blocker"). The substrate fix: a function value
held dynamically is a **Function-tagged dynamic value whose refval is the
closure struct**; call sites recover it by `tag.test(Function)` +
`unbox(Function)` + `ref.test` against candidate closure types keyed on
the EXACT static closure type (param ValTypes), not arity. Land as: (1)
key `__callable_param_*` candidate selection (`expressions/calls.ts`
~13230–13640) on closure struct typeIdx recovered via `ref.test` chains;
(2) once slice 3's unbox exists, route the externref-widened `const f = …`
read through the dynamic carrier instead of raw externref so the tag is
available. Acceptance: `const f = Number.isInteger; f(4)` → true,
standalone, no trap, no `__get_builtin`.

### B. #2984 buckets (1)+(2) — gOPD on builtins (method-value reification)

Measured verdict in #2984: descriptor SHAPE is fixed; the residual gap is
that `descriptor.value` for a builtin method is a **non-first-class
placeholder** (path-dependent `typeof`, non-invocable, non-canonical).
The substrate answer: a builtin method VALUE is the #2963 Phase-1
singleton closure, carried as a Function-tagged dynamic value. Slices:
(1) descriptor `.value` writes store the singleton (identity `===
Array.prototype.forEach` holds by the singleton property); (2) `.value`
reads produce the dynamic carrier so `typeof` reads the Function tag
(fixes the inline-vs-const instability — same read path everywhere); (3)
invocation `d.value.call(arr, cb)` = the same recovery as slice A +
thisArg threading (slice C). Bucket (2)'s ctor-receiver CE retires when
the `__get_builtin` fallthrough in `property-access.ts` can instead
materialize the singleton value. Do NOT attempt a descriptor-layer-only
fix (re-breeds the placeholder — #2984's explicit warning).

### C. `.call`/`.apply` on a closure VALUE (the #3015/#3016 residual family)

Two known concrete defects, both "function value lost its callable type":

- `identifier.call(...)` handler (`src/codegen/expressions/calls.ts`
  ~L4831): when the receiver identifier is a closure-typed local, the
  lowering DROPS thisArg and mis-dispatches; with the dynamic carrier the
  receiver read keeps the Function tag and `.call` lowers to unbox →
  closure-struct invoke with explicit thisArg prepend.
- property-access `.call` (e.g. `d.get.call(obj)` from a descriptor):
  there is NO closure-value recovery path today — the value arrives as
  opaque externref. Same recovery as slice A; the descriptor read (slice
  B step 2) must produce the tagged carrier first.
- #3015 (`arr.some(cb)` where cb is a dynamic function-typed param):
  prefer its Direction 1 (preserve the closure struct through argument
  evaluation) for the TYPED-param case — no dynamic carrier needed; the
  dynamic carrier is the answer only for genuinely-untyped callbacks
  (post-slice-3 unbox to closure). Don't conflate the two in one PR.

### Sequencing

slice 3 (lowering) → {slice 3b (any unification), A (#2963 P2)} → B/C in
either order (both consume A's recovery helper). Producer widenings (step
6) can proceed in parallel with A–C once slice 3 lands. Each slice: own
PR, own claim-rate/CE-delta measurement, prove-emit-identity for
untouched lanes.
