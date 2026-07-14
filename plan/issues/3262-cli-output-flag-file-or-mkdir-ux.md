---
id: 3262
title: "CLI: make -o friendlier — accept a file path and/or mkdir the output dir instead of ENOENT"
status: backlog
sprint: Backlog
priority: medium
horizon: s
feasibility: easy
task_type: enhancement
area: cli
goal: ir-full-coverage
created: 2026-07-14
related: [2816, 2736]
origin: "npx js2wasm input.ts -o output.wasm crashes with ENOENT: output.wasm/input.wasm — -o is a dir, and a nonexistent dir isn't created"
---

# #3262 — Friendlier CLI `-o` handling

## Problem

`-o`/`--out` is an output **directory** (`cli.ts:41,177` → `outDir`; the `.wasm`
name is derived from the input basename, `cli.ts:353`; `dir = resolve(outDir)`,
`cli.ts:358`). Two rough edges follow:

1. **`-o <file>.wasm` silently misbehaves.** The natural, widely-expected
   `js2wasm input.ts -o out.wasm` treats `out.wasm` as a directory and crashes at
   write time with `ENOENT: … open 'out.wasm/input.wasm'` — no helpful message.
   (This is exactly what the README example documented; fixed in the docs by the
   #3055 PR, but the CLI itself should not hard-crash on the most intuitive
   invocation.)
2. **A nonexistent `-o <dir>` is not created.** `-o dist` fails with ENOENT if
   `dist/` doesn't exist — the CLI never `mkdir`s it.

## Scope (pick the least-surprising behavior)

Make `-o` do the intuitive thing:

- **Accept a file path.** If the `-o` value ends in `.wasm` (or has any file
  extension / looks like a file), treat it as the **output file**: write the
  binary there, and derive the sibling `.wat`/`.d.ts`/`.imports.js` names from
  that basename+dir. Otherwise treat it as a directory (current behavior).
  - Alternative/companion: add an explicit `--out-file <path>` and keep `--out`
    dir-only, if overloading `-o` is deemed ambiguous.
- **`mkdir -p` the output directory** when it doesn't exist (both the dir form
  and the parent of a file path), instead of ENOENT.
- **Clear error** as a floor: if neither is done for some path, fail with a
  message that says what `-o` expects, not a raw `fs` ENOENT.

## Acceptance

- `js2wasm input.ts -o out.wasm` writes the wasm to `out.wasm` (file semantics),
  with siblings `out.wat` / `out.d.ts` / `out.imports.js` alongside it.
- `js2wasm input.ts -o build/artifacts` creates `build/artifacts/` if missing and
  writes `input.wasm` there.
- `--help` text updated to describe the file-or-directory behavior.
- A CLI unit test covers: file-path `-o`, nonexistent-dir `-o`, and the plain
  no-`-o` CWD default (regression-guard the #2816 default).
- README CLI example (post-#3055) revisited so the recommended form matches
  whatever semantics land here.

## Non-goals

- No change to compile targets / modes (that's the `--target` axis, #2736).
- Don't change the default (no-`-o`) behavior of writing to the CWD (#2816).
