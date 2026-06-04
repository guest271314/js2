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
sprint: 59
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
