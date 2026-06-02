---
id: 1753
title: "Native-messaging host: 64 MiB read/write via ≤1 MiB chunked streaming"
status: done
created: 2026-05-30
updated: 2026-06-02
completed: 2026-06-02
priority: medium
feasibility: medium
task_type: feature
area: examples
goal: platform
sprint: 58
required_by: [1767]
related: [389, 1655, 1700, 1752]
---
# #1753 — Native-messaging host: 64 MiB chunked streaming

## Context

Follow-up from GitHub #389 (native-messaging host). The 1 MiB null-corruption
bug is fixed (#945) and the host is now `Uint8Array`-native end-to-end
(`getMessage`/`sendMessage`/`main`). The remaining piece the contributor asked
for is the **large-payload** path: Chrome Native Messaging caps a single message
the **extension** sends at ~1 MiB, but a **host** may send up to 64 MiB — and a
large response must be delivered as a sequence of ≤1 MiB framed messages.

The byte-native loop makes this straightforward: it's a chunking layer on top of
the existing frame writer, not new compiler work.

## Scope

- **Write path:** `sendMessage` (or a `sendLarge`/streaming helper) splits a
  body larger than 1 MiB into ≤1 MiB framed chunks (each with its own 4-byte LE
  length header), written back-to-back; the extension reassembles.
- **Read path:** the host reads and concatenates successive framed messages up to
  the 64 MiB ceiling (guard against runaway sizes).
- Stays `Uint8Array`/`ArrayBuffer`-native (no lossy string round-trip), building
  on #1655 (`process.stdout.write(Uint8Array|ArrayBuffer)`).

## Acceptance

- A 64 MiB payload round-trips host↔client as ≤1 MiB chunks, byte-exact.
- Memory stays bounded (chunked, not a single 64 MiB linear-memory staging
  region) — verify no OOB/`memory.grow` blow-up like the original 1 MiB bug.
- Regression test at the chunk boundary (exactly 1 MiB, 1 MiB+1) and at 64 MiB.

## Notes

This is an **example/protocol** completeness item, not a conformance fix. The
#389 thread stays open as the public feedback channel; this issue is internal
tracking so the large-payload work doesn't get lost.

## Partial unblock via #1767 — 2026-06-01

The #1767 memory-growth branch implements the write-side slice needed for the
reported 64 MiB path:

- large native-messaging responses are emitted as successive <=1 MiB frames;
- the writer uses one reusable 1 MiB scratch buffer instead of staging the full
  response or every response chunk at once;
- the Chrome `Array(...nulls...)` stress shape is emitted as valid JSON array
  chunks of at most 209,715 elements per frame.

This does not close #1753 by itself. The broader read-side aggregation /
multi-frame request contract remains open here, and the 64 MiB guarded memory
measurement remains tracked by #1767.

## Implementation Summary — 2026-06-02

Status: done on `symphony/1753`.

What was done:

- The native-messaging example now treats a full-size 1 MiB inbound frame as a
  possible continuation start. It reads successive <=1 MiB request frames,
  guards the logical request at 64 MiB, and emits the response as <=1 MiB
  Native Messaging frames.
- Continuation aggregation uses `ArrayBuffer` backing storage instead of a
  single large `Uint8Array`. In this compiler, `Uint8Array` is still represented
  as f64 elements, so aggregating 64 MiB that way caused a Vitest worker OOM.
  `ArrayBuffer` lowers to the i32-byte backing store and keeps the WASI linear
  memory staging bounded to the 1 MiB read/write scratch path.
- The response side preserves the #1767 null-array behavior: aggregated
  `Array(...nulls...)` payloads are emitted as valid <=1 MiB JSON array frames,
  while raw byte payloads are split byte-exactly.
- `examples/native-messaging/stress-memory.mjs` now sends <=1 MiB request
  frames for the manual 64 MiB stress path and reports the request frame budget.

Findings:

- Bare `process.stdin.read(ArrayBuffer, offset)` is not currently lowered by the
  compiler; it falls back to an `env::__extern_get` path. Continuation reads
  therefore still use one per-frame `Uint8Array`, then copy into the
  `ArrayBuffer` aggregate.
- The final WAT for the shipped example imports only
  `wasi_snapshot_preview1::fd_read` and `fd_write`; no `env.*` imports remain.

Files changed:

- `examples/native-messaging/nm_js2wasm.ts`
- `examples/native-messaging/stress-memory.mjs`
- `examples/native-messaging/README.md`
- `tests/issue-1753.test.ts`
- `tests/issue-1767.test.ts`
- `plan/issues/1753-native-messaging-64mib-chunked-streaming.md`
- `plan/issues/backlog/backlog.md`
- `plan/issues/sprints/58.md`
- `plan/log/issues-log.md`

Validation:

- `node_modules/.bin/vitest run tests/issue-1753.test.ts`
- `node_modules/.bin/vitest run tests/issue-1767.test.ts`
- `node_modules/.bin/vitest run tests/issue-1530.test.ts`
- `node_modules/.bin/vitest run tests/issue-1753.test.ts tests/issue-1767.test.ts tests/issue-1530.test.ts`

Also attempted: `pnpm test -- tests/issue-1753.test.ts`. That command was too
broad for this repo's script invocation, ran unrelated suites, showed existing
non-native-messaging failures, and eventually hit a Vitest worker OOM. The
direct scoped commands above are the validation results for this branch.
