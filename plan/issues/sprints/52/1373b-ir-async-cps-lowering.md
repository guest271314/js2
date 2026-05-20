---
id: 1373b
sprint: 52
title: "IR async Phase C: CPS lowering for await + async-return + async-throw"
status: blocked
created: 2026-05-09
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: async
goal: ir-full-coverage
depends_on: [1326c]
---
# #1373b — IR async Phase C: CPS lowering

## Background

#1373 Phase A (PR #328) shipped:
- New `IrFallbackReason: "async-function"` distinct from
  `"async-generator"`, `"non-export-modifier"`, `"deferred-feature"`.
- Selector buckets async functions / async methods correctly.
- New IR node types: `IrInstrAwait`, `IrInstrAsyncReturn`, `IrInstrAsyncThrow`
  (type-only — switch arms exist but lowering throws "not yet
  implemented").

Phase A is purely additive: async functions remain rejected (fall back
to legacy codegen). This issue tracks Phase C — the actual lowering
that flips the gate from deferred → claimed.

## Dependency

**BLOCKED on #1326c** (microtask queue + `Promise.then` standalone).
Phase C's CPS transform schedules continuations via
`__microtask_enqueue` and resolves chained promises via
`__promise_then`; both are still throwing stubs in
`src/codegen/async-scheduler.ts`. Until #1326c lands real bodies for
those helpers, Phase C cannot complete.

## Strategy (architect to re-spec after #1326c lands)

The original Phase 1 spec at `1326-async-microtask-queue-wasm-scheduler.md`
estimated Phase C at ~250 LoC. After Phase 1B implementation experience,
the closure-funcref interaction is harder than estimated — see
`1326c-microtask-queue-and-promise-then-standalone.md` "Constraint
discovered during 1B implementation" section.

### High-level transform

`async function f() { const x = await g(); return x + 1; }` becomes a
state machine:

- **State 0** (entry): call `g()`, register continuation as microtask.
  Return a pending `$Promise`.
- **State 1** (resume): receive resolved value; bind `x`; compute
  `x + 1`; settle the outer Promise (via `Promise_resolve`-equivalent
  in standalone mode).

The CPS transform splits the function at each `await` point. Each split
lifts the post-await tail into a synthetic continuation closure. The
continuation captures the outer's locals (whichever ones the tail
references).

### IR-level shape

After Phase C, an `await <expr>` node lowers to:

```
%promise = lowerExpression(<expr>)
%continuation = closure.new $continuation_N (captures...)
__microtask_then(%promise, %continuation)
return %outer_pending_promise
```

The `$continuation_N` lifted function takes the resolved value,
restores the captured state, and continues.

### Acceptance criteria

1. `async function f() { return await g(42); }` is IR-claimed and
   produces correct results.
2. `.then` chaining via `await` works — `async function () { return
   await g().then(x => x + 1); }` yields the chained value.
3. Rejection: `async function f() { throw new Error("x"); }` produces
   a rejected `$Promise`.
4. Existing legacy async equivalence tests (the ones that pass on
   today's main) all continue to pass with IR claim active.
5. WASI standalone mode: `async function main() { return await
   Promise.resolve(42); }` returns 42 after `__drain_microtasks()`.

## Files

- `src/ir/from-ast.ts` — emit `IrInstrAwait` / `IrInstrAsyncReturn` /
  `IrInstrAsyncThrow` from `ts.AwaitExpression` / async-function
  `return` / `throw` nodes.
- `src/ir/lower.ts` — replace the throwing stubs with the CPS transform
  emission (microtask queue calls + continuation-closure synthesis).
- `src/ir/select.ts` — flip the `"async-function"` bucket from
  deferred → claimed when a `supportsAsyncIr` flag is set (default
  off in #1373b's first slice; flipped to on once tests confirm
  parity).
- `src/ir/integration.ts` — thread the `supportsAsyncIr` flag from the
  codegen context.
- `tests/ir/issue-1373b.test.ts` — comprehensive test coverage.

## Risk and split

This is the hardest IR slice in flight. Recommend splitting further:

- **1373b-prep**: thread `supportsAsyncIr` flag, wire `from-ast.ts` to
  emit the new IR nodes. No lowering yet (still throws).
- **1373b-lower**: replace the throws with real CPS transform.
  Requires #1326c to be done.
- **1373b-claim**: flip the selector to actually claim async functions
  (default-on). Requires both above.

Each sub-slice is independently shippable.

## Notes for the next architect to read this

- The closure-funcref constraint identified in #1326c also applies
  here. The continuation closure must be call_ref-able from the
  microtask drain loop, which requires either uniform-arity
  `(externref) → externref` continuations (recommended) or per-site
  function-table dispatch (more complex).
- Async generators (`async function*`) are NOT in scope. They get the
  separate `"async-generator"` bucket and are tracked under the
  long-deferred `async-generator` category.
- `try/catch` inside async function bodies has additional CPS
  complexity (catch handlers are continuations). Consider splitting
  out as a separate sub-slice if it becomes the long pole.

---

## Implementation Plan

**Authored**: 2026-05-20 by senior-dev-conflicts
**Targets**: post-#1326c-Phase-1C-B (real `emitStandalonePromiseThen`)

### Architectural overview — CPS state-machine transform

Every async function lowers to a **synthesised state machine**: the
function body is sliced at each `await` point into a chain of
"continuation" functions, each of which advances the machine by one
state. The outer function returns the synthesised outer Promise
immediately; suspension/resumption is driven by the microtask queue.

Functions with N `await` operands produce N+1 IR functions in the
emitted module:

- **F₀** (the original): allocates the outer Promise (state=pending),
  runs prelude code up to the first await, registers the State-1
  continuation, returns the outer Promise.
- **F₁ … Fₙ** (synthesised continuations): each one consumes a single
  resolved value, runs the slice of original-body code up to the next
  await (or to the function end), and either registers Fᵢ₊₁ or settles
  the outer Promise via `emitStandalonePromiseResolve` /
  `emitStandalonePromiseReject`.

A "zero-await" async function (no `await` in body) lowers without any
synthesised continuations — F₀ runs the whole body and settles the
outer Promise synchronously before returning it. This is the
**FULFILLED/REJECTED fast path** described below and is the **only
shape that works without #1326c Phase 1C-B**.

### Continuation closure signature

All continuations are uniformly typed:

```wat
(type $continuation (func (param externref) (result externref)))
```

- **Param** `externref` is the resolved/rejected value from the
  awaited Promise.
- **Return** `externref` is one of:
  - The outer Promise (still pending, more awaits to come)
  - The settled outer Promise (final state)

Captures (variables bound in the outer scope that the continuation
needs) are bound via a closure struct field — same mechanism as
existing user-level closures in `src/codegen/closures.ts`. The closure
struct is allocated once at F₀ entry and shared by every continuation
in the chain (mutated as the function progresses).

**Rationale for uniform arity**: the microtask drain loop in
`async-scheduler.ts` invokes continuations via `call_ref`. Variable
signatures would require either a function table per signature
(complex) or boxing (loses type info). The uniform `(externref) →
externref` signature lets one drain loop fire all continuations.
Rejection vs fulfillment is encoded by a second
boolean-flagged variant or by tagging via the closure struct — see
"Error path" below.

### CPS algorithm (Phase C lowering, in `src/ir/lower.ts`)

For an async function whose IR body is a linear sequence of blocks
B₀, B₁, …, Bₘ where some blocks end in `IrInstrAwait`:

1. **Outer Promise allocation**: at F₀ entry, allocate
   `outerPromise: ref $Promise` with `state=PENDING`,
   `value=ref.null.extern`, `callbacks=ref.null.extern`. Store in a
   captured closure field `$outer`.

2. **Identify split points**: walk the IR body, marking each
   `IrInstrAwait` block as a split point. Each split produces:
   - A "pre-await" sub-graph (everything from the previous split point
     up to but not including the await).
   - A "continuation" stub (everything from immediately after the
     await up to the next split point, or the function end).

3. **Capture analysis**: for each continuation, compute the set of
   IrValueIds defined before the split that the post-split code reads.
   These become fields on the closure struct. The closure type is
   synthesised per-function: `$cont_capture_<fn>_<idx>`.

4. **Emit F₀** (the entry):
   ```
   <prelude: outerPromise allocation, closure struct allocation>
   <pre-await block 0 instructions>
   <await operand evaluation → %p>
   <fast-path check>
   if %p.state == FULFILLED:
     %resolved = %p.value
     <jump to State-1 inline> ← same-function continuation, NO closure synthesis
   elif %p.state == REJECTED:
     <jump to rejection handler> ← either try/catch handler or settle outerPromise as rejected
   else:  // PENDING
     %cont = closure.new $cont_capture_fn_1 (captures...)
     emitStandalonePromiseThen(%p, %cont)
     return outerPromise   ← pending; resumption happens via microtask drain
   ```

5. **Emit F₁ … Fₙ** (continuations) as separate top-level IR functions.
   Each is registered in `ctx.mod.functions` with a synthesised name
   like `${fnName}/continuation_${i}`. The signature is the uniform
   `(externref) → externref`. The body:
   ```
   <local: $resolvedValue = param 0>
   <local: $closureSelf = local.get/cast>
   <restore captures from closureSelf into locals>
   <post-await block i instructions, using $resolvedValue for the await's result>
   <next await → recurse with State-(i+1) continuation>
   <or: settle outerPromise via emitStandalonePromiseResolve(returnValue)>
   ```

6. **Settle on completion**: every path through F₀…Fₙ that doesn't
   register a further continuation MUST settle the outer Promise:
   - Normal return: `emitStandalonePromiseResolve(outerPromise, returnValue)`
   - Throw: `emitStandalonePromiseReject(outerPromise, reason)`
   - The settle helper mutates the outer Promise's `state` from
     PENDING → FULFILLED/REJECTED and fires any registered `.then`
     callbacks via the microtask queue (this is what #1326c Phase
     1C-B will plumb).

### `IrInstrAwait` lowering (the critical path)

Stack contract: operand has type `IrType.externref` (a Promise, possibly
unboxed if statically a `$Promise` ref). Lowering steps:

1. Cast operand to `ref $Promise`. If operand is `ref null $Promise`,
   first ref.cast-guard against null (null is not a Promise → spec says
   wrap in `Promise.resolve(null)`, which is FULFILLED with value=null).

2. Branch on `state`:

   **FULFILLED path** (state == 1):
   ```wat
   local.tee $p_local           ;; save promise
   struct.get $Promise $state
   i32.const 1                  ;; FULFILLED
   i32.eq
   if (result externref)
     local.get $p_local
     struct.get $Promise $value ;; resolved value as externref
   else ...
   ```
   The resolved value becomes the IR value bound to the await's result
   `IrValueId`. Control flow continues in the SAME wasm function —
   no continuation synthesis, no microtask scheduling. This is the
   **only path that works pre-1C-B**.

   **REJECTED path** (state == 2):
   - If inside `try/catch`: branch to the catch handler with the
     rejection value as the caught exception. Implementation: use the
     same Wasm exception tag the `IrInstrThrow` lowerer uses; the
     handler catches it normally.
   - If not inside `try/catch`: settle `outerPromise` as REJECTED with
     the rejection value, then return `outerPromise`.

   **PENDING path** (state == 0):
   - **Phase C scaffolding slice** (pre-1C-B): emit `unreachable` with
     a marker comment, OR call a host import that throws "async
     suspension not yet supported" so the failure is observable but
     non-fatal.
   - **Phase C full slice** (post-1C-B): synthesise the continuation
     closure as described in step 5 above, register it via
     `emitStandalonePromiseThen(%p, %cont)`, and `return outerPromise`.
     Control reaches drain when the host yields.

3. The IR-level result `IrValueId` is bound only in the FULFILLED
   branch; the REJECTED and PENDING branches do not produce a value
   (they terminate or schedule a continuation respectively). Lowerer
   must therefore wrap the await result in an `if/else` with explicit
   block result type, OR emit each branch as a separate basic block
   with proper SSA renaming.

### `IrInstrAsyncReturn` lowering

```wat
;; stack: <returnValue: externref>
local.get $outerPromise
swap
call $emit_settle_resolved  ;; pseudo — actually emits inline:
                            ;;   struct.set $Promise $state (i32.const 1)
                            ;;   struct.set $Promise $value (resolved)
                            ;;   drain pending callbacks via 1C-B
local.get $outerPromise
return                       ;; F₀'s caller gets the (now-settled) Promise
```

Implementation: call `emitStandalonePromiseResolve(ctx, fctx,
valueInstrs)` with `outerPromise` accessible via the captured closure
struct field. Add a new variant
`emitStandalonePromiseSettleResolve(ctx, fctx, promiseLocalIdx,
valueInstrs)` that MUTATES an existing pending Promise rather than
allocating a fresh one — needed because the outer Promise was already
returned to the caller.

### `IrInstrAsyncThrow` lowering

Symmetric to async-return: settle `outerPromise` as REJECTED with the
thrown reason. Implementation: new helper
`emitStandalonePromiseSettleReject(ctx, fctx, promiseLocalIdx,
reasonInstrs)`.

The Phase C lowerer also recognises **uncaught Wasm throws** inside
the function body (i.e. `IrInstrThrow` that reaches the function
boundary without a matching `try/catch`). These must be intercepted
at the function epilogue and re-routed to `async-throw` semantics —
otherwise the host sees a raw Wasm exception instead of a rejected
Promise.

### try/catch interaction

`try { … await x; … } catch (e) { … }` requires the catch handler
itself to be a continuation: when `x` rejects, control must transfer
to the catch handler with the rejection value as `e`, NOT propagate
as a Wasm exception (the function has already returned `outerPromise`
to its caller).

Implementation approach: associate each `IrInstrAwait` with the
**innermost enclosing try-block**'s catch handler IrBlockId (computed
during from-ast lowering). The PENDING-path continuation synthesis
must then emit TWO callbacks:

- `onFulfilled`: standard continuation
- `onRejected`: enters the catch handler with the rejection value

This means the microtask scheduler must distinguish fulfillment vs
rejection callbacks. Two options:

A. **Two parallel queues** (recommended for Phase C v1): every
   continuation gets two slots in the callback vec; `__promise_then`
   takes two funcref params. Simpler, doubles closure storage.

B. **Tagged single queue**: each continuation funcref is wrapped in a
   struct `{ fulfilled: funcref, rejected: funcref }`. More memory
   per pending await but uniform scheduler interface.

**try/catch is OUT OF SCOPE for the first Phase C slice.** Initial
implementation rejects (defers) async functions whose bodies contain
`try`/`catch` around an `await`. Adding catch handler routing is a
follow-up.

### Integration with tail-call infrastructure (`return_call` / `return_call_ref`)

The existing tail-call mechanism (used for non-async functions in
return position) DOES NOT apply to async continuations — async always
returns through the outer Promise, never via direct tail-call to the
caller. Phase C lowerer must explicitly NOT emit `return_call` in
async function bodies. The selector should mark async-function bodies
with a flag that `peephole.ts` reads to skip the tail-call rewrite.

### Selector gate (`supportsAsyncIr` flag)

In `src/ir/select.ts`, the `whyNotIrClaimable` function returns
`"async-function"` for plain `async function` / `async` methods.
Phase C threads a new flag through the codegen context:

```ts
// src/codegen/context/types.ts
interface CodegenContext {
  // ...existing fields
  /** #1373b — when true, async functions flow through IR's CPS lowering;
   * when false, they fall back to the legacy direct codegen. */
  supportsAsyncIr: boolean;
}
```

The selector reads this flag and CLAIMS async functions when both:
1. `supportsAsyncIr === true` (config opt-in)
2. The function body matches the "Phase C v1" subset (no
   try/catch/finally wrapping awaits — see "try/catch" above)

For the **scaffolding-only first slice** (this PR's recommended
scope), `supportsAsyncIr` is hardcoded `false` — selector stays
deferred, no async function actually flows through IR yet. Phase 1C-B
+ scheduler queue can land independently. Once both are green, a
single-line change in `isAsyncIrReady(ctx)` flips the gate on.

### File-by-file implementation map

1. **`src/ir/from-ast.ts`** — wire `ts.AwaitExpression` → `IrInstrAwait`
   emission, async-function `return <v>` → `IrInstrAsyncReturn` (replacing
   the standard `IrTerminatorReturn`), uncaught `ts.ThrowStatement` inside
   async body → `IrInstrAsyncThrow`. ~80 LoC.

2. **`src/ir/lower.ts`** — replace the throwing stubs at lines
   1773-1778 with the full CPS transform described above. Add a new
   helper `synthesiseContinuationClosure(ctx, fctx, postAwaitBlocks,
   captures): { closureTypeIdx, contFuncIdx, structFields }` that:
   - Registers the per-call closure struct type
   - Emits the continuation function (per-callsite naming)
   - Returns the indices needed by the call site
   ~250-400 LoC.

3. **`src/codegen/async-scheduler.ts`** — add two new helpers:
   - `emitStandalonePromiseSettleResolve(ctx, fctx, promiseLocal,
     valueInstrs)` — mutate existing pending Promise → FULFILLED, fire
     stored callbacks via the microtask queue. ~30 LoC.
   - `emitStandalonePromiseSettleReject` — symmetric for REJECTED.
     ~30 LoC.
   Both are blocked on #1326c Phase 1C-B's `emitStandalonePromiseThen`
   implementation landing.

4. **`src/ir/select.ts`** — flip `"async-function"` bucket from
   always-deferred to conditionally-claimed via `isAsyncIrReady(ctx)`.
   One new helper, ~20 LoC.

5. **`src/codegen/context/types.ts`** — add `supportsAsyncIr: boolean`
   to `CodegenContext`. Initialised `false` in `create-context.ts`.
   ~5 LoC.

6. **`tests/ir/issue-1373b.test.ts`** — comprehensive coverage. Test
   shapes:
   - Zero-await async function (FULFILLED fast path only)
   - Single-await with FULFILLED Promise.resolve operand
   - Single-await with REJECTED Promise.reject operand
   - Single-await with PENDING operand (requires drain)
   - Chained `await await` (nested CPS)
   - Captures: locals defined before await read after
   - Mutated captures (let, not const, written in continuation)

### Splitting strategy (revisit from original plan)

The original split (1373b-prep / 1373b-lower / 1373b-claim) remains
valid. Concretely:

**Slice 1 — `1373b-scaffolding` (this PR, ~400 LoC)**:
- Files 4, 5, 6 above + the FULFILLED/REJECTED fast paths in file 2
- PENDING path: emit a clear "needs 1C-B" runtime throw stub
- Gate hardcoded `false` (no async function flows yet)
- Tests: zero-await + FULFILLED-only + REJECTED-only cases
- Ships independent of #1326c Phase 1C-B status

**Slice 2 — `1373b-pending-path` (~250 LoC, blocked on 1326c Phase 1C-B)**:
- Replace the "needs 1C-B" stub with the real CPS continuation
  synthesis in file 2
- Add helpers in file 3 (settle helpers)
- Tests: single-await PENDING + capture + mutated capture cases

**Slice 3 — `1373b-claim-gate` (~10 LoC, blocked on Slices 1-2 green)**:
- Flip `isAsyncIrReady(ctx)` to true when context says so
- Add a config flag (default off; flip after CI green)
- Tests: existing async equivalence test suite continues to pass with
  the IR claim active

**Slice 4 (out-of-scope follow-up): try/catch handler routing**, async
generators (`async function*`), top-level await — separate issues.

### Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Closure-funcref interaction harder than expected (per #1326c notes) | Uniform-arity continuation signature avoids per-site function-table dispatch. Tests cover capture/restore. |
| CPS transform regresses legacy async tests | Slice 1 + 2 keep gate closed; Slice 3 ships only after equivalence tests pass on a feature-flag-on run. |
| `outerPromise` allocation cost dominates microbenchmarks | The standalone `$Promise` struct.new is 3 stack values + struct.new, cheaper than the host import. JS-host mode unchanged. |
| Tail-call optimisation accidentally re-applied to async bodies | Selector sets a "skip tail-call" flag on async functions; `peephole.ts` reads it. |
| Drain-after-_start ordering in WASI | Already handled by #1326c Phase 1C-A's `getDrainFuncIdxForWasiStart` wire-up. |

### Acceptance criteria mapping (from existing § above)

| # | Original criterion | Slice that delivers |
|---|--------------------|---------------------|
| 1 | `async function f() { return await g(42); }` works | Slice 2 (PENDING path) |
| 2 | `.then` chaining via await | Slice 2 + 1326c Phase 1C-B |
| 3 | Rejection: `async function f() { throw … }` | Slice 1 (REJECTED fast path) |
| 4 | Legacy equivalence tests pass | Slice 3 (gate-flip + CI sweep) |
| 5 | WASI standalone `async main()` returns 42 | Slice 1 (zero-await + Promise.resolve fast path) + Slice 2 (drain) |

### Implementation notes for the developer

- Write the FULFILLED fast path FIRST and ship Slice 1 standalone.
  Validating that path against existing equivalence tests will catch
  ~80% of the integration bugs before the harder PENDING path lands.
- Reuse the existing closure infrastructure
  (`src/codegen/closures.ts`'s `lowerClosureCapture` + `closureStructTypeIdx`
  pattern). The continuation closure struct is conceptually identical to
  a user-level closure — no new lifting machinery needed.
- Reject async functions inside the IR selector for now whenever the
  body contains `ts.SyntaxKind.TryStatement` whose `tryBlock` (or any
  nested block) contains an `await`. Single regex-like AST walk.
- The `outerPromise` captured-in-closure pattern is identical to how
  generators capture their `IteratorResult` slot — see #1323 for
  prior art.
