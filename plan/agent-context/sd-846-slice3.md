# Senior-Dev session context — sd-846-slice3

**Session focus:** async/await CPS machinery (#1042 Slice 2A), plus several standalone/IR
fixes. Closed out at end of sprint 58.

## Work landed this session

| Issue | PR | What |
|-------|-----|------|
| #846 slice 3 | (merged earlier) | TypeError-not-thrown residual investigation + targeted fix |
| #681 | #1108 (MERGED) | native `Array.prototype.values()` for-of in standalone/WASI |
| #1320 blocker | #1111 (MERGED) | register box helpers before emitting struct-field getters (`__sget_bool`) |
| #1131 | #1113 (MERGED) | IR: lower bare `null` + `??` over reference operands |
| #1042 Slice 2A | #1122 (enqueued) | single-await JS-host CPS machinery — gate stays OFF |

## #1042 Slice 2A — the headline deliverable (PR #1122)

**Status: machinery implemented + verified correct, gate `ASYNC_CPS_ENABLED` ships OFF.**

PR #1122 (branch `issue-1042-slice2a`, commit `fa12f2a2`) lands the full single-await
continuation-passing-style lowering for JS-host async functions, with all four blockers
from my own implementation spec (#281) fixed:

1. **Blocker 1 — late-import index shift (#1384).** New `collectAsyncCpsImports` prepass
   in `src/codegen/declarations.ts` detects CPS-eligible async fns in the unified collector
   and pre-registers `__make_callback` / `Promise_then2` / `Promise_resolve` upfront. The
   driver in `src/codegen/async-cps.ts` then reads stable `ctx.funcMap.get(...)` indices
   instead of `ensureLateImport` (which would shift `call` opcodes in the outer `$f` body
   that is NOT in `ctx.liveBodies` during `emitAsyncStateMachine`).
2. **PromiseResolve wrapping** (§27.7.5.3): driver calls `Promise_resolve(awaitedValue)`
   before `Promise_then2` so `await <non-thenable>` (e.g. a literal number) resolves
   instead of throwing on `(42).then`.
3. **Blocker 2 — return-await collapse.** `returnAwaitValue` option in
   `compileSyntheticAsyncContinuation` (`src/codegen/closures.ts`) emits `local.get 1`
   (the `__awaitValue` param) as the identity tail for `return await P`, instead of
   `ref.null.extern`.
4. **Capture/resume-binding aliasing.** For `const x = await P; return x`, the resume
   binding name is now excluded from the capture set (computed `resumeBinding` BEFORE
   `captures` in `emitAsyncStateMachine`) so the continuation reads the resumed value,
   not the snapshotted uninitialized (0) local.

**Verified correct:** forcing the gate on makes all 8 resolved-value tests in
`tests/issue-1042.test.ts` (the `describe.skipIf(!ASYNC_CPS_ENABLED)` suite) pass.
`tests/async-await.test.ts` migrated from bare `{env:{}}` to the `compile()` +
`buildImports()` + Promise-resolution harness (8/8 pass).

### WHY the gate ships OFF (do not flip without architect spec)

Flipping `ASYNC_CPS_ENABLED = true` globally regresses **3 equivalence tests**
(`tests/equivalence/{async-function,promise-chains}.test.ts`). Those tests consume a
single-await async fn **synchronously** as `asyncFn() as any as number` — the #1313/#1727
"compile away" pattern. With CPS on, that fn returns a real `Promise` and the cast yields
`NaN` (26/100 → NaN).

The conflict is structural: **the CPS rewrite is per-definition, but synchronous
consumption is per-call-site.** A single global flip cannot satisfy both contracts at once.
Turning CPS on for real requires the synchronous-consumption call sites to be taught to
drive the returned Promise — that is an **architect-level consumption-contract decision**
(async-fn-as-raw-value vs Promise-return). Team-lead confirmed this is genuine architect
scope and will be spec'd before the next gate-flip attempt.

Full analysis is in `plan/issues/1042-async-await-state-machine-lowering.md` (Slice 2A
section). PR #1122 ships the machinery inert and **byte-identical to main** for
override-free modules, so it lands clean (expected net 0 test262) and lays the foundation
for the architect's safe-flip spec.

## Pre-existing bugs surfaced (worth filing)

1. **#1667 test-harness migration** — already folded into PR #1122
   (`tests/async-await.test.ts` was using bare `{env:{}}` which stopped satisfying the
   import set after #1667; migrated to `buildImports`).
2. **Host `declare function` marshaling returns NaN/0** — a `declare function getV(): number`
   host import returns `NaN` even when called synchronously (independent of CPS). This is
   why the Slice 2A resolved-value tests use INTERNAL async callees + literals as the
   awaited-value source, not host calls. Team-lead is filing an issue for this one.

## Key files (#1042)

- `/workspace/src/codegen/async-cps.ts` — `ASYNC_CPS_ENABLED` gate (false), `emitAsyncStateMachine`, `emitMakeContinuationCallback`
- `/workspace/src/codegen/closures.ts` — `compileSyntheticAsyncContinuation` + `returnAwaitValue` option
- `/workspace/src/codegen/declarations.ts` — `collectAsyncCpsImports` prepass in unified collector
- `/workspace/tests/issue-1042.test.ts` — gate-OFF assertion + skipIf resolved-value suite
- `/workspace/tests/async-await.test.ts` — migrated to buildImports harness
- `/workspace/plan/issues/1042-async-await-state-machine-lowering.md` — full Slice 2A finding

## Resume notes for next gate-flip attempt

The machinery is done and proven. The ONLY thing standing between OFF and ON is the
consumption-contract analysis: every call site that currently does `asyncFn() as any as T`
needs to either (a) be detected and kept on the legacy synchronous path, or (b) drive the
Promise. This needs an architect spec, not a dev patch. When that lands, flip the gate,
re-run `tests/equivalence.test.ts` (must stay clean) and `tests/async-await.test.ts`, and
update `tests/issue-1042.test.ts` to assert the gate is ON.
