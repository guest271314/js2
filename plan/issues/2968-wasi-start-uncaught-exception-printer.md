---
id: 2968
title: "wasi _start uncaught-exception printer: catch_all → __error_to_string → fd_write + proc_exit(1)"
status: done
assignee: ttraenkler/fable-dev
sprint: Backlog
created: 2026-07-02
completed: 2026-07-02
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

## Root cause found (measure-first)

Two distinct gaps had to be closed for the acceptance program to work:

1. **Top-level `throw` was silently dropped.** `collectTopLevelStatements`
   (`src/codegen/declarations.ts`) had cases for var/for/if/try/block/expression
   statements but **no `ThrowStatement` case**, so a bare top-level
   `throw new TypeError("x")` was never added to `__module_init` — it emitted no
   code at all, no `_start`, no imports, and the program exited 0. (An
   `if (…) { throw }` worked only because the `IfStatement` case collected it.)
2. **`_start` did not catch.** Its body was a bare `call __module_init`, so an
   uncaught exception propagated out and (under Node/WASI) exited 0 silently.

## Implementation

- `declarations.ts` — collect a top-level `ThrowStatement` into `__module_init`,
  **gated on `ctx.wasi`** (host/standalone keep their pre-existing drop → byte-identical).
- `index.ts registerWasiImports` — a `throw` anywhere sets `needsFdWrite` +
  `needsProcExit` so the printer's imports are registered in the normal pass
  (both are in the existing WASI set — no late-import shift).
- `index.ts addWasiStartExport` — pre-emit `__wasi_start_print_exn(payload: externref)`
  (null → skip; else `any.convert_extern` → `__any_to_string` (#2962 error arm) →
  `__wasi_write_any_string_stderr` + a `\n`), then wrap the entry call + reactor
  drain in `try` / `catch $exc` → `call __wasi_start_print_exn` → `proc_exit(1)`.
  Gated on `ctx.wasi && exnTagIdx >= 0 && nativeStrings && fd_write/proc_exit
present` — non-throwing modules stay byte-identical (no wrap, no printer).

## Test Results (`node:wasi`, preview1 — see tests/issue-2968.test.ts, 7/7 pass)

| Program                                              | stderr                                     | exit |
| ---------------------------------------------------- | ------------------------------------------ | ---- |
| `throw new TypeError("x")`                           | `TypeError: x`                             | 1    |
| `throw new Error("boom")`                            | `Error: boom`                              | 1    |
| `throw new RangeError("out")`                        | `RangeError: out`                          | 1    |
| `throw "just a string"`                              | `just a string`                            | 1    |
| `console.log("before"); throw new TypeError("late")` | stdout `before` + stderr `TypeError: late` | 1    |
| `function main(){throw new Error("in main")} main()` | `Error: in main`                           | 1    |
| `throw null`                                         | (no render)                                | 1    |
| `console.log("hi")` (non-throwing)                   | stdout `hi`, no `proc_exit` import         | 0    |

`throw 42` renders `[object Object]` — a pre-existing `__any_to_string`
boxed-number limitation shared with the #2962 `__exn_render_prepare` harness,
out of scope here.

## Known limitation — modern wasmtime rejects the compiler's legacy EH

The acceptance says "run under wasmtime". The compiler emits the **legacy**
exception-handling opcodes (`try`=0x06 / `catch`=0x07), which V8/Node (and the
#2962 harness) accept but **wasmtime 46 rejects** (`legacy_exceptions feature
required for try instruction`). This is **pre-existing and compiler-wide** —
on `origin/main`, an ordinary user `try { … } catch { … }` fails under wasmtime
46 identically, independent of this change. So these runs validate under
`node:wasi` (a real WASI runtime), matching how #2962's own criterion is met
today. Making binaries run under modern wasmtime needs a separate
`try` → `try_table` (new EH proposal) migration touching the emitter + the
instruction-tree walkers (dead-elim / fixups / stack-balance / wat) — filed as
follow-up **#2997**, out of this issue's M scope.
