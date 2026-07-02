---
id: 2968
title: "wasi _start uncaught-exception printer: catch_all → __error_to_string → fd_write + proc_exit(1)"
status: ready
sprint: Backlog
created: 2026-07-02
priority: medium
horizon: m
feasibility: medium
task_type: feature
area: codegen
language_feature: errors
goal: standalone-mode
related: [2962, 1104, 2958]
origin: "follow-up filed from #2962 (fable-2)"
---

# wasi `_start` uncaught-exception printer

## Problem

#2962 gave standalone binaries host-readable exception rendering via the
`__exn_render_prepare`/`__exn_render_char` exports (the Node test262 harness
consumes them), and a native `__error_to_string` (§20.5.3.4). But under a real
WASI runtime (wasmtime/wasmer), an uncaught exception still propagates out of
`_start` as a raw unhandled Wasm exception — the runtime prints an opaque
engine message instead of `TypeError: x`, and the #2962 acceptance criterion
"prints `TypeError: x` and exits nonzero" is only satisfied through the Node
harness today.

## Approach

Wrap the `_start` body (emitted in `src/codegen/index.ts`, the
`targetIdx !== undefined` block around line 2470) in `try` + `catch` on the
`$exc` tag (`ctx.exnTagIdx`):

1. Payload → `__any_to_string` (pull via `ensureAnyToStringHelper`; the
   #2962 error arm handles `$Error_struct`) → `__str_flatten`.
2. Print the flat string + `\n` to fd 2 via the existing wasi fd-write
   machinery (`registerWasiImports` — iovec scratch at page 0, write scratch
   at page 2; see the #1618 layout notes; `__str_to_utf8` exists for the
   staging copy).
3. `proc_exit(1)`.

Gate on `ctx.wasi` (the linear-memory + fd_write plumbing exists only there;
plain `--target standalone` has no memory/fd imports and keeps the #2962
harness-exports path). `catch_all` is not needed — standalone/wasi has no
foreign exceptions (#1473) and traps are not catchable anyway.

## Acceptance criteria

- `js2wasm --target wasi` of `throw new TypeError("x")` run under wasmtime
  prints `TypeError: x` to stderr and exits nonzero.
- No new imports beyond the existing wasi set; JS-host and plain-standalone
  lanes byte-identical.
