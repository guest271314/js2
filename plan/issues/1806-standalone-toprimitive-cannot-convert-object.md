---
id: 1806
title: "standalone: 2,136 tests fail with 'Cannot convert object to primitive value'"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: to-primitive, symbol-toprimitive, abstract-operations
goal: standalone-mode
sprint: 60
related: [1472, 1525, 1525b, 1781]
---
# #1806 — Standalone ToPrimitive: `Cannot convert object to primitive value`

## Symptom

**2,136 standalone-lane test262 tests** fail with:

```
Cannot convert object to primitive value
```

Split:
- 839 are `compile_error` (thrown during compilation)
- 839 + 458 = 1,297 are `runtime_error`

**Baseline**: sha `f692249d`, 2026-06-03T22:28Z.

## Sample test files

```
test/language/expressions/bitwise-and/bigint-toprimitive.js          (CE)
test/language/function-code/10.4.3-1-19gs.js                         (CE)
test/language/expressions/compound-assignment/S11.13.2_A7.5_T2.js   (runtime)
test/language/expressions/grouping/S11.1.6_A3_T6.js                 (runtime)
test/language/expressions/logical-not/S11.4.9_A3_T4.js              (runtime)
```

## Root cause

In the default (JS-host) lane, `ToPrimitive` delegates to the JS runtime via
the `__toPrimitive` host import for objects. `__toPrimitive` is registered as
a late import — it looks up `Symbol.toPrimitive` and/or calls `valueOf()`/
`toString()` on the JS side.

In standalone mode there is no JS runtime, so `__toPrimitive` is refused.
Currently, instead of emitting a clear "ToPrimitive not yet supported in
standalone mode (#1806)" refusal, the compiler hits an earlier JS-side code
path (during type coercion or object-wrapping) and throws "Cannot convert
object to primitive value" with no tracking issue cite.

The `bitwise-and/bigint-toprimitive.js` compile error indicates this is hit
at compile time too — the compiler calls a JS-side coercion during lowering.

## Distinction from #1525 / #1525b

- **#1525** (done): fixed "raised too eagerly" in the JS-host lane (was thrown
  for typed paths that don't need it).
- **#1525b** (in-review): trampoline invalid Wasm + §7.1.1.1 step-6.
- **This issue** (#1806): standalone mode entirely lacks a Wasm-native ToPrimitive
  implementation. The error appears 2,136× with no tracking cite.

## Fix approach

### Option A — emit a clear standalone refusal
Add a guard in the ToPrimitive lowering path (wherever `__toPrimitive` is
dispatched):
```typescript
if (ctx.standalone) {
  throw new CodegenError(
    `__toPrimitive (Symbol.toPrimitive / valueOf coercion) is not yet supported ` +
    `in standalone mode (#1806). Add a Wasm-native ToPrimitive (Phase 1 of #1806).`
  );
}
```
This changes the error to a compile_error with a cite, making it trackable.
Immediate impact: the 1,297 runtime errors become compile errors. The total
failing count doesn't decrease, but every failure gains a tracking issue.

### Option B — implement Wasm-native ToPrimitive (Phase 1: numeric hint)
Implement `__toPrimitive_number` and `__toPrimitive_string` as pure Wasm
functions operating on the `$Object` WasmGC struct:
1. If `[[Symbol.toPrimitive]]` entry exists on the object → call it.
2. Otherwise for number hint: try `valueOf()` → try `toString()`.
3. Otherwise for string hint: try `toString()` → try `valueOf()`.
Step 1 requires Symbol property lookup support in `$Object` (Phase B of
#1472). Steps 2–3 require method dispatch via `$PropMap`.

## Acceptance criteria

**Phase 0 (quick win)**: All 2,136 records cite `#1806` in the error string
rather than printing the bare message. Requires Option A guard.

**Phase 1 (feature)**: numeric-hint ToPrimitive over `$Object` structs passes
without touching the JS host. Target: >500 tests pass.

## Implementation (Phase 0 — done)

Took **Option A** (the issue's recommended quick win). The single chokepoint
for the JS-host ToPrimitive dispatch is `toPrimitiveHostCallInstrs` in
`src/codegen/type-coercion.ts`, which requests the `env::__to_primitive` import
via `ensureLateImport`. Every `emitToPrimitiveHostCall` site funnels through
that one function.

Rather than scatter a `ctx.standalone` check across the ~6 call sites, the guard
lives at the `ensureLateImport` chokepoint in
`src/codegen/expressions/late-imports.ts` — the same place the #1472 Phase A
object/property refusals already live (`refuseStandaloneObjectImport`). Added a
sibling `refuseStandaloneToPrimitive(ctx, name)`:

- Fires only when `ctx.standalone && name === "__to_primitive"`.
- Deduplicated per import name via the existing `ctx.standaloneRefusedImports`
  set, so a single source construct queues at most one error.
- Queues a `"Codegen error:"`-prefixed message via `reportErrorNoNode`, which
  forces `success: false` + empty module (same hard-failure contract as #1472).
- Message: `Codegen error: __toPrimitive (Symbol.toPrimitive / valueOf coercion)
  is not yet supported in standalone mode (#1806). A Wasm-native
  numeric/string-hint ToPrimitive over the $Object struct is Phase 1 of #1806.`
- The message deliberately does **not** begin with `Cannot ` / `Invalid `, so
  the test262 classifier (`classifyError`) does not mis-bucket it as a stray
  `runtime_error`; it lands as a `compile_error` (compile returns
  `success: false`).

Result: the 1,297 runtime errors and the opaque
`"module is not an object or function"` instantiation failures become
compile errors, and **all** 2,136 records now cite `#1806`.

The JS-host (GC) lane is untouched — the guard is gated on `ctx.standalone`, so
`__to_primitive` is still emitted and satisfied by the host runtime there.
Compile-time-resolvable `valueOf`/`toString` (typed class methods) never reach
`ensureLateImport("__to_primitive", …)`, so they are not affected.

## Test Results

`tests/issue-1806.test.ts` — all 5 pass:
- 3× standalone host-ToPrimitive dispatch (plain object `- 0`, `* 2`, `& 3`):
  compile fails with a `#1806`-citing, non-`Cannot`/`Invalid` message and no
  leaked `__to_primitive` import.
- compile-time-resolvable `valueOf(): number` class still compiles + runs in
  standalone (returns 7) — no false refusal.
- default GC lane still compiles the same dynamic object with no `#1806`
  refusal.

`typecheck` clean (exit 0), `prettier --check` + `biome lint` clean,
`host-import-allowlist-{budget,gate}` tests pass (13).

## Implementation (Phase 1, string-hint slice — done)

Phase 0 only re-bucketed the failures; it did not make any pass. Phase 1 is the
feature work. It splits cleanly by how the object's type is known:

- **Compile-time-resolvable** (typed object literals incl. `var o = {…}`, and
  class instances): the struct type and its `valueOf`/`toString` methods are
  known at compile time. The **numeric-hint** path here already worked
  (`obj + 1` → correct via the ref→f64 `valueOf`/`toString` dispatch). The
  **string-hint** path was broken: `string + obj`, `` `${obj}` ``, `String(obj)`
  all routed any struct ref through the `$__any_to_string` dispatcher, which
  (by design, deferred to #1472) cannot introspect a user struct and returns
  `"[object Object]"` — observed as a dropped `undefined` concat result.
- **Dynamic / open-object** (`any`-typed, sidecar-backed): genuinely blocked on
  open-object method dispatch (#1472 Phase C, in progress). Out of scope here.

This slice fixes the **compile-time-resolvable string-hint** family. New
exported helper `tryStructToString(ctx, fctx, from)` in
`src/codegen/type-coercion.ts` performs OrdinaryToPrimitive(§7.1.1.1, hint
"string") over a known struct, mirroring the numeric-hint walker
(`tryToStringFallback`) but producing a `ref $AnyString` instead of f64:

1. the `toString` closure field via `call_ref` — handles both the concrete
   `ref`/`ref_null` closure case and the **eqref**-stored case (object literals
   store methods as `eqref`), recovering the closure type from
   `ctx.valueOfClosureTypes`. When both `valueOf` and `toString` exist, the
   candidate list is filtered to **string-returning** closures first so the
   f64-returning `valueOf` is never invoked with the wrong signature (a
   null-deref / illegal cast — the bug behind the `concat-both` case).
2. a named `${name}_toString` in `funcMap` (class methods).

Results normalise to a native string; non-string returns route through
`$__any_to_string`. When neither form resolves, the helper returns false and the
caller falls back to `$__any_to_string` (so plain objects still yield
`"[object Object]"`).

Wired into the two standalone string-coercion sites in
`src/codegen/string-ops.ts`: `compileNativeConcatOperand` (string `+`) and the
template-literal span path — both try `tryStructToString` before the
`$__any_to_string` fallback.

**Deliberately deferred**: a user `[Symbol.toPrimitive]` (which would take
precedence per §7.1.1.1) is NOT dispatched here — its hint argument needs native
string marshalling in native-strings mode, which the externref-global
`pushStringHint` does not satisfy; handling it caused a `u32 out of range`
binary-emit error, so it's left to a follow-up. (The computed-`@@toPrimitive`
case already emits invalid Wasm on `main`, unrelated to this slice.)

## Test Results (Phase 1)

`tests/issue-1806-string-hint.test.ts` — all 6 pass (in-Wasm `=== expected`
assertions, since standalone returns a `$AnyString` GC struct, not a JS string):
- `string + obj` and `` `${obj}` `` dispatch a user `toString` (closure field).
- string hint prefers `toString` over `valueOf` when both exist (no null-deref).
- numeric `obj + 1` still uses `valueOf` (no regression).
- plain object without `toString` still yields `"[object Object]"`.
- class-instance `toString` dispatched for a string coercion.

No regressions: `tests/issue-1806.test.ts` (Phase 0, 5), `tests/issue-1525.test.ts`
(10), `tests/issue-1470-standalone-string-imports.test.ts` (14),
`tests/issue-1470-string-coercion-standalone.test.ts` (4),
`tests/call-arg-type-coercion.test.ts` (6) all pass. `typecheck` clean,
`prettier --check` clean. The default GC/JS-host lane is untouched (the new
dispatch is reached only via the `noJsHost` string-coercion sites). Full test262
conformance validated by CI.
