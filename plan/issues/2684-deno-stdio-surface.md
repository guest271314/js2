---
id: 2684
title: Deno stdio host surface (Deno.stdin/stdout/stderr.*Sync → WASI fd) + nm_deno.ts
area: host-interop
language_feature: deno-api-compat
goal: platform
related: [389, 2655, 2631]
feasibility: medium
status: done
assignee: ttraenkler/sendev-deno
sprint: 66
completed: 2026-06-26
---

## Problem

js2wasm already recognizes Node's synchronous fd-based stdio (`node:fs`
`readSync`/`writeSync(fd, …)`) and lowers it to direct WASI `fd_read`/`fd_write`
under `--target wasi` (#2655), so the SAME source both compiles to a
self-contained WASI P1 command module AND runs unmodified under real `node`.

Deno is the other runtime in loopdive/js2#389's "runs under the runtime + also
compiles to wasi" story. Deno's synchronous stdio is a different *surface* but
the same *primitive*: fd-based blocking IO over fd 0/1/2.

- `Deno.stdin.readSync(p: Uint8Array): number | null` — read into `p`, return
  bytes read, or **`null` at EOF** (a 0-byte read ⇒ `null`).
- `Deno.stdout.writeSync(p: Uint8Array): number` — write `p`, return bytes
  written. (`Deno.stderr.writeSync` → fd 2.)

`Deno` is an **ambient global** (not an `import`), so it is recognized by the
member-call *shape* (`Deno.stdin.readSync` / `Deno.{stdout,stderr}.writeSync`),
mirroring the `process.std*.write` recognition rather than the `node:fs` import
recognition.

## Acceptance criteria

- `examples/native-messaging/nm_deno.ts` compiles under `--target wasi` to a
  module importing **only `wasi_snapshot_preview1`** (no node:fs, no JS host),
  owns + exports its own `memory`, and round-trips a framed echo byte-for-byte
  (incl. high/null bytes) under wasmtime. The same source runs unmodified under
  real `deno` (Deno provides the `Deno` namespace).
- `Deno.stdin.readSync` faithfully returns `number | null` (null at EOF), so
  `if (r === null) …` works in the compiled module.
- Byte-neutral for any program that does not reference `Deno.`.
- `tests/issue-2684-deno-stdio.test.ts` proves it (gated on `findWasmtime()`).

## Implementation notes (WHY, not just WHAT)

### `number | null` under pure WASI — the one intricate part

Deno's `readSync` returns `number | null`. The compiler **already** represents a
`number | null` value-type as an `externref` carrying *either* a
WasmGC-**native** boxed-number struct (`$__box_number_struct`, moved
anyref→externref) *or* `ref.null extern`. Verified empirically on current main:
a `function f(x): number | null { … return null }` with a `=== null` consumer
compiles under `--target wasi` to **zero host imports** — `=== null` lowers to
`ref.is_null`, and arithmetic on the unwrapped value lowers to the native
`__unbox_number` helper. The `__box_number`/`__unbox_number` names resolve to
**native** helpers under `ctx.wasi` (`UNION_NATIVE_HELPER_NAMES` →
`addUnionImportsViaRegistry`, late-imports.ts:407), NOT to `env::*` host imports.

So `tryCompileDenoStdioCall` lowers `Deno.stdin.readSync(buf)` to:
1. `fd_read(0, …)` into `buf` (reusing #2655's `emitFdReadRuntime` + the
   iovec/scratch machinery), leaving the byte count as i32;
2. `count > 0 ? __box_number(f64(count)) : ref.null extern` → `externref`.

This keeps the module host-import-free; the only additions are `externref` +
the native box/unbox helpers, both of which wasmtime (gc + reference types)
supports — exactly as the #2655 test already runs.

`__box_number` is pulled in via `ensureLateImport(ctx, "__box_number", …)` at
the **start** of the readSync lowering (before any fd instructions are emitted),
mirroring the proven mid-body usage in array-methods.ts; under `ctx.wasi` that
routes to `addUnionImportsViaRegistry`, which performs its own index shift.

### writeSync

`Deno.{stdout,stderr}.writeSync(buf)` is the easy direction — identical to
node:fs `writeSync(1|2, buf)` minus the offset/length options (Deno writes the
whole buffer): lower to `fd_write(1|2, …)` reusing `emitFdWriteRuntime`, return
the byte count as f64 (`number`).

### Recognition + typing

- Codegen: `src/codegen/deno-api.ts` `tryCompileDenoStdioCall`, dispatched in
  `calls.ts` before the node:fs path. Gated on `ctx.wasi` and an unshadowed
  ambient `Deno` identifier — byte-neutral otherwise.
- Import registration: the existing `registerWasiImports` AST walk detects the
  `Deno.stdin.readSync` / `Deno.{stdout,stderr}.writeSync` shapes and sets
  `needsFdRead` / `needsFdWrite`, so `ctx.wasiFdReadIdx` / `wasiFdWriteIdx` are
  registered (no duplicate import — same idx the node:fs/raw-wasi paths reuse).
- Typing: an import-scoped ambient `Deno` `.d.ts` (just `Deno.stdin` /
  `stdout` / `stderr` with `readSync`/`writeSync`) injected when `Deno.` is
  referenced, mirroring `buildNodeEnvDts`'s bare-`process` injection. Type-level
  only — codegen lowers the shape regardless. (`Cannot find name 'Deno'` is
  TS2304, non-hard, so it never blocks compilation; the dts just removes the
  diagnostic noise and gives the program clean types.)

## Validation

- `tests/issue-2684-deno-stdio.test.ts`: WAT-shape assertions (only
  `wasi_snapshot_preview1`, owns memory, no node:fs) + a wasmtime framed-echo
  round-trip with high/null bytes (gated on `findWasmtime()`).
- Byte-neutral check: a program with no `Deno.` reference is unchanged.
