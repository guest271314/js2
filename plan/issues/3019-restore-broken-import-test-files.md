---
id: 3019
title: "Restore 106 silently-dead test files whose ./helpers.js import broke when helpers moved to tests/equivalence/"
status: done
sprint: 69
priority: medium
created: 2026-07-03
completed: 2026-07-03
assignee: ttraenkler/dev-team-d
feasibility: easy
reasoning_effort: low
task_type: chore
area: quality-infra
language_feature: n/a
goal: quality-infra
related: [3008, 2767, 2957]
origin: "2026-07-03 — while triaging #3008/#2967 found the ./helpers.js breakage is 106 files, not one"
---

# #3019 — restore the test files silently killed by the tests/helpers.ts → tests/equivalence/helpers.ts move

## Finding

`tests/equivalence/helpers.ts` (the `compileToWasm` / `evaluateAsJs` /
`assertEquivalent` harness) used to live at `tests/helpers.ts`. When it moved,
**106** `tests/*.test.ts` files that import `from "./helpers.js"` were **not**
updated. `./helpers.js` no longer resolves (there is no `tests/helpers.ts`;
`tests/helpers/` holds only `ir-fallbacks.ts`), so vitest throws
`Cannot find module './helpers.js'` at **collection time** for every one of
those files. A file that errors at collection contributes **zero** assertions,
so all 106 have been running as silent no-ops — exactly the regression-memory
blind spot #3008 documents (and #2767 hit: 6/11 silently red), but at scale.

This is invisible to CI because the required `quality` gate
(`.github/workflows/ci.yml`) runs lint / format / typecheck / the IR-fallback,
oracle, ir-adoption and stack-balance ratchets — **not** `vitest run`. It also
does not typecheck the files (`tsconfig.json` `exclude: ["tests"]`). So the
breakage never surfaced.

## Fix (this issue — the bounded, green slice)

Mechanically repoint `from "./helpers.js"` → `from "./equivalence/helpers.js"`
in the passing files — pure coverage restoration, all green. Test-file-only;
byte-inert to the compiler (`src/**`). Verified: the files load and pass on
`origin/main` (measured on f1afd54b2, re-sanity-checked on df025c3e9).

### Scope narrowed to 28 files (overlap with PR #2588)

Of the 94 files that pass once repointed, **66 are ALSO deleted outright by
PR #2588** (dev-team-e), which verified those 66 as provably-dead duplicates —
70 byte-identical modulo the import path, 6 superseded by a larger updated
copy — of live files already under `tests/equivalence/`. Two PRs can't both
delete and fix-and-keep the same files, and restoring a genuine duplicate just
runs the same assertions twice (no new coverage). So this PR is narrowed to the
**28 passing files that #2588 does NOT delete** (the unique, non-duplicate
survivors); the other 66 are dropped from this diff and handled by #2588's
deletion. The 28:

```
arguments-object, bigint, boolean-relational-comparison, coalesce-operator,
compound-assignment-property, compound-assignment-unresolvable-prop,
function-arity-mismatch, gradual-typing, in-operator-edge-cases,
logical-assignment-property, logical-operators, loose-equality,
modulus-special-values, negative-zero-modulus, nested-class-declarations,
new-expression-spread, object-literal-getters-setters,
prefix-postfix-increment-property, private-class-members,
scope-and-error-handling, shape-inference, spread-in-new-expressions,
string-relational-operators, switch-and-misc, template-literal-type-coercion,
typeof-comparison, unary-plus-coercion-185, unary-plus-coercion-215
```
(all `tests/*.test.ts`)

## Deferred (real regressions surfaced — NOT in this PR)

Repointing the import on **12** files makes them load and reveals **22
genuinely-failing tests** — real, previously-hidden regressions of the exact
class #2767 warned about. These are left with the broken import untouched (no
worse than before — still dead) and tracked here for separate triage so this
slice stays green:

```
tests/arguments-nested-and-loops.test.ts
tests/array-inline-return.test.ts
tests/async-function.test.ts          (also flagged in #2967)
tests/global-index-shift-trycatch.test.ts
tests/iife-and-call-expressions.test.ts
tests/iife-tagged-templates.test.ts
tests/import-meta.test.ts
tests/json-stringify.test.ts
tests/logical-conditional-identity.test.ts
tests/math-pow-test262-pattern.test.ts
tests/misc-small-patterns.test.ts
tests/optional-direct-closure-call.test.ts
```

Follow-up scope (route via #3008 or a new triage issue): fix each cluster's
underlying codegen regression, then repoint its import, then — per #3008 — add
a collection-time guard so a broken-import / load-error test can't ever again
pass by contributing zero assertions.

## Acceptance criteria

- The 28 non-duplicate passing files import `./equivalence/helpers.js` and load
  + pass; the 66 duplicate-of-`tests/equivalence/` files are ceded to #2588's
  deletion. [done]
- The 12 failing files are enumerated with their surfaced-regression status for
  follow-up (real bugs, tracked here regardless of the #2588 overlap). [done]
- No compiler-source change; required CI green. [done]
