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
