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
blocked_reason: "DECIDED (lead, 2026-07-02): harness-scoped (option b) — wrapTest hoists module-goal imports to top level + passes allowJs:true (or .ts-key equiv) for fixture deps, scoped to the test262 runner; NOT compiler auto-allowJs (that is a separate product decision affecting every consumer). SEQUENCING: open the PR only AFTER (1) #2930+#2931 merged AND (2) the -439 re-baseline chain (#2424 + revert) has settled with the guard back at 200 — no two large baseline deltas overlapping. Its sharded CI run IS the dedicated full-test262 validation; read the regression report BOTH directions (~172 fixture tests change; expect net-positive), bucket any pass->fail flips before merging, and message the lead with the delta once CI reports."
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

## Fix — DECIDED: harness-scoped (option b) (lead, 2026-07-02)

The lead chose **(b) harness-scoped**, NOT compiler auto-allowJs, because both
runner-side gaps live in the runner anyway (the import-hoisting one can ONLY be
fixed in `wrapTest`), the runner already special-cases `.js` entry handling, and
changing the compiler API's default compilation set is a **product decision
affecting every consumer** that deserves its own issue + validation, not a rider
on a conformance fix.

So #2932 is two runner-scoped changes:

1. **`wrapTest` hoists module-goal imports to top level** — for `flags: [module]`
   tests, emit the source's top-level `import`/`export … from` statements at module
   top level (outside the synthetic `export function test()`), so the checker
   resolves the bindings and #2930's top-level-scan alias pass sees them.
2. **Pass `allowJs: true` for fixture deps** in the FIXTURE branch of
   `tests/test262-shared.ts` (+ the sharded fork worker), or the equivalent
   `.ts`-key mapping, so `.js` fixture modules compile.

Rejected — **(a) compiler auto-allowJs** in `analyzeMultiSource`: correct for real
bundler use but a broad API-default change; split to its own issue if ever wanted.

Blast radius: ~172 `_FIXTURE.js` tests. Its sharded CI run is the dedicated
full-test262 validation.

## Why blocked

This is the piece that lets #2900's runner path actually exercise #2930 + #2931.
It is **broad-impact and conformance-shifting** — many `instn-*` / `eval-gtbndng-*`
module tests currently pass/fail on the null-import artifact. It must be validated
by a **full test262 diff** (merge_group), and likely wants its **own dedicated run
slot** so its large delta does not overlap with another baseline swing in one
window. Do NOT implement without tech-lead sign-off on the option and timing.

## Second runner-side gap — the wrapped import is placed INSIDE `test()` (dev-2900, 2026-07-02)

With #2930 + #2931 landed, an end-to-end trace shows a **second** runner-side blocker
beyond `allowJs`: `tests/test262-runner.ts` `wrapTest` naively wraps the _entire_
test body — **including the top-level `import` statement** — into
`export function test() { try { … } }`. An `import` nested in a function body is not
a real module import; the checker does not resolve its binding, and #2930's
`registerImportBindingAliases` (which scans **top-level** `ImportDeclaration`s only)
does not see it.

Proof: the real fixture with `allowJs: true` and the import **hoisted to module top
level** returns `1` (**PASS**); the same fixture with the runner's actual wrapping
(import inside `test()`) returns `2` (FAIL). So #2932 must ALSO hoist module `import`
statements out of the wrapped `test()` to module top level (or otherwise keep the
module goal's imports at top level) for `flags: [module]` tests. This is a
`wrapTest` change, bounded to the module-goal wrapping path.

## Acceptance

- `.js` module dependencies compile and link in multi-file mode.
- `tests/issue-1015.test.ts` positive case passes.
- Module-goal test imports are emitted at module top level (not inside `test()`).
- Full test262 diff reviewed; net conformance change is understood and accepted.
- #2900 (needs #2930 + #2931 + this) passes end-to-end via the runner.
