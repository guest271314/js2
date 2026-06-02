---
id: 1759
title: "native number→string missing on the WASI/standalone string-concat path (process.stderr/stdout.write of numeric template emits invalid module)"
status: done
created: 2026-05-31
updated: 2026-06-02
completed: 2026-06-02
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
language_feature: template-literals
goal: platform
sprint: 58
related: [389, 985]
---
# #1759 — WASI native number→string bridge gap

## Symptom

Under `--target wasi` (and standalone), compiling a `process.stdout.write(...)`
or `process.stderr.write(...)` whose argument is a **template literal with a
numeric substitution** produces an **invalid Wasm module**. The compile step
succeeds, but the module is rejected at instantiation/compile time by a real
runtime (wasmtime v44):

```
Error: failed to compile: wasm[0]::function[38]::__str_to_extern
  1: Invalid input WebAssembly code at offset 6416:
     type mismatch: expected i32 but nothing on stack
```

The generated `.wat` shows literal `call undefined` instructions inside
`__str_to_extern` and `__str_from_extern`.

This is how it surfaced: PR #985 (native-messaging example, GH #389) switched a
debug-telemetry line from `console.error(\`...${n}...\`)` to
`process.stderr.write(\`...${n}...\`)`. The example's `smoke` CI check (real
wasmtime round-trip) then failed because the module no longer compiles. The
workaround that landed for #985 is to keep that one numeric-template debug line
on `console.error` (which formats integers natively under WASI) and reference
this issue — see `examples/native-messaging/nm_js2wasm.ts`.

## Minimal repro

```ts
declare const process: { stdout: { write(c: string): void } };
export function main(): void {
  const n = 7;
  process.stdout.write(`n=${n}\n`);
}
```

```
npx tsx src/cli.ts repro.ts --target wasi -o out
wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y out/repro.wasm
# → Error: failed to compile: ... __str_to_extern ... expected i32 but nothing on stack
```

A `console.log` / `console.error` of the same numeric template compiles and runs
cleanly — that path formats integers directly to the output buffer
(`__wasi_write_i32`) and never produces a native-string value, so it never
touches the extern bridge.

## Root cause

`process.stdout.write` / `process.stderr.write` of a string routes through the
native-string concat path. In `src/codegen/string-ops.ts` (template-literal
compilation, ~lines 185-240), a **non-string** template span sets
`hasNonStringSpan = true`, which calls `ensureNativeStringExternBridge(ctx)`.

`ensureNativeStringExternBridge` (`src/codegen/native-strings.ts:3784-3965`)
emits `__str_to_extern` and `__str_from_extern`. Both bodies call the JS-host
late imports `__str_from_mem`, `__str_to_mem`, and `__str_extern_len`. Under
`--target wasi` / standalone, those host imports **do not exist** — they are
never materialized into the module's import section. `ensureLateImport` returns
`undefined` for them, so the baked `call` targets are `undefined` funcIdx, which
serialize to a garbage LEB index and produce an invalid function body
("expected i32 but nothing on stack").

The numeric span itself only needs a number→native-string conversion
(`number_toString` returns externref → `__str_from_extern` marshals back). But
`ensureNativeStringExternBridge` unconditionally also emits `__str_to_extern`,
and neither bridge half is satisfiable under WASI standalone because their
backing host imports are JS-host-only. The `string-ops.ts:187-193` comment
already flags the bridge as "JS-host-only" and guards the **all-string** case,
but does NOT guard the **numeric-span** case, which is exactly what trips here.

There is currently **no** Wasm-native "number → native-string ref" helper in the
codebase, so under WASI there is no alternative path to fall back to.

## Relevant files

- `src/codegen/string-ops.ts:185-240` — template-literal compile; `hasNonStringSpan` → `ensureNativeStringExternBridge`; numeric-span conversion via `number_toString` + `__str_from_extern`.
- `src/codegen/native-strings.ts:3784-3965` — `ensureNativeStringExternBridge`: emits `__str_to_extern` / `__str_from_extern` calling `__str_from_mem` / `__str_to_mem` / `__str_extern_len` late imports.
- `src/codegen/expressions/calls.ts:1951-1984` — the `process.stdout.write` / `process.stderr.write` string path (`matchProcessStdStreamWrite` + `ensureWasiWriteAnyStringHelper`).
- `src/codegen/index.ts:4891` — `ensureWasiWriteAnyStringHelper`.

## Proposed fix options

- **(a) Native int/f64 → native-string formatter for the WASI concat path.**
  Add a Wasm-native helper that formats an integer/double into a NativeString
  ref (mirroring the existing `__wasi_write_i32` digit formatting, but producing
  a string value instead of writing bytes). Route numeric template spans to it
  under `ctx.wasi || ctx.standalone` instead of the host extern bridge. This is
  the complete fix and unblocks `process.stdout/stderr.write` of any numeric
  template in standalone.

- **(b) Gate the extern bridge off under standalone + route numeric spans
  natively.** Make `ensureNativeStringExternBridge` a no-op (or refuse with a
  clear compile error) when the backing host imports are unavailable, and route
  numeric template spans through the native formatter from (a). Avoids ever
  emitting an invalid `__str_to_extern` in standalone builds.

Option (a) is the substantive piece; (b) is the guard that prevents the
silent-invalid-module failure mode regardless.

## Acceptance criteria

- [x] `process.stdout.write(\`n=${n}\n\`)` compiles AND produces a valid module
      under `--target wasi` (instantiates under wasmtime, prints `n=7`).
- [x] `process.stderr.write` of a numeric template works equivalently on fd=2.
- [x] The native-messaging example debug line can switch back from
      `console.error` to `process.stderr.write` and `examples/native-messaging/smoke-test.sh` still passes.
- [x] No invalid `call undefined` / unsatisfiable host imports emitted in any
      standalone/WASI build.

## Final findings — 2026-06-02

Implemented on branch `symphony/1759`.

- Added a pure-Wasm `number_toString(value: f64) -> externref` helper for
  WASI/standalone, emitted from the existing native number-format module. It
  keeps the host-compatible function name/signature but no longer imports
  `env.number_toString` in no-JS-host targets.
- Updated native template interpolation so numeric spans in WASI/standalone use
  the native formatter and convert its internally-created externref back to
  `ref $AnyString` with Wasm reference conversions. The JS-host
  `__str_to_extern` / `__str_from_extern` bridge is no longer emitted for this
  path.
- Unsupported object substitutions in WASI/standalone native templates now
  report a compile error instead of risking an invalid bridge-dependent module.
- Switched `examples/native-messaging/nm_js2wasm.ts` debug telemetry back to
  `process.stderr.write(...)` with an explicit newline.

Validation:

- `pnpm exec vitest run tests/issue-1759.test.ts`
- `pnpm exec vitest run tests/issue-1759.test.ts tests/issue-1321-standalone.test.ts tests/issue-1335-standalone.test.ts tests/issue-1723.test.ts`
- `bash examples/native-messaging/smoke-test.sh` with wasmtime 44.0.0
