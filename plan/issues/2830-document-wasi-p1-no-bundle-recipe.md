---
id: 2830
title: Document the wasi_p1 --no-bundle build recipe
status: ready
sprint: current
priority: low
area: docs
task_type: docs
related: [389]
---

# Document the wasi_p1 `--no-bundle` build recipe

## Problem

`examples/native-messaging/nm_js2wasm_wasi_p1.ts` imports `wasi_snapshot_preview1`
(`fd_read`/`fd_write`) and `wasm:memory` (`store32`/`load32`/…). These are
compiler intrinsics with **no resolvable JS module**, so bundling with
`bun build` fails unless the example is built with `--no-bundle` (or each ghost
import is marked `--external`). The loopdive/js2#389 reporter hit exactly this.

## Goal

Document the wasi_p1 build recipe in `examples/native-messaging/README.md` and/or
the runtimes doc:

- `bun build --no-bundle`, or
- the `--external wasi_snapshot_preview1 --external 'wasm:memory'` form already
  used in `examples/native-messaging/scale-test.mjs`.

Note the ghost-import ergonomics tradeoff (already discussed on #389) so users
understand why these imports cannot be bundled.
