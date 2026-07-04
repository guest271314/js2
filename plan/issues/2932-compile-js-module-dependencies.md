---
id: 2932
title: "codegen: .js module dependencies are not compiled in multi-file mode (imports resolve to null)"
status: done
priority: high
sprint: 69
created: 2026-07-02
completed: 2026-07-02
assignee: ttraenkler/dev-2900f
feasibility: medium
task_type: bug
area: codegen
goal: spec-completeness
related: [2900, 2930, 2931]
parent: 2900
---

> Unblocked 2026-07-02: lead green-light after the re-baseline chain settled
> (revert #2450 merged, guard back at 200, honest baseline promoted 01:28Z).
> Decision record (harness-scoped option b) preserved in "## Fix" below.

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

- `.js` module dependencies compile and link in multi-file mode. ✓ (allowJs in both runner FIXTURE branches)
- `tests/issue-1015.test.ts` positive case passes. ✓ (allowJs mirrored in the test; was `expected 2 to be 1` on main)
- Module-goal test imports are emitted at module top level (not inside `test()`). ✓ (`wrapTest` hoist, `flags: [module]` only)
- Full test262 diff reviewed; net conformance change is understood and accepted. — via the PR's sharded CI regression report (see Test Results).
- #2900 (needs #2930 + #2931 + this) passes end-to-end via the runner. ✓ locally (prize test returns 1 through the replicated runner path); CI confirms.

## Test Results (dev-2900f, 2026-07-02)

Implementation: (1) `wrapTest` (tests/test262-runner.ts) hoists top-level
`import` / `export … from` statements to module top level for `flags: [module]`
tests (same-line-count placeholder keeps error line citations stable; negative
tests bypass `wrapTest` and are untouched; TLA branch untouched — its body is
already emitted at top level); (2) `allowJs: true` in the FIXTURE compileMulti
call of `tests/test262-shared.ts` (sharded CI + local shards) and
`tests/test262-vitest.test.ts`; (3) `tests/issue-1015.test.ts` mirrors the
runner and passes.

Local probes (gc lane, in-process replication of the runner fixture branch):

- **Prize test** `language/module-code/eval-gtbndng-indirect-update-dflt.js`:
  baseline `fail` → **PASS** (returns 1) — the last ≤ES3 blocker for #2900.
- Changed-path surface (static `_FIXTURE` importers): 183 tests in baseline —
  38 pass / 54 fail / 91 skip. (The other ~600 `_FIXTURE`-grepping tests use
  dynamic `import()` and do NOT take the fixture branch — unchanged.)
- Baseline-fail set (54): 6 flip fail→**pass** (incl. prize test,
  eval-rqstd-order, instn-\* siblings), 48 remain fail (honest failures now —
  real fixture semantics instead of the null-import artifact).
- Baseline-pass set (38): 31 still pass; 7 candidate pass→fail flips from the
  in-process replication, resolved by a scoped REAL-runner run
  (`TEST262_PATH_FILTER` over the candidates, local shards):
  - 3 artifacts of the replication (no flip): `top-level-await/module-import-rejection{,-body,-tick}.js` — real runner records **pass**.
  - 2 were real but FIXED in-branch: `import-attributes/import-attribute-key-string-{double,single}.js` — negative resolution tests; `allowJs` suppresses the
    syntax-error bail in `compileMultiSource`, so the invalid module "compiled"
    and its raw top-level asserts executed at instantiation. Fix: `allowJs:
!isNegative` in both runners (negative tests assert compile-time failure;
    allowJs must never mask it).
  - 2 REAL honest regressions remain (baseline pass was a null-import artifact;
    the now-compiled fixture exposes genuine compiler gaps):
    - `language/expressions/import.meta/distinct-for-each-module.js` — requires
      per-module `import.meta` object identity.
    - `language/module-code/top-level-await/async-module-does-not-block-sibling-modules.js` — requires async-module sibling evaluation ordering.
- Scoped unit tests: `issue-1015`, `test262-runner-static-gen-yield`,
  `test262-path-filter`, `test262-scope-classification` — 20/20 pass.

## merge_group run #1 (head 228d906, run 28568484919) — PARKED, diagnosed (dev-2900f)

The queue's full-matrix run attributed **8 improvements / 8 regressions**
(merge-base baseline 72fad54, ratio gate 100% ≥ 10% → auto-park `hold`).
Per-file attribution (from the run's merged-report artifact):

- **8 improvements** — the 6 predicted fixture gains (prize test incl.) + 2
  accidental `module-code/namespace/internals` wins
  (`get-own-property-str-found-uninit.js`, `set-prototype-of.js`).
- **8 regressions**, three buckets:
  1. `import-attributes/import-attribute-key-string-{double,single}.js` —
     negative-resolution tests broken by allowJs diagnostic suppression.
     **FIXED** in-branch: `allowJs: !isNegative` in both runners.
  2. 4× `module-code/namespace{,/internals}` tests failing `ns is not defined`
     (`Symbol.iterator`, `get-own-property-str-not-found`, `is-extensible`,
     `set-prototype-of-null`) — these tests **SELF-import**
     (`import * as ns from './<own-filename>.js'`); the hoist moved the
     self-import to top level where it cannot resolve under the runner's
     virtual `./test.ts` key. **FIXED** in-branch: hoist restricted to
     `_FIXTURE` specifiers only (the exact fixture-linking purpose of #2932).
     This also reverts the 2 accidental namespace improvements above — they
     were the same brittle self-import-hoist behavior in the lucky direction.
  3. 2 honest, irreducible regressions (baseline pass was the null-import
     artifact; the now-compiled fixture exposes real compiler gaps), each with
     a tracking issue filed in this PR:
     - `language/expressions/import.meta/distinct-for-each-module.js` —
       per-module `import.meta` object identity → **#2970**.
     - `language/module-code/top-level-await/async-module-does-not-block-sibling-modules.js` — async-module sibling evaluation ordering → **#2971**.

**Post-fix arithmetic: +6 / −2 (net +4), ratio 2/6 = 33% ≥ 10%** — the
required `check for test262 regressions` gate will re-park on re-enqueue.
The remaining 2 regressions cannot be removed honestly at the harness level
(skips also count as pass→other regressions). Lead decision required on the
landing mechanism (accept-and-refresh-baseline vs gate excusal vs
gap-fix-first).
