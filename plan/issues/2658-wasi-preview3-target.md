---
id: 2658
title: "WASI Preview 3 (0.3) target — scope: adapter-interop tops out at P2, native-P3 is a component-model epic"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: wasi
goal: wasi-async-runtime
sprint: Backlog
es_edition: n/a
depends_on: []
related: [2643, 2646, 2632, 2635, 2525, 1774, 1772]
origin: "Arch scoping of a WASI Preview 3 (0.3) target after WASI 0.3 shipped 2026-06-11 (native async in the Component Model: async func / stream<T> / future<T>). Mirrors the #2643 verdict style: cheap-interop-slice-now vs component-model-epic-deferred."
---

# #2658 — WASI Preview 3 (0.3) target scope

## Problem

WASI 0.3 shipped on 2026-06-11: native async in the Component Model
(`async func`, `stream<T>`, `future<T>` baked into the canonical ABI), rebasing
the P2 `wasi:cli` / `wasi:io` interfaces onto real async. The strategic appeal
for js2wasm is that P3's native `stream<u8>` is the _clean_ substrate for
**interactive streaming stdin** (#2646) — the thing the asyncify hack (blocked)
and the P2 `poll`-based reactor both struggle with.

This issue scopes what "target WASI Preview 3" actually means for js2wasm today,
in the same honest-sizing spirit as the #2643 scoping. The headline answer is
below; the two paths and their slice decomposition follow.

## Verdict (TL;DR)

**There is no cheap P3-interop win today, because the toolchain ships no
P1→P3 or P2→P3 adapter.** Everything that "targets P3" requires the _native_
component-model producer work, which is the deferred `#2525` epic.

Concretely, regrounded against the installed toolchain on this box
(2026-06-25):

| Capability                               | State on this box                           | Implication                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasmtime                                 | **44.0.0**                                  | hosts WASI `0.3.0-rc-2026-03-15` worlds (`wasi:cli/stdin@0.3.0`, `wasi:clocks@0.3.0`, …). Built-in `-W component-model-async`. ✅ a P3 host is runnable here.                                                                 |
| jco                                      | **1.16.1** (vendored via `componentize-js`) | only adapter shipped is `wasi_snapshot_preview1.{command,reactor}.wasm`, and it encodes **`wasi:cli@0.2.3`** — a **P1→P2** adapter. **No P3 adapter, no `--wasi-version` flag.**                                              |
| `wasi:io/poll` + `wasi:io/streams` in P3 | **removed** in 0.3                          | streams/futures moved into the canonical ABI; P3 stdin is `wasi:cli/stdin.read-via-stream → stream<u8>`. So the P2 adapter's whole reactor-backing model (`poll_oneoff`→`wasi:io/poll`) has **no P3 analogue to adapt onto**. |

So the two paths split cleanly:

- **Path 1 — adapter/interop (the #2643 Slice-A trick), re-run for P3: DOES NOT
  EXIST.** The jco adapter only produces a **P2** component. There is no
  P1→P3 / P2→P3 adapter in jco 1.16, wasm-tools, or wasmtime 44. The cheapest
  honest "P3 interop" we can ship is a **documentation + verification slice**
  proving our existing **P2 component runs unchanged under wasmtime 44's
  P3-capable host** (a P3 host is backward-compatible with 0.2 worlds) — i.e.
  "P3 host, P2 guest." That is real and cheap, but it is **not** a P3 _target_;
  the guest is still P2. **No codegen change, no new behaviour over #2643.**

- **Path 2 — native P3 async producer.** Emit a genuine P3 component:
  `wasi:cli/run@0.3.0` world, the async canonical ABI (`async`-lifted exports,
  `stream<u8>` / `future<T>` lowering, `task.*`/`waitable-set` built-ins,
  `cabi_realloc`, resource tables, a `component-type` custom section). This is
  the component-model-producer epic (`project_wasm_linking_core_over_component`,
  #2525) — **large, defer.** It is the _only_ path that makes js2wasm a true P3
  target and the _only_ path that gives #2646 interactive streaming "for free."

**Does P3 unblock #2646 interactive streaming?** _Architecturally yes, but only
via Path 2._ P3's `wasi:cli/stdin.read-via-stream` hands the guest a host-driven
`stream<u8>`; the async canonical ABI lets a P3-async-lifted `run` export
**suspend at a stream read and be resumed by the host scheduler** — exactly the
incremental loop-borrow #2646 needs, with the suspend/resume done by the
_component-model runtime_ instead of the blocked asyncify hack or a pre-drain.
**But it is NOT reachable via the adapter path** (which doesn't exist for P3 and
even if it did would wrap our _synchronous_ `poll_oneoff` core, not an async
export). #2646 "for free" requires the native async-export lowering in Path 2.
So: P3 is the right long-term home for interactive stdin, but it is **not** a
shortcut around the #2646 blocker — it relocates the blocker from "asyncify the
core module" to "emit an async-lifted component export," which is strictly more
work (the whole Path 2 epic) though architecturally cleaner.

## Regrounding — what we already have (verified 2026-06-25)

- **P1 reactor** (`src/codegen/async-scheduler.ts`, 3013 lines): timer heap +
  fd0-readiness reactor (multi-subscription `poll_oneoff`) + the #2632 Phase-3
  faithful `process.stdin` Readable, all against **WASI Preview 1**. `_start`
  runs a synchronous `poll_oneoff`-blocking loop.
- **#2643 Slice A (done)**: `scripts/wasi-p2-component.mjs` adapts the unchanged
  P1 core module into a **P2 component** via the jco P1→P2 adapter
  (`jco new --adapt wasi_snapshot_preview1=<adapter>`), runs under wasmtime 44's
  component model, byte-identical streaming to the P1 arm
  (`tests/issue-2643-wasi-p2-adapter.test.ts`). The adapter targets
  `wasi:cli@0.2.3`. Slices B2–B4 (native `wasi:io/poll` lowering) were deferred
  as a component-model epic with **no new behaviour over the adapter**.
- **#2646 (blocked)**: true incremental loop-borrow via asyncify
  (`wasm-opt --asyncify` over `poll_oneoff`) so the reactor suspends and resumes
  on each Node `'data'` tick — blocked on the asyncify-GC gap (asyncify does not
  handle WasmGC stack values).

## Implementation Plan

### Path 1 — "P3 host, P2 guest" verification (cheap, but NOT a P3 target)

The honest cheap slice. Proves forward-compat: our existing #2643 P2 component
runs under a **P3-capable host** (wasmtime 44 with `-W component-model-async`),
since a P3 host still hosts 0.2 worlds. Delivers **no P3 guest**, **no codegen
change**, **no #2646 unblock** — purely a forward-compat assurance + a doc that
records "no P3 adapter exists; here is why the cheap trick stops at P2."

**Slice A1 (docs + test, ~0.5 day, role: developer)**

- Extend `tests/issue-2643-wasi-p2-adapter.test.ts` (or a sibling) to also run
  the adapted **P2** component under wasmtime 44 with
  `-W component-model-async=y` enabled, asserting the same byte-identical
  streaming output — i.e. proving the P2 guest is unaffected by the host's P3
  async machinery being on.
- Document in this issue + `docs/` that the jco 1.16 adapter is **P1→P2 only**
  (`wasi:cli@0.2.3`), so there is no `--target wasi-p3` adapter slice analogous
  to #2643 Slice A. Record the toolchain probe (no P3 adapter in jco/wasm-tools/
  wasmtime 44; P3 drops `wasi:io/poll`+`wasi:io/streams`).
- **Acceptance:** P2 component runs green under a P3-async-enabled wasmtime host;
  doc states plainly that "target P3" today = Path 2 (native), not an adapter.
- **Value:** low — forward-compat assurance only. Worth doing _only_ bundled
  with whoever next touches the WASI test path; not worth a standalone dispatch.

### Path 2 — native P3 async producer (large epic, DEFER to #2525 track)

Make js2wasm emit a genuine P3 component. This is the component-model-producer
work deferred by `project_wasm_linking_core_over_component` and #2525. Sized
honestly into slices so it can be picked up incrementally **after** the #2525
Component-Model track is staffed.

**Slice B0 — spike: hand-author a P3 `run` component, run it (1–2 days, role:
senior-developer / architect)**

- NOT codegen. By hand (WIT + `wasm-tools`/jco `embed`+`new`, or a tiny Rust/JS
  reference), produce a minimal `wasi:cli/run@0.3.0` component that does an
  async `stream<u8>` stdin echo, and run it under wasmtime 44
  (`-W component-model-async=y`). Purpose: pin down the _exact_ binary shape
  js2wasm must emit (async canonical ABI lifting, `stream`/`future` type
  encoding, `component-type` section, `cabi_realloc`, the `0.3.0-rc-2026-03-15`
  vs final `0.3.0` world id on this wasmtime). De-risks the entire epic.
- **Acceptance:** a working reference P3 echo component + a written spec of the
  binary sections js2wasm must produce. **Gate for B1+.**

**Slice B1 — `--target wasi-p3` flag plumbing + WIT/world selection (1 day,
role: developer)**

- Add the CLI flag and thread a `wasiPreview: 1 | 2 | 3` (or `p3: boolean`)
  through `compile()` into codegen options. No binary change yet (flag selects
  world id + later toggles the lowering). Cheap seam; **no standalone value**
  until B2 (mirror of #2643 Slice B1).

**Slice B2 — component-type custom section + canonical-ABI lifting for a
_synchronous_ P3 `run` (large, ~1–2 weeks, role: senior-developer)**

- Emit the `component-type` custom section describing the
  `wasi:cli/run@0.3.0` world; lift `_start`→`run` through the canonical ABI;
  emit `cabi_realloc`; resource-table plumbing for any handles. Start
  _synchronous_ (no `stream`/`future`) to land the producer machinery before the
  async ABI. This is the bulk of "js2wasm is a component producer."
- Depends: B0, B1, and the #2525 component-model substrate.

**Slice B3 — async canonical ABI: `async`-lifted `run` + `stream<u8>` stdin
(large, ~1–2 weeks, role: senior-developer)**

- Lift `run` as an **async** export; lower `wasi:cli/stdin.read-via-stream` to a
  native `stream<u8>` read; wire the reactor's suspend points to the
  component-model `task`/`waitable-set` built-ins instead of `poll_oneoff`. The
  async event-loop reactor stops calling `poll_oneoff` and instead yields to the
  host scheduler at stream reads.
- **This is the slice that subsumes #2646**: interactive incremental stdin comes
  from the host driving the async `stream<u8>`, no asyncify, no pre-drain.
- Depends: B2.

**Slice B4 — wire #2646 acceptance onto B3 (small once B3 lands, role:
developer)**

- Re-run the #2646 interactive echo-per-line acceptance against the native P3
  async component; prove per-chunk reaction with no up-front EOF. Close #2646 as
  _resolved-by-P3-native_ (its asyncify approach becomes the fallback only for
  non-component P1 hosts).
- Depends: B3.

### What to do now vs defer

- **Now:** _nothing dispatch-worthy on its own._ Path 1 Slice A1 is a ~half-day
  forward-compat doc/test — fold it into the next WASI-path PR, don't staff it
  solo. The genuinely valuable artifact of this issue is **this scope doc**:
  it records that "target P3" has no cheap-adapter shortcut and stops the team
  from chasing a #2643-style Slice A that cannot exist for P3.
- **Defer (gated on #2525):** Path 2 (B0→B4). B0 is the right first move when
  the Component-Model track is picked up — a low-cost spike that de-risks the
  whole epic and produces the binary-shape spec. #2646 should be marked
  `related:` here and ultimately resolved by B3/B4, not by reviving asyncify.

## Acceptance (for this scoping issue)

- This issue file documents the two paths with honest sizing and a slice
  decomposition (above). ✅
- The verdict explicitly states: no P1→P3/P2→P3 adapter exists in the installed
  toolchain, so there is **no cheap P3-interop slice** analogous to #2643 Slice
  A; "target P3" = the native component-model epic (Path 2). ✅
- The #2646 question is answered: P3 native async (Path 2, Slice B3) is the clean
  replacement for the asyncify hack, reachable **only** via the native path, not
  the (nonexistent) adapter path. ✅

## Out of scope

- Implementing any of Path 2 (this is scoping only).
- The #2525 component-model substrate itself (prerequisite, tracked separately).
- Reviving the #2646 asyncify approach (superseded by Path 2 Slice B3 long-term;
  remains the P1-host fallback).
