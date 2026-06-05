---
id: 1866
title: "JS→WASM standalone: compiled .js host emits undefined `env::__extern_get` import"
status: done
sprint: 60
created: 2026-06-04
updated: 2026-06-05
completed: 2026-06-05
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: js-input
goal: correctness
related: [1865, 1864]
---
# #1866 — JS-compiled host emits undefined `env::__extern_get` import

**Source:** GitHub issue #389 (guest271314).

## Problem

Compiling a plain-JavaScript Native Messaging host via the JS→WASM path
(`--target wasi`/standalone) produced a module that fails to instantiate under
wasmtime:

```
Error: failed to instantiate ".../nm_js2wasm.js.wasm"
  1: unknown import: `env::__extern_get` has not been defined
```

A standalone/WASI module must import **only** `wasi_snapshot_preview1` — an
`env::__extern_get` import is a JS-host import that should never be emitted in
standalone mode (and is undefined when run under a bare WASI runtime).

The repo's own `nm_js2wasm.ts` avoids this, but guest's JS source triggers it,
so the trigger is input-shape dependent (a construct that lowers to
`__extern_get` without a standalone fallback).

## Why it matters

js2wasm advertises a standalone (zero JS-host-import) mode. Any `env::*` import
leaking into a `--target wasi`/standalone build breaks the "runs under wasmtime
with no JS runtime" guarantee. Closely tied to JS-input typing gaps (#1864):
when JS loses TS type info, codegen falls back to externref/host paths like
`__extern_get`.

## Acceptance criteria

- Reduce a minimal JS input (and/or the guest host JS) that emits
  `env::__extern_get` under `--target wasi`.
- Either provide a standalone Wasm-native lowering for that construct, or emit a
  clear compile error instead of an unsatisfiable import.
- A `--target wasi` build of that input imports only `wasi_snapshot_preview1`
  (add to the import-only-WASI assertion in `tests/issue-1530.test.ts`-style
  coverage).

## Investigation start

- Grep codegen for `__extern_get` emission and the guard that should suppress
  `env.*` imports under `ctx.wasi`/`ctx.standalone`.
- Compare the lowering of the same construct from `.ts` (typed) vs `.js`
  (untyped) input — likely a missing-type → host-fallback path.
