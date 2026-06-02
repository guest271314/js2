---
id: 1723
title: "writeMessage cast failure on multi-segment / large message (ConsString downcast + fixed-staging overflow)"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: wasi, native-strings, stdout-write
goal: real-world-compat, spec-completeness
sprint: 57
parent: 389
related: [389, 887, 1618, 1651, 1653, 1724]
reporter: guest271314
---
# #1723 — writeMessage cast failure on a multi-segment / large message

## Problem

Reported by guest271314 against the Native Messaging host (parent #389), tested
in WASI/standalone mode. A large (~1 MiB) response trapped on WRITE:

```
[host] received 1048580 chars, declared body length 1048576
{ messageLength: 1048614 }
Error: failed to run .../host.wasm
  wasm backtrace:
    0: writeMessage
    1: main
    2: _start
  wasm trap: cast failure
```

#887 fixed READING large messages; WRITING a large response still trapped. He
also found a low-N trigger: fails at `Array(13)`, works at `Array(12)`.

## Reproduction

Driving the compiled `examples/native-messaging/host.ts` through a WASI harness:
- `Array(1)` → works (response stays a flat string).
- `Array(12)`, `Array(13)`, `Array(100)`, `Array(209715)` (~1 MiB) → trapped
  `illegal cast` in `writeMessage`, AFTER the stderr debug line was written.

The `Array(12)`-works / `Array(13)`-fails boundary guest saw is a function of the
*response* string staying flat vs becoming a rope at a given size — not the input
count per se.

## Root cause (TWO coordinated bugs)

### Bug A1 — ConsString downcast at the `process.stdout.write(string)` call site

`writeMessage` does `process.stdout.write(response)` where `response` is built by
template interpolation: `` `{"received":${bodyStr},"runtime":"js2wasm+wasi"}` ``
— a **ConsString** (rope, type `$ConsString`).

Both string-write call sites emitted a `ref.cast` of the argument DOWN to the
concrete `NativeString` type before calling the byte-writer helper:
- `src/codegen/expressions/calls.ts` (`process.stdout/stderr.write(string)`)
- `src/codegen/expressions/builtins.ts` (`emitWasiValueToStdout`, console writer)

```
local.get 0          ;; body : AnyString (could be Native OR Cons)
ref.cast (ref $NativeString)   ;; ← TRAPS "illegal cast" when body is a ConsString
call $__wasi_write_any_string
```

The author's comment assumed "`__str_flatten` accepts the supertype, so any
non-flat tree is handled there" — but the downcast ran BEFORE flatten, so a rope
trapped at the cast and never reached the flattening helper. The host worked only
for tiny single-segment (still-flat) responses.

### Bug A2 — fixed staging buffer overflows linear memory for large payloads

`__wasi_write_any_string` stages the string bytes into `WASI_WRITE_SCRATCH_START`
(128 KB, page 2) one byte at a time, then issues one `fd_write`. The module
reserves only 3 pages (192 KB), so a ~1 MiB payload writes far past page 2 and
traps `memory access out of bounds`. The stdin read staging buffer
(`WASI_STDIN_BUF_START`, 64 KB, page 1) has the symmetric problem for a single
large read.

## Fix

1. **`ensureWasiWriteAnyStringHelper` (`src/codegen/index.ts`)** — change the
   helper param type from `NativeString` to the **AnyString supertype**. A
   NativeString or ConsString satisfies AnyString directly, so no downcast is
   needed; `__str_flatten` (which takes AnyString and collapses ropes) does the
   real work inside.

2. **Both call sites** (`calls.ts`, `builtins.ts`) — remove the
   `ref.cast → NativeString`. For a nullable ref, emit `ref.as_non_null` only
   (keeps the value's subtype intact while matching the helper's non-null param).

3. **Memory growth guards** — before staging, both `__wasi_write_any_string`
   (`index.ts`) and `emitProcessStdinRead` (`calls.ts`) compute
   `neededPages = ceil((SCRATCH_START + len) / 65536)` and
   `if (neededPages > memory.size) memory.grow(neededPages - memory.size)`.

## Tests

`tests/issue-1723.test.ts`:
- a template-interpolated (ConsString) response writes without an illegal cast,
- a ~1 MiB cons-string response round-trips (4-byte LE prefix + body), declared
  length == actual body bytes (the #389 headline case, message length 1,048,614).

## Result

Fixed. Full Native Messaging round-trip verified for N = 1, 12, 13, 100, 1000,
and 209,715 (~1 MiB): declared response length matches body bytes exactly.

## Relationship to #1724

Does NOT share a root cause with #1724 (string-constant corruption). #1724 is an
itoa-scratch / data-segment memory aliasing. #1723 is a ConsString downcast +
fixed-staging overflow. Fixed in the same PR but independent.

## Follow-up (deferred) — `process.stdout/stderr.write(<string>)` in a minimal program

While verifying the example-polish request (switch host.ts from `console.error`
to `process.stderr.write` with the same protocol encoding), a SEPARATE
pre-existing bug surfaced: a *minimal* program whose only string-write is
`process.stdout.write("...")` or `process.stderr.write("...")` produces a
malformed binary — `__str_to_extern` fails validation with
`not enough arguments on the stack for call (need 4, got 2)`. This reproduces on
clean `origin/main` (confirmed by stashing this PR's changes) and is unrelated to
the cast/overflow fixes here. It does NOT affect `examples/native-messaging/host.ts`,
which compiles correctly because its broader feature mix lays out the externref
bridge differently. Because of this latent bug, the example-polish (swap
`console.error` → `process.stderr.write`) is **deferred** — switching now would
risk the example. Tracked as a separate codegen stack-balance issue in
`__str_to_extern` (`ensureNativeStringExternBridge` / late-import shifting).
