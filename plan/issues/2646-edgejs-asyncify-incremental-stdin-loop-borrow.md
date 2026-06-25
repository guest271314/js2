---
id: 2646
title: "edge.js async stdin: true incremental loop-borrow via asyncify (P3-d) — suspend poll_oneoff instead of pre-draining to EOF"
status: blocked
created: 2026-06-24
updated: 2026-06-25
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
depends_on: [2653]
related: [2635, 2632, 1772, 2653]
origin: "Slice P3-d of the #2635 async dual-provider proof (arch-capstone scoping, 2026-06-24). A `P3-d SEAM` marker comment was left in examples/native-messaging/edge.js where this slots in. Deferred as a fidelity follow-up — the basic proof (#2635, PR #2012) used mechanism 2."
---

# #2646 — edge.js incremental loop-borrow via asyncify (P3-d)

## Problem

The #2635 dual-provider proof (PR #2012) showed the SAME `process.stdin` wasm
binary runs byte-identically under wasmtime (native WASI `poll_oneoff`) AND
edge.js (native Node). But it used **mechanism 2 (pre-drain)**: edge.js `await`s
Node's `process.stdin` to `'end'`, collecting ALL bytes, THEN calls `_start()` so
every `poll_oneoff` finds data/EOF immediately and never truly blocks.

This is correct for batch input but is NOT a _true_ incremental loop-borrow: an
interactive/streaming program (one that should react to each line as it arrives,
or never sees EOF) cannot be driven by pre-draining. The wasm reactor's `_start`
is a synchronous `poll_oneoff`-blocking loop, while Node's stdin is async — so to
borrow Node's loop incrementally, the wasm stack must be able to _suspend_ at
`poll_oneoff` and resume on the next `'data'` tick.

## Scope

- Apply **asyncify** (`wasm-opt --asyncify`) to the reactor's blocking points so
  `poll_oneoff` suspends the wasm stack, returns control to Node, and resumes on
  the next `process.stdin` `'data'`/`'end'` event.
- Extend `createNodeStdinWasiProvider` in `examples/native-messaging/edge.js`
  (the `P3-d SEAM` marker) to drive the asyncify unwind/rewind around the async
  stdin queue, replacing the pre-drain.
- Prove an _interactive/streaming_ program (reacts per-chunk, no up-front EOF)
  runs under edge.js with the same observable behavior as wasmtime.

## Acceptance

- An interactive `process.stdin` program (e.g. echo-per-line that flushes before
  EOF) runs under edge.js via incremental asyncify loop-borrow, observably
  matching the wasmtime arm, WITHOUT pre-draining to EOF first.
- The existing mechanism-2 batch proof (#2635) still passes (no regression).
- Document the binary-size / perf cost of asyncify and gate it behind an opt-in
  so non-interactive builds keep the cheaper pre-drain path.

## Out of scope

- The batch dual-provider proof (#2635, landed).
- The WASI/wasmtime arm (already incremental via native `poll_oneoff`).

## Investigation (2026-06-24)

**Status → `blocked`.** The asyncify mechanism this issue is scoped around is
**not viable on our WasmGC reactor binary** with any available Binaryen. The
architecture is otherwise sound (single suspend point, wasmtime + wasm-opt
present, asyncify works fine on plain non-GC modules), so this is parked behind
a Binaryen capability, not closed.

### Root cause — Binaryen asyncify fake-call-global name collision on GC refs

`wasm-opt --asyncify` aborts on the compiled `--target wasi` `process.stdin`
reactor binary with a **fatal** error during its own pre-scan, before emitting
anything:

```
Fatal: Module::addGlobal: asyncify_fake_call_global_(ref null $struct.0) already exists
```

Why: asyncify creates one "fake-call global" per **function type that returns a
GC reference** (used to model indirect/`call_ref` returns across a suspend), but
it **names that global solely by the result type's _printed_ name**. Our
string/closure helper ABI exports **10+ distinct function types that all return
`(ref null $1)`** — e.g. the `__str_*` helpers and the closure-dispatch
trampolines (types `$25 $34 $35 $40 $42 $43 $57 $59` in the binary's type
section, all `… (result (ref null $1))`). The first such type creates the
global; the second collides on the identical generated name → `addGlobal`
aborts. The globals are created in asyncify's analysis phase **before** any
list/scope filter is consulted, so no pass-arg can avoid them.

### Exhaustively ruled out (none work)

- **Every Binaryen version available**: 123, 125 (current dep), and 130 (latest)
  — all abort with the identical fatal.
- **Both optimizer backends** that `src/optimize.ts` uses: the `wasm-opt` CLI
  _and_ the in-process `binaryen` JS-module API (`mod.runPasses(["asyncify"])`)
  — identical fatal in each.
- **Every asyncify scoping pass-arg**:
  `--pass-arg=asyncify-imports@wasi_snapshot_preview1.poll_oneoff` (scope to the
  single real suspend point),
  `--pass-arg=asyncify-onlylist@_start,__run_event_loop,__rl_poll_fd0_or_clock`
  (the entire direct call path), and `--pass-arg=asyncify-ignore-indirect` — none
  help, because the colliding globals are created before the filter applies.
- **DCE the colliding helpers first**: they are part of the module's **exported
  public ABI** (`__sget_*`, `__vec_*`, `__call_fn_*`, `__str_*` — 20 exports), so
  `--remove-unused-module-elements` keeps them; and `-O2` (which might prune more)
  independently aborts on this WasmGC module with a separate
  `Assertion failed: canMakeZero(type)` (`makeZero`) — the same class of
  WasmGC-immaturity our optimize pipeline already validates-and-falls-back around.

The single blocking suspend point is confirmed: `_start` → `__run_event_loop`
(`buildRunLoopBodyWithFdReactor`, `src/codegen/async-scheduler.ts`) →
`__rl_poll_fd0_or_clock` → imported `poll_oneoff`. Asyncify around exactly that
import is the clean classic shape; it is blocked **only** by the GC-ref global
naming bug, not by anything in our reactor design.

> Note: the upstream Binaryen limitation is documented **here, in our own issue,
> only.** No external Binaryen issue was filed (that needs explicit user
> consent we do not have). The #2635 batch pre-drain proof was re-run on this
> branch and still passes 4/4 — the shipped mechanism-2 path is unaffected.

### Two unblock paths

1. **Upstream Binaryen fix** — asyncify should dedup the fake-call global **by
   the function type itself, not by the result type's printed name** (reusing the
   one global already created for that result type). When a Binaryen release
   carries this fix, re-attempt the scoped (`asyncify-imports@…poll_oneoff`) build
   and resume the original P3-d plan unchanged.
2. **Non-asyncify reactor single-tick refactor (#2653)** — refactor the #2632
   reactor codegen (`src/codegen/async-scheduler.ts buildRunLoopBodyWithFdReactor`)
   to expose a re-entrant **single-tick** export ("process available bytes, return
   if it would block") that `edge.js` drives per `process.stdin` `'data'` event.
   This reaches true interactive streaming **without** asyncify and is therefore
   independent of the Binaryen bug. Tracked as #2653 (`depends_on`).

Either path unblocks this issue; pre-drain (#2635) remains the correct shipped
mechanism for batch input in the meantime.
