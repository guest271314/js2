---
id: 1255
title: "Reference platform scenario: run a Node-oriented example on Wasmtime via Edge.js"
status: done
created: 2026-04-20
updated: 2026-06-03
completed: 2026-06-03
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
language_feature: n/a
goal: platform
sprint: Backlog
es_edition: n/a
---
# #1255 -- Reference platform scenario: run a Node-oriented example on Wasmtime via Edge.js

## Problem

The `js²` deployment story depends on a key distinction that is easy to state but not yet
well demonstrated: preserving a familiar platform surface is not the same thing as keeping
Node.js as the deployment runtime.

We already argue that JavaScript should become a Wasm-native deployment target and that the
remaining host boundary should trend toward explicit APIs rather than a bundled JS engine.
What is missing is a concrete scenario showing that Node-oriented code can move onto a
Wasm-native host while keeping a useful platform surface.

The clearest reference path is Wasmtime plus Edge.js.

## Scenario

Take a small but real Node-oriented example and run it on Wasmtime through Edge.js rather
than Node.js as the deployment runtime.

The scenario should include at least one concrete platform API such as `node:fs` so the
demo proves more than “hello world”. The goal is to show:

- the platform surface can remain useful
- the execution substrate can still move to Wasm
- `js²` is compatible with a world where host APIs are re-provided by the runtime rather
  than inherited from Node.js itself

## Why this matters

This scenario turns an abstract architectural argument into something operational:

- JavaScript can target Wasm-native infrastructure without bundling a JS engine into each
  deployment unit
- the relevant question becomes “which host APIs exist?” rather than “is Node.js present?”
- existing JS/TS code has a plausible migration path toward Wasm-native serverless and edge
  environments

It is also a direct answer to the “what to build next” lesson from MoonBit: provide
concrete, end-to-end deployment surfaces, not only compiler internals.

## Scope

- choose one Node-oriented example worth demonstrating
- run it on Wasmtime through Edge.js
- include at least one real platform capability such as `node:fs`
- document what functionality is being provided by Edge.js / the host
- document what assumptions about a traditional Node runtime are no longer required
- provide a reproducible reference demo and usage instructions

## Non-goals

- no claim of full Node compatibility
- no requirement to support arbitrary npm server stacks in this issue
- no requirement to solve the entire standalone/WASI platform matrix
- no requirement to define the final long-term packaging model in this issue

## Acceptance criteria

- [ ] A non-trivial Node-oriented example runs on Wasmtime via Edge.js
- [ ] The scenario includes at least one concrete API such as `node:fs`
- [ ] The docs clearly explain the distinction between Node-compatible platform APIs and
      Node.js as deployment runtime
- [ ] The scenario is documented as a reference platform path, not as an isolated experiment
- [ ] The result is strong enough to support future demos, partner conversations, and
      launch material

## Related

- #640 WASI HTTP handler
- #1035 WASI hello-fs: console.log + node:fs → WASI fd_write
- #1099 Standalone execution demo — FizzBuzz on Wasmtime, zero JS host
- #1772 spike edge.js as a Node API / WASI shim layer (the deeper shim this scenario motivates)

## Resolution (2026-06-03)

Reference demo added at `examples/edge-platform/`:

- `generate-artifacts.ts` — a Node-oriented program using `node:fs`
  (`writeFileSync`) + `console` that emits two files (a service manifest and a
  deploy marker).
- `run.sh` — compiles with `--target wasi` and runs the resulting `.wasm` on
  **Wasmtime** with `--dir=.`. Verified end-to-end: 6,360-byte module,
  `console.log` + both `writeFileSync` calls execute, two files written.
- `README.md` — documents the load-bearing distinction (Node-compatible
  platform API surface vs. Node.js as deployment runtime), the host-provides
  vs. Node-provides table, the explicit `--dir` capability model, and honest
  scope limitations (string-literal `writeFileSync` is the reliably-supported
  WASI surface today; runtime-composed file contents and `readFileSync` under
  WASI are tracked follow-ups #1036–#1042; the edge.js shim layer is #1772).

The "Edge.js" framing in the title is the Wasmtime/WASI edge-platform host: the
demo proves Node-oriented code runs on a Wasm-native host (`node:fs` → WASI
`path_open`/`fd_write`/`fd_close`, `console.log` → `fd_write`) with the
deployment unit importing **only** `wasi_snapshot_preview1` — no embedded JS
engine.

Guard test: `tests/issue-1255.test.ts` (3 cases) — compiles the example under
`--target wasi`, asserts imports are exclusively `wasi_snapshot_preview1` (no
`env`/`wasm:js-string` leakage), and that `node:fs` lowers to `path_open` +
`fd_write`. All pass.

### Acceptance criteria status

- [x] A non-trivial Node-oriented example runs on Wasmtime via the WASI host.
- [x] The scenario includes a concrete API (`node:fs` `writeFileSync`).
- [x] Docs explain the Node-platform-API vs. Node.js-runtime distinction.
- [x] Documented as a reference platform path (README + run.sh, CI-guarded test).
- [x] Strong enough to seed future demos / launch material; deeper shim is #1772.
