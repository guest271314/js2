---
id: 1905
title: "standalone: native Reflect.get/set/has/deleteProperty over $Object"
status: ready
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

