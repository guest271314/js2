---
id: 2635
title: "Async node:fs / process.stdin members over the event loop (Phase 3 of #1772)"
status: done
assignee: sdev-2635
completed: 2026-06-24
created: 2026-06-24
updated: 2026-06-24
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: 65
es_edition: n/a
depends_on: [2632]
related: [1772, 2631, 2632, 2634]
origin: "Phase 3 split out of #1772; gated on the WASI async event loop (#2632)"
---
# #2635 — async Node members over the event loop (Phase 3)

Phase 3 of #1772. The fd-based synchronous `node:fs` core (`readSync`/`writeSync`)
is portable across all three host classes today (Phase 0 ABI + Phase 1 proof,
both landed). The **async** Node surface is not, and is gated on the event loop.

## Problem

Node's async surface — `process.stdin` as a `Readable`, `fs.promises.*`,
EventEmitter-driven IO — has no synchronous fd primitive to lower to. The
`node:fs` pointer-ABI (`docs/architecture/node-fs-abi.md`) can stay identical in
shape, but each provider must drive a loop:

- the pure-WASI provider drives `poll_oneoff` over the shim;
- `edge.js` borrows the JS host's event loop.

Both require a real async runtime, which is #2632 (WASI async event-loop reactor).

## Scope (deferred until #2632 lands)

- Extend the `node:fs` interface (and `node:process`) with the async members,
  keeping the per-member ABI contract from Phase 0.
- Pure-WASI provider: drive `poll_oneoff`; `edge.js`: delegate to the JS loop.
- Same-binary dual-provider proof extended to an async member.

## Acceptance

- Blocked on #2632. When unblocked: one async `node:fs`/`process.stdin` member
  runs under both providers from the same compiled binary, with a test.

## Out of scope

- Path-based `node:fs` (`readFileSync(path)`, `open`) — separate capability tier
  needing a filesystem (`--allow-fs`/preopens), not async-gated.

## Implementation notes (P3-a + P3-b + P3-c — 2026-06-24, sdev-2635)

Landed slices P3-a + P3-b + P3-c in one PR. **P3-d (asyncify incremental
loop-borrow) is the remaining deferred fidelity follow-up** — not done here.

### What was actually the gap (regrounded against current main)
#2632 already shipped the ENTIRE WASI side of async `process.stdin`: the
fd0-readiness reactor (`async-scheduler.ts`: `buildRunLoopBodyWithFdReactor`,
`__rl_stdin_drain`, multi-subscription `poll_oneoff`), the four `__wasiStdin*`
reactor intrinsics, and a faithful byte-chunk `Readable` substrate
(`tests/issue-2632-phase3-stdin-readable.test.ts` proves the WASI arm under both
the JS polyfill and real wasmtime). So the true #2635 gap was exactly ONE thing:
the **edge.js (native-Node) arm** of the same-binary async proof.

### The load-bearing architectural fact (why the seam is `wasi_snapshot_preview1`, not `node:fs`)
The async `process.stdin` reactor is **WASI-internal**: `__run_event_loop` is
wired into `_start` and drives `poll_oneoff`/`fd_read`/`fd_fdstat_set_flags`/
`clock_time_get`/`fd_write` **directly as `wasi_snapshot_preview1` imports**.
There is no exported per-tick API and no `node:fs`-member ABI for the async path
(unlike the synchronous `readSync`/`writeSync`, which ARE `node:fs` closures
edge.js can satisfy — Phase 1). So the provider seam for the async path is the
`wasi_snapshot_preview1` import surface. edge.js's `createNodeStdinWasiProvider`
provides exactly that surface, fed by Node's real `process.stdin` events.

### The sync/async impedance + the decision I owned
The wasm reactor's `_start` is a **synchronous** `poll_oneoff`-blocking loop;
Node's stdin is **async**. Calling `_start()` and letting `poll_oneoff` block
deadlocks (data only arrives when the JS loop is free). I used **MECHANISM 2
(pre-drain)**: `await` Node's real `process.stdin` to `'end'`, collecting all
chunks (this genuinely borrows Node's event loop for the collection phase), THEN
run `_start()` so every `poll_oneoff` finds data/EOF immediately and never truly
blocks. This is the proven `setStdin(bytes)` + `_start()` path #2632 validated
byte-identically against wasmtime. **Mechanism 1** (true incremental
asyncify-suspend loop-borrow) is the deferred **P3-d**; the `P3-d SEAM` comment
in `edge.js` marks where it would slot in.

### Crucial codegen constraint discovered (memory ownership)
The async proof program must be **pure `--target wasi`** (owns + EXPORTS its own
`memory`), NOT `--link-node-shims`. A first attempt mixed `node:fs` writeSync
(imported memory, Phase-1 model) with the native WASI reactor; under wasmtime it
failed with **"missing required memory export"** — wasmtime's native
`wasi_snapshot_preview1.fd_read`/`clock_time_get` require the COMMAND module to
export `memory`, but a `node:fs`-importing module imports memory from the shim
and exports none. The pure-wasi program (memory self-owned + exported) is what
both wasmtime and edge.js bind. edge.js binds it lazily from
`instance.exports.memory` after instantiation.

### Provider semantics (mirror `buildWasiPolyfill` exactly, byte-for-byte)
- `fd_read(0)`: drain the pre-collected queue into the iovec base, return count;
  0-byte read == EOF (queue empty) — `__rl_stdin_drain`'s contract.
- `poll_oneoff`: fd0 FD_READ fires when bytes remain (else CLOCK; else fd0 anyway
  so the reactor's EOF read ends the subscription rather than hanging).
- `fd_fdstat_set_flags`: no-op ack (fd_read already non-blocking vs the queue).
- `fd_write`: writes RAW bytes to the real fd1/fd2 (NOT line-buffered through
  console.log) — required for byte-identity with wasmtime's native fd_write.
- Re-reads `memory.buffer` per `fd_read`/`fd_write` so a `memory.grow` between
  calls can't leave a detached view (matches Phase-1 `createNodeFsProvider`).

### Dependency choice
Kept the example **zero-dependency** (only `node:` imports), inlining the minimal
`wasi_snapshot_preview1` subset rather than importing `buildWasiPolyfill` from the
built `dist/` runtime (Phase-1 "thin adapter" precedent). This makes the edge.js
arm a genuinely INDEPENDENT provider that must AGREE byte-for-byte with both
wasmtime AND the in-tree polyfill — a stronger proof than re-exporting the
polyfill verbatim. Recorded in an `edge.js` comment; if semantics ever drift,
prefer reusing `buildWasiPolyfill` via a small `edge-wasi.mjs` helper.

### Files
- `examples/native-messaging/edge.js` — added `createNodeStdinWasiProvider`
  (the async provider) + `drainProcessStdin` helper (P3-a).
- `examples/native-messaging/run-edge-stdin.mjs` — native-Node async runner (P3-b).
- `tests/issue-2635-async-dual-provider.test.ts` — same-binary byte-identical
  proof: one compiled `process.stdin` line-count + byte-echo binary, byte-identical
  output under wasmtime AND edge.js, across frames incl. `0x00/0xff/0x80/0x0a` (P3-c).

### Validation
No compiler-core change (example + test + runtime-mirroring helper only). New test
green under both arms; `tests/issue-1772-*` + `tests/issue-2632-phase3-*` green
(no regression); tsc + biome lint/format clean. This closes Phase 3 of #1772;
#1772 itself stays in-progress for P2-c.

---

## Implementation Plan (Phase 3 — async dual-provider proof)

> NOTE (2026-06-24): the architect's plan below is preserved for design context;
> the "Implementation notes" section above records what was actually built and
> the one deviation (proof program is pure `--target wasi`, not `--link-node-shims`,
> for the memory-export reason). The plan's recommended P3-a→P3-b→P3-c order was
> followed; P3-d remains deferred.

> Scoping pass 2026-06-24 (architect), regrounded against current `main`.
> **The remaining gap is much smaller than the issue text implies.** #2632
> already landed the ENTIRE WASI side of async `process.stdin`: the fd0-readiness
> reactor (`src/codegen/async-scheduler.ts` — `buildRunLoopBodyWithFdReactor`,
> `__rl_stdin_drain`, `poll_oneoff` multi-subscription), the reactor-tick reader
> hook, the four `__wasiStdin*` intrinsics, AND a faithful `process.stdin`
> Readable source-prelude (`src/process-stdin-prelude.ts`, #2632 Phase 3 +
> finalize-shift fix #2641). The WASI provider arm of the dual-provider proof
> ALREADY WORKS end-to-end (`tests/issue-2632-phase3-stdin-readable.test.ts`
> proves it under both the JS polyfill and real wasmtime with piped stdin).
> **So the true #2635 gap is exactly ONE thing: the edge.js (native-Node) arm of
> the same-binary async proof.** Everything else is in place.

### The central architectural fact (what makes this non-trivial)

Verified in `src/codegen/async-scheduler.ts` + `src/codegen/index.ts`:

- The `process.stdin` reactor is **WASI-internal**, not a `node:fs`-style
  swappable import. `__run_event_loop` is wired into `_start`
  (`getRunLoopFuncIdxForWasiStart` → `index.ts` line ~2115) and drives
  `poll_oneoff` / `fd_read` / `fd_fdstat_set_flags` / `clock_time_get` **directly
  as `wasi_snapshot_preview1` imports**. There is **no exported per-tick API** and
  **no `node:fs`-member ABI** for the async path — unlike the sync `readSync`/
  `writeSync` (which ARE `node:fs` imports edge.js can satisfy as closures).
- Consequence: edge.js **cannot** provide the async reactor by implementing two
  `node:fs` closures the way Phase 1 did. The reactor's `poll_oneoff`-blocking
  loop runs to EOF *inside* `_start`. The provider seam for the async path is
  therefore **the `wasi_snapshot_preview1` import surface**, not `node:fs`.
- There already exists exactly such a JS provider of that surface:
  **`buildWasiPolyfill()` in `src/runtime.ts`** — it implements `fd_read`,
  `poll_oneoff`, `fd_fdstat_set_flags`, `clock_time_get`, `fd_write`, with
  `setStdin(bytes)` + `setMemory(mem)`. The #2632 polyfill `poll_oneoff` already
  reports fd0-readable when buffered stdin remains and CLOCK otherwise. **This is
  the substrate the edge.js async arm builds on.**

### The provider-ABI contract for the async arm

The async path keeps the **same compiled binary** and the **same Node-shaped
source** (`process.stdin.on('data'|'end')` / `.read()`), but the link contract is
the `wasi_snapshot_preview1` surface rather than `node:fs`:

| Host class | Provider | Satisfies the async `process.stdin` reactor by |
|---|---|---|
| **Pure WASI** (wasmtime) | the host kernel | real `poll_oneoff`/`fd_read` on fd0 over the module's own memory — **already proven** (#2632 wasmtime arm). |
| **Native Node** (JS) | **edge.js async** | provide `wasi_snapshot_preview1` = a `buildWasiPolyfill()`-style shim whose `fd_read`/`poll_oneoff` are fed by Node's REAL `process.stdin` `'data'`/`'end'` events (the JS host's event loop), over the module's exported memory. |

The byte-ABI is unchanged from `docs/architecture/node-fs-abi.md` in spirit
(fd-based, pointer over shared memory); only the *named import surface* differs
(`wasi_snapshot_preview1.*` vs `node:fs.*`). Record this distinction in the ABI
doc as the "async tier".

### The smallest async member to prove it on

**`process.stdin` Readable line-count / echo**, exactly mirroring the #2632
Phase-3 program (`s.on('data', …)` + `s.on('end', …)`). It is the natural choice
because the whole substrate already exists for it and the WASI arm is already
green. The proof program is a *byte-chunk* echo/count (the string-chunk prelude
is also available post-#2641, but the byte-chunk form is the lowest-risk shared
program for a byte-identical assertion). **Do not** add `fs.promises` or timers
to the proof — keep it to the one stdin member.

### Slice decomposition

#### Slice P3-a — edge.js async provider (`createNodeStdinWasiProvider`)

**File: `examples/native-messaging/edge.js`** (extend; do NOT fork a new file —
keep one adapter module).
- Add `export function createNodeStdinWasiProvider(opts)` returning
  `{ memory, importObject, run }` where `importObject` has a
  `wasi_snapshot_preview1` key. Implement it by **reusing the runtime polyfill
  shape**. Cleanest path: a tiny `examples/.../edge-wasi.mjs` helper that imports
  `buildWasiPolyfill` from the built `dist/` runtime, so the async arm tracks the
  canonical polyfill semantics rather than drifting. If the example must stay
  zero-dep (the Phase-1 precedent), inline the minimal subset: `fd_read(fd0)`,
  `poll_oneoff`, `fd_fdstat_set_flags`, `clock_time_get`, `fd_write`. **Record the
  dependency choice in a comment** (mirror the Phase-1 "thin adapter, irreducible
  job" note). **Recommend reusing `buildWasiPolyfill`** to avoid semantic drift.
- **The async wiring (the load-bearing part):** unlike the polyfill's
  `setStdin(preloadedBytes)` (synchronous, all-bytes-up-front), edge.js must feed
  Node's **real** `process.stdin` incrementally:
  - subscribe `process.stdin.on('data', chunk => stdinQueue.push(chunk))` and
    `process.stdin.on('end', () => { stdinEof = true })`;
  - the provider's `fd_read(0, …)` drains from `stdinQueue` into wasm memory at
    the iovec base, returns the count; returns 0 + signals EOF only when
    `stdinEof && queue empty` (mirroring `__rl_stdin_drain`'s 0-byte-read = EOF
    contract);
  - the provider's `poll_oneoff` resolves fd0-readable when `stdinQueue` is
    non-empty OR `stdinEof`, else honors the CLOCK subscription's timeout.
  - **The impedance:** the wasm reactor's `_start` is a *synchronous*
    `poll_oneoff`-blocking loop, but Node's stdin is *async* (data arrives on
    future loop ticks). So edge.js **cannot** just call
    `instance.exports._start()` and let it block — that deadlocks waiting for data
    that only arrives when the JS loop is free. **Resolution (the dev MUST pick
    one):**
    1. **Asyncify** the `_start` blocking points (wasm-opt `--asyncify`) so
       `poll_oneoff` suspends the wasm stack, returns to Node, and resumes on the
       next `'data'`. Heaviest; most faithful to "borrow the JS loop".
    2. **Pre-drain to EOF then run once** — `await` Node's `process.stdin` to
       `'end'` collecting all bytes into the queue, THEN call `_start()` so every
       `poll_oneoff` finds data/EOF immediately and never truly blocks. This is
       exactly what `buildWasiPolyfill().setStdin()` + `_start()` does today (the
       proven #2632 polyfill path). **Recommend mechanism 2 for the FIRST proof**
       — reuses the proven path verbatim, borrows Node's loop for the collection
       phase, byte-identical to wasmtime. Mechanism 1 (true incremental borrow) is
       follow-up `P3-d`.
- **Role:** **senior-developer** (the sync/async impedance + the
  asyncify-vs-predrain decision is the architecturally load-bearing call). **PR-able
  alone** (adds an export + helper; no compiler-core change).

#### Slice P3-b — `run-edge-stdin.mjs` (the native-Node async runner)

**File: `examples/native-messaging/run-edge-stdin.mjs`** (new) — mirrors
`run-edge.mjs` but for the async stdin member. Reads the compiled stdin-echo
wasm, wires `createNodeStdinWasiProvider` against the process's REAL fd0, runs
`_start`, lets stdout carry the echo/count. The native-Node arm counterpart to
the wasmtime invocation.
- **Role:** developer. **Depends on P3-a.** Can land in the same PR as P3-a or
  immediately after.

#### Slice P3-c — the same-binary async dual-provider proof test

**File: `tests/issue-2635-async-dual-provider.test.ts`** (new) — the #2635
acceptance. Mirror the SHAPE of `tests/issue-1772-edge-dual-provider.test.ts`
(Phase-1 sync proof) extended to the async member:
- Compile **ONE** wasm binary from a `process.stdin` Readable echo/line-count
  program (`--target wasi`, so the #2632 prelude + reactor wire in
  automatically).
- Run it under **both** providers with the same stdin frames (use bytes that
  catch a UTF-8-collapsing provider: include `0x00`, `0xff`, `0x80`, `0x0a`):
  - (a) **pure-WASI**: real `wasmtime` with piped stdin (the proven #2632 arm) —
    `skipIf(!wasmtime)`;
  - (b) **native Node**: `createNodeStdinWasiProvider` (P3-a), via a child
    process running `run-edge-stdin.mjs` with the bytes piped to its real stdin
    (so Node's real event loop carries them — the "borrows the JS host's loop"
    requirement, not the synchronous in-process polyfill).
- Assert **byte-identical** output from both arms.
- **Role:** developer. **Depends on P3-a + P3-b.** PR-able alone after them.

#### Slice P3-d (follow-up, deferred) — true incremental loop-borrow via asyncify

Mechanism 1 above: feed stdin *incrementally* across real JS loop ticks (not
pre-drained), proving the reactor genuinely *borrows* Node's event loop rather
than collecting-then-running. Needs asyncify on the `poll_oneoff` suspend points.
**Out of scope for the first acceptance.** Note: the pre-drain mechanism already
uses Node's loop for the collection phase, so it arguably satisfies the
acceptance wording; P3-d is a fidelity upgrade, not a correctness gap. File as a
follow-up only if pre-drain is deemed insufficient. **Role:** senior-developer.

### Edge cases (all arms)

- **EOF semantics must match** across providers: a 0-byte `fd_read` at a readable
  fd0 = EOF (drops the subscription); EAGAIN (errno 6) = "no data this tick"
  WITHOUT EOF. edge.js's `fd_read`/`poll_oneoff` must reproduce this exactly or
  the Readable's `'end'` fires at the wrong time and the byte-identical assertion
  fails. (See `buildStdinDrainBody` in `async-scheduler.ts` for the canonical
  contract.)
- **Empty stdin** → both arms emit only the EOF/`'end'` output, no data.
- **`memory.grow` during the run** — edge.js must re-read `memory.buffer` per
  `fd_read` (a cached `Uint8Array` view detaches on grow), exactly as the Phase-1
  `createNodeFsProvider` already copies per-call.
- **Non-blocking flag** — the reactor calls `fd_fdstat_set_flags(0,
  FDFLAG_NONBLOCK=0x4)` once; edge.js's shim may treat it as a no-op (its
  `fd_read` is already non-blocking against the JS queue), matching the polyfill.

### Test shape (acceptance)

`tests/issue-2635-async-dual-provider.test.ts` green: one compiled
`process.stdin`-echo binary, byte-identical output under wasmtime AND under
edge.js→real-Node-fd0, for stdin frames containing high/null bytes. The WASI arm
reuses the proven #2632 path; only the edge.js async arm is new.

### Decomposition summary

| Slice | What | Role | Depends on | PR-able alone |
|-------|------|------|-----------|---------------|
| **P3-a** | edge.js async provider `createNodeStdinWasiProvider` (wasi_snapshot_preview1 shim fed by real Node stdin; pre-drain mechanism) | **senior-developer** | #2632 (landed) | yes |
| **P3-b** | `run-edge-stdin.mjs` native-Node async runner | developer | P3-a | with/after P3-a |
| **P3-c** | `tests/issue-2635-async-dual-provider.test.ts` same-binary byte-identical proof | developer | P3-a, P3-b | yes (after) |
| **P3-d** | (deferred) true incremental loop-borrow via asyncify | senior-developer | P3-c | yes (follow-up) |

**Suggested order: P3-a (senior-dev, the impedance decision) → P3-b + P3-c
(developer) → P3-d deferred.** P3-a is the only architecturally load-bearing
slice; the rest are mechanical given P3-a's provider.

> **Unblock note:** `depends_on: [2632]` is SATISFIED (#2632 landed). This issue
> is `ready` to dispatch starting with P3-a.
