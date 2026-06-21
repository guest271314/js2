---
id: 2202
title: "arguments.length wrong for trailing-comma + spread call args in generator / class-method bodies (~30 test262 fails)"
status: done
assignee: sd-1
sprint: 64
created: 2026-06-19
updated: 2026-06-21
completed: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: spec-completeness
related: [1726, 2079]
test262_bucket: arguments-trailing-comma-spread
test262_count: 30
es_edition: es2017
origin: "2026-06-19 sprint-64 standalone failure mining: language/arguments-object/*gen-meth*-args-trailing-comma-spread* fail `arguments.length`. Distinct from #1726 (mapped-arguments representation) — this is arg-count miscounting for spread+trailing-comma specifically in generator/class-method call sites."
---

# #2202 — `arguments.length` wrong for trailing-comma + spread in generator / class-method bodies

## Problem

A call argument list with **spread + a trailing comma** — `f(...args,)` — must
produce the same `arguments.length` as `f(...args)` (the trailing comma is pure
grammar; §13.3.8 ArgumentListEvaluation ignores it). The compiler computes the
wrong `arguments.length` for this form **specifically inside generator methods /
class generator methods** (the call site is a `gen-meth` / `cls-*-gen-meth`
body), where the arguments object and the spread-expansion counting interact
with the generator-body lowering.

`#1726` already fixed the plain trailing-comma and `arguments.length` clusters
and owns the **mapped-arguments exotic-object representation** (§10.4.4
descriptors). This issue is a **distinct, narrower bug**: the spread +
trailing-comma argument *count* in generator/method contexts, not the
descriptor/mapped representation. Confirm against #1726 to avoid overlap; if the
fix turns out to live in the shared arguments-materialization path, coordinate.

## Spec

- §13.3.8 ArgumentListEvaluation (trailing comma / spread):
  https://tc39.es/ecma262/#sec-argument-lists-runtime-semantics-argumentlistevaluation
- §10.4.4 Arguments Exotic Objects:
  https://tc39.es/ecma262/#sec-arguments-exotic-objects

## Minimal repro

```js
// A generator method whose body reads arguments.length, called with
// spread + trailing comma. Expected arguments.length === args.length.
var log;
var obj = {
  *m() {
    log = arguments.length;   // must equal 3 for the call below
    yield;
  }
};
var args = [1, 2, 3];
obj.m(...args,).next();        // spread of 3 + trailing comma ⇒ length 3
// assert log === 3
```

Compare against the non-generator form (which passes today):

```js
var obj2 = { m() { return arguments.length; } };
obj2.m(...[1,2,3],);   // === 3  (works)
```

## Failing test262 cluster

`test/language/arguments-object/*` where the body is a generator/class generator
method and the call uses trailing-comma + spread — **~30** fails. Assertion:
`assert.sameValue(arguments.length, N)`. Representative files:

- `language/arguments-object/gen-meth-args-trailing-comma-spread-operator.js`
- `language/arguments-object/cls-expr-gen-meth-args-trailing-comma-spread-operator.js`
- `language/arguments-object/cls-decl-gen-meth-static-args-trailing-comma-spread-operator.js`
- `language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-spread-operator.js`
  (async-gen variants are deferred if they need the async-gen state machine —
  scope to sync generators first; carry async-gen variants as a follow-on note.)

## Approach (sketch — dev to confirm against codegen)

Trace how `arguments.length` is materialized for a generator-method body and how
a spread call argument with a trailing comma is counted at the call site. The
trailing comma should add **zero** to the count; the suspicion is an off-by-one
(trailing comma counted as an extra slot) or a spread-length-vs-fixed-arg
miscount that only surfaces in the generator-body arguments path. Fix the count;
do not touch the mapped-arguments descriptor representation (that is #1726).

## Acceptance criteria

- [ ] Repro: generator method reads `arguments.length === 3` for
      `obj.m(...[1,2,3],).next()`.
- [ ] Sync-generator + sync class-generator-method trailing-comma+spread tests
      flip to pass (`>= 20` of the ~30 sync variants).
- [ ] No regression in non-generator `arguments.length` / spread-call counting,
      and no regression in #1726's mapped-arguments tests.
- [ ] A focused `tests/issue-2202-*.test.ts` covering object-literal generator
      method, class generator method, and static class generator method.

## Implementation Plan (architect spec — 2026-06-21)

> **Rating correction.** Filed as `feasibility: medium` ("off-by-one trailing
> comma"). That hypothesis is **wrong** — see Root Cause. The real defect is a
> call-dispatch operand-stack desync in the shared `__argc` / `__extras_argv`
> protocol, with **invalid-wasm** (not just a miscount) in the mixed
> fixed+spread form. Re-rated **hard / reasoning_effort high**. A dev attempt
> (2026-06-19/21) built partial WIP and correctly escalated to senior-dev.
> Touches the broad spread-call path (#1726, #2079) → high regression surface.

### Root cause (confirmed by code reading)

The real failing cluster is **mixed args**: `obj.method(42, ...[1], ...arr,)`
(fixed positional + inline-literal spread + variable spread + trailing comma)
where the callee body reads `arguments`. **9 sync test262 files: 5
`compile_error` (INVALID WASM at instantiate — `call[0] expected type
(ref null 15), found struct.new of type (ref 20)`) + 4 `fail`
(`arguments.length` returns 2, expected 4).**

The `arguments`-extras vector and the call's positional argument list are built
from **two independent compilations of the same argument expressions,
interleaved on one operand stack**:

1. **Call site** (`src/codegen/expressions/calls.ts`, every dispatch path —
   static-method `~7931`, non-generic `~7271`, generator `~8066`, instance
   method `~8128`, static-method-on-instance `~8212`, non-null method `~8270`,
   and the `compileArgsAndExtras` helper `~1785`): it first compiles the
   positional/implicit call args onto the operand stack
   (`for … compileExpression(args[i])`, e.g. `calls.ts:7931-7933`), **then**, if
   `args.length > paramCount && calleeReadsArgs*`, calls
   `emitSetExtrasArgv(ctx, fctx, args, paramCount)` (`calls.ts:7936`), **then**
   emits the `call`.
2. **`emitSetExtrasArgv`** (`src/codegen/statements/nested-declarations.ts:1355`)
   **re-compiles each spread source** at line **1454**
   (`compileExpression(ctx, fctx, arg.expression)`) to build a runtime-length
   extras vec (the `hasSpread` branch, 1404-1690: per-arg `Slot`s — `single` /
   `vec` / `spread` — summed into `__xa_total`, allocated, filled, `struct.new`
   → `__extras_argv` global).

Because `emitSetExtrasArgv` runs **while the call's already-compiled
positional/implicit operands sit on the stack**, and it itself pushes/pops
during the spread re-compile + vec build, the two interleave. In a
generator/class-method callee the compiled signature is **not** 0-param even for
a JS-syntactic `*m()` — it carries implicit leading params (closure-env / `this`
/ generator-state, the `(ref null 15)` in the error). The extras-vec
`struct.new` (`(ref 20)`) lands where that implicit `call[0]` operand is
expected → invalid wasm. The 4 `fail` files are the same desync in a shape that
happens to validate but mis-counts (`arguments.length` 2 vs 4: the static
AST-node split counts a spread node as one slot instead of its runtime arity).

Note the existing `hasSpread` branch (1404-1690) *already* tries to count spread
runtime arity (and #2079's inline-tuple handling at 1468-1488 is present) — so
the **count logic exists**; the defect is **sequencing / stack-neutrality**, not
counting per se. `emitSetExtrasArgv` is not reliably stack-neutral relative to
the operands the caller left on the stack when a spread is re-compiled.

### Prior WIP (branch `issue-2202-arguments-length-generator`, commit `434eb233a`)

Adds `emitSetExtrasArgvWithSpread` in `nested-declarations.ts` (~249 lines),
delegated from `emitSetExtrasArgv` for the `startIdx==0 + spread` shape,
**scope-gated to `paramCount==0`**. It fixes the simple variable-spread 0-param
case (`obj.m(...a)`) but NOT the mixed/inline-literal form. The gate to
`paramCount==0` is the right instinct (the named cluster is all 0-JS-param
methods → every arg is an "extra", `startIdx==0`), but the helper still
re-compiles inside the dispatch window. **Recommendation: do not extend the
additive helper — replace the strategy with capture-once (below).** Salvage its
runtime length/box/fill loop, discard the "second builder" framing.

### Design — "compile each argument exactly once, then build both consumers"

The fix is structural: **never compile an argument expression twice, and never
build the extras vec while call operands are live on the stack.** Introduce a
single pre-pass that evaluates the argument list once into typed locals, then
derive both the `__extras_argv` vector and the call's positional operands from
those locals.

For a dispatch where `calleeReadsArgs* && (anySpread(args) || args.length >
paramCount)`:

1. **Evaluate-once pre-pass (before pushing ANY call operand).** Walk `args` in
   source order (preserving §13.3.8 left-to-right evaluation-order side
   effects). For each:
   - non-spread → `compileExpression`, box/coerce to externref per
     `coerceTopToExternref`, `local.set` a fresh externref local; record a
     `single` slot (runtime length 1).
   - spread → compile the source **once** with its natural type; classify as
     inline-tuple (`_0.._n` struct, #2079 path 1468-1488), typed WasmGC vec
     (read field-0 length + field-1 array, 1489-1519), or opaque host iterable
     (`__array_from_iter` + `__extern_length`/`__extern_get_idx`, 1521-1547);
     `local.set` the source + a runtime `lenLocal`. This is exactly the existing
     `Slot` machinery — reuse it verbatim.
   The pre-pass is **stack-neutral**: everything lands in locals, nothing is left
   on the operand stack.
2. **Build `__extras_argv` from the locals** (runtime length = Σ slot lengths),
   `struct.new` the vec, `global.set __extras_argv`, set `__argc` = runtime
   total. Stack-neutral (the existing fill loop, but reading from the pre-pass
   locals instead of re-compiling).
3. **Push the call's positional operands from the SAME locals**, then emit the
   `call`. For the named cluster (`paramCount==0`) this pushes only the
   callee's implicit params (closure/this/state) — zero JS operands — so step 3
   is a no-op for JS args and the desync is gone by construction.

This kills the double-compile (correctness + no duplicated side effects), makes
the extras build provably stack-neutral (fixes the invalid wasm), and yields the
runtime count (fixes `arguments.length`).

### Staging (de-risks the high blast radius)

- **Stage 1 — the named cluster + invalid-wasm (do first, lands the issue).**
  Scope to `startIdx == paramCount` AND **all spreads/extras are in the extras
  region** (true for every named file: 0-JS-param generator/class methods, so
  `paramCount==0`, every arg is an extra). Implement the evaluate-once pre-pass
  inside `emitSetExtrasArgv` so it captures-once and is stack-neutral; since
  there are no JS positional operands on the stack in this shape, step 3 is
  empty. This clears all 9 named files (5 invalid→valid, 4 count) with the
  smallest surface. **Acceptance gate for Stage 1 = the 9 files + zero
  regression in the non-spread / non-generator extras path.**
- **Stage 2 — spread *within* the first `paramCount` positions (separable,
  deferrable).** `f(...[1,2], 3)` with `paramCount==2` needs param0/param1 drawn
  from the runtime-expanded spread, not the static AST split — the positional
  push (step 3) must index the captured expansion. Higher risk, **not required
  by the named cluster**; carry as a follow-on note / separate issue unless a
  regression sweep shows existing spread-in-params calls already depend on it.
- **Async-generator variants**: deferred per the issue (need the async-gen
  state machine); sync generators + sync class/static generator methods only.

### Regression surface + mitigation (this is why it's hard)

`emitSetExtrasArgv` is shared by **every** call path that materializes
`arguments` beyond formals: free functions (`calls.ts` non-generic ~7271),
static methods (~7936), instance methods (~8129/8271), static-on-instance
(~8213), the generic non-generator path (~8067), the `compileArgsAndExtras`
helper (~1785), inlined array-methods (`array-methods.ts:5805+`), class
constructors / `super()` (`class-bodies.ts:925`, declarations `declarations.ts:3088`),
and object-literal methods (`literals.ts:2366`). It runs in **both** host and
standalone (the `noJsHost` branch at 1406 picks vec-direct vs
`__array_from_iter`). Mitigation:
- Keep the **non-spread** path (the `array.new_fixed` static branch, post-1690)
  **byte-identical** — gate the new capture-once path on `hasSpread` only, so
  the overwhelmingly common no-spread `arguments` calls are untouched.
- Preserve §13.3.8 **evaluation order**: the pre-pass must compile args in the
  exact source order the current interleaved path does (verify side-effect
  ordering against a `f(sideEffect1(), ...sideEffect2(), sideEffect3())` probe).
- **Late-import shift hazard** (this file's own recent bug family — #2567 /
  #2564 / #2158 / #1109): the pre-pass compiles spread sources that may register
  late imports (`__array_from_iter`, `__box_number`, `__extern_*`) mid-build.
  Any detached/temporary instruction buffer used while building must be
  registered in `ctx.liveBodies` (and dropped after splice) so a func-index
  shift reaches the in-flight `call`/`struct.new`. The current code already
  calls `flushLateImportShifts(ctx, fctx)` at 1416 — keep that discipline and
  re-audit it for the new buffer.
- Watch the standalone floor (#2097, merge_group-only gate): the
  `noJsHost`/`externIndexingOk` branch must keep emitting valid wasm with no new
  host imports — verify a standalone compile of the repro.

### Concrete change set

- **`src/codegen/statements/nested-declarations.ts`** — rework
  `emitSetExtrasArgv` (1355-1690): hoist the spread-source compilation into a
  stack-neutral evaluate-once pre-pass (locals only), then build the vec from
  locals. Fold/replace the WIP `emitSetExtrasArgvWithSpread`. ~the existing
  `Slot`/box/fill code, re-sequenced.
- **`src/codegen/expressions/calls.ts`** — no behavioral change for Stage 1 if
  `emitSetExtrasArgv` becomes self-contained-stack-neutral; audit each dispatch
  site (7271/7936/8067/8129/8213/8271, helper 1785) to confirm none relies on
  the old interleaving (e.g. a positional operand left on the stack that the old
  emitSetExtrasArgv "consumed" — it must not).
- **`tests/issue-2202-*.test.ts`** — object-literal `*m()`, class
  `*m()`, static `*m()`, each called `(...[1,2,3],)` asserting
  `arguments.length===3`; plus a **mixed** `f(42, ...[1], ...arr,)` valid-wasm +
  count case; plus an **evaluation-order** probe; plus a **no-spread regression
  guard** (`f(1,2,3,4)` with `function f(a){return arguments.length}` → 4).

### Test / validation plan

1. The 9 named sync files → 5 invalid→PASS, 4 fail→PASS.
2. Broad sweeps, **0 regressions**: `test/language/arguments-object/**`,
   `test/language/expressions/**spread**`, `test/language/**/generators/**`,
   and the #1726 mapped-arguments tests.
3. `node scripts/check-test262-hard-errors.mjs` — 0 new hard errors.
4. Standalone compile of the repro (no new host imports; valid wasm).
5. `tsc` + `biome` + `prettier` clean.

### Effort / risk

**~1–2 days senior-dev.** Medium-high implementation difficulty, **high
regression risk** (shared protocol, both backends, 7+ call sites). Stage 1 is
the bounded, issue-closing slice; Stage 2 is optional/separable. Recommend the
implementing senior dev confirm the exact `(ref 15)`/`(ref 20)` operands by
instrumenting one failing file (`gen-meth-args-trailing-comma-spread-operator.js`)
before refactoring, and land Stage 1 alone first.

## Implementation notes (sd-1, 2026-06-21) — what actually landed

**The architect spec was written against a pre-`0145c98ad` main.** By the time
I started, the *named* generator/class-method cluster (`gen-meth`,
`cls-*-gen-meth`, `cls-*-meth`, private variants — the files the issue lists)
was **already passing** in BOTH host and standalone: commit
`0145c98ad fix(#2202): correct arguments.length + values for spread call args`
had already made `emitSetExtrasArgv` spread-aware (runtime-length extras vec,
per-arg `Slot`s — this is the "capture-once" machinery the spec describes, and
it was already there). I re-ran the full 34-file `*trailing-comma-spread*`
cluster through `runTest262File` (host + standalone, one file at a time) and
the entire method cluster was green. The `(ref 15)/(ref 20)` invalid-wasm the
spec predicted for the method paths does **not** reproduce on current main.

**The real remaining SYNC defect was a different dispatch path** — the
**direct free-function / lifted-nested-function** spread call. A call like
`ref(42, ...[1], ...arr,)` where `ref` is a `function`/`function*` declaration
(in the test262 wrapper these are hoisted *inside* `export function test()`, so
they are *lifted nested* functions with capture/env params) reading
`arguments`. That path (`compileCallExpression` in
`src/codegen/expressions/calls.ts`) routed any spread call through
`compileSpreadCallArgs` (extern.ts:450), which only fills **positional param
slots**. For a 0-user-param callee that reads `arguments`, it fills *no* slots,
**never sets `__argc`/`__extras_argv`**, and leaves a stray positional operand
(`f64.const 42`) on the stack → the callee saw `arguments.length === 0` and the
mismatched stack trapped as `dereferencing a null pointer`. Distinct from the
method paths, which already route extras through `emitSetExtrasArgv` +
`maybeSetArgcForKnownCall`.

**Fix (Stage 1, surgical):** in the direct-call dispatch, *before* the generic
`hasSpreadArg` branch, detect the named-cluster shape —
`hasSpreadArg && calleeReadsArguments && !restInfo && !hasLinearParams &&
userParamCount <= 0` — and route the whole arg list through
`emitSetExtrasArgv(args, 0)` + `maybeSetArgcForKnownCall(funcName, 0, 0)`,
mirroring every method path. Crucial subtlety: for a *lifted nested* function
the capture/env operands are **already on the stack** from the `nestedCaptures`
prepend loop that runs before the branch; `emitSetExtrasArgv` is stack-neutral
(everything → locals), so it doesn't disturb them. I therefore pad only the
param slots *after* the capture region (`for i = captureCount; i <
paramTypes.length`). Over-padding the captures with `pushDefaultValue` was a
*second* null-deref I hit and fixed (a phantom default landed on top of the
real env). The common no-spread path and the existing spread→positional path
are byte-identical (the new branch is gated narrowly), so the
overwhelmingly-common cases are untouched — keeping the high regression surface
contained.

**Result (host + standalone, per-file `runTest262File`):**
- `func-decl-args-trailing-comma-spread-operator.js`: fail (null-deref) → **pass**
- `gen-func-decl-args-trailing-comma-spread-operator.js`: fail (null-deref) → **pass**
- `cls-decl-async-gen-func-args-trailing-comma-spread-operator.js`:
  compile_error → **pass** (bonus — its body is the same free-function shape)
- net **+6 test262 results** (3 files × 2 modes); no sync regressions in the
  cluster.

**Deferred (out of scope per issue): async-generator METHODS.** 5 files remain
fail — `async-gen-meth`, `cls-{decl,expr}-async-gen-meth[-static]` — all return
`arguments.length === 2` (expected 4). This is a separate **async-generator
state-machine** lowering bug in the *method* path (the async-gen body
under-counts), not the sync free-function/spread defect fixed here. The issue
explicitly defers async-gen variants (they need the async-gen state machine).
Carry as a follow-on. (Top-level — non-nested — generator function declarations
reading `arguments` in standalone are *also* a separate pre-existing gap; the
nested/lifted form this PR targets works in standalone.)

**Validation:** `tsc` + `biome` + `prettier` clean (only pre-existing
`noExplicitAny` warnings remain, none at the new lines);
`check-test262-hard-errors.mjs` → 0 hard errors, no growth; relevant unit
suites (`generators`, `issue-2079`, `issue-2151-*`, `issue-1053`) green;
`tests/issue-2202-spread-arguments-count.test.ts` extended with nested
free-function + nested generator (len + element-VALUES + no-spread regression
guard) cases — 21/21 pass host+standalone. (The `#1712` capture-closure test
and the `tests/{arguments-object,generator-*}.test.ts` files that import a
non-existent `./helpers.js` fail identically on pristine `origin/main` — both
pre-existing, not caused by this change.)

### Concrete change set (as landed)
- `src/codegen/expressions/calls.ts` — `compileCallExpression`: hoist
  `paramCount`/`calleeReadsArguments` computation above the spread-call branch
  dispatch; add the capture-aware 0-user-param `arguments`+spread branch.
- `tests/issue-2202-spread-arguments-count.test.ts` — nested free-function and
  nested generator-function cases (both modes).
