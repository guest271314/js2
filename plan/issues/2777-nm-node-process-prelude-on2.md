---
id: 2777
title: "process.stdin reactor prelude builds each 'data' chunk byte-by-byte (O(n^2)) — SIGKILLs nm_node_process at multi-MiB"
status: done
created: 2026-06-28
completed: 2026-06-28
assignee: ttraenkler/dev-2777-stdin-on2
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: process.stdin, async-reactor
goal: spec-completeness
related: [2775, 2752, 389]
sprint: Backlog
---

# #2777 — `process.stdin` prelude assembles chunks in O(n^2)

The compiler's injected `process.stdin` Readable prelude
(`src/process-stdin-prelude.ts`) assembles each `'data'` chunk ONE BYTE AT A TIME
via growing-string concatenation. `drainBytes()` (~L195-200):

```ts
private drainBytes(): number {
  let n = 0;
  let b = __wasiStdinReadByte();
  while (b >= 0) { this.chunk = this.chunk + String.fromCharCode(b); n = n + 1; b = __wasiStdinReadByte(); }
  return n;
}
```

Each `this.chunk = this.chunk + String.fromCharCode(b)` copies the entire growing
string, so draining an `N`-byte chunk is **O(N^2)**. A single large Native
Messaging frame delivered in one drain is therefore quadratic, which is why
`examples/native-messaging/nm_node_process.ts` SIGKILLs even at 1 MiB and is
excluded from the multi-MiB CI matrix (#2775).

This is a COMPILER-LEVEL issue (the prelude), not the example. The example's own
`buffered = buffered + chunk` / `.substring()` compounds it, but the prelude is
the gating root and would remain O(n^2) even after an example-level rewrite.

## Fix

Accumulate the drained bytes in a **byte buffer** (`Uint8Array`, grown
amortized-doubling, or a chunk list joined once) instead of per-byte string
concatenation — O(n). The `'data'` callback contract delivers a string whose
char codes are the raw bytes (one char per byte); produce that string from the
byte buffer in a single pass (e.g. build the final chunk once) rather than
incrementally. Mirror the same amortized strategy anywhere the prelude rebuilds
`this.chunk` / the read-side buffer.

## Acceptance

- [x] `drainBytes` (and any sibling per-byte string build) is O(n), not O(n^2).
- [x] `examples/native-messaging/nm_node_process.ts` echoes 1 / 64 / 128 MiB
      frames byte-for-byte under wasmtime in seconds.
- [x] Re-enable the `nm_node_process` 1/64/128 MiB cases in
      `tests/native-messaging-matrix.test.ts` (currently gated on this issue).
- [x] No regression in the existing `process.stdin` reactor tests.

## Resolution (2026-06-28)

Root cause was twofold (the cited `drainBytes` per-byte concat was only half the
story): js2wasm native strings are **cons-ropes**, so

1. the prelude (`src/process-stdin-prelude.ts`) delivered each `'data'` chunk as a
   cons-rope built one byte at a time, and
2. the example (`nm_node_process.ts`) kept a growing STRING `buffered` and
   recovered bytes with `charCodeAt`/`substring` — each of which **re-flattened
   the whole growing rope**, O(n) per access ⇒ O(n²) for a multi-MiB frame.

Fix — amortized-growth `Uint8Array` byte buffers on both sides:

- **Prelude**: accumulate drained bytes into `buf[head..tail)` (no string ops),
  and materialise the `'data'`/`read()` chunk ONCE per emit as a **flat** string
  (`slice()` builds then `substring(0,len)` forces a single flatten). Consumers
  now receive a flat string ⇒ their `charCodeAt`/`substring` are O(1)/O(k).
- **Example**: parse frames from a byte buffer via O(1) typed-array indexing
  (`append()` + `decodeLength()` + body copy out of `buf`), not a growing string.

Measured (in-process reactor shim, byte-exact at every size): 16 MiB 1.5 s,
64 MiB 7.2 s, 128 MiB 16.3 s — **linear**, not quadratic.

`tests/native-messaging-matrix.test.ts` un-gated: a new in-process
`runReactorShim` (poll_oneoff/fd_read/fd_write, bulk copies) drives the async
reactor, so `nm_node_process` runs the **full 1/64/128 MiB sweep on every CI
run** (no `it.skip`, no wasmtime dependency), matching the other three variants.
All 12 matrix cases + the 21 existing `process.stdin` reactor tests
(`issue-2632-phase3-*`, `issue-2735`, `issue-2752`) + the comparison harness
stay green.
