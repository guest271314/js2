---
id: 2779
title: "node:fs multi-file standalone-WASI bundle: cross-module struct/nullable-ref/global mis-lower (runtime fault)"
status: ready
created: 2026-06-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: platform
related: [2771, 2778, 2655]
sprint: Backlog
---

# #2779 — node:fs multi-file standalone-WASI bundle mis-lowers cross-module refs

## Problem

Building a standalone WASI module from a **multi-file** project whose entry imports
`node:fs` (`compileProject` / `compileMultiSource`, `--target wasi`) compiles to a
clean wasi-only module (imports = `{wasi_snapshot_preview1}` only) but **FAULTS at
runtime** (`WebAssembly.Exception`) for several common code shapes. The equivalent
SINGLE-file compile, and the equivalent multi-file compile using **Deno** stdio
(`Deno.stdin.readSync` — no `node:fs` shim insertion), both run correctly. So the
fault is specific to `node:fs` lowering in a multi-file bundle.

Surfaced while doing the #2778 native-messaging dedup (a shared local helper
imported by `nm_node_fs.ts`). #2771 made the bundle COMPILE; this is the runtime
follow-up.

## Four triggering shapes (each a clean compile, then a runtime/validate fault)

1. **Struct / interface VALUE across the bundle boundary.** Passing an object
   (`{ read, write }`) — or a method extracted from one (`io.read`) — from the
   entry into a function defined in a bundled helper faults on the cross-file
   `call_ref` / field access. Standalone function references cross fine.
2. **A shared-helper function returning a nullable reference type** (e.g.
   `function readExact(...): Uint8Array | null`) faults when that helper lives in a
   bundled file and the entry imports `node:fs`. A `boolean`-returning equivalent
   does not.
3. **A module-level `const` (lowered to a Wasm global) passed as a call argument**
   across the bundle boundary faults; a LOCAL const / inline literal (a plain
   `i32.const` operand) does not.
4. **The number→string path (`number_toString_radix`)** — e.g. a template literal
   `` `…${n}…` `` — mis-compiles to **invalid Wasm** in the bundled `node:fs`
   entry (`WebAssembly.validate` fails: `not enough arguments on the stack for
   f64.convert_i32_s @ number_toString_radix`). Plain f64 arithmetic is fine, so a
   hand-rolled decimal formatter (`% 10`, `(v - v%10)/10`) is an unaffected
   workaround (used by nm_node_fs's fd-2 telemetry).

## Hypothesis

`node:fs` shim insertion (`detectNodeFsImports` → `wasiNodeFsFuncs`, threaded in
`compileMultiSource`) shifts function / global / type indices, but some references
are not consistently re-mapped once the bundled module crosses a size/shape
threshold — analogous to the documented `addUnionImports` "late import addition
shifts function indices; must also shift the current body" hazard, but in the
multi-file + node:fs path. The Deno path inserts no shim, so no shift, no fault.

## Minimal repros

See `.tmp/mini*` scratch built during #2778 (not committed). Reproduce with two
files: an entry importing `node:fs` `readSync`/`writeSync` + a relative helper
`./lib`, where `lib` exports a function the entry calls. Compile the entry with
`compileProject(entry, { target: "wasi" })`, run under a raw fd shim. The struct /
nullable-ref / module-global shapes fault; funcref / boolean / local-const shapes
run. (#2778's example sources carry the working shapes + comments at each site.)

## Acceptance

`compileProject(entry, { target: "wasi" })` for a `node:fs` entry importing a
relative helper runs identically to the single-file equivalent for ALL three
shapes above — so the #2778 example sources can drop the workaround comments and use
the originally-specified `NmHostIo` object seam / module-level cap const.
