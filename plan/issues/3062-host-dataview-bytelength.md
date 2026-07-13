---
id: 3062
title: "codegen: DataView.byteLength / byteOffset return NaN in JS-host mode (native accessor gated to standalone only)"
status: done
completed: 2026-07-06
sprint: 71
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: dataview, typed-arrays
goal: spec-completeness
related: [3061, 2159, 1064]
depends_on: [3061]
test262_bucket: dataview-bytelength-byteoffset-host
test262_count: 13
assignee: ttraenkler/dev-cycleC
origin: "2026-07-06 harvest (dev-cycleC). #3061 follow-up; stacked on PR #2753. origin/main; default (JS-host) lane."
---

# #3062 — `DataView.byteLength` / `byteOffset` NaN in JS-host mode

## Problem

`dv.byteLength` and `dv.byteOffset` on a `DataView` return **NaN** in JS-host
(`gc`) mode. #3061 fixed the same defect for plain `ArrayBuffer` but deliberately
left DataView (and TypedArray) standalone-only because their host-mode backing is
a **windowed** view over the buffer, not a bare `i32_byte` vec.

In JS-host mode `new DataView(buffer, byteOffset, byteLength)` returns the raw
`i32_byte` buffer struct itself (no `$__dv_window` wrapper — that shape is
standalone-only, see `new-super.ts`). The view window is recorded out-of-band by
`__dv_register_view(buf, offset, length)` into the `_dvViewMeta` WeakMap
(`src/runtime.ts`), keyed on the struct. The native accessor arm in
`property-access.ts` that reads the window (`$__dv_window` field 1/2) is gated to
`noJsHost(ctx)`, so in host mode `dv.byteLength` / `dv.byteOffset` fall through to
the generic `__extern_get(struct, "byteLength")`, which returns `undefined`
(byteLength/byteOffset are not real struct fields) → **NaN**.

```ts
export function test(): number {
  const buf = new ArrayBuffer(12);
  const dv = new DataView(buf, 4);
  return dv.byteLength; // was NaN, spec wants 8 (bufLen 12 − offset 4)
}
```

## Fix

Add a JS-host accessor arm for DataView `byteLength` / `byteOffset` that reads the
window recorded in `_dvViewMeta`. A single host import
`__dv_view_byte_attr(view: externref, sel: i32) -> i32`:

- `sel === 0` → `byteOffset` = `meta.offset` (0 if no meta).
- `sel === 1` → `byteLength` = `meta.length` if concrete, else
  `__dv_byte_len(view) − meta.offset` (the `length === -1` NaN sentinel that
  `__dv_register_view` writes for externref-buffer views).

The `_dvViewMeta` sidecar already exists (written at construction, read by the
`__extern_method_call` DataView method-dispatch fallback). This reuses it for the
byteLength/byteOffset accessors. Detached-buffer / resize-tracking semantics are
out of scope (those tests fail for independent reasons and are unchanged).

Single import + one new arm in `src/codegen/property-access.ts`; runtime helper in
`src/runtime.ts`. Standalone/WASI path unchanged (`$__dv_window` arm still runs).

## Acceptance criteria

1. `new DataView(new ArrayBuffer(12), 4).byteLength === 8`,
   `.byteOffset === 4` in host mode.
2. `new DataView(buf, 6, 4).byteLength === 4`; offset-0 default-length view
   reports full buffer byteLength.
3. No regression for standalone DataView, ArrayBuffer, TypedArray, or plain
   objects with an own `byteLength` property.
4. Regression test: `tests/issue-3062-host-dataview-bytelength.test.ts`.

Flips the DataView `byteLength` / `byteOffset` value clusters
(`built-ins/DataView/prototype/{byteLength,byteOffset}/return-*.js`,
`built-ins/DataView/defined-bytelength-and-byteoffset.js`, plus byteLength/
byteOffset value assertions spread across other DataView ctor tests).
