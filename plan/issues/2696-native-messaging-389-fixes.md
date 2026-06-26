---
id: 2696
title: Native-messaging #389 fixes — wasm:memory inline, node:fs/process direct-WASI flags, str_to_number coercion
area: host-interop
related: [389, 2655, 2657, 2632, 2683]
feasibility: hard
status: in-progress
assignee: ttraenkler/sendev-nm389
sprint: Backlog
---

## Problem

External reporter guest271314 (loopdive/js2#389) ran the `examples/native-messaging/`
hosts via the npm package `@loopdive/js2` + `bun build --no-bundle <ex>.ts --outfile
<ex>.js` and hit three distinct failures. This issue reproduces each on **current
origin/main with the repo's own CLI on the `.ts` directly** (isolating genuine compiler
bugs from npm-staleness / bun-transpile artifacts), fixes them, and adds the reporter's
cases as regression unit tests.

### Bug 1 — `wasm:memory` host-import leak (`nm_wasi.ts`)
`Host import "env.store32"/"env.load32"/"env.store8"/"env.load8" … not on the dual-mode
allowlist`. These are the `import { store32, load32, store8, load8 } from "wasm:memory"`
intrinsics (#2657) which MUST lower to inline `i32.store`/`i32.load`/`i32.store8`/
`i32.load8_u` — NOT `(import "env" …)`.

### Bug 2 — node:fs / node:process flags (`nm_js2wasm.ts`, `nm_node_process.ts`)
`--target wasi --link-node-shims --emulate node` → `unknown import: node:fs::readSync`/
`writeSync`. `nm_node_process.ts` additionally leaked `env.__wasiStdinReadByte/Available/
Eof/SetReader` + `env.global_String`.

### Bug 3 — `__str_to_number` externref/f64 invalid Wasm (`nm_wasi_p3.ts`)
`--target wasi` → INVALID Wasm: `call $__str_to_number (f64.convert_i32_s …)` /
wasmtime `type mismatch: expected externref, found f64`.

## Reproduction outcomes (current origin/main @ f32b2cf78)

### Bug 1 — REPRODUCED (direct + bun-transpile)
`npx tsx src/cli.ts examples/native-messaging/nm_wasi.ts --target wasi -o .tmp/` emits
`warning: 4 host import(s) not on the dual-mode allowlist were dropped` for
`env.store32/load32/store8/load8`. On the direct path the call sites are still inlined
(the module's import section is clean and it echoes correctly under wasmtime), so the
warning is **spurious**; but on a transpiled path where the stub survives it leaks an
unsatisfiable `env.store32` import that breaks wasmtime instantiation — exactly the
reporter's symptom.

**Root cause:** `collectExternDeclarations` (src/codegen/index.ts) registers every
top-level `declare function` stub as an `env.*` host import. `preprocessImports`
rewrites BOTH raw-WASI source-import forms — `wasm:memory` accessors and
`wasi_snapshot_preview1` fd funcs — into bare `declare function` stubs that have lost
their module origin, so they fall into that generic registration even though
`tryCompileRawWasiCall` (src/codegen/raw-wasi-api.ts) already inlines / WASI-binds every
call site. The detection sets `ctx.wasiMemAccessors` / `ctx.wasiRawImports` exist
precisely to identify these, but `collectExternDeclarations` did not consult them.

**Fix:** in `collectExternDeclarations`, skip the `declare function` stub when
`ctx.wasi && (ctx.wasiMemAccessors.has(name) || ctx.wasiRawImports.has(name))` — mirrors
the existing node:fs skip. After the fix both the direct `.ts` and a tsc/bun-transpiled
`.js` (types stripped, ESM imports intact) compile with ZERO `env.*` imports — only
`wasi_snapshot_preview1` — and echo a framed message byte-exactly under wasmtime.

### Bug 2 — node:fs / node:process flags
**Point 1 (#2655 direct path) — CONFIRMED working, not a bug.** `nm_js2wasm.ts
--target wasi` ALONE already emits a self-contained module importing only
`wasi_snapshot_preview1` (the `node:fs` readSync/writeSync lower inline) and echoes
byte-exactly under wasmtime. The reporter's `unknown import: node:fs::readSync`
came from adding `--link-node-shims`, which is the **modular-linking variant**: it
makes the module *import* a stable `node:fs` interface that must be linked against
`node-fs.wasm` (or a JS host) BEFORE running. Running it under bare wasmtime with
no link step is expected to fail — not a compiler bug. **Fix:** corrected the
README to lead with `--target wasi` alone as the runnable standalone build, and
clearly mark `--link-node-shims` as a link-step-required variant (the example
header `nm_js2wasm.ts` was already correct; `smoke-test.sh` already links
node-fs.wasm, so it stays).

**Point 3 (`nm_node_process.ts` leaks) — REPRODUCED, fixed.** `--target wasi`
emitted dropped `env.*` imports: the four #2632 fd0 stdin-reactor intrinsics
(`__wasiStdinReadByte/Available/Eof/SetReader`) and `env.global_String`. Despite
the warnings the module ALREADY echoed correctly under wasmtime — the #2632 reactor
drives `poll_oneoff`/`fd_read` natively, so `process.stdin` Readable IS standalone
WASI, NOT host-dependent. The leaks were spurious:
- The four `__wasiStdin*` are js2wasm intrinsics declared as `declare function`
  stubs by the injected `src/process-stdin-prelude.ts`; every call site is
  inline-lowered by `tryWasiTimerCall` (calls.ts) under `ctx.wasi`, but
  `collectExternDeclarations` still re-registered the stubs as `env.*` host
  imports (same root cause as bug 1). **Fix:** skip them via
  `WASI_STDIN_REACTOR_INTRINSICS` under `ctx.wasi`.
- `env.global_String` comes from the `AMBIENT_BUILTIN_CTORS` loop registering
  `global_<Ctor>` when a builtin is used as a bare value — `String.fromCharCode`
  in the prelude makes `String` a value-ref. Under `ctx.strictNoHostImports`
  (auto-on for wasi/standalone) that import is ALWAYS dropped and, because the
  drop leaves no funcMap entry, the `declaredGlobals.set` never fires either — the
  registration is a pure no-op except the warning. **Fix:** skip the
  `AMBIENT_BUILTIN_CTORS` registration under `ctx.strictNoHostImports`.

After both fixes `nm_node_process.ts --target wasi` compiles with ZERO warnings,
imports only `wasi_snapshot_preview1`, and echoes byte-exactly under wasmtime — a
genuine standalone-WASI async-stream variant.
