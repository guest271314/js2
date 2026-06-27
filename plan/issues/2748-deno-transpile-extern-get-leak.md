---
id: 2748
title: bun/tsc-transpiled (type-stripped) nm_deno.js leaks env::__extern_get under --target wasi
area: host-interop
related: [389, 2684, 2696, 2698]
feasibility: hard
status: done
completed: 2026-06-27
assignee: ttraenkler/sdev-2748-deno-transpile
sprint: Backlog
---

## Problem

External reporter (loopdive/js2#389, latest comment): `examples/native-messaging/nm_deno.ts`
compiles + runs correctly directly (`js2wasm nm_deno.ts --target wasi`), but the reporter's
pipeline transpiles to JS first —

```
bun build --no-bundle nm_deno.ts --outfile nm_deno.js   # strips TS types
js2wasm nm_deno.js --target wasi
```

— and the emitted wasm then imports `env::__extern_get` (and `env::__extern_is_undefined`),
an unsatisfiable host import that breaks standalone instantiation under wasmtime
(`unknown import: env::__extern_get has not been defined`). The direct `.ts` imports ONLY
`wasi_snapshot_preview1`.

## Reproduction outcome (current origin/main)

REPRODUCED via esbuild (`esbuild nm_deno.ts --loader ts`) and tsc — both produce the same
type-stripped `.js`. The transpiled form preserves the `Deno.stdin.readSync(buf)` /
`Deno.stdout.writeSync(buf)` member-call SHAPE; what it loses are the `Uint8Array` PARAM
annotations on the streaming helpers (`function writeFull(out)` / `readExact(n)`).

```
[.ts] env imports: []
[.js] env imports: ["env::__extern_get","env::__extern_is_undefined"]
```

## Root cause (NOT the Deno recognition — that already works)

The Deno stdio recognition is purely syntactic and DOES fire on the type-stripped shape:
`fd_read`/`fd_write` are registered and the calls lower correctly. There are actually THREE
distinct `.js`-path defects vs the direct `.ts` (the reporter hit #1 first — the module would
not instantiate — and never reached the runtime ones):

**Bug A — the reported `env::__extern_get` leak.**

1. With the `Uint8Array` param annotations stripped, `out`/`buf` are `any` → `externref`.
   `out.length` (and `out[i]`) on an externref receiver lower through the polymorphic
   dynamic-read dispatch (`emitDynGet` in `src/codegen/dyn-read.ts`, `.length`), whose
   host-object MISS arm calls `__extern_get`, plus an `__extern_is_undefined` null-guard.

2. `ensureLateImport` (`src/codegen/expressions/late-imports.ts`) routes the
   `OBJECT_RUNTIME_HELPER_NAMES` (`__extern_get`, `__extern_is_undefined`, …) to their
   Wasm-NATIVE `ensureObjectRuntime` definitions **only under `ctx.standalone`** — a
   deliberately-deferred decision ("WASI is intentionally NOT routed here yet"). Under
   `--target wasi`, `ctx.standalone` is FALSE (only `ctx.strictNoHostImports` / `ctx.wasi`
   are true), so these helpers fell through to `addImport(ctx, "env", name, …)` — an
   unsatisfiable host import in a host-free module.

**Bug B — silent no-op buffer (read/write echoes nothing).** Surfaced once A was fixed: the
Deno read/write buffer resolver (`emitNodeFsResolveGcU8`, `src/codegen/node-fs-api.ts`)
required a STATICALLY-typed `Uint8Array` (a concrete `ref`/`ref_null` vec struct). An
`any`/externref buffer returned `null` → the read/write SILENTLY no-op'd, so even with clean
imports the transpiled `.js` echoed nothing.

**Bug C — infinite-loop hang on EOF (`.js`-only).** Surfaced once A+B were fixed. With a
`.js`/`.mjs`/`.cjs` fileName the checker uses `strict: false` (`src/checker/index.ts`), which
turns `strictNullChecks` OFF. That COLLAPSES `Deno.stdin.readSync(): number | null` →
`number`: the boxed-or-null `externref` result is unboxed to `f64` at `const r = …`, and
`if (r === null)` constant-folds to `i32.const 0` (a number is never null). The EOF signal is
lost, so the framed read loop never terminates — the bun/tsc-transpiled `nm_deno.js` HANGS
under wasmtime even with clean imports. (The reporter never saw this — bug A blocked
instantiation first.) `strictNullChecks` is load-bearing for CODEGEN here, not just
diagnostics: representation is chosen from the static type, so nullability must be accurate.

## Fix

Three surgical changes, each a host-free / null-accuracy generalisation of existing behaviour:

1. **(Bug A) `src/codegen/expressions/late-imports.ts`** — gate the native object-runtime
   routing on `ctx.standalone || ctx.wasi` (was `ctx.standalone` only), mirroring the
   `UNION_NATIVE_HELPER_NAMES` routing on the line above and the #2609 `__object_is`
   host-free registration inside `ensureObjectRuntime`. WASI now emits the native
   `__extern_get`/`__extern_is_undefined` DEFINITIONS — no `env::*` import. Host mode
   (`!wasi && !standalone`) is untouched, so test262 / equivalence are byte-identical (both
   compile via the `.ts` path).

2. **(Bug B) `src/codegen/node-fs-api.ts`** (`emitNodeFsResolveGcU8`) — when the buffer
   expression compiles to a bare `externref` (a type-stripped param), resolve it at RUNTIME by
   casting to the module's canonical `Uint8Array` vec struct (`canonicalUint8VecTypeIdx`,
   keyed `i8_byte` under WASI). `ref.cast` traps only if the value is genuinely not a
   Uint8Array, matching the TS type contract — and replaces the prior silent-no-op, so the
   statically-typed path is unchanged. Benefits both the Deno and node:fs sync-IO buffer paths.

3. **(Bug C) `src/checker/index.ts`** — force `strictNullChecks: true` regardless of the
   `strict: !isJs` setting, so `T | null` keeps its nullable representation on the `.js` path
   too. Blast radius is bounded: test262 + equivalence compile with `fileName: "test.ts"`
   (already strict), so ONLY genuine `.js`/`.mjs` compiles are affected; null-related
   diagnostics (TS2531 etc.) are NOT in `HARD_TS_DIAG_CODES`, so it tightens type INFO without
   failing otherwise-valid loose-JS. Validated green against real npm `.js`/allowJs suites
   (lodash-es, react-scheduler, lodash/react tier1, js-mode-template).

The #2698 link-time gate would CATCH an unsatisfiable `env::__extern_get` under
`--target wasi` as a clear error rather than a silent unresolved import — that is the
general backstop; this is the targeted recognition/lowering fix.

## Validation

- `nm_deno` compiles clean from BOTH the `.ts` AND the type-stripped `.js` (esbuild + tsc),
  importing ONLY `wasi_snapshot_preview1`.
- All variants (`.ts` control, esbuild, tsc) round-trip a framed echo byte-for-byte under
  wasmtime at **1 MiB, 64 MiB, and 128 MiB** — the 64 KiB streaming window keeps resident
  memory flat across many window runs (128 MiB > 64 MiB confirms multi-run streaming).
- Regression test: `tests/issue-2748-deno-transpile.test.ts` (esbuild type-strip of the real
  example + a hand-written untyped form; asserts pure-`wasi_snapshot_preview1` imports + a
  byte-exact wasmtime echo incl. a >window body, via file-based stdio to avoid pipe
  deadlock).
- `tests/issue-2684-deno-stdio.test.ts` (direct `.ts` cases) stays green; tsc + lint clean.
