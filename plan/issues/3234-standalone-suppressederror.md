---
id: 3234
title: "Standalone: native SuppressedError multi-error aggregation in the DisposableStack dispose driver"
status: done
assignee: ttraenkler/opus-suppressed
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: 71
horizon: m
related: [3231, 1781]
umbrella: 1781
loc-budget-allow:
  - src/codegen/disposable-runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/builtin-tags.ts
---

# Standalone: native SuppressedError multi-error aggregation (#3231 Phase 1b follow-up)

## Problem

In `--target standalone` the native `DisposableStack` dispose driver
(`fillDisposableStackDisposeDriver`, `src/codegen/disposable-runtime.ts`, landed
by #3231 Phase 1a/1b) ran each stored disposer LIFO **without** try/catch, so the
first disposer that threw unwound out of `dispose()` immediately and the
remaining disposers never ran. Per §DisposeResources the spec requires running
EVERY disposer and, when more than one throws, chaining the errors into nested
`SuppressedError` instances (LIFO-with-suppression: each new error suppresses the
accumulated one — `.error` = the newer error, `.suppressed` = the prior).

Additionally, `instanceof SuppressedError` and the `.error` / `.suppressed`
accessor reads leaked host imports standalone (`__instanceof`,
`SuppressedError_get_error`, `SuppressedError_get_suppressed`), so a module that
merely inspected a caught SuppressedError could not instantiate.

## Scope (this issue)

Native, `nativeStrings`/standalone-gated, host lane byte-identical:

1. `SuppressedError` added to `BUILTIN_TYPE_TAGS` (tag −18) + `BUILTIN_PARENT`
   (→ `Error`) so its native `$Error_struct` discriminates for `instanceof`.
2. Native `instanceof SuppressedError` (and `instanceof Error` for a
   SuppressedError) via the field-0 tag check — `collectErrorInstanceOfTags`
   - the error-family `instanceof` gate in `expressions/identifiers.ts`.
3. Native `.error` / `.suppressed` reads via the `$Error_struct.$props`
   (fieldIdx 5) open-object backing (`emitExternrefBackedOwnFieldRead`,
   reusing the #2101a own-field read + #3137 AggregateError `.errors` pattern),
   intercepted in `compileExternPropertyGet`. Identity-preserving (`ref.eq`).
4. Dispose driver aggregation: each disposer invocation wrapped in
   `try`/`catch $exn`; every disposer runs even if a prior threw; on the first
   throw `pending = err`, on each subsequent throw
   `pending = SuppressedError{ error: newer, suppressed: prior }` (built inline
   from a plain `$props` object via `__new_plain_object`/`__extern_set` + a
   `$Error_struct` with the SuppressedError tag); the final completion is
   rethrown via the module `$exn` tag. Single error is rethrown as-is.

Native `new SuppressedError(error, suppressed, message)` **construction** is NOT
in scope (still host in standalone) — the aggregation builds SuppressedError
structs internally without the constructor.

## Implementation

- `src/codegen/builtin-tags.ts` — `SuppressedError: -18` + `BUILTIN_PARENT`.
- `src/codegen/expressions/identifiers.ts` — `collectErrorInstanceOfTags` +
  the `noJsHost` error-family `instanceof` gate recognise `SuppressedError`
  (NOT added to `WASI_ERROR_NAMES` — its ctor arity differs; the tag check is
  all `instanceof` needs).
- `src/codegen/property-access.ts` — `compileExternPropertyGet` intercepts
  `SuppressedError.error` / `.suppressed` in `nativeStrings` mode →
  `emitExternrefBackedOwnFieldRead`.
- `src/codegen/disposable-runtime.ts` — `reserveDisposableStackDisposeDriver`
  pre-registers the object runtime + `$Error_struct` + key strings (compile
  time, so the finalize-time fill can resolve them); the fill wraps each
  disposer in try/catch, aggregates, and rethrows.

## Test plan

`tests/issue-3234-standalone-suppressederror.test.ts` — 3-error LIFO nesting
(matches test262 `throws-suppressederror-if-multiple-errors-during-disposal`),
single-error-as-is, run-every-disposer, 2-error aggregation, no-host-leak, host
lane unchanged. All green; the 20 existing #3231 tests still pass (incl. the
host-lane byte-identity gate).

## Measured flip-count (honest)

**0 immediate test262 standalone flips.** This is a correct host-free
**prerequisite**, not itself a flip lever, because:

- The `built-ins/DisposableStack/prototype/dispose` SuppressedError tests
  (`throws-suppressederror…`, `throws-error-as-is…`) are blocked UPSTREAM: the
  test262 runner hoists a nested-closure-captured `var stack` to `let stack:
any`, and native DisposableStack method dispatch keys on
  `className === "DisposableStack"` (`expressions/extern.ts:133`), which fails
  on an `any`-typed receiver → `stack.defer(fn)` / `stack.dispose()` leak
  `DisposableStack_defer` + `__make_callback` BEFORE dispose even runs. That is
  a separate **any-receiver builtin-native dispatch** gap (see follow-up),
  distinct from #2151 (which closed only object-literal any-receiver dispatch).
  `throws-suppressederror…` also fails in HOST mode (a runner assert-harness
  artifact), so it is un-passable in the runner regardless.
- The `built-ins/SuppressedError` tests that pass standalone (7/22) are
  descriptor-only (`name`, `prop-desc`, `prototype/*`) and pass pre-existing via
  #2861 proto glue — they exercise none of this change's paths. The 12 failing
  ones need native `new SuppressedError` construction (out of scope).

The aggregation is verified byte-for-byte correct against the exact test262
assertion sequence (the 3-error body returns 31 = all five asserts). Once
any-receiver builtin dispatch lands, the dispose SuppressedError cluster flips.
