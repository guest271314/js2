---
id: 1772
title: "Node API imports from @types/node, satisfied by one ABI across pure-WASI shim / edge.js→node / JS+WASI hosts (anchor: node:fs readSync/writeSync)"
status: in-progress
created: 2026-06-01
updated: 2026-06-24
assignee: ttraenkler/agent-a9512a06
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: research
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [389, 1575, 1766, 2527, 2528, 2624, 2625, 2631, 2632, 2083, 2181, 2634, 2635]
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

---

## Phase 0 — ABI (PINNED 2026-06-23)

> Companion doc: [`docs/architecture/node-fs-abi.md`](../../docs/architecture/node-fs-abi.md).
> This section is the normative pin; the doc expands the rationale.

### Canonical per-member pointer-ABI (anchor members)

The wasm import module is `"node:fs"` (real Node member names). Each member is a
flat `(i32, …) -> i32` function over the module's **exported linear memory** —
nothing GC-typed crosses the link:

| Member      | Wasm import signature                     | Contract |
|-------------|-------------------------------------------|----------|
| `readSync`  | `(fd i32, ptr i32, len i32) -> i32`       | Read up to `len` bytes from descriptor `fd` into `mem[ptr, ptr+len)`. Returns the count actually read (`0` = EOF). MUST NOT write past `ptr+len`. |
| `writeSync` | `(fd i32, ptr i32, len i32) -> i32`       | Write `mem[ptr, ptr+len)` to descriptor `fd`. Returns the count actually written (a short write is legal — callers loop). |

`fd` is **load-bearing**: `0`=stdin, `1`=stdout, `2`=stderr. `writeSync(2, …)`
routes telemetry to stderr, off the stdout protocol stream — a provider MUST
honor the integer fd, never collapse all writes to stdout.

This is the **single** ABI every provider implements. It is fd-based and
filesystem-free (no `path_open`, no preopens). Path-based `node:fs`
(`readFileSync(path)`) is a *different* capability tier (needs `--allow-fs`) and
is rejected under `--target wasi`.

**Caller ↔ ABI bridge.** Source code calls the *Node-shaped* signatures
(`readSync(0, buf, { offset, length })`, `writeSync(1, buf, offset)`); the
compiler bridges the GC/linear `Uint8Array` to the flat `(fd, ptr, len)` over the
shared memory. So the **same `.ts`** runs unmodified under real `node` (where
`node:fs` is the real module) *and* compiles to a wasm module whose imports honor
the pointer-ABI above. The pointer-ABI is the wasm-link contract; the Node-shaped
signature is the source-level contract. `edge.js` is exactly the adapter that
reconciles the two on the native-Node path.

### Memory-ownership / linking model

**Today — shim-owned exported memory** (mirrors `examples/native-messaging/node-fs.wat`):

1. The **provider owns and exports** the linear memory (`(memory (export "memory") 3)`).
2. The **user module imports** memory index 0 from `"node:fs"` along with
   `readSync`/`writeSync`. It declares NO memory of its own.
3. No instantiation cycle: instantiate the provider first (it imports only its
   own backing — `wasi_snapshot_preview1` for the `.wat` shim, or nothing for
   `edge.js`), then instantiate the user module with `{ memory, readSync,
   writeSync }` taken from the provider's exports.
4. The provider reads/writes the user's bytes over the **same** memory. The
   `.wat` shim builds its WASI iovec in reserved scratch at `mem[0, 12)`; `edge.js`
   reads/writes the byte range directly from JS — no scratch needed.

   (If a module uses **both** `node:process`/`console` IO and `node:fs`, the
   `node-process` shim owns the memory and `node-fs` links the same bytes —
   byte-identical layout, min 3 pages.)

**Durable form — #2527 core-wasm linking.** The shim-owned-memory convention is
a stop-gap that works on any plain `WebAssembly.instantiate`. The durable form is
WebAssembly core-module linking (#2527): the user module and provider are linked
as components/core modules with an explicitly shared memory, so neither side
hard-codes "who owns memory". The pointer-ABI per member is unchanged by that
migration — only the memory-binding mechanism changes.

### Contract table — one binary, three providers

The user's `nm_js2wasm.wasm` is **agnostic** to the provider. Compatibility holds
**by construction** iff every provider honors the pointer-ABI above:

| Host class | Provider | Satisfies `node:fs::readSync(fd, ptr, len) -> i32` by |
|---|---|---|
| **Pure WASI** (wasmtime, no JS) | `node-fs.wat`/`.wasm` shim (#2631) | WASI `fd_read`/`fd_write` over the shim-owned linear memory (iovec in `mem[0,12)`). |
| **Native Node** (JS, no WASI) | **`edge.js` adapter** (Phase 1) | reads/writes `mem[ptr, ptr+len)` from JS, calls real `fs.readSync(fd, Buffer, 0, len, null)` / `fs.writeSync(fd, Buffer)`, copies bytes back, returns the count. |
| **JS + WASI** (browser / Node-WASI) | `edge.js` over a WASI polyfill | delegates to a WASI `fd_read`/`fd_write` polyfill or platform fd APIs over the same memory. |

The Phase-1 proof: the **same compiled binary** runs under (1) wasmtime via the
`.wat` shim and (2) native Node via `edge.js`, with byte-identical output for the
same stdin frames.

---

## Phase 1 — edge.js provider + compatibility proof (DONE 2026-06-24)

**Result: the same-binary dual-provider proof works byte-identically.** ✓

Deliverables (on `main` via this issue's PR):

- `examples/native-messaging/edge.js` — a dependency-free native-Node provider of
  the `node:fs` import interface. `createNodeFsProvider()` owns + exports the
  linear memory (mirrors `node-fs.wat`) and implements `readSync(fd, ptr, len)` /
  `writeSync(fd, ptr, len)` by translating the pointer-ABI ↔ Node Buffer-ABI over
  that memory, delegating to the **real `node:fs`** (`fs.readSync(fd, buf, 0,
  len, null)` / `fs.writeSync(fd, buf, 0, len, null)`). `runWithEdge()`
  instantiates a compiled module with edge.js as the `node:fs` provider and runs
  it.
- `examples/native-messaging/run-edge.mjs` — runs a compiled module under edge.js
  with **real fds** 0/1/2 (so real `node:fs` syscalls carry the bytes).
- `tests/issue-1772-edge-dual-provider.test.ts` — the proof. It compiles **one**
  `node:fs`-importing wasm binary and runs it under **both** providers:
  - (a) **pure-WASI**: `node-fs.wat` shim under wasmtime
    (`-W gc=y,function-references=y,tail-call=y,exceptions=y --preload
    node:fs=<shim> --invoke main`);
  - (b) **native Node**: `edge.js` → real `node:fs` over real fds (child process).
  Both echo a framed message containing non-printable / high bytes
  (`[0x05,0,0,0, 0x00,0xff,0x0a,0x7f,0x80]`) **byte-for-byte identically** — a
  UTF-8-collapsing provider would diverge on `0x00`/`0xff`/`0x80`. Test green.

**Verdict on the JS-provider substrate (acceptance item).** `edge.js` is the
right substrate, and it is a **thin, dependency-free adapter** (two closures over
the instance's exported memory), **not** a framework. The only irreducible job is
the pointer-ABI ↔ Buffer-ABI translation (calling-convention impedance wrinkle):
real `fs.readSync(fd, buffer, offset, length, position)` ≠ wasm `readSync(fd,
ptr, len)`, so native Node is never a *direct* provider — it always needs this
adapter. A heavier "edge.js framework" would add nothing the pinned ABI doesn't
already specify. One implementation detail worth recording: edge.js copies the
wasm byte range into a standalone `Buffer` before each syscall (rather than
passing a `Uint8Array` view onto `memory.buffer` directly), because a
`memory.grow` between calls can detach a cached view — copying keeps the adapter
correct across growth.

### Phase status

- **Phase 0 — ABI**: ✅ done (pinned above + `docs/architecture/node-fs-abi.md`).
- **Phase 1 — edge.js + proof**: ✅ done (byte-identical dual-provider proof).
- **Phase 2 — `@types/node` → capability map**: ⏭️ split out to **#2634**.
- **Phase 3 — async members**: ⏭️ split out to **#2635** (blocked on #2632).

Issue stays `in-progress` because Phase 2 (#2634) remains. Phases 0+1 acceptance
criteria are met.
