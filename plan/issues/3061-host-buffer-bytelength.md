---
id: 3061
title: "codegen: ArrayBuffer.byteLength / byteOffset return NaN in JS-host mode (native accessor gated to standalone only)"
status: done
completed: 2026-07-06
sprint: 71
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: arraybuffer, typed-arrays
goal: spec-completeness
related: [2159, 2595, 1359]
test262_bucket: arraybuffer-bytelength-host
test262_count: 18
assignee: ttraenkler/dev-cycleB
origin: "2026-07-06 harvest (dev-cycleB). origin/main; default (JS-host) lane."
---

# #3061 — `ArrayBuffer.byteLength` / `byteOffset` NaN in JS-host mode

## Problem

`ab.byteLength` and `ab.byteOffset` on an ArrayBuffer return **NaN** in JS-host
(`gc`) mode. The native accessor computation in `property-access.ts` (read the
`i32_byte` byte-vec's field-0) was gated to `(ctx.wasi || ctx.standalone ||
ctx.strictNoHostImports)`. In host mode the read falls through to the generic
`__extern_get(struct, "byteLength")`, which returns `undefined` for the opaque
WasmGC byte-vec struct (byteLength/byteOffset are not real struct fields and no
`__sget_byteLength` export exists) → `NaN`.

```ts
export function test(): number {
  const b = new ArrayBuffer(8);
  return b.byteLength; // was NaN, spec wants 8
}
```

Verified at the WAT level: `b.byteLength` lowered to `__extern_get(b,
"byteLength")`, and calling that host helper directly on a compiled ArrayBuffer
struct returns `undefined`.

## Fix

Enable the existing native accessor arm for **plain ArrayBuffer** in JS-host
mode too. The `i32_byte` backing (field-0 = byte count, element size 1) is
**identical** across host and standalone, so the ArrayBuffer arm is
representation-safe in both. Scope kept deliberately narrow:

- **ArrayBuffer** — fixed in host mode (byteLength = field-0, byteOffset = 0).
- **SharedArrayBuffer** — host-mode backing differs (a bare `i32_byte`
  `ref.test` misses → a wrong `0`), so SAB stays gated to no-host, falling
  through to the generic reader exactly as before (no change).
- **TypedArray / DataView** — element-scaled / windowed backings diverge in host
  mode; left standalone-only (follow-up: DataView host windowing + TypedArray
  host byteLength; `any`-typed buffer receivers also still fall through since
  `recvName` can't be resolved — a pre-existing shared limitation).

Single-file change: `src/codegen/property-access.ts` — relax the byteLength/
byteOffset outer gate with a `hostBufferByteAttr` predicate and gate
`isBuffer`/`isTypedArr` on `noJsHost` so only the ArrayBuffer arm runs in host
mode.

## Acceptance criteria

1. `new ArrayBuffer(n).byteLength === n`, `.byteOffset === 0` in host mode. ✓
2. `ArrayBuffer.prototype.slice` result reports correct byteLength. ✓
3. No regression for TypedArray/DataView/SharedArrayBuffer or plain objects
   with an own `byteLength` property. ✓
4. Regression test: `tests/issue-3061-host-buffer-bytelength.test.ts` (7 cases). ✓

Flips the ArrayBuffer byteLength-value cluster (`built-ins/ArrayBuffer/*` —
`return-bytelength.js`, `zero-length.js`, several `slice/*` result.byteLength
checks) plus byteLength-value assertions spread across other ArrayBuffer tests.
