---
id: 2834
title: nm_js2wasm_node_process example is not node-runnable (Buffer stdin chunks)
status: done
completed: 2026-06-29
assignee: ttraenkler/agent-aca3caf083aabc01b
sprint: 69
priority: low
area: examples
task_type: bug
related: [389, 2832, 2831]
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

## Resolution (option a — node-runnable via setEncoding)

Fixed by declaring the stdin encoding instead of per-byte Buffer handling:

- `examples/native-messaging/nm_js2wasm_node_process.ts` calls
  `process.stdin.setEncoding("latin1")` BEFORE subscribing. Under REAL node this
  switches the stream to deliver one-char-per-byte latin1 **string** chunks, so
  the state machine's `chunk.charCodeAt(...)` byte reads recover the raw byte
  exactly as they do for the js2wasm prelude's string chunks — no
  `TypeError: chunk.charCodeAt is not a function`.
- `src/process-stdin-prelude.ts` `__Js2wasmReadable` gains a faithful
  `setEncoding(encoding?)` no-op (returns `this`). The prelude already
  materialises every chunk as a one-char-per-byte string, so there is no Buffer
  mode to switch — the SAME source compiles to Wasm unchanged.

This is preferred over per-byte `chunk[i]` access: a js2wasm **native string**'s
`chunk[i]` yields a 1-char string (not a byte code), and reading bytes off an
`any`/union/`Buffer` value in compiled code lowers through the externref vec path
(`__vec_from_extern`), which is invalid under standalone WASI. `setEncoding` keeps
the wasm path byte-identical (string `charCodeAt`) while making node deliver the
same string shape.

### Verification

- **Under real node** (`bun build --target node` + transpiled `.js`): framed
  message round-trips **byte-exact**, exit 0, NO `charCodeAt` error.
- **New regression test** `tests/issue-2834-nm-node-process-node-runnable.test.ts`
  runs the transpiled example under the actual `node` binary (single frame +
  >64 KiB multi-chunk body) and asserts byte-exact echo with no `charCodeAt`
  TypeError. Passes.
- **Wasm path** stays covered by the existing `#2735`/`#2752` compile +
  byte-exact wasmtime round-trip tests (setEncoding is a no-op there).

### Pre-existing blocker (NOT this issue): #2831

`native-messaging-smoke` (`scale-test.mjs`) and the standalone-WASI `process.stdin`
tests (`issue-2735`, `issue-2752`) are currently **RED on origin/main**, broken by
#2831 ("host-externref→wasm-vec materializer") since the merge of #2311 — they
fail at compile with `__vec_from_extern_* … type mismatch: expected i32, found
externref`. This reproduces on the **unedited** origin/main file (confirmed via
`git stash`), so it is independent of this change and must be fixed under #2831.
The node-runnability fix here is verified on the paths #2831 does not break.
