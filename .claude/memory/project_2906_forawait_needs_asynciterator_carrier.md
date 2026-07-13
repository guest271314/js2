# #2906 3b — for-await-of drive is blocked BELOW the machine (carrier + implicit-await)

The #2906 CFG drive machine (3a) is **already sufficient** to drive a for-await
loop: the spec-equivalent index lowering `while (i < src.length) { const x =
await src[i]; i++ ; body }` written as REAL source compiles host-free and runs
correctly on the 3a while-with-await machine (`[P.resolve(1..3)]` → 6, drains
fine). No emitter/planner change is needed for for-await.

Two blockers sit **below** the drive machine (the "more than the drive machine"
case):

1. **Implicit-await coupling.** `for await` emits **no `ts.AwaitExpression`** —
   the per-element suspension is implicit in `awaitModifier`. So
   `analyzeAsyncBody` reports **0 await points**, and every `awaitPoints`-keyed
   gate (`asyncFnNeedsDrive`, `asyncFnNeedsCps`, `computeAsyncSpills`) treats the
   fn as non-suspending → AG0 unwrap → **for-await over pending promises yields
   NaN** (measured on main). Fixing needs an analyzer change (recognize
   `awaitModifier` for-of as a suspend point) or a dedicated `planForAwaitCfg`
   that doesn't key off `plan.awaitPoints`.

2. **No native async-iterator carrier in standalone/wasi.**
   `ensureAsyncIterator` (destructuring.ts:397) returns the **SYNC** `__iterator`;
   `next()` is synchronous `(i32 done, externref value)`, never a `$Promise`.
   The general for-await (Symbol.asyncIterator sources, async generators,
   non-array iterables) needs `GetAsyncIterator` + `AsyncFromSyncIterator` +
   `next()`→native `$Promise<IteratorResult>` — same carrier async-gen (3d)
   needs.

**Synthetic-AST desugar does NOT work.** Desugaring for-await into a synthetic
`while` (index lowering) and threading a synthetic `updateFunctionDeclaration`
through the pipeline: (a) crashes on missing `parent` pointers (fix:
`ts.setParentRecursive`), then (b) **silently produces wrong values (loop never
runs, sum=0)** because the checker cannot type synthetic identifiers —
`getTypeAtLocation(__src)` returns error/any, so `.length` and the numeric index
take the wrong (string-key/non-array) compile path. js2wasm codegen is
checker-heavy on property/element/index access; synthetic AST there is a wall.
General lesson: **do not synthesize TS AST that flows through checker-dependent
property/element/index-access codegen** — wrap real (checker-typed) expressions
in synthetic *statement* wrappers only (the generators-native.ts `lowerFor`
pattern), or emit Wasm helpers directly.

Landed for 3b: banking only (issue doc + this note); the drive machine stays
ready, the carrier is the real next step.

## UPDATE (2026-07-04): carrier BUILT — for-await works host-free.

Both blockers are now closed (branch `issue-2906-asynciter-carrier`, opus-asynciter):
`for await (x of [P.resolve(1),P.resolve(2),P.resolve(3)]) sum+=x` → **6, imports
`[]`** (was NaN). The approach that WORKED — reuse the 3a machine, do NOT build a
Promise-returning native next():

1. **Implicit-await coupling.** `AsyncCpsPlan` gained `forAwaitPoints` (ForOf with
   `awaitModifier`, collected in `analyzeAsyncBody`); `asyncFnNeedsDrive` accepts a
   bounded for-await-only body (awaitPoints===0 && forAwaitPoints===1) as
   suspending.
2. **Carrier = the SYNC iterator + a per-element `await value`.** The dominant
   sync-backed shape is spec-equivalent to `it = GetAsyncIterator(src); loop {
   {done,value}=it.next(); if done break; x = await value; body }` — one suspend
   per iteration = the 3a while machine. So NO native async-next()→$Promise was
   needed. `ensureAsyncIterator` (destructuring.ts) already returns the native
   `__iterator` in standalone; each element (a Promise) is awaited by the stock
   suspend terminator (Await(P.resolve(1))=1). `planForAwaitCfg` (async-cps.ts)
   builds the 5-state CFG (entry/head/body/resume/exit).
3. **Emit-hook operands (the AST-free escape hatch).** `it.next()`, the done flag
   and the element are runtime wasm-local ops, NOT checker-typed AST — so the
   plan's `suspend.awaited` / `condGoto.cond` were widened to
   `ts.Expression | {emit}` and states gained an `emit?` step hook. This is how we
   sidestep the #2367 synthetic-AST wall WITHOUT synthesising any AST. Existing
   linear/while plans use no hooks → byte-identical.
4. **Drive gate = BOXED elements only.** `forAwaitNeedsDrive` checks
   `srcType.getNumberIndexType()` → resolveWasmType: externref/ref ⇒ drive;
   f64/i32 (number[]) ⇒ LEGACY (Await(v)=v is already correct, and the typed array
   would trap the vec `__iterator` — driving it was a regression). Non-array/user-
   iterable (undefined index type) ⇒ legacy (3b′). The synthetic iterator is a
   frame spill (`FORAWAIT_ITER_SPILL`).

Byte-inertness: gc+standalone identical for all; wasi identical except a
for-await. `number[]` for-await byte-identical to main (legacy). **3d (async-gen)
is unblocked** — same emit-hook carrier + forAwaitPoints coupling, planner-only.
Files: `src/codegen/async-cps.ts` (forAwaitPoints, emit-hook types,
analyzeForAwait/forAwaitNeedsDrive/forAwaitSpillInfo/planForAwaitCfg),
`src/codegen/async-frame.ts` (asyncFnNeedsDrive branch, computeForAwaitSpills,
suspend/condGoto/state emit-hook emitters), `tests/issue-2906-3b-forawait.test.ts`.
