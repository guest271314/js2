---
id: 1904
title: "standalone: native __extern_is_array predicate for Array.isArray over Wasm carriers"
status: in-review
pr: 1259
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
claimed_by: codex-developer
claimed_at: 2026-06-07T01:10:23.877Z
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

## Implementation Notes

- Routed `__extern_is_array` through the standalone object-runtime native helper
  path before the broad `__extern_*` refusal.
- Reserved the helper with `ensureObjectRuntime`, then filled its body during
  finalize after all Wasm array carriers are known.
- The native predicate recognizes `$ObjVec`, `__vec_*`, and template vector
  carriers; primitives, `$Object`, and other externrefs return false.
- Proxy/host exotic recursion from ES §7.2.2 is intentionally out of scope for
  standalone because those carriers cannot exist without a JS host.

## Validation

- `npm test -- tests/issue-1904.test.ts`
- `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts`
- `npm run typecheck`

Final Codex rerun on 2026-06-07: all scoped validation passed.
