---
id: 1905
title: "standalone: native Reflect.get/set/has/deleteProperty over $Object"
status: in-progress
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: reflection, objects
goal: standalone-mode
parent: 1472
related: [1472, 1466, 1629, 1888]
test262_bucket: standalone-reflect-refusal
test262_count: 309
claimed_by: codex-developer
claimed_at: 2026-06-07T00:35:56.934Z
---
# #1905 — Standalone native Reflect object subset

## Problem

The standalone report still has `309` failures in
`standalone-reflect-refusal`. `#1472` deliberately routed only
`Reflect.ownKeys` to native `__object_keys` and refused the rest to avoid
leaking `env::__reflect_*` imports.

The obvious `$Object` subset is now implementable:

- `Reflect.get(target, key[, receiver])`
- `Reflect.set(target, key, value[, receiver])`
- `Reflect.has(target, key)`
- `Reflect.deleteProperty(target, key)`

`Reflect.apply` and `Reflect.construct` remain separate call/constructor
machinery and are out of scope here.

## Scope

- Implement the object-runtime-backed subset for standalone only.
- Reuse existing `__extern_get`, `__extern_set`, `__extern_has`/keyed has, and
  `__delete_property` helpers where semantics line up.
- Preserve boolean return semantics for `Reflect.set`, `Reflect.has`, and
  `Reflect.deleteProperty`.
- Keep descriptor/prototype/integrity methods refused unless they are proven
  correct in this slice.

## Acceptance Criteria

- Focused tests in `tests/issue-1905.test.ts` cover get/set/has/deleteProperty
  on open `$Object` values under `target: "standalone"`.
- No `env::__reflect_*` imports leak under standalone.
- Unsupported Reflect methods still refuse loud with a tracked issue cite.
- Default/gc mode still uses the host Reflect bridge.

## Implementation Notes

- Added standalone lowering for `Reflect.get`, `Reflect.set`, `Reflect.has`,
  and `Reflect.deleteProperty` before the existing Reflect refusal path.
- `Reflect.get`, `Reflect.has`, and `Reflect.deleteProperty` route to the
  existing native `$Object` helpers: `__extern_get`, `__extern_has`, and
  `__delete_property`.
- Added native `__reflect_set` as a boolean-returning wrapper around
  `__extern_set` so ordinary assignments keep their void ABI while
  `Reflect.set` reports false for the object-runtime write refusals it can
  prove: frozen data writes, non-extensible new keys, non-writable own data
  properties, getter-only accessors, and non-`$Object` receivers.
- Descriptor/prototype/integrity methods, `Reflect.apply`, and
  `Reflect.construct` remain on the standalone refusal path with the existing
  `#1472 Phase C` cite.

## Validation

- `pnpm test tests/issue-1905.test.ts`
- `pnpm test tests/issue-1472.test.ts -t "unsupported Reflect"`
- `pnpm exec prettier --check src/codegen/object-runtime.ts src/codegen/expressions/calls.ts tests/issue-1472.test.ts tests/issue-1905.test.ts`
- Also tried the full `tests/issue-1472.test.ts`; it still has unrelated
  pre-existing failures in Object prototype and open-any method-dispatch cases,
  so validation for this issue stayed scoped to the changed Reflect refusal
  regression.
