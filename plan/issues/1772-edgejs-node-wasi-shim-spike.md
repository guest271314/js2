---
id: 1772
title: "Node API imports from @types/node, satisfied by one ABI across pure-WASI shim / edge.js→node / JS+WASI hosts (anchor: node:fs readSync/writeSync)"
status: ready
created: 2026-06-01
updated: 2026-06-23
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: research
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [389, 1575, 1766, 2527, 2528, 2624, 2625, 2631, 2632, 2083, 2181]
origin: "Follow-up from PR #1010 review direction; regrounded 2026-06-23 against the landed node:fs/node:process shim work"
---
# #1772 — Node API imports from @types/node, one ABI, swappable host providers

> **Regrounded 2026-06-23.** The original framing ("spike edge.js for
> `process.std*`") has been overtaken by landed work. The per-module shim
> approach is now real for two surfaces, so this is no longer a from-scratch
> spike — it is the **generalization** of what shipped, anchored on **`node:fs`
> `readSync`/`writeSync`**, not `process`. See "What already landed".

## Problem

Node-shaped host APIs should not keep accumulating as ad-hoc cases in the generic
compiler. The clean model (now partially built) is:

1. a program *imports* a node module surface (`import { readSync } from "node:fs"`),
2. the compiler emits a **wasm import** declaring the host-API dependency by the
   real module + member name (`import "node:fs" "readSync"`), import-scoped to
   only the members actually used,
3. that import is satisfied at **link time** by any provider honoring one fixed
   ABI — the module neither knows nor cares whether a `.wat` shim, a JS adapter,
   or the real Node module backs it.

Two pieces are still missing to make that model general and host-portable:

- **(A) Derive the importable surface + types from `@types/node`** instead of the
  hand-written minimal typings we inject today, gated by a **capability map** of
  what is actually runtime-satisfiable.
- **(B) An `edge.js` JS adapter** as the provider for native-Node and JS+WASI
  hosts, proven **compatible** with the pure-WASI `.wat` shim against one ABI.

**Anchor surface: `node:fs` `readSync` / `writeSync`** — fd-based and
filesystem-free (integer fds 0/1/2, no `path_open`, no preopens). This is the
concrete, already-landed surface to build the contract around. The old
`process.std*` framing is superseded; `node:process` is just a second consumer of
the same contract.

## What already landed (the slices this generalizes)

- **#2631** — `node:fs` `readSync`/`writeSync` via a per-module shim; wasm import
  module is `node:fs` (real member names), the shim is one provider
  (`examples/native-messaging/node-fs.wat`). The example runs unmodified under
  real `node`.
- **#2625** — `node:process` shim + `--link-node-shims` flag.
- **#2624** — node-emulation typing is **import-scoped**, not blanket
  (`scanNodeEmuUsage` / `buildNodeEnvDts`) — hand-written minimal typings today.
- Memory `feedback_node_apis_via_per_module_shim_not_builtin`: the wasm module
  declares WHAT host API it needs, never HOW it is satisfied; no Node semantics in
  codegen core.

## The compatibility contract (core deliverable)

One wasm binary, three host classes, one ABI per member:

| Host class | Provider | How it satisfies `node:fs::readSync(fd, ptr, len) -> i32` |
|---|---|---|
| **Pure WASI** (wasmtime, no JS) | `.wat`/`.wasm` shim (#2631) | `readSync` → WASI `fd_read` over the shim-owned linear memory |
| **Native Node** (JS, no WASI) | **`edge.js` adapter** | reads wasm memory `[ptr, ptr+len]`, calls real `fs.readSync(fd, Buffer, …)`, copies bytes back |
| **JS + WASI** (browser / Node-WASI) | `edge.js` | delegates to a WASI polyfill or platform fd APIs |

The binary is agnostic to the provider — this is the dual-mode "JS host optional"
principle (#679/#682). **Compatibility holds by construction iff every provider
honors the same pointer-ABI per member.** The synchronous fd core (`readSync`/
`writeSync`) is already portable across all three today.

### The wrinkles that decide real compatibility (must be addressed, not assumed)

1. **Calling-convention impedance.** Real `fs.readSync(fd, Buffer, offset,
   length, position)` ≠ the wasm `readSync(fd, ptr, len)`. So native Node is
   **never a direct provider** — it always needs the `edge.js` adapter to
   translate pointer-ABI ↔ Buffer-ABI over the module's exported memory. Define
   the canonical per-member pointer-ABI once; `edge.js` and the `.wat` shim both
   implement it.
2. **Type surface ≫ runtime surface.** `@types/node` types thousands of members;
   only the subset with a shim/adapter is *linkable*. Extraction must gate
   against a **capability map** (`@types/node` member → shim/adapter fn → host
   classes that can provide it), or programs type-check then fail to link. This
   is #2083 (host-glue suite) / #2181 (`defineBuiltin` scaffold) / #2527
   (core-wasm linking) territory.
3. **Async ≠ sync.** Sync fd APIs port trivially. Node's async surface
   (`process.stdin` Readable, `fs.promises`) needs the event loop (**#2632**);
   the contract can stay identical but the pure-WASI provider must drive
   `poll_oneoff` while `edge.js` borrows the JS host's loop. Async members are
   **out of scope here** — they unlock once #2632 lands.

## Scope (phased)

- **Phase 0 — pin the ABI.** Document the canonical pointer-ABI for the anchor
  members (`readSync(fd,ptr,len)->i32`, `writeSync(fd,ptr,len)->i32`) and the
  memory-ownership/linking story (shim-owned exported memory today; #2527
  core-wasm linking as the durable form).
- **Phase 1 — `edge.js` provider + compatibility proof.** A JS adapter that
  satisfies the `node:fs` imports of a #2631-compiled module by delegating to
  real `node:fs` over the module's exported memory. Prove the **same**
  `nm_js2wasm` wasm binary runs (a) under wasmtime via the `.wat` shim and (b)
  under native Node via `edge.js` — byte-identical behavior. This is the concrete
  compatibility proof.
- **Phase 2 — `@types/node`-driven surface + capability map.** Replace/extend the
  hand-written `buildNodeEnvDts` minimal typings with extraction from
  `@types/node`, gated by a capability map so only runtime-satisfiable members
  type-check clean (and unsatisfiable ones produce a precise "no provider" error,
  not a silent link failure). Compose with #2528 `--platform node`.
- **Phase 3 (deferred) — async members** behind #2632.

## Acceptance

- Phase 0: a short design note (in this issue or `docs/`) pinning the per-member
  pointer-ABI and the link/memory-ownership model.
- Phase 1: one `node:fs`-based example (the native-messaging host) demonstrably
  runs against **both** providers — `.wat` shim under wasmtime **and** `edge.js`
  under native Node — from the **same compiled wasm**, with a test asserting
  identical output. Or the precise blocker recorded.
- Phase 2: a working `@types/node`→capability-map extraction for the anchor
  members, with a deliberate-error path for unsatisfiable members. Follow-up
  issues filed for further surfaces.
- A written verdict on whether `edge.js` is the right JS-provider substrate (vs a
  bespoke thin adapter) and why.

## Out of scope

- Async/stream/EventEmitter Node surface (Readable `process.stdin`,
  `fs.promises`) — gated on the event loop (#2632).
- Path-based `node:fs` (`readFileSync(path)`, `open`) — needs a filesystem
  (`--allow-fs`/preopens); a separate capability tier from the fd-based core.
