---
id: 2834
title: nm_js2wasm_node_process example is not node-runnable (Buffer stdin chunks)
status: ready
sprint: current
priority: low
area: examples
task_type: bug
related: [389, 2832]
---

# nm_js2wasm_node_process is not node-runnable (Buffer stdin chunks)

## Problem

`examples/native-messaging/nm_js2wasm_node_process.ts`, run under **real
`node`** via the bun-bundled `.js`, throws:

```
TypeError: chunk.charCodeAt is not a function
```

Real node delivers `process.stdin` `'data'` chunks as **`Buffer`** objects, but
the host assumes **string** chunks (the shape the js2wasm prelude / bundled
harness provides), calling `chunk.charCodeAt(...)` on them. A `Buffer` has no
`charCodeAt`, so it throws on the first chunk.

The loopdive/js2#389 reporter confirmed: "node_process doesn't work using node
and the .js file." The example README only claims this variant runs under
**wasmtime**, so the source is doc-consistent — but the `node_process` source is
not actually node-runnable despite its name implying a `process.stdin`/`process`
Node host.

## Decision / Goal

Pick per maintainer preference:

- **(a) Make the host accept `Buffer` chunks** — read bytes via
  `Buffer.prototype` access / `.toString()` / byte indexing instead of
  `charCodeAt`, so the same source runs under real node as well as wasmtime.
- **(b) Document it as wasmtime-only** — explicitly state (and guard/clarify the
  entry point) that `nm_js2wasm_node_process` targets a WASI host and is not
  intended to run under real node, removing the misleading "node" framing or
  adding a clear runtime note.

## Notes

Tracking only — no implementation in the PR that created this file. Related to
the #389 native-messaging example hardening series (#2832, #2833).
