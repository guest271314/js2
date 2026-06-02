---
id: 1618
title: "wasi: console.log of a runtime string emits corrupted [object] placeholder"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: wasi, codegen
language_feature: stdout, string
goal: wasi-completeness
sprint: Backlog
parent: 1530
related: [1530, 1480]
---
## Problem

Under `--target wasi`, `console.log` of a **non-literal string** (a variable,
template interpolation, or concatenation) does not print the string's content
cleanly. The output is a corrupted mix of the real bytes and the literal
`[object]` placeholder.

Observed (via `buildWasiPolyfill()` round-trip):

| Source                                            | stdin  | stdout (actual)        | expected   |
|---------------------------------------------------|--------|------------------------|------------|
| `console.log(readStdin())`                        | hello  | `helloct]\n`           | `hello\n`  |
| `const s=readStdin(); console.log(s)`             | world  | `worldct]\n`           | `world\n`  |
| `const s=readStdin(); console.log(\`x${s}y\`)`    | MID    | `MIDbject]y\n`         | `xMIDy\n`  |
| `const s=readStdin(); console.log(s+s)`           | AB     | `ABbject]\n`           | `ABAB\n`   |
| `console.log("literal-content")`                  | (none) | `literal-content\n` ok | ok         |

Only **string literals** and **numeric** values print correctly. Any runtime
string value leaks the `[object]` placeholder.

## Root cause (suspected)

`emitWasiValueToStdout` in `src/codegen/expressions/builtins.ts` (~line 1543)
handles `f64` and `i32` value kinds, then falls into an `else` branch that
`drop`s the value and writes a `wasiAllocStringData(ctx, "[object]")`
placeholder. A `ref` / `ref_null` NativeString value hits this fallback. The
real string bytes appear to be partially emitted before the placeholder
overwrites the tail — net effect is corruption.

The fix is to add a `ref`/`ref_null` (NativeString) case that writes the
string's i16 char-array out as UTF-8 to fd=1 (the same encoding the literal
path uses via `wasiAllocStringData`), instead of falling through to the
`[object]` placeholder.

## Acceptance criteria

- `const s = readStdin(); console.log(s)` round-trips the exact input.
- Template interpolation and concatenation of runtime strings print their
  real content.
- A unit test in `tests/wasi-stdin.test.ts` (or `tests/wasi.test.ts`) asserts
  the round-trip via `buildWasiPolyfill()`.

## Origin

Filed from #1530 (Native Messaging host example). This bug — combined with the
missing raw-byte stdout primitive (#1617) — is why the #1530 host can read and
process a message but cannot yet emit a correct response.

## Implementation notes (resolution)

The `[object]` placeholder was only *one* of two distinct bugs the runtime-string
output triggered. Both are fixed:

1. **`emitWasiValueToStdout` ref fallback (the documented symptom).**
   `src/codegen/expressions/builtins.ts` now has a `ref`/`ref_null` + string-type
   case that casts to `NativeString` and calls a new
   `__wasi_write_any_string` helper (`ensureWasiWriteAnyStringHelper` in
   `src/codegen/index.ts`). The helper flattens any AnyString (Cons/Utf8/template
   result) via `__str_flatten`, copies the low byte of each i16 code unit into a
   dedicated linear-memory scratch region, and issues one `fd_write`.

2. **WASI memory-layout collision (the *real* cause of the "corrupted mix").**
   The stdin read buffer and the string-literal data segments BOTH started at
   offset 1024, so `fd_read` clobbered the initialized `[object]`/newline literal
   bytes — that is why the output was a *mix* of real bytes and placeholder, not
   a clean placeholder. `registerWasiImports` now reserves 3 pages and places the
   stdin buffer at page 1 (`WASI_STDIN_BUF_START`) and the write scratch at page 2
   (`WASI_WRITE_SCRATCH_START`), well above any page-0 data segment.

3. **Template-literal extern-bridge leak under WASI (surfaced while fixing #1).**
   `compileNativeTemplateExpression` (`src/codegen/string-ops.ts`)
   unconditionally emitted the JS-host string-marshal bridge
   (`__str_to_extern` / `__str_from_extern`), whose `__str_to_mem` /
   `__str_from_mem` host imports do not exist under `--target wasi` and collapsed
   to bogus function indices (a `call 0` → `fd_write`), producing an **invalid
   module** for *any* template literal under WASI — independent of stdout. The
   fix: a string-typed substitution is already a NativeString, so it concatenates
   natively with zero marshaling; the bridge is now emitted only when a template
   has a genuinely non-string (number/bigint/object) substitution. As a
   robustness fix, `__str_flatten` is now also registered in `ctx.funcMap` (the
   shift-maintained map) so internal `call __str_flatten` sites that follow a
   late-import addition resolve correctly.

Tests: `tests/issue-1618-1651-wasi-stdout.test.ts` (console.log + template
runtime strings, no host-import leak) and the byte-exact round-trip in
`tests/issue-1530.test.ts`.

Landed on main in PR #573 / commit `17fee538b`, with follow-up integer-print
cleanup in `88b9e3921`.
