---
id: 2155
title: "wasm-treemap can't visualize WebAssembly Component binaries (GH #1465)"
status: done
sprint: 62
created: 2026-06-15
updated: 2026-06-15
completed: 2026-06-15
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bug
area: website
language_feature: tooling
goal: process
related: [2156]
origin: "GitHub issue #1465 (external, guest271314) — dropping a 13.4 MiB componentize-js .wasm onto the treemap fails"
---

## Problem

Dropping `nm_componentize_js.wasm` (a ~13.4 MiB
[componentize-js](https://github.com/guest271314/native-messaging-componentize-js)
output) onto the wasm-treemap tool fails to produce a useful visualization.

**Root cause:** the file is a **WebAssembly Component**, not a core module. Its
8-byte preamble is `00 61 73 6d 0d 00 01 00` — magic + version `0x0d` + **layer
`0x01`** (core modules use layer `0x00`, `01 00 00 00`). The treemap's
`parseWasm` only understands the core-module section-id space. Because the
Component layer reuses the same `id + u32leb size` section framing, the parser
doesn't throw — it silently walks the component framing as if it were core
sections, yielding garbage (`version 65549`, 321 phantom "sections", a
meaningless treemap). All the real content — four embedded `core:module`
sections, one of which is the dominant **13.38 MiB** module containing the 9 MB
code section and 12.7k functions — is invisible.

## Fix

Make the parser Component-aware in both copies of the tool:

- `website/playground/wasm-treemap.ts` (playground module)
- `website/public/wasm-treemap.html` (standalone drop-a-file page — the one the
  reporter used)

Changes:

1. **Detect the layer** in the preamble (`bytes[6] | bytes[7]<<8`). Layer `1` →
   dispatch to a new `parseComponent`.
2. **`parseComponent`** walks the top-level component sections with the correct
   Component section-id names (`core:module`, `core:instance`, `alias`, `canon`,
   `type`, …) and, for each embedded `core:module` (id 1) / nested `component`
   (id 4), recurses (`parseWasm` on the slice) and attaches the result as
   `section.embedded`. Embedded payloads are complete, self-contained binaries,
   so recursion is clean.
3. **Tree builders** (`addModuleSections` / `addModuleFunctions` /
   `addComponentFunctions`) recurse into `section.embedded` so the treemap drills
   from component → embedded core module → sections → functions. The dominant
   13.38 MiB module breaks down into its real `code`/`data`/etc.
4. **Info bar** aggregates code size / function / import / export counts and a
   "core modules" count across embedded modules (`aggregateStats`).
5. **Robustness:** both parsers now bounds-check each section (stop on a section
   that runs past EOF or fails to advance) so truncated/malformed input can't
   spin or over-read.

## Verification

Against the actual 14,092,650-byte file:

- `isComponent = true`, 5 embedded binaries (4 core modules + 1 nested
  component); the 13.38 MiB module exposes its 14 sections, 9.24 MB code,
  12,859 functions.
- Sections **and** functions trees sum **exactly** to the file size (no
  double-counting; recursion terminates); ~13.5k bounded tree nodes.
- Plain core-module path is unchanged (the existing core parser still drives
  layer-0 modules, including the recursively-parsed embedded ones).
- Both files pass `prettier --check` and a strict DOM-lib `tsc` typecheck.

## Follow-up

The parser + tree-building + rendering logic is **duplicated** between the `.ts`
module and the standalone `.html` (both had to be patched here). Tracked for
unification in [[2156-wasm-treemap-dedup]].
