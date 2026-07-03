---
id: 2812
title: "Native Messaging deployment recipe: ship a Chrome NM host from js2wasm output (wasmtime shebang / bun -b / deno compile + manifest)"
status: done
completed: 2026-07-02
assignee: ttraenkler/agent-a45493
created: 2026-06-29
updated: 2026-07-03
priority: medium
feasibility: medium
task_type: docs
area: examples
language_feature: native-messaging
goal: platform
sprint: 69
horizon: m
related: [389, 2778, 2807]
---

# Native Messaging deployment recipe

## Problem

The native-messaging examples compile to a `.wasm`, but there's no documented,
turnkey path to a **deployable** Chrome native-messaging host — which is a single
executable Chrome launches per the host manifest. The loopdive/js2#389 reporter
is hand-assembling this:

- a `#!/usr/bin/env -S wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y host.wasm`
  shebang script that Chrome launches,
- `bun -b host.wasm` direct WASM-GC execution,
- `deno compile` to a standalone executable.

## Scope

Document (a `docs/` section + the `examples/native-messaging/README.md`) a
turnkey recipe from a js2wasm-compiled host to a deployable Chrome host:

1. **Compile:** `js2wasm examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi -o .`
2. **Pick a runner:**
   - wasmtime shebang script (the exact `-W` flags; **not** `--all-proposals`, which enables stack-switching wasmtime rejects),
   - `bun -b host.wasm` (direct WASM-GC execution),
   - `deno` / `deno compile` standalone executable.
3. **Wire the manifest:** point the Chrome `com.example.host.json` `path` at the runner script/executable.
4. **node:fs hosts** need `--preload node:fs=<shim>` (`scripts/build-node-fs-shim.mjs`) — document the wasmtime/bun/deno equivalents.

Optionally a small `scripts/make-nm-host.sh` helper that emits the runner + a
manifest template.

## Acceptance

A user can follow the doc to produce a runnable Chrome native-messaging host
from an example — manifest wiring included — for at least the wasmtime-shebang
and `bun -b` paths.

## Related

- #389 — reporter's deployment exploration (shebang runner, `bun -b`, `deno compile`).
- #2778 / #2807 — the example hosts themselves.
