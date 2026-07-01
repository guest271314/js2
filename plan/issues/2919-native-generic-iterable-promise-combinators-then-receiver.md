---
id: 2919
title: "Standalone async widen: native generic-iterable Promise.all/race (clears the 63 host-path-receiver .then illegal-casts, residual −65 layer)"
status: done
created: 2026-07-01
completed: 2026-07-02
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
horizon: xl
related: [2867, 2918, 2895, 2906, 2860]
umbrella: 2860
depends_on: [2918]
assignee: ttraenkler/sendev-2919
---

# Native generic-iterable Promise.all/race — the residual −65 widen layer

## Context

#2918 eliminated the −601 invalid-Wasm class (the funcIdx-shift desync) so the
standalone-async carrier widen now emits VALID Wasm. Re-measuring the widen
(carrier flipped to standalone, 314-file Promise/async corpus) isolates the next
convergent layer:

| lane | pass | fail | compile_error |
| --- | --- | --- | --- |
| host baseline | 221 | 55 | 38 |
| widen + #2918 | 117 | 159 | 38 |

The residual −104 pass is dominated by **65 "illegal cast"**, of which **63 are
receiver-cast traps** (32 `Promise/all` + 31 `Promise/race`) and 2 are
handler-wrapper casts.

## Root cause

The native `.then`/`.catch` lowering (`emitStandalonePromiseThen`) does an
**unconditional `ref.cast $Promise`** on its receiver. Under the widen the
receiver is frequently a **host-path promise** — `Promise.all/race(<X>)` where X
is anything other than a no-spread array literal falls through to the host
`Promise_all`/`Promise_race` import (the #2867 Gap-4 native combinator only
intercepts array literals, `calls.ts:8653`). The host promise is an externref
that is NOT a native `$Promise` GC struct, so `ref.cast $Promise` traps → the
`.then` chain fails with "illegal cast in test()".

A host-free `.then` cannot have a correct fallback for a genuine host-promise
receiver: routing the else-arm to the host `Promise_then2` import would leak an
unsatisfiable import and break the host-free invariant that
`tests/issue-2867*.test.ts` assert (`imports == []`). So the fix must remove the
host-path receivers at the SOURCE — make the combinators native for the argument
forms these tests use.

## The three argument arms (all 63 receiver casts fall in these)

1. **array-value** — `Promise.all(arrVar)` / `Promise.all([...spread])`: an
   array TYPE that is not a literal. Needs a **runtime** element loop
   (`array.len` + `array.get` over the arg's Vec) feeding the existing
   `__combinator_subscribe`, i.e. a runtime-count variant of the currently
   compile-time-unrolled `emitStandalonePromiseCombinator`. (e.g.
   `S25.4.4.1_A2.3_T1` — `var arg = []; Promise.all(arg)`.)
2. **not-iterable → reject TypeError** — `Promise.all(1)` / `(null)` / `(true)`
   / `(symbol)` … : a native `Test262Error`-style TypeError construction settling
   a **rejected** `$Promise`. (the `iter-arg-is-*-reject` family.)
3. **generic iterable** — `Promise.all(set)` / a custom `[Symbol.iterator]`
   (incl. `iterThrows` where GetIterator throws → reject): host-free
   `GetIterator(arg)` + `.next()` loop, reusing the standalone for-of iterator
   machinery. GetIterator-throws routes to arm 2's reject.

## Plan / scope guard

Extend `promise-combinators.ts` + the `calls.ts:8653` aggregator gate:

- Keep the array-literal fast path unchanged.
- Add a runtime-loop `subscribe-all` for array-TYPED args (arm 1) — smallest,
  highest-coverage slice; land first and re-measure.
- Add the not-iterable-reject arm (arm 2) — needs the native TypeError carrier
  (check what `Test262Error`/error construction is already native under the
  carrier before re-deriving).
- Add the generic-iterator arm (arm 3) last — reuse the standalone for-of
  `GetIterator`/`next` lowering; do NOT fork it.

**Discipline (non-negotiable, the graveyard rule):** each arm is carrier-gated
(`isStandalonePromiseActive`, wasi-only until the eventual widen), **byte-inert**
on gc/host + standalone (sha256-prove), and corpus-verified against the
−16/−29 guard. Start at a FRESH budget window — this is `horizon: xl` and a
partial combinator strands (the #2367 graveyard). **ESCALATE if arm 1/3 needs a
deeper value-representation change** (the fulfilled `Promise.all` value is an
externref vec; a `number[]`-typed consumer casts to an f64 vec and traps — the
documented Gap-4 representation contract, `promise-combinators.ts` header).

## Also fix (same funcIdx-desync class as #2918, small)

- `calls.ts:8665` — the combinator element buffer swap uses a bare `savedBody`
  local, same reachability hole #2918 fixed in the then buffers. Push onto
  `fctx.savedBodies` for a mid-buffer late-import shift.

## Expected effect

Clearing the 63 receiver casts drops the widen residual from −65 illegal-cast
toward ~0, leaving the last two layers: async-fn drive (−16, #2906) and Gap 5
for-await/async-gen (−32, #2867), after which the slice-1d carrier widen can be
measured net-positive → the ~5,000 co-blocked async cluster.

## Separately filed follow-up (out of this scope)

A pre-existing **wasi-lane** funcIdx desync of the same class in the
closure-capture path: `let m = new Map(); m.set("a",1);
Promise.resolve(1).then((v)=>m.get("a"),...)` emits invalid Wasm in `__closure_0`
under `--target wasi` on clean upstream/main (a Map-helper late-import shift
desyncing a captured-closure body). Not part of the standalone-gap goal.

## Implementation (arm 1 landed — 2026-07-02)

Arm 1 (array-TYPED non-literal args, the highest-coverage slice) is implemented.
Arms 2 (not-iterable→reject) and 3 (generic iterable) remain follow-ups (see
below) and stay on the host path unchanged.

### What landed

- **`src/codegen/promise-combinators.ts`**
  - `resolveExternrefVecArg(ctx, argType)` — classifies a compiled argument's
    ValType. Returns `{vecTypeIdx, arrTypeIdx}` only for a genuine `__vec_*`
    struct whose backing array element is `externref` (`Promise<T>[]` / `any[]`
    compile to exactly this — each element already `extern.convert_any`'d, so
    `array.get` yields the externref `__combinator_subscribe` wants, **no
    boxing**). Everything else (`number[]` = f64-backed vec — the documented
    Gap-4 output-representation escalation —, `any`/externref scalars, strings,
    non-vec structs) returns `null` → host fallthrough, byte-unchanged.
  - `emitStandalonePromiseCombinatorRuntime(ctx, fctx, method, argVecLocal,
    argVecTypeIdx, argArrTypeIdx)` — the runtime-count analogue of the existing
    compile-time-unrolled `emitStandalonePromiseCombinator`. Reads `n` from the
    vec's **logical length** (struct field 0, not `array.len` — the backing
    array over-reports after push growth), builds the pending result `$Promise`
    + `$CombinatorState`, fulfils empty-`all` immediately, then a
    `block{loop{ i>=n → br 1; subscribe(argVec.data[i], state, i, fulfillFn,
    rejectFn); i++ ; br 0 }}`. Subscribe never settles synchronously so
    `remaining` stays == n through the loop (no mid-loop settle race).

- **`src/codegen/expressions/calls.ts`** (the `isAggregator` gate)
  - Factored the eligibility predicate into `nativeCombinatorEligible`
    (`isStandalonePromiseActive` ∧ native method ∧ non-subclass ∧ single arg).
  - Array-literal path unchanged in behaviour, but its element-buffer swap now
    pushes the outer body **and** each completed element buffer onto
    `fctx.savedBodies` for the duration (the **#2918 funcIdx-desync fix** applied
    to this buffer too — a late import landing mid-element-compile now shifts the
    baked `ref.func`/`call` indices in the detached buffers). Buffers are popped
    only after `emitStandalonePromiseCombinator` returns; its `ensure*`
    registration runs before it copies buffers into `fctx.body`, so no
    instruction is ever reachable via two walked arrays at shift time (avoids the
    shared-Instr double-remap hazard).
  - **Arm 1** (new): for an array-typed non-literal arg, compile it in place with
    its natural type at a rollback mark, classify with `resolveExternrefVecArg`;
    on an externref-vec match, `local.set` it into a `ref null <vecTypeIdx>`
    local and call the runtime emitter. On a non-match, `fctx.body.length = mark`
    rolls the probe compile back (side-effect-free: the rolled-back instructions
    never execute) and control falls through to the host path unchanged.

### funcIdx-shift discipline (the async-graveyard hazard, #2918 class)

The cached combinator ids on `ctx.__promiseCombinators` are kept in lockstep
with late imports by the pre-existing `shiftAsyncSideChannelFuncIdxs`
(`COMBINATOR_FUNC_IDX_KEYS`). Arm 1 emits everything **inline** into `fctx.body`
(single arg expr, no detached element buffer), so a later `.then` late-import
shift is applied by the standard `ctx.currentFunc.body`/`savedBodies` walk.
`ensureCombinatorFunctions` is called from inside the runtime emitter (after the
arg is compiled), preserving the slot-reservation ordering.

### Verification

- **Byte-inert on the off-carrier lanes** (sha256, HEAD vs clean base, a
  Promise/async corpus): every `--target` (gc/host) digest **identical**; only
  the three arm-1 wasi shapes (`all(arrVar)`, `race(arrVar)`, `all([...spread])`)
  changed — the intended carrier-gated delta. `all(number[])` wasi digest
  **unchanged** (correct host fallthrough + clean probe rollback); `all([lit])`
  wasi digest unchanged (savedBodies refactor byte-inert absent a mid-compile
  shift).
- `tests/issue-2867-gap4.test.ts`: 12/12 pass (6 new `#2919 arm 1` cases —
  values array, order-preservation, first-rejection, empty-var, spread, race).
- Stack-balance gate OK (no bucket increase; `default-value-lossy` −36).
- Pre-existing unrelated failures confirmed on the clean base (host-path
  `promise-combinators.test.ts` ×2 `_toIterable` on gc, `#2865` await-unwrap
  ×2 WASI) — NOT introduced by this change.

### Follow-ups (arms 2 & 3 — tracked as #2922)

Filed as **#2922** (`depends_on: [2919]`):

- **Arm 2** (not-iterable → reject TypeError): `Promise.all(1)` / `(null)` still
  traps under wasi. Needs a rejected `$Promise` carrying a native TypeError —
  check the existing native error/`Test262Error` construction under the carrier
  before re-deriving.
- **Arm 3** (generic iterable: Set / custom `[Symbol.iterator]`, incl.
  GetIterator-throws → arm 2): host-free `GetIterator` + `.next()` loop reusing
  the standalone for-of iterator lowering.
