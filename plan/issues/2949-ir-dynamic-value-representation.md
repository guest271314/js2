---
id: 2949
title: "IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType (make untyped JS claimable)"
status: in-progress
assignee: ttraenkler/opus-2949s4
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

## Implementation Notes — Slice 3 (fable-2949s3, 2026-07-04, branch `issue-2949-slice3-lowering`)

Slice 3 ships the **lowering substrate**: the three staged `"lands in #2949
slice 3"` errors in `lower.ts` are replaced with real arms, driven by a new
`IrDynamicLowering` handle. **Producer-free and byte-inert by construction**
(prove-emit-identity: all 39 (file,target) hashes IDENTICAL vs main
`cf2fb1c40`); the move-only scan, gate 6, and the zero-demotion invariant are
untouched. Decisions and the WHY:

1. **Handle shape** (`backend/handles.ts` `IrDynamicLowering`): the ratified
   §4 record (`carrier`/`anyValueTypeIdx`/`tagFieldIdx`/`payloadFieldIdx`)
   PLUS emit-time op-sequence methods (`emitBox`/`emitUnbox`/`emitTagTest`)
   in the proven `emitStringConcat` resolver-emit style. The emitter-trait
   trio (`emitBox?` on `BackendEmitter`) was NOT promoted — the union arms it
   was declared for still go through `pushRaw`, and rerouting both families
   is #2953's surface; the handle exposes the gc layout so that migration
   can consume it later. FuncIdx values are resolved BY NAME at emit time
   (never captured at handle creation) — the #2191/#2193 repoint discipline.
2. **gc strategy boxes via `boxToAny` itself** (a body-only FunctionContext
   shim), not a re-derived helper choice — ONE kind→tag policy for legacy
   and IR (D4), including the #42 native-string re-tag arm and the
   `honestAnyBoxing` flag, for free. Unbox routes through the CANONICAL
   readers `__any_unbox_f64` / `__any_unbox_i32` (not raw `struct.get`) for
   the number partitions.
3. **V2 numeric-class deviation from the plan sketch (deliberate)**: plan
   step 4 said `tag.test` = `struct.get tag + i32.eq` (exact). But the host
   carrier CANNOT split NumberI32/NumberF64 (`typeof` has one "number") —
   exact gc tests would make producer decision trees mode-divergent (host
   `tag.test(NumberI32)` true for 0.5, gc false). So `tag.test` on EITHER
   number partition is the CLASS test in both strategies (gc:
   `(tag−2) ≤u 1`, host: `__typeof_number`), per js-tag.ts's V2 invariant
   ("consumers must treat {2,3} as a single class"); the payload choice
   lives in the UNBOX tag (F64 → V2-safe f64 read; I32 → trunc-sat).
4. **Box refinement hint**: `box{toType: {kind:"dynamic", tag}}` maps the
   refinement onto `boxToAny`'s `jsType` hint (same "never override
   representation" contract). Load-bearing case: Boolean-refined i32 boxes
   tag-4 (`__any_box_bool` / `__box_boolean`) — without it i32 always boxes
   as a NUMBER (legacy unbranded parity), and `true` would round-trip as
   `1`. Producers that know the partition MUST refine the box target.
5. **R6 hardening = verifier rejection**, not auto-box: `returnTypeAssignable`
   now accepts ONLY dynamic (bare or refined) into a dynamic declared
   result. Auto-boxing in `coerceReturnValue` was rejected because box is a
   PRODUCER decision (the scan must mirror it 1:1 — see note 7) and a silent
   coercion would let scan/builder drift compile. Zero-delta today: the
   move-only scan never produces the flow. Dual direction (dynamic value →
   externref-val declared result) unchanged.
6. **Host `Object` tag.test needs two reads** (`typeof === "object" &&
   !ref.is_null` — host `typeof null === "object"` but Null is its own
   partition), so `emitTagTest` takes a lazy scratch-local allocator;
   `lower.ts` allocates one carrier-typed local per function (`$dyn_tag_
   scratch`, same pattern as the bitwise/vec scratches). gc arms never use
   it. Host `Null` test is `ref.is_null` (JS null IS the null externref;
   undefined is a non-null host value).
7. **Producer widening DESCOPED from this PR — with a load-bearing lattice
   finding**: the planned "mixed return boxes the concrete arm" producer is
   mostly VACUOUS as specced, because `join(unknown, number) = number` in
   propagate.ts — `f(x){ if(c) return x; return 0; }` types its return
   CONCRETE f64 (the optimistic no-evidence join), NOT dynamic. The scan
   correctly rejects that shape today (dyn value into concrete result), and
   the type-honest fix is a **soundness-driven return-WIDENING slice**
   (selector + `resolvePositionType` symmetry: any dyn-shaped return arg ⇒
   return verdict dynamic ⇒ box the concrete arms), not a bolt-on box in
   `coerceReturnValue`. Only the rare lattice-TOP population (union-cap
   overflow params) hits "literal return under dynamic verdict" as written.
   Widening the scan for that sliver risks the zero-claim-then-demote
   invariant (load-bearing under JS2WASM_IR_FIRST) for ~no claim delta, so
   slice 3 lands the substrate only; the widening family (truthiness via
   tag.test+unbox, return-widening + box, concrete-arg→dyn-param box) is
   the follow-up producer slice with its own claim-sweep evidence.
8. **Registration discipline**: `preregisterDynamicSupport` walks the IR
   (deep, `forEachInstrDeep`) BEFORE Phase 3 and registers the full backing
   (fast: `ensureAnyHelpers`; host: `addUnionImports`) so no emit can
   trigger a mid-emission funcIdx shift (#329/#2078 class). Both entry
   points are idempotent.
9. **Known hazards banked for the producer slice** (documented in the
   handle docs too): (a) a wasm-null gc carrier TRAPS in `tag.test`/`unbox`
   `struct.get` — producers must null-guard or normalize at entry
   (coherent with #2106 S1's $undefined singleton, tag 1 — same table,
   suspended, no live interlock: verified `issue-2106` is backlog/resume-
   only, `$undefined` reservation in `ensureAnyValueType` matches
   `JsTag.Undefined = 1`); (b) `unbox(String)` yields the extern-shaped
   payload (externref) in BOTH modes — native-string consumers need a
   convert+cast op that lands with the first string-consuming producer;
   (c) `tag.test(Function)` is mechanical (tag 7) but closures BOX AS
   tag-6 Object today — no producer may emit Function tests until #2963
   Phase 1 reifies function values (host/gc would diverge on them).

## Test Results — Slice 3 (2026-07-04, fable-2949s3)

- `tests/issue-2949-slice3-dynamic-lowering.test.ts` — **16/16 pass**,
  including REAL RUNTIME execution of both strategies (a first for the
  box/unbox/tag.test arms; the union V1 arms were only ever instr-level):
  hand-built IrFunctions lowered against the PRODUCTION `makeDynamicLowering`
  over a real `CodegenContext` (real `ensureAnyHelpers` / `addUnionImports`
  registration), production `emitBinary`, instantiated and executed.
  - gc (fast + js-string config): box→unbox f64 identity (incl. −0, NaN),
    V2 cross-tag reads (i32 box → f64 unbox; f64 box → trunc-sat i32),
    Boolean-refined box → tag-4 proof, numeric-CLASS tag.test from BOTH
    partition tags, negative tags (String/Null on numbers, Number on bools).
  - host: real JS values through dynamic params — String/Object(excl.
    null!)/Null-vs-Undefined/Number/Function classifiers, `__box_number`/
    `__unbox_number` round-trip, Boolean unbox.
  - handle-contract: payload-field table (1/2/3/4 + singleton throws),
    canonical-family routing (D4), V2 class-test equality across partition
    tags, carrier↔resolveDynamic lockstep, host scratch protocol.
  - failure modes: missing/null `resolveDynamicLowering`, jsTag backstops.
  - R6: string→dynamic return REJECTED, box→return clean, dyn/refined-dyn
    moves clean, scalar→dynamic still rejected.
- `tests/issue-2949-ir-dynamic-type.test.ts` 19/19 (one staged-error
  expectation updated to the new missing-resolver contract error),
  `issue-2949-slice2-dynamic-producers` 22/22, `issue-2104-value-tags`,
  `backend-contract` — 62/62 across the four suites.
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline on clean
  main (`cf2fb1c40`), check on branch → **IDENTICAL, all 39 (file,target)
  hashes** across gc/standalone/wasi.
- `pnpm run check:ir-fallbacks` — OK, zero delta, no post-claim entries
  (no selector/producer change, as designed).
- Adjacent IR suites (`tests/ir/`, `ir-frontend-widening`,
  `ir-backend-emitter`, `ir-scaffold`): 164/173; the 9 failures
  (`ir-scaffold` 2, `ir/passes` 4, `ir/inline-small` 3) reproduce with the
  IDENTICAL counts on clean main `cf2fb1c40` run side-by-side — pre-existing,
  unrelated (ir-scaffold's 2 were already recorded in the slice-1/2 notes).
- `npx tsc --noEmit` clean.

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

## Implementation Notes — Slice 3b (fable-2949s3, 2026-07-04, branch `issue-2949-slice3b-any-unification`, stacked on slice 3)

Ships as planned: `resolvePositionType`'s AnyKeyword arm → `irDynamic()`
(codegen/index.ts), the selector's AnyKeyword arms → `"dynamic"`, and the
`"any"` ResolvedKind is DELETED. Findings beyond the plan:

1. **`any[]` element preservation**: the AnyKeyword flip would have made
   `resolvePositionType(any[])`'s element resolution return `dynamic` →
   `null` elemVal → previously-claimed `any[]` functions silently drop to
   legacy. Added an explicit `dynamic → externref` element arm in the
   ArrayTypeNode case (element rep is #2379/#1852 territory, not 3b) —
   byte-preserving, probe-verified. (Separately: the fast-mode any[]
   IR-vs-legacy header divergence — legacy narrows to a different vec
   type + i32 result — is PRE-EXISTING on main, probe-verified
   side-by-side, untouched here.)
2. **The plan's "fast-mode cross-call probe (legacy caller → IR callee)"
   is unconstructible for top-level calls** — pinned in the tests: the
   selector's call-graph-closure rule EVICTS a claimable any-callee when
   a non-claimable function calls it, so mixed legacy→IR top-level edges
   cannot exist. The ABI unification's cross-front-end exposure is the
   export boundary, class-method claims (the typeIdx-parity guard now
   MATCHES legacy in fast mode instead of demoting), and future producer
   widenings. A future call-graph relaxation must revisit the ABI story —
   the pinning test will fire.
3. **Claim-then-demote channel closed**: the old `"any"` kind claimed
   every any-param function unconditionally (from-ast threw on non-move
   uses → post-claim demotion, NOT covered by gate 6 pre-3b since the
   signature carried externref, not dynamic). Now any-annotated functions
   run through `dynamicUsesAreMoveOnly` pre-claim (e.g. `a === b` on any
   params: was claim→demote, now a clean `param-type-not-resolvable`
   rejection) AND gate 6 covers the claims (dynamic signature ⇒
   compile-twice under IR_FIRST).
4. Byte-inert on the 39-hash corpus (no claimed any-functions there);
   the behavior change is confined to any-annotated IR claims — fast-mode
   signatures now equal legacy's (the FIX), host-mode bytes unchanged.

## Test Results — Slice 3b (2026-07-04, fable-2949s3)

- `tests/issue-2949-slice3b-any-dynamic.test.ts` — **8/8**: #1228 surface
  stays claimed; `===`-on-any rejects PRE-claim with the scan's bucket;
  mixed any/unannotated chains claim; host header parity (unchanged) and
  **fast header parity — the FIX** (`func $f` == legacy's, NOT externref);
  call-graph-closure eviction pinned; host-mode runtime identity across
  number/string/null/undefined/bool/object; any[] claim + host header
  parity + fast zero-demotion compile.
- `tests/issue-1228.test.ts` 9/9 UNCHANGED (the `===` fallback test passes
  via the new pre-claim rejection instead of post-claim demotion).
- Slice 1/2/3 suites: 74/74 combined. `check:ir-fallbacks` OK, zero delta.
- `prove-emit-identity` vs main baseline: IDENTICAL (39/39) — corpus has
  no claimed any-functions; drift is confined to the intended population.
- `npx tsc --noEmit` clean.

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

## Implementation Notes — Slice 4: return-widening measured VACUOUS-ADJACENT; do NOT ship in isolation (opus-2949s4, 2026-07-04, branch `issue-2949-s4-return-widening`)

**Verdict: the isolated return-widening producer has a measured claim delta
of ~0 at test262 scale and must NOT be shipped alone.** It is a necessary
CO-REQUISITE of the dynamic-use-in-body producer family (step 6), not an
independent slice. Landing it in isolation would be dead codegen carrying a
load-bearing scan↔builder 1:1-lockstep obligation (drift = a
`JS2WASM_IR_FIRST` skipped-slot hard error) for zero payoff. Evidence,
mechanism, and the corrected next step below.

### What "return-widening" was specced to do (and why it can't fire alone)

Slice-3 note 7 flagged the specced "mixed-return box producer" as vacuous
because `join(unknown, number) = number`. The honest correction was a
return-WIDENING slice: *any dyn-shaped return arg ⇒ widen the return verdict
to `dynamic` ⇒ box the concrete return arms*. The target population is a
function like `f(x){ if(c) return x; return 0; }` (x an unannotated → dynamic
param): one arm moves a dynamic value, another returns a concrete literal, and
the join **collapses** the return to concrete `f64` so the slice-2 move-only
scan rejects `return x` (dyn into concrete result).

**Source-confirmed collapse** (`src/ir/propagate.ts:840-842`): `join` is
`dynamic ∨ x = dynamic` (840), but `unknown ∨ concrete = concrete` (841-842,
the optimistic no-evidence arm). A dyn (=`unknown`) param arm joined with a
concrete co-arm yields the concrete type — the return is NEVER lattice-dynamic
from this mix. And two *distinct concrete* arms join to `union`
(propagate.ts:872), which is #2135's tagged-union rows, not the dynamic
carrier. So a return is lattice-`dynamic` **only** when an arm is already
dynamic (union-cap-overflow params) — the "rare sliver" slice-3 named.

### Measurement (three independent probes, banked in `.tmp/`)

1. **AST shape ceiling** (`widening-ceiling2.mts`, over-approximation — ignores
   body-shape / call-graph gating): across **4452 files** (playground + test262
   stride-12), **5295** functions, **928** with an unannotated param, only
   **8** match the widening shape (≥1 dyn-move return + ≥1 concrete return) —
   0.18% of unannotated-param functions, ~1 per 556 files.

2. **Real-selector on those candidates** (`real-selector-probe.mts`, production
   `planIrCompilation`): EVERY reachable candidate rejects for a reason
   return-widening cannot convert:
   - `nextUp`/`nextDown` (Temporal precision test) → `body-shape-rejected`
     (`nontail-if-cond:PrefixUnaryExpression`; also `new Float64Array`, BigInt,
     element stores) — never reaches the type gate.
   - `handleGet` (Locale getter-order) → `body-shape-rejected`.
   - `callbackfn` (`Array.prototype.reduce` test) → `param-type-not-resolvable`,
     but NOT because of its mixed `return curVal;`/`return false;` — because the
     body USES the dyn params non-trivially (`idx > 0`, `obj[idx] === curVal`,
     `obj[idx-1] === prevVal`): comparison + property access on dynamic values,
     which need the slice-3 unbox producers (`tag.test`+`unbox`), NOT
     return-widening.

3. **Corpus aggregate** (`widening-aggregate.mts`, production selector over a
   test262 stride-40 sample): the intersection {functions rejecting on
   `param-/return-type-not-resolvable`} ∩ {functions with the widening shape}
   is an OVER-count of the true flip set (a member may reject for a body-use
   reason, not the return arm). It read **0** in the sampled prefix (stable
   through 500 files before a probe-perf timeout: claimed=4, type-rejects=11,
   widen-intersect=**0** throughout), consistent with the ~8-per-4452 ceiling
   density. Crucially, even the ~8
   ceiling members corpus-wide (incl. `callbackfn`) are each blocked by a
   NON-return cause per probe 2 — so the *true* return-widening flip set (return
   arm is the SOLE blocker) is **empty** on this corpus, which is the decisive
   number, not the aggregate's sampled 0.

**Honest reading:** this is not the fully-vacuous case (the box producer, which
never fired) — the shape does exist (~8 ceiling). It is *vacuous-adjacent*: the
surviving population after body-shape + move-only gating is empty, because any
function with a dyn param that also mixes returns invariably USES that param in
the body (comparison/arith/property access), and that use is the binding
blocker — exactly the slice-2 finding ("the body-shape/use gate is the binding
constraint, not the type gate") applied to producers.

### Why NOT ship an isolated byte-inert substrate

- To be byte-inert it must claim ZERO functions (else the widened function's
  Wasm signature flips `f64`→dynamic carrier at the export/caller boundary).
  Claiming zero ⇒ the new scan-arm + from-ast box-producer are dead code.
- That dead code still carries the **load-bearing** obligation that the
  selector's widening decision and the from-ast box producer agree 1:1 (a
  claimed-then-demote under `JS2WASM_IR_FIRST` is a skipped-slot hard error;
  the box is a PRODUCER decision per slice-3 note 5 — no silent
  `coerceReturnValue` auto-box). Maintaining that lockstep for no claim is
  pure liability.
- Slice-3 note 7 already prescribed this: the widening family lands WITH its
  use-producer siblings, measured together — not as an isolated sliver.

### Corrected next step (the real lever)

Return-widening is a **co-requisite** of, and must be bundled into, the
**dynamic-use-in-body producer slice** (this issue's step 6): truthiness
`if (x)` and `x ? a : b` via `tag.test`+`unbox`; comparison `x === lit` /
`x > lit` via `tag.test`(+unbox); property access `x.p` / `x[i]` via dynamic
read. Those producers are what the reachable population (`callbackfn` and the
bulk of real untyped-JS bodies) actually needs; a function unblocked by them
that ALSO returns a concrete arm alongside a dyn arm then needs the return box —
so return-widening rides along, measured against the SAME claim sweep, with the
signature-flip exposure validated in one full-CI pass rather than for a
zero-delta sliver. Recommend re-scoping step 6 as one XL producer slice
(architect pass first — it overlaps the `select.ts` move-only scan +
`from-ast` lowering region that #3000-1b's `buildIrClassShapes` work also
touches; coordinate). The isolated "return-widening only" task is closed as
**wont-fix-in-isolation** with this evidence.

---

## Implementation Plan — Slice 5: dynamic-use-in-body producer (architect-ratified, 2026-07-05)

This is the s4-mandated re-scope of step 6 into landable, independently-
verifiable sub-slices. It is the **claim-rate lever** for the whole issue:
s4 PROVED that isolated return-widening is vacuous because the return arm is
never the sole blocker — every reachable candidate is ALSO blocked by a
non-move dynamic body-USE (`callbackfn`: `idx > 0`, `obj[idx]`,
`obj[idx] === curVal`). So the producer that matters is the one that lowers
dynamic VALUE USE in the body, with return-widening bundled in.

### 0. What the current tree already provides (grounding, upstream/main @ read-time)

Before writing any code, note the substrate slices 1–3 already landed — this
slice is mostly **wiring existing pieces**, not building box/unbox from
scratch:

- **The node-level lowering is DONE** (`src/ir/lower.ts` cases `"box"`
  ~L1231, `"unbox"` ~L1288, `"tag.test"` ~L1331). They are real (not staged
  errors), driven by `resolver.resolveDynamicLowering()` →
  `IrDynamicLowering` (`src/ir/backend/handles.ts:197`), backed by
  `$AnyValue` / `__any_box_*` / `__any_unbox_*` (gc) and
  `__box_number` / classifier imports (host). `$dyn_tag_scratch` is already
  allocated per-function in `lower.ts` (~L827).
- **The `IrType.dynamic` lattice + verifier R1–R6** are enforced
  (`src/ir/verify.ts`): dynamic operands may ONLY feed box/unbox/tag.test
  and moves; **R4 forces an explicit `unbox` before any `binary`/`unary`**
  (verify.ts ~L1061); `if.stmt`/loop `condValue` must be i32 (structural
  backstop). The producer therefore MUST unbox/ToBoolean a dynamic operand
  down to a concrete ValType before feeding it to any scalar op or branch —
  the verifier is the hard backstop that makes a producer bug fail loudly.
- **The move-only selector gate** (`src/ir/select.ts`
  `dynamicUsesAreMoveOnly` ~L1178) is the ONLY thing rejecting these bodies:
  `if(x)`/`x===lit`/`x>lit`/`obj[idx]` all pass `isPhase1StatementList`
  (they are ordinary Phase-1 shapes), reach the move-only gate, and fail it
  → bucket `param-type-not-resolvable` (or `return-type-not-resolvable`,
  select.ts ~L925). **That bucket is exactly what this slice drains.**

**What is MISSING (the work of this slice):**
1. `src/ir/builder.ts` has **NO** `emitBox`/`emitUnbox`/`emitTagTest`
   methods (grep: 0 hits) — producers cannot construct the nodes yet.
2. `src/ir/from-ast.ts` has no dynamic arm in `lowerBinary` (~L5218),
   `lowerElementAccess` (~L2579), `lowerPropertyAccess` (~L2200),
   `lowerConditional` (~L4993), nor in the `if`/`while`/`for`/`do` condition
   paths (~L945, `coerceLoopCondToBool` ~L4028).
3. `IrDynamicLowering` exposes `emitBox`/`emitUnbox`/`emitTagTest` but **not**
   the higher-level carrier ops the body-uses actually need (see §1).
4. `select.ts` `dynamicUsesAreMoveOnly` rejects every body-use.

### 1. Architectural correction to the s4/step-6 framing: route through the CANONICAL carrier helpers, not hand-rolled tag.test chains

s4 wrote the forms "via `tag.test`+`unbox`". That is the RIGHT primitive for
a **known-literal fast path**, but it is NOT the D4-compliant lowering for the
general case, and the general helpers ALREADY EXIST in the codegen layer:

- **Truthiness** `ToBoolean(dyn) → i32`: `emitToBoolean` in
  `src/codegen/coercion-engine.ts:383`. For the boxed-any carrier it emits
  `__any_unbox_bool` (gc `ref null $AnyValue`) / `__is_truthy` (host
  externref) — proper JS truthiness (`0`/`NaN`/`""`/`null`/`undefined` →
  falsy), one call, both modes.
- **Strict/loose equality** `dyn === x → i32`: `__any_strict_eq` /
  `__any_eq` (coercion-engine `emitAnyEqOperands` + `emitStrictEq`/
  `emitLooseEq`, ~L440+), which take two carrier operands. `dyn === lit` =
  box the literal to the carrier (box lowering already exists) + call the
  helper. `dyn === dyn` = both already carriers.
- **Relational** `dyn > lit → i32`: `emitToNumber` (coercion-engine) on the
  dyn side → `f64.gt` (the numeric-abstract-relational common case), with
  the string×string arm deferred (see S5.3 scope).
- **Property access** `dyn[i]` / `dyn.p`: the dynamic member-read MOP. This
  is the ONE form with no clean single-helper carrier op today — it is the
  `$Object` dynamic-reader substrate (memory
  `project_standalone_any_string_value_read_substrate`). Treat it as the
  heavy, substrate-adjacent sub-slice (S5.4).

**Decision:** add these as new methods on `IrDynamicLowering`
(`emitToBoolean(): Instr[]`, `emitStrictEq(negate): Instr[]`,
`emitToNumber(): Instr[]`, and — S5.4 — `emitMemberGet(...)`), each produced
by `integration.ts`'s `makeDynamicLowering` by routing to the SAME
coercion-engine functions legacy uses (pass the body-only `FunctionContext`
shim already used for `boxToAny` in slice 3, per that slice's note 2). This
keeps ONE ToBoolean/equality/ToNumber engine (D4) and guarantees IR-claimed
and legacy functions agree byte-for-byte on these coercions. `tag.test`+`unbox`
remains available and is the right lowering only when a producer statically
knows the literal's partition AND wants to skip the general dispatch — NOT the
default; do not hand-roll it in from-ast for the general arms.

### 2. The conjunction problem — why sub-slices split mechanism-from-producer

s4's reachable exemplar (`callbackfn`) needs truthiness-adjacent + relational
+ property-access + dyn×dyn-eq **simultaneously**; a function claims only when
EVERY dynamic body-use is handled. Therefore a per-form *producer* (scan-arm
flip) will measure a claim delta of ~0 until the last form its reachable
population needs also lands — the exact vacuity trap s4 hit. To stay landable
without shipping dead lockstep-bearing code, decompose along the
**mechanism / producer** seam, mirroring how slices 1–3 already split
(lowering landed byte-inert; producers landed separately):

- **Mechanism sub-slices (S5.0–S5.4): byte-inert, unit-proven, no scan
  change.** Each adds the handle method + builder emit + from-ast lowering
  arm for one form, but leaves `dynamicUsesAreMoveOnly` REJECTING it. So
  from-ast never sees the form in a claimed function yet → **zero compiled
  output changes** → self-proof is `prove-emit-identity.mjs` IDENTICAL (39
  hashes) PLUS slice-3-style unit tests that hand-build the IR and EXECUTE
  it against the production lowering. No claim, so no `JS2WASM_IR_FIRST`
  lockstep liability (the s4 hazard is specifically a *claiming* producer
  with dead scan lockstep — a lowering-only slice has none).
- **Producer sub-slice (S5.P): flips the scan arms for the landed forms
  together + bundles return-widening + boxes concrete arms.** This is the
  ONLY slice that changes claims, gated on a reachability probe (§4), and it
  carries the real claim-rate measurement and full CI. It may split into
  ≥1 producer PR IF the reachability probe (§4) finds a non-empty
  single-form flip set; default is one bundling producer.

This ordering means the hard, reviewable lowering lands first (small, green,
byte-inert PRs), and the risky claim-flip lands last as one measured,
full-CI PR — the inverse of shipping a byte-inert producer that claims 0.

### 3. Sub-slice sequence

Each mechanism slice: own PR; branch from `upstream/main`; `emitBox`-family
plumbing (S5.0) is the shared dependency, land it first. Collision surface is
`from-ast.ts` + `handles.ts` + `integration.ts` + `builder.ts` (additive arms
only) for S5.0–S5.4, and `select.ts` `dynamicUsesAreMoveOnly` for S5.P — the
same region #3000-1b/C/E (merged) and slices 2/3 touched, so land the
mechanism PRs first and rebase S5.P onto them.

#### S5.0 — builder emit plumbing (foundation, byte-inert)

- **Files/functions:** `src/ir/builder.ts` — add `emitBox(value, toType)`,
  `emitUnbox(value, jsTag)`, `emitTagTest(value, jsTag)` (append the
  respective `IrInstrBox`/`IrInstrUnbox`/`IrInstrTagTest`; result type:
  box→`toType`, unbox→`irVal` of the partition payload ValType via
  `jsTagUnboxKind`, tag.test→`irVal i32`). `typeOf` already covers them.
- **Lowering change:** none (nodes already lower).
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity.mjs` IDENTICAL (39/39); a unit test
  builds a box→tag.test→unbox round-trip and executes it (gc + host), proving
  the builder emits verifier-clean nodes that lower and run. `tsc` clean.
- **Anti-vacuity:** N/A (pure plumbing; its consumers are S5.1–S5.4).

#### S5.1 — truthiness lowering (mechanism, byte-inert)

- **Files/functions:** `handles.ts` `IrDynamicLowering` + `integration.ts`
  `makeDynamicLowering`: add `emitToBoolean(): Instr[]` routing to
  `coercion-engine.emitToBoolean` for the carrier (`__any_unbox_bool` gc /
  `__is_truthy` host). `builder.ts`: `emitDynTruthy(value): IrValueId`
  (i32 result) emitting a new `IrInstrDynTruthy` (or reuse `unbox{Boolean}`
  only if the operand is Boolean-refined — but general truthiness is NOT
  Boolean-unbox, it is ToBoolean, so a dedicated node/handle op is required;
  add `IrInstrDynTruthy{value}` → i32, lowered via the new handle method).
  `from-ast.ts`: in the `if` (~L945), `while`/`for`/`do` condition paths and
  `coerceLoopCondToBool` (~L4028) and `lowerConditional` (~L4993) condition,
  when `typeOf(cond).kind === "dynamic"`, emit `emitDynTruthy` instead of the
  current "must be i32" throw.
- **Scan-arm change:** none (scan still rejects a dyn condition; from-ast arm
  is exercised only by unit tests until S5.P).
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit test executes
  `function f(x){ if(x) return 1; return 0; }`-shaped hand-built IR over gc +
  host and asserts JS truthiness for `0/NaN/""/null/undefined/{}/"a"/5`.
- **Anti-vacuity:** deferred to S5.P; this slice claims nothing by design.

#### S5.2 — strict/loose equality lowering (mechanism, byte-inert)

- **Files/functions:** `handles.ts`/`integration.ts`: `emitStrictEq(negate):
  Instr[]` and `emitLooseEq(negate)` routing to `coercion-engine`'s
  `__any_strict_eq`/`__any_eq` (both operands carrier-shaped). `builder.ts`:
  `emitDynEq(lhs, rhs, {negate, loose})` → i32. `from-ast.ts` `lowerBinary`
  (~L5218): for `===`/`!==`/`==`/`!=` when either operand is dynamic — box
  the concrete operand to the carrier (existing `emitBox{toType:dynamic}`,
  refining the box tag from the literal's kind where known), leave dyn
  operands as-is, emit `emitDynEq`. `dyn === null` / `dyn === undefined`
  lower via `tag.test{Null|Undefined}` (the payload-less partitions —
  cheaper and exact) rather than the general helper.
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit tests execute
  `dyn === 5`, `dyn === "s"`, `dyn === null`, `dyn === undefined`,
  `dyn === true`, and `dyn === dyn` over gc + host, asserting SameValue/`===`
  semantics incl. cross-type falsity (`"5" === 5` → false).
- **Anti-vacuity:** deferred to S5.P.

#### S5.3 — relational lowering (mechanism, byte-inert)

- **Scope:** numeric-abstract-relational only (`dyn </<=/>/>= lit|dyn` via
  `ToNumber` → `f64` compare). The string×string relational arm is DEFERRED
  (needs the native-string compare path; a dyn operand whose runtime tag is
  String falls back through ToNumber = NaN, i.e. all-false — spec-correct for
  `"a" > 0` but WRONG for `"b" > "a"`; so restrict producer admission in
  S5.P to relational against a NUMERIC literal, where ToNumber(dyn) vs number
  is spec-complete, and reject dyn-string-relational to keep correctness).
- **Files/functions:** `handles.ts`/`integration.ts`: `emitToNumber():
  Instr[]` routing to `coercion-engine.emitToNumber` (carrier → f64).
  `builder.ts`: `emitDynToNumber(value)` → f64. `from-ast.ts` `lowerBinary`
  relational arm: `emitDynToNumber` on dyn operand(s), then the existing
  `f64.lt`/`gt`/… path.
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit tests execute
  `dyn > 0`, `dyn <= 10` for number/bool/null (→0)/undefined(→NaN→false)
  carriers over gc + host.
- **Anti-vacuity:** deferred to S5.P.

#### S5.4 — dynamic member read (mechanism, byte-inert, substrate-adjacent — HEAVIEST)

- **Scope + risk:** `dyn[i]` / `dyn.p` is the general MOP on an arbitrary any
  value — the `$Object` dynamic-reader substrate. This is where the reachable
  population's real weight sits (`obj[idx]`), and it is the sub-slice most
  likely to need its own architect pass / to be split further. Route through
  the SAME legacy any-member helper the codegen layer uses (identify the
  concrete import in `src/codegen/property-access.ts` / `object-ops.ts`; if
  none is cleanly reusable, this sub-slice is BLOCKED on a substrate helper
  and must be filed as a dependency, NOT hand-rolled — see the substrate
  memory notes). Element index that is itself dynamic (`obj[idx]` with `idx`
  dynamic) needs `ToPropertyKey(dyn)` first — bundle or defer per the helper's
  signature.
- **Files/functions:** `handles.ts`/`integration.ts`: `emitMemberGet(name?)`
  / `emitElementGet()` routing to the legacy any-member reader. `builder.ts`:
  `emitDynMemberGet(recv, key)` → dynamic. `from-ast.ts` `lowerPropertyAccess`
  (~L2200) / `lowerElementAccess` (~L2579): dynamic-receiver arm.
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit tests execute
  `dyn.length`, `dyn[0]`, `dyn["k"]` over host (gc where the substrate reader
  exists) asserting value + tag preservation (the substrate's known
  drop-native-string-value hazard MUST be covered — reference
  `project_standalone_any_string_value_read_substrate`).
- **Anti-vacuity:** deferred to S5.P; if BLOCKED on substrate, S5.P proceeds
  WITHOUT property-access and its reachability probe (§4) must be re-run
  excluding property-access-bearing candidates.

#### S5.P — the producer + return-widening (the ONLY claim-flipping slice)

- **Files/functions:** `src/ir/select.ts` `dynamicUsesAreMoveOnly` (~L1178) —
  relax `scanExpr`/`scanStmt` arms 1:1 with the from-ast arms that landed in
  S5.1–S5.4:
  - **truthiness:** `scanStmt` `isIfStatement`/`isWhileStatement`/for/do —
    the condition may now be dyn-shaped (currently `scanExpr(cond, false)`
    rejects it); add an `allowDynCondition` path that accepts a bare dyn name
    / dyn-returning call in condition position (lowers via S5.1).
  - **equality:** `scanExpr` `isBinaryExpression` `===/!==/==/!=` — accept a
    dyn operand on either side (currently `if (expectDyn) return false; …`
    rejects), matching S5.2. Result is concrete i32, so `expectDyn` stays
    false for the enclosing context.
  - **relational (numeric-literal only):** `</<=/>/>= ` accept a dyn operand
    IFF the other operand is a numeric literal/concrete f64 (S5.3 scope
    guard — reject dyn×dyn-string-relational).
  - **property access:** `isPropertyAccessExpression`/`isElementAccess` —
    accept a dyn receiver; the RESULT is dynamic (a member read of any is
    any), so the access can itself be a dyn move (feeds return / another
    dyn-accepting position). Only if S5.4 landed unblocked.
  - **return-widening (co-requisite, s4):** in the claim gate (select.ts
    ~L768/L925) widen the return verdict to `dynamic` when ANY return arg is
    dyn-shaped even if a co-arm is concrete; and in `from-ast` return
    lowering box the concrete arms via `emitBox{toType:dynamic}` (R6 already
    rejects un-boxed non-dynamic→dynamic returns, so the box is mandatory and
    the verifier enforces the lockstep). This is where s4's return-widening
    finally has a non-empty population (rides on the body-use unblock).
- **Lowering change:** none new — S5.1–S5.4 already landed the arms; S5.P only
  opens the scan + adds the return-box producer arm.
- **Acceptance measurement (REAL claim delta — s4 discipline):**
  1. Run the production claim sweep (`.tmp/claim-sweep.mts` pattern, STRIDE
     ~40–200, 287+ file corpus = 13 playground + `examples/` + test262
     stride sample) on `upstream/main` baseline and on the S5.P branch;
     record the table (files OK / claim denominator / **claimed** /
     `param-type-not-resolvable` / `return-type-not-resolvable` /
     `body-shape-rejected` / **post-claim demotions**) exactly as the
     slice-2 measurement table in this file.
  2. **PASS criteria:** `claimed` strictly increases; `param-/return-
     type-not-resolvable` drops by the claim increase and does NOT reappear
     as `body-shape-rejected` (that reappearance was s4's slice-2 signature
     of a vacuous type-gate move — here the body IS handled, so it must not
     recur); `post-claim demotions == 0` (the `JS2WASM_IR_FIRST` skipped-slot
     invariant — load-bearing).
  3. Full CI + `ir_first` test262 lane (#2947); expect small IMPROVEMENTS
     from pass-through/harness-shaped bodies (slice-2 note documented the
     live legacy miscompile the IR path fixes), zero regressions.
  4. Lift `computeIrFirstSkipSet` gate 6 (`codegen/index.ts`) only AFTER the
     `ir_first` lane shows zero dynamic-claim build demotions (per slice-3
     plan step 7).
- **check:ir-fallbacks bucket that drops:** `param-type-not-resolvable` and
  `return-type-not-resolvable` (refresh baseline with `--update-on-decrease`).

### 4. Anti-vacuity gate — MANDATORY before building S5.P (and before splitting it per-form)

s4's lesson: measure the REAL flip set, do not ship a producer that claims 0.
BEFORE writing the S5.P scan-arm flips, run TWO probes (bank in `.tmp/`,
reuse s4's `widening-ceiling2.mts` / `real-selector-probe.mts` /
`widening-aggregate.mts` patterns):

1. **Ceiling probe (AST over-approximation):** across the 4452-file corpus,
   count functions with ≥1 unannotated (→dynamic) param whose ONLY
   non-Phase-1-or-move constructs are the forms landed in S5.1–S5.4. This is
   the upper bound on the flip set.
2. **Real-selector reachability probe:** run production `planIrCompilation`
   over those candidates; the TRUE flip set = candidates that reject TODAY on
   `param-/return-type-not-resolvable` AND whose every dynamic body-use is now
   covered by the landed forms (i.e. would pass the relaxed scan). s4's
   decisive number was that the return-arm-sole-blocker set was EMPTY — the
   analogous decisive number here is: **is the covered-body flip set
   non-empty?**

**Gate:** build S5.P (or a per-form producer split) ONLY for a form/combination
whose real-selector flip set is non-empty. If the probe shows the reachable
population needs property-access (S5.4) and that is substrate-blocked, S5.P
ships WITHOUT property-access and the probe is re-run on the reduced form set;
if THAT flip set is also empty, S5.P is deferred (documented, like s4) rather
than shipped byte-inert. The mechanism slices S5.0–S5.4 remain valuable
regardless (they are the substrate the producer and the #2963/#2984/#3015
adoption slices in "Banked adoption slices" all consume) — only the
scan-flip is gated.

### 5. Honest sizing verdict (is the lever smaller/bigger than framed?)

- **Smaller than "build box/unbox producers":** the node lowering, the
  carrier helpers (`emitToBoolean`/`__any_strict_eq`/`emitToNumber`), the
  verifier, the handle, and the scratch local ALL already exist. S5.0–S5.3
  are thin wiring PRs.
- **Bigger/harder than "flip the scan for three forms":** (a) the reachable
  population needs a CONJUNCTION of forms, so no single-form producer is
  claim-productive — the claim delta is back-loaded onto S5.P; (b) S5.4
  (dynamic member read) is a substrate-scale problem (`$Object` dynamic
  reader) that may block, and it is the form the reachable population most
  needs; (c) relational correctness forces a numeric-literal-only restriction
  (string relational deferred). **Net:** the mechanism is turnkey and safe to
  land incrementally; the CLAIM payoff is real but concentrated in S5.P and
  contingent on S5.4 — so the honest expectation is a modest test262 claim-
  rate delta at first, growing only as S5.4's substrate and the #1370/#2855
  shape surface widen. Do not promise a large delta from S5.1–S5.3 alone; the
  probe in §4 sets the expectation before the code is written.
