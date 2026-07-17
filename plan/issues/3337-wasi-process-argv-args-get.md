---
id: 3337
title: "wasi: lower process.argv through args_get instead of invalid native-string path"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, wasi
language_feature: process-argv
goal: standalone-mode
sprint: Backlog
horizon: m
es_edition: n/a
related: [1035, 1482, 1490, 1532, 1801]
origin: "2026-07-17 current-origin/main PO audit: tests/real-world-wasi.test.ts marks process.argv under --target wasi as invalid-binary it.fails"
---

# #3337 - WASI `process.argv` must lower through `args_get`

## Problem

`process.argv` under `--target wasi` reports compile success but emits an
invalid WebAssembly module. The current tests document this as an `it.fails`
sentinel, and the previous WASI invalid-binary issue explicitly deferred it as a
separate native-string argv defect.

The fix should implement a real WASI argv path, not reuse the Node host-import
path and not narrow the behavior to a JS polyfill-only shortcut.

## Evidence on current `origin/main`

- `tests/real-world-wasi.test.ts:39-58` marks `"reads process.argv as a valid
WASI module"` as `it.fails`; the comment says `process.argv.length` compiles
  successfully but emits an invalid binary in `__str_flatten`.
- #1801 recorded this as out of scope and said "the native-string argv defect
  should get its own issue" at
  `plan/issues/1801-wasi-process-exit-invalid-binary.md:121-129`.
- The implemented `process.argv` runtime path is explicitly non-WASI:
  `src/codegen/property-access-dispatch.ts:1524-1549` gates the Node
  `__get_process_argv` import on `!ctx.wasi`.
- `tests/wasi.test.ts:22-27` still lists `args_get` / `args_sizes_get` and
  `process.argv` support as out of scope.
- #1490 is done for Node host mode, not WASI: its problem statement and plan
  are Node runtime access at
  `plan/issues/1490-nodejs-process-argv-env-runtime.md:18-24` and
  `plan/issues/1490-nodejs-process-argv-env-runtime.md:72-83`.
- #1035's follow-up list points `process.argv` / `process.env` to #1044 at
  `plan/issues/1035-wasi-hello-world-compile-console.md:232-240`, but #1044 is
  not the WASI argv implementation; the pointer is stale.
- #1532 mentions `process.argv[2] -> args_get` as one case in a tests-only WASI
  syscall suite at `plan/issues/1532-wasi-syscall-unit-test-suite.md:26-33`,
  but its acceptance is "PR is tests-only" at
  `plan/issues/1532-wasi-syscall-unit-test-suite.md:69-77`. It cannot fix this
  compiler/runtime invalid-binary path.
- `src/runtime/wasi-polyfill.ts:24-35` exposes fd, env, clock, and memory
  helpers but no `args_sizes_get` / `args_get` shims or `{ args }` option.
- `src/codegen/wasi.ts:498-525` shows the current `process.env` precedent:
  WASI imports are registered for the protocol, with a separate JS-polyfill
  fast path. There is no analogous argv registration.

## Impact

WASI CLI programs cannot inspect their arguments. Worse, the compiler returns
`success: true` and emits a module that does not validate, so users get a late
binary failure instead of either working argv support or a clear compile-time
unsupported diagnostic. This blocks normal standalone command-line programs and
keeps a known invalid-binary sentinel in the real-world WASI suite.

## Root cause / unknowns

The likely root cause is that WASI `process.argv` falls through to a generic
array/native-string path instead of registering `args_sizes_get` and `args_get`
and materializing a guest `string[]`. The implementation must confirm the exact
current lowering route before patching it.

Open semantic choices for the implementer:

- Whether guest `process.argv` should expose WASI argv verbatim, including
  argv0, or emulate Node's `process.argv` shape. The issue should document the
  chosen contract and keep tests consistent with it.
- Whether the first slice supports only `.length` and indexed reads, or full
  array iteration. If only a subset is shipped, unsupported operations must
  fail loudly instead of emitting invalid Wasm.

## Proposed approach

1. Add a WASI `process.argv` detector beside the existing `process.env` scan in
   `src/codegen/wasi.ts`, registering `args_sizes_get` and `args_get` only when
   argv is referenced.
2. Materialize argv into the existing standalone string/array representation
   using WASI linear-memory buffers, with bounds-checked allocation and a clear
   contract for argv0.
3. Extend `buildWasiPolyfill()` with deterministic test args, for example
   `{ args?: string[] }`, and implement memory-writing `args_sizes_get` /
   `args_get` shims.
4. Keep the Node host import path in `property-access-dispatch.ts` gated to
   non-WASI mode. WASI modules should import only `wasi_snapshot_preview1`
   functions for argv unless a documented test-only polyfill import is needed.
5. Replace the `it.fails` sentinel with executable validity/runtime coverage.

## Non-goals

- Reworking Node host-mode `process.argv` (#1490).
- Implementing all Node `process` APIs in WASI mode.
- Solving unrelated native-string invalid-binary buckets such as the broader
  standalone `__str_flatten` residuals.
- Implementing WASI component-model `wasi:cli/environment`; this issue targets
  preview1 `args_sizes_get` / `args_get`.

## Dependencies / related issues

- Related: #1482 (`process.env`/`environ_get`) is the closest implementation
  precedent.
- Related: #1801 fixed `process.exit` invalid-binary behavior and documented
  this argv defect as separate.
- Related: #1490 covers Node host mode and must not be regressed.
- Related: #1532 should use this issue's implementation as the prerequisite for
  its argv syscall-suite case; it is not an implementation owner.
- No open issue currently owns WASI argv support.

## Why this is not already covered

#1801 explicitly deferred this bug. #1490 is Node-host-only, #1482 is env-only,
#1532 is tests-only, and #1035's old follow-up pointer is stale. Searches for
`args_get`, `args_sizes_get`, and `process.argv` on current `origin/main` find
no open implementation issue or code path that turns the existing `it.fails`
into a valid WASI module.

## Acceptance criteria

- [ ] The `tests/real-world-wasi.test.ts` `it.fails("reads process.argv as a
valid WASI module", ...)` sentinel is converted to a passing test.
- [ ] `process.argv.length` under `{ target: "wasi" }` returns the documented
      argc value with a deterministic test argv source.
- [ ] At least one indexed read test, for example `process.argv[1].length` or a
      string equality check, validates that argv strings are materialized
      correctly and do not pass through `__str_flatten` with invalid operand
      types.
- [ ] The emitted WASI module validates with `WebAssembly.validate(binary) ===
true` and instantiates with `buildWasiPolyfill({ args: [...] })`.
- [ ] The module's argv imports come from `wasi_snapshot_preview1`
      `args_sizes_get` / `args_get`, with no `env.__get_process_argv` host
      import in WASI mode.
- [ ] Existing Node host-mode tests for #1490 still pass.

## Validation plan

- Run the focused WASI argv tests added for this issue.
- Run `pnpm test tests/real-world-wasi.test.ts tests/wasi.test.ts tests/issue-1490.test.ts`.
- Run a WAT/import inspection asserting only expected WASI argv imports are
  introduced when argv is referenced.
- Run the standard issue-specific test gate if the implementation adds
  `tests/issue-3337.test.ts`.
