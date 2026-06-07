---
id: 1903
title: "standalone object runtime: __obj_find emits invalid Wasm in dynamic-property bucket"
status: ready
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property-access
goal: standalone-mode
parent: 1472
related: [1472, 1888]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
---
# #1903 — Standalone object runtime: `__obj_find` invalid Wasm

## Problem

The current standalone report still classifies `8,163` failures under
`standalone-dynamic-object-property`. One sample signature is a validator error
inside the native object runtime:

```text
invalid Wasm binary ... "__obj_find" failed: i32.and expected type i32, found call of type externref
```

This is not a missing feature. It is a bad Wasm emission inside the runtime that
should be fixed before larger object-model work, because it can mask real
remaining semantic failures.

## Scope

- Inspect `src/codegen/object-runtime.ts`, especially `__obj_find` and flag/key
  checks around tombstones/accessor/data entries.
- Find the path where an externref-producing helper is left on the stack for an
  `i32.and`.
- Preserve the existing `$Object`/`$PropMap` representation and dual-mode
  invariant: standalone native path only, JS-host mode unchanged.

## Acceptance Criteria

- Add a focused regression test in `tests/issue-1903.test.ts` that previously
  forces the invalid `__obj_find` shape.
- The test compiles with `target: "standalone"`, validates with
  `WebAssembly.validate`, and instantiates with an empty import object.
- The generated module has no `env::__extern_*`, `env::__object_*`, or
  `env::__new_plain_object` imports.
- No broad refactor of the object runtime.

