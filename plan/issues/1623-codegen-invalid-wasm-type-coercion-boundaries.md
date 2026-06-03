---
id: 1623
title: "codegen: invalid Wasm binary at type-boundary coercion (extern/anyref + struct ref types)"
status: done
created: 2026-05-20
updated: 2026-06-03
completed: 2026-06-03
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion, externref, wasm-gc
sprint: Backlog
renumbered_from: 1522
es_edition: n/a
test262_category: multiple (Iterator, Promise, Temporal, super, class)
test262_count: 530
related: [1289, 1287, 1400]
---
# #1522 — Codegen emits Wasm modules that fail validation at type boundaries

## Problem

Across the test262 baseline (run 2026-05-20, 17,055 fails) **~530 tests**
fail with `invalid Wasm binary`. These are codegen bugs — the compiler
produces a module whose Wasm validator rejects it before any user code
runs. Sub-clusters by failure shape:

| Count | Shape | Likely root cause |
|-------|-------|-------------------|
| 55 | `extern.convert_any expected anyref, found global.get of type externref` | Coercion path forgets that the global is already `externref`, double-wraps |
| 11 | `struct.get expected (ref null N), found local.get of (ref null M)` | Lost type identity at struct field load — mostly Temporal `order-of-operations` tests |
| 6  | `f64.trunc expected f64, found local.get of type externref` | Compound-assignment skips unbox for `externref` operand |
| 4  | `any.convert_extern expected shared externref, found global.get f64` | privatename / private-field paths emit wrong source type |
| 4  | `f64.ne expected f64, found local.get externref` | line-terminator tests — `!=` against an externref-typed binding |
| 3  | `any.convert_extern expected externref, found ref.cast null …` | `await-using` / Reflect — externref boxing layered on ref.cast |
| 2+ | `type error in fallthru (expected (ref null N), got externref)` | `super(...spread)` error-path return type widened to externref |
| 2  | `not enough arguments on the stack for if (need 1, got 0)` | `Array.prototype.filter` species-undefined — branch leaves stack empty |
| 2  | `not enough arguments on the stack for array.set (need 3, got 2)` | `Array.prototype.map` species-null — store path missing value |
| 2  | `not enough arguments on the stack for local.set (need 1, got 0)` | `Array.prototype.reduce` accumulator path drops result |
| 2  | `local.set expected (ref null 21), found struct.get of type f64` | `toLocaleString` resizable-buffer — wrong typed temp |

This is **distinct from** the ESLint-specific failures already filed
(#1287, #1289, #1400) — those were narrow worktree examples; this
ticket is an umbrella for the general type-boundary coercion gaps
showing up across the test262 corpus.

## Failing test examples

- `test/built-ins/Iterator/from/result-proto.js` — extern.convert_any double-wrap
- `test/built-ins/Promise/all/resolve-before-loop-exit.js` — extern.convert_any double-wrap
- `test/built-ins/Temporal/Duration/prototype/round/order-of-operations.js` — struct.get ref-type mismatch
- `test/language/expressions/compound-assignment/S11.13.2_A6.11_T1.js` — f64.trunc on externref
- `test/language/expressions/super/call-spread-err-sngl-err-expr-throws.js` — fallthru type
- `test/built-ins/Array/prototype/filter/create-species-undef.js` — not enough args on stack
- `test/built-ins/Array/prototype/map/create-species-null.js` — array.set missing arg

## Approach (high level)

1. Cluster the failures by Binaryen validator message — done in this issue.
2. For each shape, write a minimal repro into `.tmp/` and walk the IR
   before lowering to find where the type assumption diverges.
3. Most shapes look like missing/duplicate `coerceType` calls at
   value-flow joins (globals, struct fields, branch fallthrough).

## Acceptance criteria

- The 5 biggest sub-clusters (≥ 200 fails combined) compile to valid
  Wasm — even if the runtime semantics still differ.
- No new compile-error regressions in test262.
- Add at least one targeted regression test per fixed shape under
  `tests/`.

## Estimated impact

**~530 test262 compile errors** today; some unblock further runtime
fails behind them, so realised gain may exceed the raw count.

## Fix 2026-05-28 (issue-1623-extern-doublewrap / dev-1623) — sub-cluster #1

Targets the dominant sub-cluster: 53 fails with shape
`extern.convert_any[0] expected type anyref, found global.get of type externref`.

**Root cause.** `compilePropertyAccess` in `src/codegen/property-access.ts`
at the `(#799 WI4) Property not found on struct ... fall back to
__extern_get` branch unconditionally emits `extern.convert_any` after
compiling the receiver expression. The comment says "Coerce struct ref to
externref" but the receiver can already be externref — most notably `this`
inside a `static` method, where `compileExpression(expr.expression)`
returns the static class-object global (externref). `extern.convert_any`
expects an `anyref` operand, so the validator rejects the module.

**Fix.** Capture the receiver's compiled type and call `coerceType` to
emit the correct conversion (which is a no-op when source equals
destination kind):

```ts
const recvType = compileExpression(ctx, fctx, expr.expression);
if (recvType && recvType.kind !== "externref") {
  coerceType(ctx, fctx, recvType, { kind: "externref" });
}
```

(was: bare `extern.convert_any` after `compileExpression`).

**Repro** (was: `compile_error`, now: compiles and runs):

```ts
class C {
  static set #f(v) { throw new Error(); }
  static getAccess() { return this.#f; }
}
```

**Impact on the four canonical fails listed in this issue:**

| Test | Before | After |
|------|--------|-------|
| `Iterator/from/result-proto.js` | compile_error (extern.convert_any) | fail (runtime — `Cannot convert null to object`) |
| `class/elements/static-field-declaration.js` | compile_error | fail (assertion mismatch) |
| `class/elements/get-access-of-missing-private-static-getter.js` | compile_error | fail (assertion mismatch) |
| `Promise/prototype/then/capability-executor-called-twice.js` | compile_error (`found call of type externref`) | unchanged — different sub-cluster (#1623b) |

The first three are now valid Wasm; the runtime failures are downstream
issues outside the type-coercion scope. The Promise case is a different
shape (call-of-externref-result rather than global.get-of-externref) and
is not addressed by this fix.

**Scope.** Single-site fix in `src/codegen/property-access.ts:2517-2519`.
Adds `coerceType` to the imports from `./type-coercion.js`. Regression
test in `tests/issue-1623.test.ts`. 38 nearby tests (`#1605`, `#1680`,
`#1681`, `#1682`, `#1683`, `#1612`, `#1605-cpn`) still pass.

### Companion fix in `src/codegen/fixups.ts`

The peephole/late fixup passes (`fixupStructNewResultCoercion` and
`fixupExternConvertAny`) resolved `global.get` operands via
`ctx.mod.globals[gIdx]`. That array stores only the module-defined
globals — imported globals occupy the lower part of the combined Wasm
global index space. For any module that imports globals (the common
case), `globals[gIdx]` returned `undefined` for every import-side
index, so the safety net missed all redundant `extern.convert_any`
ops over imported externref globals.

Added a `getGlobalType(gIdx)` helper to both passes that resolves
combined indices against `ctx.mod.imports` first, then falls back to
`ctx.mod.globals`. Of the 53 baseline tests in the
`global.get of type externref` sub-cluster, 46 now compile to valid
Wasm (the remaining 7 are unrelated TS compile errors or different
codegen shapes). Regression test in
`tests/issue-1623-extern-doublewrap.test.ts`.

## Refreshed standalone evidence - 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The standalone root-cause classifier assigns **2,351** rows primarily to the
invalid-Wasm/type-boundary family owned by #1623 and adjacent issues
#1666/#1525b. Most of these are `compile_error` rows with `wasm_compile`
diagnostics; two are Promise-path rows sharing the same late-boundary shape.

This means the #1623 umbrella remains active even though the earlier
`extern.convert_any` imported-global sub-cluster was fixed. The latest
standalone artifact exposes broader validation failures at dynamic equality,
ToPrimitive/trampoline, late global, struct-ref, and boxed-value joins. Treat
the 2,351-row bucket as the current standalone invalid-Wasm budget to reduce,
while continuing to carve tightly-scoped sub-clusters when a validator message
has a single codegen site.


## Fix 2026-06-03 (issue-1623-standalone-typecoerce / dev-1623) — standalone dstr null-throw

Targets the dominant standalone invalid-Wasm sub-cluster: `Invalid global
index: 4294967295` (and the `throw expected externref, found call of type
f64` it masks) emitted at the destructuring null-throw guard under
`--target standalone` / `--target wasi` (nativeStrings mode).

**Two stacked root causes**, both in the destructuring null-throw path:

1. **nativeStrings `-1` global-index sentinel.** In nativeStrings mode
   `stringGlobalMap` maps each literal to `-1` (no real `string_constants`
   import global is emitted). `destructuring-params.ts` pushed the
   "Cannot destructure 'null' or 'undefined'" message and the `__extern_get`
   property-name keys via a bare `{ op: "global.get", index: strIdx }` where
   `strIdx === -1`. `-1` serialises to u32 `0xFFFFFFFF` (4294967295) →
   "Invalid global index". Fixed by routing all three sites through
   `stringConstantExternrefInstrs` (native-strings.ts), which materialises the
   NativeString struct inline and `extern.convert_any`s it in nativeStrings
   mode, and emits the plain `global.get` only when a real import global
   exists.

2. **`__new_TypeError` mid-prologue emission clobber.**
   `buildDestructureNullThrow` lazily called `emitWasiErrorConstructor` while
   compiling a user function's *prologue* — at which point the user function's
   own array slot is reserved but not yet pushed. The constructor took that
   reserved slot, the user function clobbered it on its own push, and the
   funcMap `__new_TypeError` index ended up pointing at the user function
   (which returns f64) → "throw expected externref, found call of type f64".
   Fixed by a pre-pass in `index.ts` that emits the WASI/standalone error
   constructor BEFORE any user function compiles, when the source contains a
   binding pattern (`sourceContainsBindingPattern`). The emitter is
   idempotent, so the later `buildDestructureNullThrow` call is a no-op
   resolve.

**Impact (500-file random sample of standalone `compile_error` rows,
harness-wrapped, measured via `WebAssembly.compile`):** 15 modules that
previously failed Wasm validation now validate. The destructuring null-throw
sub-cluster is eliminated. 54 unrelated invalid-Wasm rows remain (extern-arg
coercion, `any.convert_extern` on `ref.cast`, `f64.eq`-on-call, …) — separate
sub-clusters tracked by the same umbrella.

**Files:**
- `src/codegen/destructuring-params.ts` — `stringConstantExternrefInstrs` at
  the 3 string-push sites in `buildDestructureNullThrow` and
  `destructureParamObjectExternref`; `__new_TypeError` resolved via
  `ensureLateImport` + `flushLateImportShifts`.
- `src/codegen/index.ts` — `sourceContainsBindingPattern` helper + pre-pass
  emitting the error constructor ahead of user functions.
- `tests/issue-1623.test.ts` — 3 standalone regression tests (object-param
  dstr, typed-struct dstr stays valid).

**Known residual (out of scope):** array-PARAM destructuring (`[a,b]: any`)
in standalone still emits `call expected externref, found array.get of type
f64` — a distinct array-dstr coercion bug, not the null-throw path.
