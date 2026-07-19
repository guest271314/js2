---
id: 1793
title: "node:buffer + global Buffer — host class with from/concat/toString"
horizon: m
status: done
completed: 2026-07-16
assignee: ttraenkler/fable-epsilon
loc-budget-allow:
  - src/codegen/expressions/calls.ts
sprint: 72
created: 2026-06-03
updated: 2026-07-19
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
parent: 1575
related: [1044, 1032, 983]
---
# node:buffer + global Buffer — host class with from/concat/toString

## Problem

`Buffer` underlies every `node:http` body, every non-utf8 `node:fs` read, and
every `node:crypto` digest (#1575 matrix: blocks axios, zlib consumers,
crypto). It is also a **global**, not just an export of `require("buffer")`, so
the opaque `__node_buffer` externref path cannot handle the common form at all
— compiled code crashes on the first `Buffer.from(...)` because `Buffer` is not
recognised as an extern class (contrast: `Date` is).

## Acceptance criteria

Tier 0 (JS-host target — standalone deferred):

- `Buffer.from("hi", "utf-8").toString("utf-8") === "hi"`
- `Buffer.concat([Buffer.from("a"), Buffer.from("b")]).length === 2`
- `Buffer.from([104, 105]).toString() === "hi"`
- `Buffer.alloc(4).length === 4`
- Passing a `Uint8Array` to a host import takes a Buffer view in JS-land
  without copying.
- Both the global form (`Buffer.from(...)`) and the import form
  (`import { Buffer } from "node:buffer"`) resolve to the same host class.

## Implementation approach

1. Recognise the global identifier `Buffer` in codegen as an extern class
   (same machinery as `Date`), so static calls `Buffer.from` / `Buffer.alloc`
   / `Buffer.concat` lower to host imports.
2. Map `Buffer.prototype.{toString, slice, write, readUInt8, ...}` to
   externref method dispatch via `__extern_method_call`.
3. Provide a thin `Uint8Array` ↔ `Buffer` bridge so Wasm-side typed arrays can
   cross the host boundary as Buffer views without a copy (see #983 for the
   round-trip-argument hazard with stream callbacks).
4. The encoding matrix (latin1/base64/hex/ucs2 …) is the long tail — Tier 0
   covers utf-8 + byte-array only; remaining encodings are a follow-up.
5. Standalone (WASI) Buffer is out of scope here — track alongside #1471/#1472.

## Test

`tests/issue-1793.test.ts` — compile each Tier 0 snippet under JS-host config
and assert against the host's native `Buffer`.

## Implementation Notes (fable-epsilon, 2026-07-16)

Tier 0 landed as a ONE-LINE whitelist addition: `"Buffer"` in
`BUILTIN_CLASS_NAMES` (`src/codegen/expressions/calls.ts`). That routes
`Buffer.<static>(...)` through the generic host-delegated arm
(`__get_builtin("Buffer")` → `globalThis.Buffer` + `__extern_method_call`),
and instances (plain externrefs) ride the existing any-receiver dispatch for
`toString` / `.length`. No new host imports; JS-host lane only.

- **Statics work**: from(string, enc), from(byte[]), from(Uint8Array),
  alloc(n), concat([...]) — wasm array literals cross correctly (the
  `_wrapForHost`/vec machinery converts them once `setExports` is wired).
- **Import form works for free**: `import { Buffer } from "node:buffer"`
  binds localName `Buffer`, whose identifier text hits the same whitelist.
- **User shadowing safe**: `const Buffer = {...}` / `class Buffer {...}` are
  intercepted by earlier user-definition arms (probed both, 42/42).

## Test Results

`tests/issue-1793.test.ts` — 7/7 pass (all Tier 0 acceptance criteria plus
concat content round-trip and Uint8Array value-faithful crossing).

## Deferred (follow-ups)

- **Zero-copy Uint8Array↔Buffer view**: TypedArrays are wasm-NATIVE structs;
  the host boundary marshals values (correct bytes, not shared memory), and
  `.buffer` is not exposed on the host mirror. A true zero-copy view needs
  the #983-style bridge. Deferred with the encoding matrix
  (latin1/base64/hex/ucs2) as the issue itself anticipated.
- **`declare function` host-dep calls silently dropped** — separate defect
  found while probing the zero-copy criterion; filed as **#3325**.
- Standalone (WASI) Buffer — out of scope per the issue (#1471/#1472 track).
