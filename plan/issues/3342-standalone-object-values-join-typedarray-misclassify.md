---
id: 3342
title: "standalone: Object.values(o).join / Object.getOwnPropertyNames(o).join misclassify receiver as Uint8ClampedArray → leak env::Uint8ClampedArray_join"
status: ready
sprint: current
created: 2026-07-17
priority: medium
horizon: s
feasibility: medium
model: opus
task_type: fix
area: codegen
language_feature: standalone-completeness, array-join, type-inference
goal: standalone-parity
related: [3155, 3170]
origin: "carved out of #3155 (fix-standalone-object-keys-join, opus-c 2026-07-17) — Object.keys().join was fixed via the native externref-join path, but Object.values()/getOwnPropertyNames() take a DIFFERENT, distinct-root-cause path."
---

# #3342 — standalone `Object.values(o).join` / `Object.getOwnPropertyNames(o).join` leak `env::Uint8ClampedArray_join`

## Source

Surfaced while fixing **#3155** (standalone `Object.keys(o).join(sep)`). That fix
added a native externref-`join` path (`compileArrayJoinExternNative`,
array-methods.ts) reached when the join-dispatch classifies the receiver as an
externref. `Object.keys(o).join(...)` now works host-free standalone.

But `Object.values(o).join(...)` and `Object.getOwnPropertyNames(o).join(...)`
take a **different** dispatch path and are NOT fixed by #3155.

## Problem (measured, current main + #3155 branch)

```ts
export function test(): boolean {
  const o: any = { a: 1, b: 2 };
  return (Object.values(o) as any).join(",") === "1,2"; // standalone
}
```

compiles (with `target: "standalone"`) to a module importing
`env::Uint8ClampedArray_join` — an unsatisfiable host import (module fails to
instantiate against `{}`). Identical symptom for
`Object.getOwnPropertyNames(o).join(...)`. `Object.keys(o).join(...)` (fixed by
#3155) and `Object.entries(o).length` are host-free.

## Root cause (to confirm)

The `join` receiver-type probe (`array-methods.ts`, the `receiverIsExternref` /
`actualType` classification around the method dispatch) classifies the
`Object.values` / `Object.getOwnPropertyNames` result as a **Uint8ClampedArray**
rather than a boxed externref array, so the dispatch routes to the TypedArray
`join` lowering (`env::<TA>_join`) instead of the externref path that #3155 made
native. Why those two builtins' results infer to a clamped typed array (while
`Object.keys` infers to a plain array/externref) is the thing to pin down — most
likely a return-type / lib.d.ts inference quirk or a probe misread of the
runtime shape.

## Fix direction

- Confirm via a WAT/import probe which dispatch arm is chosen for the
  `Object.values` / `getOwnPropertyNames` receiver (TypedArray-`join` vs
  externref-`join`).
- Correct the classification so these externref-array results take the native
  externref-`join` path (`compileArrayJoinExternNative`, already host-free), OR
  give the TypedArray-`join` host arm a `noJsHost` native fallback if the
  receiver genuinely is a native typed-array here.
- Do NOT add a host import without a standalone fallback (dual-mode contract).

## Acceptance

1. `Object.values(o).join(sep)` and `Object.getOwnPropertyNames(o).join(sep)`
   compile with `target: "standalone"` to a module with **no** `env::*` import
   and produce the correct joined string (verified in-wasm, mirroring
   `tests/issue-3155.test.ts`).
2. Add coverage to `tests/issue-3155.test.ts` (or a new `tests/issue-3342.test.ts`).
3. No test262 regression; host-lane byte-identity.
