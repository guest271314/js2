---
id: 2521
title: "Native Messaging host: re-chunked >1 MiB messages need an in-body continuation marker so the receiver can reassemble"
status: ready
sprint: Backlog
created: 2026-06-20
updated: 2026-06-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: examples
language_feature: native-messaging
goal: usability
related: [1530]
---

## Problem (reproduced)

The Native Messaging example host (`examples/native-messaging/nm_js2wasm.ts`)
splits any message larger than 1 MiB into multiple ≤1 MiB response frames —
required, because Chrome caps a host→extension message at 1 MiB. Today each
re-chunked frame is a bare JSON array (`[run]`) with no marker, so **one logical
request produces N response frames with nothing tying them together**.

A receiver that expects one response per request (the standalone test harness,
and a naive extension) therefore desyncs: the big message's extra frames are
read as the responses to the *following* messages.

Reported on loopdive/js2#389. **Reproduced exactly** under deno 2.8.3 with the
reporter's `nm_standalone_test.js`:

- 64 MiB request (`Array(209715*64)`): the host emits ~64 frames of
  `messageLength: 1048571`; the harness reads each as a separate message.
- 2 MiB request: surfaces as the reporter's exact error
  `ArrayBuffer.prototype.resize: Invalid length parameter` once the stream
  desyncs.
- Matches the reporter's symptom precisely: "64 MiB alone passes, 64 MiB **with**
  the ≤1 MiB tests fails" — alone, the extra frames drain at EOF with nothing
  after to desync.

The host wasm logic is otherwise correct (single messages of any size, and the
full sequence via buffered/Node-pipe I/O, all round-trip cleanly). The gap is
the **re-chunk contract**, not codegen.

## Decision: in-body continuation marker (chosen over sender-waits-for-size)

A "sender knows the expected size, wait for the full echo" fix only covers
request/response echo. A **continuation marker** fixes the general case
(including an extension receiving an unsolicited large broadcast), so it's the
chosen approach.

**Constraint:** the marker MUST live inside the JSON body. In the browser Chrome
owns the 4-byte framing and delivers each frame to the extension already
JSON-parsed, so the length prefix's bits are unavailable — only the message
*value* survives to the receiver.

### Recommended frame shape — envelope per frame

```json
{ "chunk": [ …slice… ], "more": true  }   // non-final frame
{ "chunk": [ …slice… ], "more": false }   // final frame
```

- Receiver reassembles by concatenating `chunk` (array elements) until
  `more:false`. No need to know the total up front.
- Single-frame (≤1 MiB) messages emit one envelope with `more:false`, for a
  uniform receiver path. (Alternative: keep ≤1 MiB messages verbatim and only
  envelope multi-frame, with the receiver branching on shape — uniform is
  simpler and unambiguous; pick during implementation.)
- Each envelope must stay ≤1 MiB: drop `MAX_RUN` by the envelope overhead
  (`{"chunk":` … `,"more":true}` ≈ 25 bytes) so a full frame including the
  wrapper never exceeds the cap.
- Open design choice (architect): plain `{chunk,more}` vs a
  `{seq,total,chunk}` form (explicit index/total — more robust, slightly larger).

## Scope

- `examples/native-messaging/nm_js2wasm.ts`: `emitRun` (and the ≤1 MiB echo
  path, if uniform) wrap output in the envelope; shrink `MAX_RUN` for headroom.
- `examples/native-messaging/README.md`: document the marker + receiver
  reassembly contract.
- `examples/native-messaging/nm_js2wasm.sh` / background.js example: show the
  reassembling receiver.
- Tests: `tests/issue-1530.test.ts`, `tests/wasi-stdin.test.ts` — assert each
  emitted frame is ≤1 MiB valid JSON carrying the marker, and that reassembly
  reproduces the original.

## Acceptance criteria

- A >1 MiB request produces N frames, each ≤1 MiB valid JSON with a
  continuation marker; a receiver that reassembles on the marker reproduces the
  original message with no desync of subsequent messages.
- The reporter's `nm_standalone_test.js` sequence (64 MiB + ≤1 MiB messages),
  updated to reassemble on the marker, round-trips cleanly.
- ≤1 MiB messages still round-trip (single final-marked frame).

## Notes

Surfaced + reproduced while investigating loopdive/js2#389 (with deno installed
locally to run the reporter's harness). Pairs with the example's existing
re-chunk design in #1530.
