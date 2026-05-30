---
id: 1752
title: "TextEncoder / TextDecoder runtime API (standalone + WASI)"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: medium
feasibility: medium
task_type: feature
area: runtime
language_feature: web-api
goal: platform
related: [389, 1588, 1655]
depends_on: []
sprint: Backlog
---

# #1752 — TextEncoder / TextDecoder runtime API

## Context

Surfaced on GitHub #389 (native-messaging host). The contributor's host wants
an `encodeMessage` helper:

```ts
const encoder: TextEncoder = new TextEncoder();
function encodeMessage(message: object): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}
```

so the host can **produce** messages (host → client) rather than only echo back
bytes it received. We don't expose `TextEncoder` / `TextDecoder` yet, so this
pattern doesn't compile in standalone / WASI mode.

## Scope

Implement the WHATWG Encoding API surface the native-messaging use-case needs,
Wasm-native (no JS host dependency) so it works under `--target wasi`:

- `new TextEncoder()` + `encoder.encode(string): Uint8Array` — UTF-8 encode.
- `encoder.encodeInto(string, Uint8Array): {read, written}` (stretch).
- `new TextDecoder([label])` + `decoder.decode(BufferSource): string` — UTF-8
  decode (at least `utf-8`; label validation can be minimal).

This builds directly on **#1588** (UTF-8/WTF-16 string-encoding tracking) and
its `__str_to_utf8` transcoder primitive (ADR-0015) — `TextEncoder.encode` is
essentially that transcoder behind the standard API, and `TextDecoder.decode`
is its inverse. Pairs with #1655 (WASI `process.stdout.write(Uint8Array|ArrayBuffer)`).

## Acceptance

- `new TextEncoder().encode(str)` returns a correct UTF-8 `Uint8Array` (incl.
  multi-byte + surrogate-pair code points) in standalone + WASI modes.
- `new TextDecoder().decode(bytes)` round-trips encode→decode.
- Mirrors the standard Web/Node API exactly (no bespoke builtin), per the
  "mimic standard APIs" rule.
- Regression test covering ASCII, multi-byte (é, 你, 😀), and round-trip;
  ideally compiles the #389 `encodeMessage` shape.
