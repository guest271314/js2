---
id: 2932
title: "codegen: .js module dependencies are not compiled in multi-file mode (imports resolve to null)"
status: blocked
priority: high
sprint: current
created: 2026-07-02
feasibility: medium
task_type: bug
area: codegen
goal: spec-completeness
related: [2900, 2930, 2931]
parent: 2900
blocked_reason: "Broad-impact (~172 _FIXTURE.js test262 tests + any .js multi-compile). Must be validated by a full test262 diff / merge_group, never a scoped sweep. Coordinate a dedicated run slot with the tech lead (see #2900 plan). Do NOT start without lead sign-off."
---

# #2932 — compile `.js` module dependencies in multi-file mode

Split from #2900 (RC1). Root-caused by dev-2900 — see #2900's Implementation Plan.

## Problem

`compileMultiSource` / `analyzeMultiSource` build the TS program **without
`allowJs`**, so TypeScript excludes `.js` **root** files from the program. A `.js`
module dependency's top-level declarations are therefore never codegen'd, and any
import of them resolves to `null`.

Proof (`skipSemanticDiagnostics: true`, `origin/main`):

- file key `./h.js`, `export function add`, `import { add }` → `add(1,2)` returns **0** (unlinked)
- identical content with key `./h.ts` → **3** (linked)
- `{ allowJs: true }` with the `.js` key → **3** (linked)

`tests/issue-1015.test.ts` ("positive fixture test") already fails on main for
exactly this (`expected 2 to be 1`). The test262 runner's `_FIXTURE.js` path
(`tests/test262-shared.ts` + the sharded fork worker) calls `compileMulti` with no
`allowJs`, so **every** fixture-based module test compiles the fixture to nothing.

## Fix options (BROAD — pick with architect/lead; validate on full test262)

- **(a) Compiler**: in `analyzeMultiSource` (`src/checker/index.ts`), auto-set
  `allowJs: true` (keep `checkJs` off) when any root file has a
  `.js`/`.jsx`/`.cjs`/`.mjs` extension. Correct for real bundler use; changes every
  multi-file `.js` compile.
- **(b) Harness-scoped**: pass `allowJs: true` only in the FIXTURE branch of
  `tests/test262-shared.ts` (+ the sharded fork worker). Blast radius bounded to
  ~172 `_FIXTURE.js` tests, but still a conformance shift for that bucket.

## Why blocked

This is the piece that lets #2900's runner path actually exercise #2930 + #2931.
It is **broad-impact and conformance-shifting** — many `instn-*` / `eval-gtbndng-*`
module tests currently pass/fail on the null-import artifact. It must be validated
by a **full test262 diff** (merge_group), and likely wants its **own dedicated run
slot** so its large delta does not overlap with another baseline swing in one
window. Do NOT implement without tech-lead sign-off on the option and timing.

## Acceptance

- `.js` module dependencies compile and link in multi-file mode.
- `tests/issue-1015.test.ts` positive case passes.
- Full test262 diff reviewed; net conformance change is understood and accepted.
- #2900 (needs #2930 + #2931 + this) passes.
