---
id: 1904
title: "standalone: native __extern_is_array predicate for Array.isArray over Wasm carriers"
status: ready
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: arrays, objects
goal: standalone-mode
parent: 1472
related: [1328, 1678, 1888]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
---
# #1904 — Native `__extern_is_array` for standalone

## Problem

The standalone dynamic object/property bucket still samples:

```text
Codegen error: '__extern_is_array' ... not yet supported in --target standalone
```

`Array.isArray` already has host-mode and compile-time paths, but any dynamic or
externref-shaped value falls through to `__extern_is_array`, which the broad
`__extern_*` standalone refusal catches. That blocks destructuring,
Array/TypedArray construction guards, and test262 harness checks that only need
a native brand predicate.

## Scope

- Add a standalone-native implementation for `__extern_is_array`.
- Route it through `OBJECT_RUNTIME_HELPER_NAMES` or an equivalent standalone
  native helper path before `STANDALONE_REFUSED_IMPORT`.
- Recognize the Wasm carriers that this compiler uses for arrays/rest vectors
  under standalone. Do not claim Proxy/exotic host arrays that cannot exist
  without a JS host.

## Acceptance Criteria

- `Array.isArray` over a standalone-emitted array/rest/vector carrier returns
  true where the JS semantics require an array result.
- Non-array `$Object` and primitive values return false without trapping.
- The regression test compiles and instantiates under `target: "standalone"`
  with no `env::__extern_is_array` import.
- JS-host/default behavior is unchanged.

