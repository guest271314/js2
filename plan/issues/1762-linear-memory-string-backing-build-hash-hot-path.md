---
id: 1762
title: "perf(strings): linear-memory string backing for the build/hash hot path — drop the WasmGC (array i16) GC barrier"
status: ready
created: 2026-05-31
updated: 2026-05-31
priority: high
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
language_feature: strings
goal: spec-completeness
sprint: Backlog
related: [1746, 1580, 679, 682, 1714]
---
# #1762 — linear-memory string backing for the build/hash hot path

Carved out of the #1746 umbrella as **lever #6 (linear-memory backing for char
data)**, which the native differential added by PR #997 identified as the
**strategic representation-level ceiling** for both the build and hash loops.

> **This likely needs an architect spec before dev dispatch.** The backing-store
> representation choice is a *strategic, dual-backend* decision, not a localized
> patch — route through `/architect-spec` (or set `status: needs-arch-spec`)
> first so the representation and its interop boundary are designed before code.

## Why this is the ceiling (from #1746's native differential)

The native differential disassembled both hot loops against V8 TurboFan. Even
after lever #1 (i32 hash path) and even *if* lever #3 (#1761 presize) lands, the
WasmGC `(array i16)` representation itself imposes a per-iteration floor that
Cranelift cannot optimize away:

**Hash loop (per `charCodeAt` iteration)** carries:
- a **GC read barrier** on `array.get` of the `(ref (array i16))`;
- **two un-hoistable WasmGC struct-field reloads** — `length` and `offset`
  reloaded every iteration because Cranelift can't prove the WasmGC ref is
  loop-invariant (the ref is opaque to it);
- an **array bounds check** + two element-address overflow traps.

Of ~50 native insns/iter, only `ldrh` + `madd` is real work; the rest is the
above representation tax.

**Build loop (per append)** carries a **GC write barrier on every `array.set`**
into the buffer (60,000 barriered stores), on top of the per-append machinery.

A flat **linear-memory** byte/`i16` buffer makes:
- appends → raw `i32.store16` (no GC write barrier);
- reads → raw `i32.load16_u` (no GC read barrier, no opaque-ref struct reloads);
exactly what V8's **sequential-string backing store** is. That is the ceiling for
**both** loops — the `(array i16)` representation is itself the thing standing
between us and V8 once #1761 removes the reallocs/cap-check.

## Framing — the dual-backend decision

This mirrors the established dual-backend pattern in the codebase and must be
designed the same way (keep WasmGC for the general object model; route the *hot
string path* through linear memory):

- **#679** — dual string backend (WasmGC i16 array vs `wasm:js-string`).
- **#682** — dual RegExp backend.
- **#1714** — linear-memory IR backend.

i.e. add a **linear-memory string representation** as an alternative backing for
the build/hash hot path under `--target wasi --nativeStrings`, without disturbing
the WasmGC object model elsewhere. The architect spec must define: the
backing-store layout (ptr/len/cap in linear memory), the `String`↔linear-memory
boundary (where a linear-memory string is created, consumed, and converted to/from
the WasmGC `$NativeString` when it escapes the hot path), allocation/lifetime
(bump vs freelist; interaction with GC of the surrounding object), and the
interop story with the JS-host string path.

## Scope / guard

- Confined to the hot string build/read path; the general WasmGC object model and
  the JS-host string backend stay as-is.
- The linear-memory-backed string must be **observably identical** to the WasmGC
  `(array i16)` string for every operation that can reach it (length, indexing,
  charCodeAt, concat, comparison, escape to host) — full result parity, no
  behaviour change.
- Gate behind the representation/target choice the architect spec settles; no new
  host import without a standalone fallback (project dual-mode rule).

## Acceptance

- An architect implementation spec in this issue file (`## Implementation Plan`)
  settling the backing-store representation and the WasmGC↔linear-memory boundary
  **before** dev dispatch.
- A linear-memory string builder/reader prototype for the build/hash hot path,
  measured via the **#1760** in-process bench: a warm drop on **both** the build
  loop and the hash loop beyond what #1761 alone achieves, with honest provenance
  (drop exceeds combined std; no gaming the #1580 30 ms gate).
- Native re-diff (per #1746's method) showing the build-loop `array.set` GC write
  barrier and the hash-loop GC read barrier + struct-field reloads are gone for
  the linear-memory path.
- Result-parity regression tests across both string backends and representative
  inputs; zero test262 regressions.
- Refresh the committed benchmark JSON and keep the #1580 staleness gate green.

## Notes

- Strategic follow-up to #1761 (presize). #1761 removes the reallocs + cap-check
  on the existing WasmGC buffer; #1762 removes the GC barrier / opaque-ref tax by
  changing the backing store itself — the representation-level ceiling for V8
  parity on both loops.
- **Likely routes to `/architect-spec` before any dev work** — the representation
  choice is strategic, not a localized codegen patch.
