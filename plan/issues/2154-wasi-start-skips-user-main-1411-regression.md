---
id: 2154
title: "WASI _start wraps only __module_init, never calls a user main() — #1411/#1978 regression (native-messaging smoke red)"
status: done
sprint: 62
created: 2026-06-15
updated: 2026-06-15
completed: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: modules
goal: core-semantics
related: [900, 907, 1122, 1789, 1978]
origin: "2026-06-15 native-messaging-smoke.yml red on main since PR #1411 (commit 657c6524); bisected last-good 65bea37e"
---

# #2154 — WASI `_start` skips a user `main()` (regression from #1411/#1978)

## Symptom

The `native-messaging smoke (real wasmtime)` check
(`.github/workflows/native-messaging-smoke.yml`, job `smoke`) went green→red on
`main` exactly at the merge of **PR #1411** (`fix(#1978): stop splicing
module-init into a user function named main`, commit `657c6524`; last good
`65bea37e`). It failed with `FAIL: stdout frame mismatch`: the compiled Native
Messaging host (`examples/native-messaging/nm_js2wasm.ts`, which has an
`export function main()`) produced **empty stdout** under real wasmtime.

A red non-required `smoke` makes every PR `UNSTABLE`, which disabled
auto-enqueue and stalled the merge pipeline — so this was high-leverage.

## Root cause

`addWasiStartExport` (`src/codegen/index.ts`) builds the WASI `_start` entry by
choosing ONE target function to wrap. Before #1978, a user `main` had the
module-init body spliced into it and no standalone `__module_init` existed, so
`_start` fell back to wrapping `main` — running init-then-body. The program
worked.

#1978 correctly removed that splice (module-init must run **once** at load, not
on every `main()` call), moving init into a standalone `__module_init`. But it
left `addWasiStartExport` **preferring `__module_init` unconditionally**:

```
// old addWasiStartExport target selection
let targetIdx;
for (…) if (fn.name === "__module_init") targetIdx = …;   // always wins
if (targetIdx === undefined) { …fall back to main… }      // never reached
```

So for a program WITH a user `main`, `_start` wrapped only `__module_init` —
top-level globals were initialised but `main()` was **never called**. Verified
in the emitted WAT: `(func $_start (call 47))` where funcIdx 47 = `$__module_init`
(globals-only), and zero `call 44` (= `$main`) anywhere in the module. Under
wasmtime the host read no stdin and wrote no stdout.

## Fix (this PR — re-greens the smoke check)

Restructured `addWasiStartExport` so it runs `applyModuleInitGuard` (#1789)
**first** — that prepends `call __module_init` to every exported function,
including a user `main` — and then **prefers an EXPORTED, no-arg, no-result
`main`** as the `_start` entry:

- `_start → main`. Because `main` (exported) now begins with the guard's
  `call __module_init`, module init runs **exactly once** (idempotent
  `__init_done` guard) and **then** main's body runs. This restores the
  pre-#1978 program entry **without** re-introducing the splice — #1978 stays
  fixed (init is not in `main`'s body, does not re-run per call).
- Only when there is **no callable exported `main`** does `_start` fall back to
  wrapping `__module_init` directly. This covers (a) pure top-level / init-only
  programs, and (b) the `main()`-calls-itself convention where a **non-exported**
  `main` is reached through the top-level call captured inside `__module_init`
  (a non-exported `main` carries no guard prefix, so wrapping it would skip
  init — it must NOT be the target).

The `func.exported` check is the load-bearing distinction between an
extension-entry `export function main()` (the target) and the convention
`function main(){…} main();` (not the target). Non-WASI codegen is untouched —
both `addWasiStartExport` call sites are `if (ctx.wasi)`-gated; non-WASI init
still runs via the Wasm `(start)` section set in `declarations.ts`.

## Acceptance

- `examples/native-messaging/smoke-test.sh` passes byte-for-byte under real
  wasmtime 44.0.0 (stdout = exact 17-byte frame; stderr = clean debug line).
- The emitted `_start` calls `$main`, and `$main`'s body begins with
  `call $__module_init`.
- #1978 stays fixed: top-level state persists across `main()` calls (init runs
  once), and the init body is not spliced into `main`.
- A non-exported `main()` (convention) and a no-`main` module still wrap
  `__module_init` in `_start`.

## Test Results

- `examples/native-messaging/smoke-test.sh`: **PASS** under real wasmtime
  (before: `FAIL: stdout frame mismatch`, empty stdout).
- `tests/issue-1411-wasi-main-start.test.ts` (new, 4 cases): exported-`main`
  entry + init-first, #1978 once-only init, non-exported-`main` →
  `__module_init`, no-`main` → `__module_init`. All pass.
- `tests/issue-1978.test.ts` (5 cases): all pass — no #1978 regression.
- `tests/wasi.test.ts` (24), `tests/wasi-target.test.ts`,
  `tests/issue-1618-1651-wasi-stdout.test.ts`,
  `tests/issue-1789-standalone-module-init.test.ts`: green.
- Pre-existing failures NOT caused by this change (verified identical on
  unpatched `origin/main`): `tests/issue-907.test.ts` "WASI target keeps _start
  … does NOT use start section" (stale assertion vs #1789's `__init_done`);
  `tests/issue-1653-*.test.ts` "ArrayBuffer-backed Uint8Array at a non-zero
  offset"; `tests/issue-1326c.test.ts` "exports the async-scheduler API surface".
