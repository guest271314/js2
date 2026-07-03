---
id: 2839
title: externref→wasm-vec materializer missing i8/i16 coerce + WASI host-import leak (#2311 regression)
status: done
sprint: 69
priority: high
area: codegen
task_type: bug
related: [389, 2831, 2311, 2832]
assignee: ttraenkler/agent-senior-2839
completed: 2026-06-29
---

## Problem

#2311 (`fix(#2831): host-externref→wasm-vec materializer`) added
`buildVecFromExternref` / `buildElemCoerce` in `src/codegen/type-coercion.ts`.
The new materializer regressed the standalone-WASI Native-Messaging hosts —
`native-messaging-smoke` and the standalone `process.stdin` tests
(`tests/issue-2735*`, `tests/issue-2752*`) have failed on `main` since #2311
merged (~05:38 2026-06-29). The bun-bundled standalone-WASI compile of
`nm_js2wasm_node_process` (and the other byte host `nm_js2wasm_node_fs`) was
the failing case.

Two distinct defects, both in `buildVecFromExternref`, both surfacing only when a
dynamic/externref value is materialized into a **packed byte/short vec**
(`Uint8Array` = packed `i8`, etc.) under `--target wasi`:

1. **Missing packed element coercion (compile-time validation failure).**
   `buildElemCoerce` handled element kinds `f64` / `i32` / `externref` / `ref`
   but **not `i8` / `i16`**. A packed element fell through to the empty
   `return []`, leaving an `externref` on the stack where the packed
   `array.set` expects `i32`:
   `[wasm-validator error in function __vec_from_extern_55] array.set must have
   the proper type` → `Fatal: error validating input`. No wasm was emitted.

2. **WASI host-import leak (runtime instantiation failure).** Once (1) is fixed
   the module compiles, but `useNativeObjVec` was gated on `ctx.standalone`
   **alone**. WASI is host-free at runtime (the scale-test runs the module under
   **raw wasmtime**), yet the non-standalone branch emits the JS-host import
   `env::__array_from_iter`, which has no definition under wasmtime:
   `unknown import: env::__array_from_iter` → instantiation fails → ZERO output.

## Root cause

`src/codegen/type-coercion.ts`, function `buildVecFromExternref`:

- `buildElemCoerce` only matched `f64`/`i32`/`externref`/`ref` element kinds.
  Packed typed-array vecs use `i8`/`i16` element kinds.
- `const useNativeObjVec = ctx.standalone;` — should be
  `ctx.standalone || ctx.wasi` (the host-free idiom used everywhere else in
  codegen, incl. this same file at lines ~1367/1454/3023). `__array_from_iter`
  is the only construct on this path that is a host import with no native
  definition; `__extern_get_idx` / `__extern_get` / `__box_number` /
  `__unbox_number` are all emitted as defined funcs under WASI.

## Fix

`src/codegen/type-coercion.ts` only:

1. Add `i8` / `i16` to the `i32` arm of `buildElemCoerce`. The value-position
   rep of a packed element is `i32`; a packed `array.set` truncates the `i32`
   modulo the storage width (8/16 bits), so the unbox→`i32.trunc_sat_f64_s`
   sequence is identical to the `i32` arm. **Signedness is irrelevant on the
   WRITE side** — it only governs the READ op (`array.get_s`/`array.get_u`),
   driven by the view name elsewhere. `f64`/`i32`/`externref`/`ref` arms
   unchanged.
2. `useNativeObjVec = ctx.standalone || ctx.wasi` — WASI takes the native
   `__extern_get_idx` reader and never imports `__array_from_iter`.

## Verification (acceptance — all green)

- The exact failing compile now succeeds: standalone bun-bundled
  `nm_js2wasm_node_process` compiles `--target wasi`; the emitted module has
  **no** `env::__array_from_iter` import.
- `node examples/native-messaging/scale-test.mjs` (NM_SCALE_SIZES_MIB
  "1 64 128 256") — all four hosts round-trip byte-exact at every size.
- `tests/issue-2752*.test.ts` — green.
- Typed-array / Uint8Array / DataView suites — no regression to the
  i32/f64/externref arms.
- Full CI (test262 shards + quality + native-messaging-smoke) validates. The
  `native-messaging-smoke` job (which runs the scale-test under real wasmtime —
  the exact #389 reporter pipeline) goes green.

### Note — pre-existing `#1886` on the RAW-`.ts` compile path (separate bug)

`tests/issue-2735*` has 4 wasmtime-gated cases that compile the **raw**
`nm_js2wasm_node_process.ts` directly via `compile(..., { target: "wasi" })`
(no bun bundle). These fail with `Codegen error: linear Uint8Array helper
argument is not backed by linear memory (#1886)` — a defect in the **linear-Uint8
escape analysis** (`src/codegen/expressions/calls.ts`), a different subsystem
from this issue's externref→vec materializer (`type-coercion.ts`). This error:

- is **pre-existing on `origin/main`** (verified: identical failure with this
  fix reverted), fires earlier in codegen than the i8 validation error, and so
  masked it on the raw-`.ts` path;
- was **not** introduced by this fix, and is **not** in this issue's scope
  (#2311 never touched the linear-Uint8 subsystem);
- does **not** gate required CI — the cases are wrapped in
  `maybe = wasmtimeBin ? describe : describe.skip`, so the `quality` vitest job
  (no wasmtime) skips them; they only run locally when wasmtime is on PATH.

The **bun-bundled** path — the real #389 reporter pipeline and the
`native-messaging-smoke` CI job — is fully fixed (all 4 NM variants × 4 sizes
round-trip byte-exact). The raw-`.ts` `#1886` escape failure should be tracked
as a **separate follow-up** against the linear-Uint8 analysis.
</content>
</invoke>
