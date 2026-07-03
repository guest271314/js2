---
id: 3019
title: "Restore 106 silently-dead test files whose ./helpers.js import broke when helpers moved to tests/equivalence/"
status: done
sprint: current
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
in the **94** files whose tests **pass** once they load — pure coverage
restoration, all green. Test-file-only; byte-inert to the compiler
(`src/**`). Verified: the 94 files load and pass (812 tests) on `origin/main`
(measured on f1afd54b2, re-sanity-checked on df025c3e9).

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

- The 94 passing files import `./equivalence/helpers.js` and load + pass. [done]
- The 12 failing files are enumerated with their surfaced-regression status for
  follow-up. [done]
- No compiler-source change; required CI green. [done]
