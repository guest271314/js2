---
id: 3064
title: "codegen: pure-Wasm escape() / unescape() (§B.2.1.1/.2) — standalone/WASI lowering"
status: done
completed: 2026-07-06
sprint: 71
priority: medium
horizon: m
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen
language_feature: annexb, string-builtins
goal: spec-completeness
related: [3063, 2500]
test262_bucket: annexb-escape-unescape
test262_count: 33
assignee: ttraenkler/dev-cycleD
origin: "2026-07-06 harvest (dev-cycleD). origin/main; standalone/WASI (host-free) lane. Follow-up to #3063 — completes the dual-mode pair."
---

# #3064 — legacy `escape` / `unescape` have no standalone (host-free) lowering

## Problem

#3063 implemented the legacy globals `escape` (§B.2.1.1) and `unescape`
(§B.2.1.2) in **JS-host mode only**, via an `env.escape` / `env.unescape`
host import. Under `--target standalone` / `--target wasi` there is no JS host,
so the call site fell through and the call returned `null` — every
`annexB/built-ins/{escape,unescape}` test fails **in the standalone lane**
(host-free `host_free_pass` floor), the exact class the dual-mode architecture
principle (#679/#682) wants a Wasm-native path for.

```ts
// --target standalone, before this fix:
escape("a b");      // → null   (should be "a%20b")
unescape("%41");    // → null   (should be "A")
```

## Fix

Emit WasmGC-native `__escape` / `__unescape` helpers, mirroring
`uri-encoding-native.ts` — but simpler: `escape`/`unescape` operate on UTF-16
**code units**, so there is no UTF-8 transcoding, no surrogate pairing, and no
error case.

- `src/codegen/escape-native.ts` (new) — `emitNativeEscape(ctx)` /
  `emitNativeUnescape(ctx)`. Each flattens the input `NativeString`, scans its
  i16 code units, and builds an over-allocated i16 output array, then wraps it
  in a `struct.new $NativeString` widened to externref. Registered as DEFINED
  funcs via `mintDefinedFunc`/`pushDefinedFunc` (batched late-import shift keeps
  their funcMap index correct).
  - `escape`: unescaped set `A-Za-z0-9 @*_+-./` → verbatim; `c ≥ 256` →
    `%uWXYZ` (four uppercase hex); else → `%XY` (two uppercase hex).
  - `unescape`: `%` + `u` + 4 hex (when `k ≤ length-6`) → that code unit;
    `%` + 2 hex (when `k ≤ length-3`) → that code unit; otherwise literal `%`.
    Hex matched case-insensitively.
- `src/codegen/declarations.ts` — the `escapeNeeded` finalize now, for
  `standalone || wasi`, calls the native emitters instead of registering the
  unsatisfiable `env` import (host mode unchanged).
- `src/codegen/expressions/calls.ts` — a standalone/WASI routing block after the
  URI block: ToString-coerces the argument (via `emitToString`) and calls the
  native helper. Host mode has no `__escape` in funcMap → falls through to the
  existing generic env-import path (byte-identical).

## Acceptance criteria

- Standalone `escape`/`unescape` compile **host-free** (no `env` import) and
  match §B.2.1.1/.2. ✓ (`tests/issue-3064-escape-unescape-standalone.test.ts`,
  14 in-Wasm assertions)
- Host mode unchanged (`tests/issue-3063-escape-unescape-host.test.ts` green). ✓
- Raises the standalone `host_free_pass` floor by the ~33
  `annexB/built-ins/{escape,unescape}` files that previously failed host-free.
