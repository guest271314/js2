---
id: 2772
title: "process.stdin reactor prelude builds each 'data' chunk byte-by-byte (O(n^2)) — SIGKILLs nm_node_process at multi-MiB"
status: ready
created: 2026-06-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: process.stdin, async-reactor
goal: spec-completeness
related: [2756, 2752, 389]
sprint: Backlog
---

# #2772 — `process.stdin` prelude assembles chunks in O(n^2)

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
excluded from the multi-MiB CI matrix (#2756).

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

- [ ] `drainBytes` (and any sibling per-byte string build) is O(n), not O(n^2).
- [ ] `examples/native-messaging/nm_node_process.ts` echoes 1 / 64 / 128 MiB
      frames byte-for-byte under wasmtime in seconds.
- [ ] Re-enable the `nm_node_process` 1/64/128 MiB cases in
      `tests/native-messaging-matrix.test.ts` (currently gated on this issue).
- [ ] No regression in the existing `process.stdin` reactor tests.
