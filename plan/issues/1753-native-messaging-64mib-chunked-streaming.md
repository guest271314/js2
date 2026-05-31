---
id: 1753
title: "Native-messaging host: 64 MiB read/write via ≤1 MiB chunked streaming"
status: ready
created: 2026-05-30
updated: 2026-05-31
priority: medium
feasibility: medium
task_type: feature
area: examples
goal: platform
related: [389, 1655, 1700, 1752]
depends_on: []
sprint: 58
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

- **Write path:** `sendMessage` (or a `sendLarge`/streaming helper) splits a body
  >1 MiB into ≤1 MiB framed chunks (each with its own 4-byte LE length header),
  written back-to-back; the extension reassembles.
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
