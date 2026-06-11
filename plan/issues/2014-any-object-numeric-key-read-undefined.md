---
id: 2014
title: "numeric-key element access on any-typed object returns undefined though the property exists (o[2] vs o['2'])"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: host-interop
language_feature: objects
goal: core-semantics
related: [1971, 140]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2014 — __extern_get_idx struct fallback misses object-literal numeric fields

## Problem

```ts
const o: any = { 2: "two" }; const i = 2;
o[2] + "," + o[i] + "," + o["2"]
// wasm: "undefined,undefined,two"   node: "two,two,two"
```

Spec: numeric and string keys are the same property (§6.1.7 ToPropertyKey).

## Root cause

`src/runtime.ts:5217` — `__extern_get_idx`'s WasmGC-struct fallback relies
on `__sget_<name>` getter exports that aren't emitted for object-literal
numeric fields; the string-key path goes through `__extern_get`/`_safeGet`
field-name lookup, which works. Numeric keys route to the idx import,
string keys to the working one.

## Fix direction

In `__extern_get_idx`, fall back to the field-name lookup with
`String(idx)` for struct receivers (or emit `__sget_<n>` exports for
numeric fields).

## Acceptance criteria

- All three accesses return "two"; array indexing unchanged

## Dupe check

#140 (done, computed property names); #1971 item 1 covers computed-key
*creation*. New.
