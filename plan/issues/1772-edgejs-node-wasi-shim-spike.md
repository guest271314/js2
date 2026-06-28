---
id: 1772
title: "Node API imports from @types/node, satisfied by one ABI across pure-WASI shim / edge.js→node / JS+WASI hosts (anchor: node:fs readSync/writeSync)"
status: in-progress
created: 2026-06-01
updated: 2026-06-24
assignee: ttraenkler/dev-1772-p2
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: research
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: 67
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

---

## Implementation Plan (Phase 2 completion — the generalization)

> Scoping pass 2026-06-24 (architect), regrounded against current `main`.
> **What is already landed is larger than the issue text implies.** Phase 0 (ABI
> doc), Phase 1 (edge.js dual-provider proof + `tests/issue-1772-edge-dual-provider.test.ts`),
> and the **#2634 capability-map *data + type surface*** are all on `main`. The
> remaining Phase-2 work is narrow and concentrated in **one missing wire** plus
> two small extensions. This plan specs ONLY that residual.

### Root cause / what is actually missing

`src/checker/node-capability-map.ts` (#2634) already provides: the
`NODE_CAPABILITY_MAP` registry, faithful overloaded `.d.ts` for `readSync`/
`writeSync`, the `FS_PATH_BASED_MEMBERS` list, and three query functions —
`getModuleCapability`, `isKnownMember`, **`isMemberSatisfiable(module, member,
target)`**. `src/checker/index.ts::buildNodeEnvDts` already consumes
`buildModuleDecls` to emit the import-scoped surface (#2624).

**The gap:** `isMemberSatisfiable` is dead code. Verified on `main` — nothing
under `src/codegen/` imports it (`grep -rn isMemberSatisfiable src/codegen/` is
empty). So a path-based member (`readFileSync(path)`) under `--target wasi` does
**not** produce the promised *precise* "no provider under --target wasi" compile
error; it falls through `node-fs-api.ts`'s `tryCompileNodeFsCall` (which only
matches `readSync`/`writeSync`, returns `undefined` for the rest) onto the
generic host-import path and becomes a silent link-time failure / dropped
import. The capability map's central promise — "type-checks clean, but
unsatisfiable members error at compile time, not at link" — is **unrealized at
codegen**. Closing that is the bulk of Phase 2.

### Slice P2-a — wire the deliberate "no provider" codegen gate (the core gap)

**File: `src/codegen/node-fs-api.ts`** — `tryCompileNodeFsCall` (line ~237).
- It currently early-returns `undefined` for any callee that is not
  `readSync`/`writeSync`. Add, BEFORE that early return, a capability check for
  imported `node:fs` members that the program actually bound:
  - Import `getModuleCapability` + `isKnownMember` + `isMemberSatisfiable` from
    `../checker/node-capability-map.js`.
  - Build the `CapabilityTarget` from codegen context: `{ wasi: ctx.wasi,
    allowFs: ctx.allowFs ?? false }`. (Confirm/add an `allowFs` field on
    `CodegenContext` in `src/codegen/context/types.ts` — there is an
    `--allow-fs` notion referenced in comments but no plumbed flag yet. **For
    this slice, hardcode `allowFs: false`** so the gate produces the correct
    standalone-WASI error and stays atomic; the flag plumbing lands later
    (P2-a.0) without touching the gate.)
  - If `isKnownMember("node:fs", callee)` and
    `isMemberSatisfiable("node:fs", callee, target) === false`, push a precise
    error to `ctx.errors` (follow the exact shape already used at line ~46 and
    ~539 in this file) with message text:
    `` `node:fs.${callee}` needs a filesystem provider, unavailable under `--target wasi`. Pass `--allow-fs` for the JS-host filesystem provider, or use the fd-based `readSync`/`writeSync(fd, …)` for standalone WASI (no path_open/preopens). `` Then return a handled sentinel (a `VOID_RESULT`-style f64 0 / the file's existing "consumed" return) so the generic path does not also fire.
- **Edge case:** only gate members the program *imported from `node:fs`* — do not
  gate a same-named user function. `tryCompileNodeFsCall` already keys off the
  imported binding; reuse that binding set so a local `function readFileSync(){}`
  is untouched.
- **Edge case:** `readSync`/`writeSync` stay satisfiable under `--target wasi`
  (`providersFor` returns `["wasi-fd"]`) — the gate is a no-op for them, the
  existing lowering proceeds unchanged.
- **Edge case:** non-WASI target — under a JS host, path-based members resolve
  through the real `node:fs`; do not gate when `!ctx.wasi` (the
  `tryCompileNodeFsCall` body already early-returns on `!ctx.wasi`, so the gate
  must sit AFTER that guard but BEFORE the `readSync`/`writeSync` match).

**P2-a.0 (deferred prerequisite, tiny):** thread `--allow-fs` → `compile()` opts
→ `ctx.allowFs`, swapping the hardcoded `false`. Independent follow-up; does not
block P2-a.

- **Role:** developer. **PR-able alone.** Test:
  `tests/issue-1772-no-provider-gate.test.ts` — compile a program importing
  `readFileSync` from `node:fs` under `--target wasi`, assert `r.success ===
  false` and the error names the member + `--allow-fs`. Assert a
  `readSync`/`writeSync` program still compiles green and a non-WASI compile of
  the same `readFileSync` program is NOT gated.

### Slice P2-b — extend the capability map beyond the fd anchor (the "mechanism", not new surface)

**File: `src/checker/node-capability-map.ts`** — add a second capability-mapped
module to *prove the data-not-code extension mechanism* the #2634 design header
promises ("adding `node:process`/`node:os` members later is a new entry in
`NODE_CAPABILITY_MAP`, not a code change").
- Add the **already-lowered** `process.stdout.write` / `process.stderr.write`
  surface as *satisfiability entries* so P2-a's gate can reason about them. These
  lower today via `node-fs-api.ts::tryCompileProcessStdoutWrite` to
  `writeSync(1|2, …)`; gate `providersFor: (t) => (t.wasi ? ["wasi-fd"] :
  ["js-host-fs"])`.
- **Important boundary:** `node:process` is *partially* handled today by the
  bespoke `PROCESS_INTERFACE_DECLS` branch in `buildNodeEnvDts` (line ~454). Do
  **NOT** rip that out in this slice — the two must not double-declare
  `stdout`/`stderr`. Keep `node:process` decl emission on the existing bespoke
  branch; add ONLY the capability *satisfiability* metadata (not new decls) so
  the map's query functions cover the process std-IO members. A full migration of
  `node:process` decls into the map is a separate follow-up.
- **Verdict to record in code (acceptance item — hand-authored vs literal
  `@types/node`):** *Keep the hand-authored faithful mirror.* Write this into the
  map's header comment. Reasoning: (1) the checker uses an in-memory lib host and
  deliberately does NOT load `node_modules/@types/node` (the support-decls
  comment says so), so literal sourcing means shipping/parsing the full
  `@types/node` graph (`NodeJS.*`, `Buffer`, stream types, thousands of members)
  at checker-init — heavy, and ~99% un-linkable. (2) The gate's whole point is
  that the *type surface must equal the runtime surface*; literal `@types/node`
  is the opposite (type ≫ runtime). (3) The mirror is already verified faithful
  against `node_modules/@types/node/fs.d.ts` per member (the #2634 comments cite
  the exact source files). **So literal-sourcing is rejected; the design is
  hand-authored-per-member-with-a-cited-source-of-truth.** The "extraction from
  `@types/node`" language in the original Phase-2 scope is satisfied by *faithful
  mirroring with a cited source*, not by runtime parsing.

- **Role:** developer. **PR-able alone** (the map entry is independent of P2-a;
  only a cross-cutting test that exercises the gate on a process member needs
  P2-a). Test: `tests/issue-1772-capability-map-extend.test.ts` — assert
  `isMemberSatisfiable("node:process", "stdout"/"write", {wasi:true,allowFs:false})`
  is truthy and a fabricated unsatisfiable member is falsy; assert
  `buildNodeEnvDtsForSource` for a `process.stdout.write` program is byte-neutral
  for a non-process program.

### Slice P2-c — compose with #2528 `--platform node|web` (ambient surface)

**Files: `src/codegen/index.ts`** (the `LIB_GLOBALS`/`DOM_ONLY_GLOBALS` sets
referenced by #2528) and `src/checker/index.ts` (the `emulateNode` gate at
line ~573 that decides whether to inject `buildNodeEnvDtsForSource`).
- #2528 is `status: backlog` and is the **ambient-global** axis; #1772 Phase 2 is
  the **importable `node:<mod>`** axis. They compose at exactly one decision
  point: today `buildNodeEnvDts` injection is gated on
  `analyzeOptions?.emulateNode === true`. When #2528 lands `--platform node`,
  that flag SHOULD imply `emulateNode = true` (the node platform auto-provides
  both the ambient `process` global AND the capability-mapped `node:<mod>` import
  surface). Under `--platform web`, the `node:<mod>` import surface stays
  available (an explicit `import` is explicit intent) but the bare ambient
  `process` global is NOT auto-declared.
- **This slice is a written composition note + the one-line
  `emulateNode ||= (platform === "node")` wire**, gated on #2528 landing first.
  **Mark P2-c `depends_on: 2528`; do not dispatch until #2528 is in progress.**
  If #2528 is not scheduled, P2-c reduces to a paragraph in
  `docs/architecture/node-fs-abi.md` recording the intended composition and is
  **deferrable**.
- **Role:** developer (trivial wire) once #2528 lands; **architect/PO note**
  meanwhile.

### Verdict on edge.js as the JS-provider substrate (acceptance item — confirmed)

Already recorded in the Phase-1 section above and **confirmed by this scoping
pass**: edge.js is the right substrate and is a thin, dependency-free adapter
(two closures over exported memory), NOT a framework. Phase 2 does not change
that verdict — the capability map decides *what is linkable*; edge.js is *one
provider* satisfying the fd-based tier on the native-Node host. The async
extension of edge.js is specced in **#2635** (a genuinely larger surface).

### Phase 2 decomposition summary

| Slice | What | Role | Depends on | PR-able alone |
|-------|------|------|-----------|---------------|
| **P2-a** | Wire `isMemberSatisfiable` → precise "no provider" codegen error in `tryCompileNodeFsCall`; hardcode `allowFs:false` | developer | — | yes |
| **P2-b** | Add `node:process` std-IO satisfiability entries (mechanism proof) + record the hand-authored-mirror verdict in code | developer | — (P2-a only for the cross-test) | yes |
| **P2-c** | Compose with #2528 `--platform node` (`emulateNode ||= platform==="node"`) | developer | **#2528** | no (gated) |

P2-a is the only true "completes the acceptance" slice; P2-b proves the
extension mechanism + lands the written verdict; P2-c is deferrable until #2528.
**Suggested order: P2-a → P2-b (parallel-safe); P2-c last/deferred.**

---

## Phase 2 progress — slices P2-a + P2-b LANDED (2026-06-24)

Architect scoping (PR #2011, `## Implementation Plan` above) split the residual
Phase-2 work into P2-a (wire the gate), P2-b (extend the map + record the
verdict), and P2-c (compose with #2528, gated). This PR lands **P2-a + P2-b**.

- **P2-a — no-provider codegen gate (DONE).** `src/codegen/node-fs-api.ts`
  `tryCompileNodeFsCall` now consults the capability map: a `node:fs` member the
  program imported, known to the map, and **unsatisfiable** under the active
  target (`isMemberSatisfiable("node:fs", member, { wasi: ctx.wasi, allowFs:
  false }) === false`) pushes a precise error naming the member + `--allow-fs`,
  and returns the `VOID_RESULT` "consumed" sentinel so the generic host-import
  path does not also fire. The gate sits AFTER the `!ctx.wasi` guard but BEFORE
  the `!ctx.linkNodeShims` short-circuit, so it fires under `--target wasi`
  regardless of `--link-node-shims`, and is a no-op for the satisfiable fd-based
  `readSync`/`writeSync`. It keys off `ctx.wasiNodeFsFuncs` (the node:fs import
  set) so a same-named local function is never gated. This wires up what was
  **dead code** (`isMemberSatisfiable` had no codegen consumer) and makes the
  map the source of truth; the legacy hardcoded `PATH_BASED_FS_FNS` gate in
  `calls.ts` (byte-identical member set) is now a harmless backstop the map gate
  pre-empts. `allowFs` is hardcoded `false` this PR — the `--allow-fs` plumbing
  is the tiny deferred follow-up **P2-a.0**.
  Test: `tests/issue-1772-no-provider-gate.test.ts`.

- **P2-b — capability-map extension + verdict (DONE).**
  `src/checker/node-capability-map.ts` gains a `node:process` entry with std-IO
  satisfiability metadata (`write`/`stdout`/`stderr`, `providersFor: t.wasi ?
  ["wasi-fd"] : ["js-host-fs"]`) — **metadata only, empty decls**. The
  `node:process` type surface stays owned by the bespoke `PROCESS_INTERFACE_DECLS`
  branch in `buildNodeEnvDts` (which `continue`s before `buildModuleDecls`), so no
  double-declaration; the map entry just lets the query functions reason about
  the std-IO members (proving the #2634 "data-not-code extension" promise). The
  **hand-authored-mirror verdict is recorded in the map header**: literal
  `@types/node` sourcing is REJECTED (in-memory lib host doesn't load
  `@types/node`; the gate needs type-surface == runtime-surface, the opposite of
  `@types/node`; the mirror is per-member faithful with a cited source).
  Test: `tests/issue-1772-capability-map-extend.test.ts`.

- **P2-c — deferred (gated on #2528).** Compose with `--platform node|web`
  (`emulateNode ||= platform === "node"`). Not dispatched until #2528 lands.
- **Phase 3 (#2635)** — async members; out of scope here.

**#1772 stays `in-progress`** — P2-c (gated on #2528) and Phase 3 (#2635) remain.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — research/multi-phase. Phases 0 (ABI pin) + 1 (edge.js byte-identical dual-provider proof) done. The referencing PR is Phase 2 scope (no-provider gate + capability-map extension, #2634); the one-ABI provider-swap surface across pure-WASI / edge.js→node / JS+WASI hosts is not fully realized. Stays in-progress.
