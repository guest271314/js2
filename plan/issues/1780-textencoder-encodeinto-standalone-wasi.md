---
id: 1780
title: "TextEncoder.encodeInto support for standalone and WASI"
status: ready
created: 2026-06-02
updated: 2026-06-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: web-api
goal: platform
related: [389, 1588, 1655, 1752]
depends_on: []
sprint: Backlog
origin: "Follow-up to #1752 stretch goal: TextEncoder.encodeInto was explicitly not implemented."
---

# #1780 - TextEncoder.encodeInto support for standalone and WASI

## Problem

#1752 added Wasm-native `TextEncoder.encode` and `TextDecoder.decode` for
standalone/WASI no-host mode, closing the native-messaging UTF-8 runtime API
gap from GitHub #389. The stretch API `TextEncoder.prototype.encodeInto` was
left unimplemented.

`encodeInto(input, destination)` should write UTF-8 bytes into the supplied
`Uint8Array` and return `{ read, written }`, respecting partial writes and
never splitting a code point or surrogate pair.

## Acceptance

- `new TextEncoder().encodeInto(str, dest)` exists and returns an object with
  standard `{ read, written }` fields.
- The API works under standalone/WASI no-host targets without adding
  `TextEncoder_*` host imports.
- ASCII, multibyte BMP code points, surrogate pairs, lone surrogates, empty
  strings, and too-small destination buffers are covered by tests.
- Partial writes report exact `read` and `written` counts and leave the
  remaining destination bytes untouched.
- Existing #1752 encode/decode round-trip tests continue to pass.

## Non-goals

- Streaming decode support.
- Encoding labels beyond UTF-8.
- Replacing or redesigning the existing `TextEncoder.encode` lowering.
