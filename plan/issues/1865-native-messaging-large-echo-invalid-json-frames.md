---
id: 1865
title: "Native Messaging host: large-message echo emits invalid-JSON frames Chrome rejects (#389)"
status: done
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: examples
language_feature: native-messaging
goal: correctness
related: [1530, 1651, 1723]
---
# #1865 — Native Messaging large-message echo emits invalid-JSON frames

**Source:** GitHub issue #389 (guest271314), field-tested 64 MiB round trip.

## Problem

Chrome Native Messaging deserializes **every** host→extension message as JSON
and caps each message at **1 MiB**. The previous example host
(`examples/native-messaging/nm_js2wasm.ts`) handled a >1 MiB body by splitting it
into raw ≤1 MiB **byte** slices and echoing them. Those slices cut JSON tokens
mid-stream, so each frame is **not valid JSON** and Chrome rejects the whole
response with:

```
The sender sent an invalid JSON message; message ignored.
```

So `port.postMessage(Array(209715*64))` (~64 MiB of `[null,...]`) did not round
trip in real Chrome, despite the bytes reassembling. The earlier
`compare-memory.mjs` metric checked **byte reassembly**, not per-frame JSON
validity, so it reported a false ✅ and masked the gap.

Verified: a 2 MiB array → 2 byte-chunk frames, **0 of 2 valid JSON**
(`[null,…l,null,` and `null,…null]`).

## Fix

Re-chunk a large JSON **array** into a sequence of valid JSON arrays `[elem,…]`,
each ≤1 MiB, split only at top-level commas, so every frame parses and the
receiver rebuilds the original array by concatenation. Messages that already fit
in one frame are echoed verbatim. Frames are written as `[` + `subarray` view +
`]` (no per-frame body copy).

Also fixed `examples/native-messaging/compare-memory.mjs`: the metric now parses
**every** response frame as JSON, enforces the ≤1 MiB cap, and checks the
flattened elements equal the input — the real native-messaging contract. The
column is renamed `exact?` → `validJSON?`.

## Verification

- 64 MiB `Array(209715*64)` → 65 frames, every frame valid JSON, each ≤1 MiB,
  reassembles to exactly 13,421,760 elements.
- `compare-memory.mjs` now reports `validJSON? ✅` for the fixed host and `❌`
  for the old byte-chunk host (which is what Chrome rejects).
- `smoke-test.sh` still passes (≤1 MiB verbatim echo); `tests/issue-1530.test.ts`
  multi-message test updated to assert per-frame valid JSON + lossless reassembly.

## Notes / follow-ups

- The correct re-chunking holds the array body (1× message size) and is slow for
  large buffers — see #1863 (Uint8Array large-buffer perf).
- The `.js`-compiled form of arbitrary hosts can still fail to instantiate —
  see #1866 (`env::__extern_get`).
- Re-chunking is array-aware (top-level commas), matching the demo payload; a
  fully general JSON splitter is out of scope for the example.
