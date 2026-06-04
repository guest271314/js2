---
id: 1867
title: "Native Messaging binary/Uint8Array path — revive streaming byte-chunk host if Chrome ships binary NM (crbug 732457)"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: medium
reasoning_effort: low
task_type: enhancement
area: examples
language_feature: native-messaging
goal: performance
related: [1865, 1863, 389]
blocked_by: external
---
# #1867 — Native Messaging binary/Uint8Array path (blocked on Chrome)

**Source:** GitHub issue #389 (guest271314, 2026-06-04): "with the 64 MiB case
… `Uint8Array` could potentially be more efficient, particularly when sending
back those 1 MiB chunks. We don't have to wait for valid JSON to send back valid
`u8` values."

## Idea

If a host could respond with **binary (`Uint8Array`) messages** instead of JSON,
a large reply could be split at **any** byte boundary (no element/comma
alignment, no `[`/`]` re-framing). That is strictly more efficient than the
current JSON re-chunking (#1865): it can stream raw ≤1 MiB byte chunks through a
single reused buffer — fast (no per-frame `array.copy`; see #1863) and
low-memory (never holds the whole body). This is essentially the original
streaming byte-chunk host we replaced for the JSON path.

## Why it's blocked (do NOT build yet)

Chrome native messaging is **JSON-only today**. Per the official docs, "each
message is serialized using JSON, UTF-8 encoded and is preceded with 32-bit
message length." There is no `ArrayBuffer`/`Uint8Array` message type — a
non-JSON frame is rejected with "The sender sent an invalid JSON message;
message ignored." (Limits: host→extension 1 MiB, extension→host 64 MiB.)

Binary native messaging is a long-standing, **unshipped** feature request:
[crbug 732457 — "Add ability to send binary data using native messaging"](https://bugs.chromium.org/p/chromium/issues/detail?id=732457),
open since 2017. So this path is not viable until/unless Chrome ships it.

## When unblocked

- Add a binary host variant (or a `--binary` mode) that streams raw ≤1 MiB byte
  chunks via a reused buffer (the pre-#1865 streaming design), and a
  `compare-memory.mjs` mode that frames/checks binary instead of JSON.
- Expect it to beat the JSON re-chunking host on both speed and memory for large
  payloads (no `array.copy`, no body retention).

## Status

Backlog / blocked on crbug 732457. The JSON re-chunking host (#1865) remains the
correct and only viable approach on current Chrome.
