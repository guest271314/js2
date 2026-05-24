---
id: 1618
title: "wasi: console.log of a runtime string emits corrupted [object] placeholder"
status: backlog
created: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: wasi, codegen
language_feature: stdout, string
goal: wasi-completeness
related: [1530, 1480]
parent: 1530
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
