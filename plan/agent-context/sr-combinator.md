# Handoff — #2919 native generic-iterable Promise.all/race (residual −65 widen layer)

**Branch:** `issue-2919-generic-iterable-combinators` (worktree
`/workspace/.claude/worktrees/issue-2919-generic-iterable-combinators`),
branched from `upstream/main`, plan branch `origin/plan-2919-generic-iterable-combinators`
already merged in (spec file present). Claimed on `issue-assignments` as
`ttraenkler/sendev-2919`. **State: analysis complete, ZERO implementation code written yet.**

## Repro confirmed (current main, wasi target)

`.tmp/repro.mjs` in the worktree. Under `--target wasi`:
- `Promise.all(arrVar).then(...)` -> valid Wasm, imports=[], but `RuntimeError: illegal cast`.
- `Promise.all(1 as any).then(...)` (not-iterable) -> same illegal cast.
- `Promise.all([literal]).then(...)` (array literal) -> works (val=3). Existing #2867 Gap-4 fast path.

Root cause verified by dumping `$run` WAT: `Promise.all(a)` (non-literal) under the carrier
falls through to the host `Promise_all` path, but `ensureLateImport` SUPPRESSES the host import
under wasi (host-free invariant), so the call leaves `ref.null.extern` on the stack. The `.then`
lowering then does `any.convert_extern; ref.cast (ref 50=$Promise)` on that null -> trap.
(Spec said "routes to host import"; empirically the import is suppressed -> null. Same fix either way.)

## The gate to extend

`src/codegen/expressions/calls.ts:8657-8689` (NOT `calls.ts:8653` -- file moved to
`expressions/calls.ts`, line drifted). The `isAggregator` block. The native arm-1 fast path
currently only fires for: `isStandalonePromiseActive(ctx) && isNativeCombinatorMethod(methodName)
&& !isPromiseSubclassReceiver && expr.arguments.length===1 && ts.isArrayLiteralExpression(arg0)
&& every-non-spread`. Everything else -> host `Promise_${methodName}` path (-> null under wasi -> trap).

## Combinator substrate -- src/codegen/promise-combinators.ts (479 lines, fully read)

- `ensureCombinatorFunctions(ctx)` reserves 4 helper funcIdx slots up-front
  (`__combinator_subscribe`, `__combinator_all_fulfill`, `__combinator_race_fulfill`,
  `__combinator_reject`) + registers `$CombinatorState`/`$CombinatorElemCaps`. Returns
  `CombinatorRuntime ids`: promiseTypeIdx, vecTypeIdx (externref vec), arrTypeIdx (externref
  backing arr), stateTypeIdx, subscribeFuncIdx, allFulfillFuncIdx, raceFulfillFuncIdx, rejectFuncIdx.
- `__combinator_subscribe(input externref, state externref, index i32, fulfillFn funcref, rejectFn funcref)`
  normalizes input to `$Promise` (native passes through; ANYTHING ELSE wrapped in a synchronously-
  FULFILLED `$Promise` -> a raw boxed value is fine), then enqueues fulfill/reject microtask or
  prepends a pending reaction. Already-settled inputs only ENQUEUE (never settle synchronously),
  so `remaining` stays == n through the whole subscribe loop -> no mid-loop settle race.
- `emitStandalonePromiseCombinator(ctx, fctx, method, elementInstrs: Instr[][])` -- existing
  compile-time-unrolled version. State{resultPromise, resultsArr(size n), length=n, remaining=n}.
  n===0: all->fulfill empty vec, race->emit nothing. Else loop i: element instrs; `local.get state;
  extern.convert_any; i32.const i; ref.func fulfillFn; ref.func rejectFn; call subscribeFuncIdx`.

## Vec representation (verified src/codegen/registry/types.ts)

`$__vec_<kind>` struct: field 0 = `length` i32, field 1 = `data` (ref $__arr_<kind>).
`getArrTypeIdxFromVec(ctx, vecTypeIdx)` -> backing arr type idx (-1 if not an array).
`Promise<T>[]`/`any[]` compile to an EXTERNREF-backed vec (each element extern.convert_any'd),
so `array.get argArrTypeIdx` yields externref directly -- matches subscribe's externref input,
NO BOXING NEEDED.

## Next concrete step -- implement ARM 1 (array-typed args), land first, re-measure

Add `emitStandalonePromiseCombinatorRuntime(ctx, fctx, method, argVecLocal, argVecTypeIdx, argArrTypeIdx)`
to promise-combinators.ts. Decisions worked out:

1. In calls.ts, before host fallthrough: detect array-typed non-literal arg. Compile the arg
   INLINE into fctx.body (compileExpression), `local.set argVecLocal` (a `ref null argVecTypeIdx`
   local). Get argVecTypeIdx from the ValType compileExpression returns; argArrTypeIdx =
   getArrTypeIdxFromVec(...). GUARD: only proceed if `ctx.mod.types[argArrTypeIdx].element` is
   externref; else fall through to host path (no regression -- `number[]`/f64-backed is the
   documented Gap-4 output-representation ESCALATION; do NOT box the output vec without escalating).
2. funcIdx-shift discipline (critical, #2918 class): call `ensureCombinatorFunctions(ctx)` AFTER
   compiling the arg (arg compile may add late imports that shift reserved combinator slots). Emit
   EVERYTHING into fctx.body inline (no detached buffer) so a LATER late-import shift (from the
   trailing `.then`) is applied by the standard ctx.currentFunc.body/savedBodies shift mechanism.
   Arm 1 has a single arg expr, so needs NO element-buffer swap -> avoids the buffer hole entirely.
3. Runtime body (inline in fctx.body): pending result `$Promise`; `n = argVec.length` (struct.get
   field 0 -- spec logical length, not array.len); results arr `array.new_default ids.arrTypeIdx`
   size n; state struct; if method==="all": if n==0 -> fulfill empty vec; then
   `block{loop{ local.get i; local.get n; i32.ge_s; br_if 1; <subscribe argVec.data[i]>; i++; br 0 }}`;
   leave `local.get resultLocal; extern.convert_any` (return EXTERNREF). Per-element subscribe args:
   `argVec(ref.as_non_null).data[i]` (array.get argArrTypeIdx -> externref), `state extern.convert_any`,
   `i32 i`, `ref.func fulfillFn`, `ref.func rejectFuncIdx`, `call subscribeFuncIdx`. fulfillFn =
   all->allFulfillFuncIdx, race->raceFulfillFuncIdx. Loop idiom model: async-scheduler.ts:539-593.

## Also fix (spec "Also fix", same funcIdx-desync class as #2918)

Existing array-literal element-buffer swap at calls.ts ~8678-8686 uses a bare
`const savedBody = fctx.body; fctx.body = buf; ...; fctx.body = savedBody;`. Same reachability
hole #2918 fixed in the then-buffers: a late import added mid-element-compile won't shift ref.func
indices baked into detached `buf`. Push `buf` onto `fctx.savedBodies` around the swap (see
savedBodies shift loops in index.ts:9143). Carrier-gated/byte-inert like the rest.

## Arms 2 & 3 (defer / follow-up within this issue if budget allows)

- Arm 2 (not-iterable -> reject TypeError): rejected `$Promise` carrying a native TypeError.
  CHECK what Test262Error/native error construction already exists under the carrier before
  re-deriving (spec note). Arm 3's GetIterator-throws routes here too.
- Arm 3 (generic iterable: Set / custom [Symbol.iterator]): host-free GetIterator + .next() loop --
  REUSE the standalone for-of iterator lowering, do NOT fork it. A GetIterator-based path subsumes
  arms 1+2+3, but arm 1's direct array.len/array.get is simpler + highest-coverage -> land first.

## Discipline (non-negotiable -- async graveyard rule)

Carrier-gated (isStandalonePromiseActive, wasi-only -- do NOT widen the gate here) -> gc/host/
standalone byte-inert by construction. Still sha256-prove gc+host+standalone corpus bytes identical
before/after. Corpus-verify vs the wasi async leaky-pass corpus (Promise.all/race generic iterables)
and the -16/-29 guard. Escalate to team lead rather than churn if blocked >30 min on a substrate
surprise (esp. output value-representation Gap-4).

## Verify tooling

- tests/issue-2867-gap4.test.ts -- wasi native-combinator shape (runWasi helper: imports==[] +
  WebAssembly.validate + drives __drain_microtasks). Add arm-1 cases (all(arrVar), race(arrVar),
  all([]) via var, pending inputs).
- .tmp/repro.mjs, .tmp/wat.mjs -- quick compile probes (gitignored).
- PR: `gh pr create -R loopdive/js2 --head ttraenkler:issue-2919-generic-iterable-combinators`,
  title `fix(#2919): ...`, carry issue file status: done. Do NOT enqueue (auto-enqueue.yml owns it).
