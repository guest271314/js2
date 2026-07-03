---
id: 2915
title: Native ToBoolean on the property-descriptor-attribute + Boolean() path (standalone leak)
status: done
sprint: 69
priority: medium
horizon: s
feasibility: medium
assignee: ttraenkler/sendev-standalone-leaks
completed: 2026-07-01
---

## Problem

Under `--target standalone`, 44 otherwise-passing test262 cases stayed
host-dependent because a single `env::__to_boolean` HOST import leaked:

- `built-ins/Object/defineProperties/*` — 31 (dynamic descriptor
  `enumerable`/`configurable`/`writable`)
- `built-ins/Object/defineProperty/*` — 10 (same)
- `built-ins/Boolean/*` — 3 (`Boolean(x)` conversion function)

`__to_boolean` is a bodyless host import: `(v) => v ? 1 : 0`. In standalone
mode there is no JS host to satisfy it, so the import *leaked* even though the
tests ran correctly when the host provided it (leaky-PASS). Eliminating the
leak flips each of these host-free 1:1 — a real host_free_pass gain.

## Root cause

Two emit sites hard-coded the `__to_boolean` host import:

1. `emitRuntimeFlagsF64` (`src/codegen/object-ops.ts`) — the dynamic
   descriptor-flag lowering for `Object.defineProperty` /
   `Object.defineProperties` (ES §6.2.5.6 step 5.b ToBoolean of a descriptor
   attribute).
2. The `Boolean(externref)` call handler (`src/codegen/expressions/calls.ts`).

Both wanted ToBoolean, but the compiler already has a **native** union helper,
`__is_truthy(externref) -> i32` (a real Wasm body registered in
`addUnionImportsAsNativeFuncs`, `src/codegen/index.ts`). It walks the same
boxed-value structs — `__box_number` / `__box_boolean` / `$BigInt` /
`$AnyString` — applying ES §7.1.2 (0 / NaN / false / "" / 0n / null → falsy)
and returns `1` for any other non-null ref.

## Why `__is_truthy` is 1:1-safe here (WHY, not just WHAT)

`__is_truthy` is strictly ≥ `__to_boolean` in spec-fidelity:

- The host `__to_boolean`, handed an **opaque WasmGC externref**, can only
  answer "non-null → truthy". So for a leaky-PASS the correct spec answer was
  already "truthy" (else the host's always-1 would have FAILED the test — it
  would not be a leaky-PASS). `__is_truthy` returns `1` for every genuine
  object/wrapper, so those preserve.
- `__is_truthy` returns `0` **only** for a genuinely spec-falsy boxed primitive
  (boxed number 0/NaN, boxed `false`, `""`, `0n`, null). In every such case the
  host's always-1 answer was already *wrong* per spec, so that test was NOT a
  leaky-PASS — it was leaky-FAIL, and the native helper can only *fix* it.
- Crucially, `new Boolean(false)` lowers to an `$Object` wrapper in standalone
  (`__new_Boolean` → `emitWrapperBuildTail`), NOT a bare `$box_boolean_struct`,
  so `__is_truthy` falls to its "other non-null ref → truthy" arm = `1`, exactly
  matching ES ToBoolean(object) = true (test262 `15.2.3.6-3-72`).

No leaky-PASS can regress; the change can only maintain or improve correctness.

## Fix

Gate both sites on `ctx.standalone`: in standalone emit native `__is_truthy`
(after `addUnionImports(ctx)`); otherwise keep the byte-identical
`__to_boolean` host sequence the GC/host lane always emitted.

- `src/codegen/object-ops.ts` — `emitRuntimeFlagsF64`
- `src/codegen/expressions/calls.ts` — `Boolean(externref)` handler

## Verification

Measure-first (compile `--target standalone`, wrap via `wrapTest`, instantiate
with the host import, run `test()`):

- Before: 44 files PASS leaking exactly `[1]__to_boolean` (31 defineProperties
  + 10 defineProperty + 3 Boolean).
- After: **44 / 44** PASS with **`[0]` env imports** (host-free), 0 still
  leaking, 0 non-PASS.

- GC lane byte-unchanged (gate excludes it — the `gc` target still emits
  `__to_boolean`).
- `tests/issue-2915-standalone-toboolean-descriptor.test.ts` — 3 cases
  instantiate with an EMPTY import object.

## Acceptance criteria

- [x] 44 defineProperty/defineProperties/Boolean tests convert to host-free
  PASS under standalone.
- [x] No `env::__to_boolean` import in the standalone binaries for these cases.
- [x] GC lane output unchanged.
- [x] `net` positive on the standalone floor; no regressions.
