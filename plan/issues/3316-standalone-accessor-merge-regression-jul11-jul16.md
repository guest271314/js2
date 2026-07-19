---
id: 3316
title: "standalone: 4/18 accessor-merge tests regressed between main 026f40f771 (2026-07-11) and f01f7fbb6e (2026-07-16) — illegal cast traps, invisible to CI"
status: done
assignee: ttraenkler/fable-3316
completed: 2026-07-16
sprint: 72
created: 2026-07-16
priority: high
feasibility: medium
model: fable
task_type: bug
area: codegen
goal: standalone-mode
related: [2992, 2893, 2106, 3037, 3246]
origin: "found as a documented residual during #2992 slice 5 (fable-mop, 2026-07-16) — not this slice's own regression, flagged for its own triage"
# LOC-ratchet allowance (#3102): both arms are regime-gated bug fixes with
# root-cause commentary in two pre-existing god-files — no new subsystem fits.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/statements/variables.ts
---

# #3316 — accessor-merge regression window, main 026f40f771 → f01f7fbb6e

> **Note on numbering**: this fix originally shipped on branch
> `issue-3307-accessor-merge-illegal-cast` (PR #3140) under a hand-picked
> id 3307 that collided with the TRAP_RATCHET_TOLERANCE issue already on
> main (#2531 dup-id hazard — the `check:issue-ids:against-main` gate
> caught it). Renumbered to #3316; the fix, root-cause and measurements
> below are fable-mop's, verified and landed by fable-3316. Test file:
> `tests/issue-3316.test.ts` (renamed from `tests/issue-3307.test.ts`).

## Problem

`tests/issue-2992-accessor-merge.test.ts` passed 18/18 (gc + standalone) when
measured on main `026f40f771` (2026-07-11, #2992 slice 3). Re-measured on main
`f01f7fbb6e` (2026-07-16, #2992 slice 5) as a documented-residual check: **4 of
18 standalone cases now fail**:

- `get-only redefine preserves the live setter (15.2.3.6-4-107 shape)` — **illegal cast**
- `flags-only redefine of an accessor preserves both halves (15.2.3.6-4-82-* shape)` — **illegal cast**
- `explicit { get: undefined, set: undefined } creates an accessor visible to gOPD (15.2.3.6-4-439)` — value mismatch (+0 !== 1)
- `non-configurable accessor rejects a getter change with TypeError` — **illegal cast**

Common shape: **dynamic descriptors** (`var d: any = { get: g, … };
Object.defineProperty(o, "foo", d)`) on a bracket-poisoned `$Object` receiver
(`o["q"] = 0`). The gc lane passes all 18; only the standalone lane regressed.

**Not caught by CI** — the `quality` job's scoped-suite runs don't include
this file on every PR; it only surfaces when someone happens to re-run it
directly, as slice 5 did as a sanity check.

## Root cause (bisected independently twice, 2026-07-16 — fable-mop and fable-3316 converged on the same commit)

**Culprit commit: `f78be06991`** — merge of PR #3020, **feat(#2106): flip
$undefined singleton default ON (standalone/nativeStrings)**. Confirmed by
`git bisect --first-parent 026f40f771..f01f7fbb6e` on this test file
(fable-3316) and by fable-mop's independent bisect of the same window;
A/B-confirmed via `JS2WASM_UNDEF_SINGLETON=0` → 18/18 on the unmodified
regressing main. A deliberate feature flip, so the fix is targeted (not a
revert). Two mechanisms:

1. **Carrier-hoist illegal cast (the 3 trap cases — and every
   `var d: any = { … }` in a function body, minimal repro
   `var d1: any = { value: 5 }`; even dynamic DATA descriptors trapped):**
   `hoistVarDecl` allocates the slot externref and initializes it with the
   tag-1 `$undefined` singleton; the #3037 CS1a any-object-carrier retype then
   flips the slot to `(ref null $Object)` up front, and the `local-set-coerce`
   stack-balance fixup splices an unguarded `any.convert_extern; ref.cast_null`
   over the non-null singleton → trap at the function's first instruction.
   Fix: `hoistedVarRetypesToConcreteRef` (statements/variables.ts) now also
   covers the CS1a carrier shape, so the hoist emits the flag-OFF
   `ref.null.extern` (exactly the pre-existing RegExp-retype discipline,
   #2106 S1 PR-2 — whose doc-comment claimed the RegExp arm was "the ONLY
   externref → ref hoist retype"; #3037 CS1a had silently added a second).
2. **gOPD null accessor halves (the value-mismatch case):** the
   `__getOwnPropertyDescriptor` accessor arm materialized a NULL stored
   get/set half with a bare `extern.convert_any` — null externref, which under
   the singleton regime is DISTINCT from undefined, so
   `desc.get === undefined` answered false for explicit `{get: undefined}`
   defines. Fix: null halves materialize as the `$undefined` singleton
   (regime-gated; legacy lanes byte-identical).

**Pre-existing residuals found during validation (fail identically on the
unmodified base — same #2106-flip family, different mechanisms, NOT fixed
here):** `issue-2874-standalone-create-descriptor > missing own property
returns undefined` and `issue-2896 > delete fn.name works (configurable)` —
both are missing-descriptor/undefined-observability shapes in OTHER gOPD
arms (typed-receiver fast path / builtin-fn metadata).

## Repro

```bash
npx vitest run tests/issue-2992-accessor-merge.test.ts   # 4 standalone fails pre-fix
JS2WASM_UNDEF_SINGLETON=0 npx vitest run tests/issue-2992-accessor-merge.test.ts  # 18/18 (A/B control)
```

## Acceptance criteria

- `tests/issue-2992-accessor-merge.test.ts` 18/18 pass (gc + standalone) on
  the fix branch. ✅
- Culprit commit identified and named in this issue file (even if the fix
  itself doesn't revert it — describe what broke and why). ✅ (`f78be06991`,
  PR #3020)
- Zero regressions on the existing #2992 slice 1/3/4/5 test files
  (`tests/issue-2992*.test.ts`) and the adjacent equivalence suites those
  slices validated against. ✅

## Measured (2026-07-16, fable-mop; re-verified on post-merge main by fable-3316)

- `tests/issue-2992-accessor-merge.test.ts`: **18/18** (was 14/18).
- New `tests/issue-3316.test.ts`: 8/8 (gc + standalone) — minimal carrier
  repro, carrier round-trip, 4-107 dynamic-descriptor merge, gOPD null-half.
- 264-file standalone test262 sample (same deterministic
  defineProperty/defineProperties sample as #2992 S5): **+16 flips, 0
  regressions** (140 → 156 pass; all 140 control passes retained) — the
  carrier-hoist trap poisoned every runner-wrapped test with a
  `var d: any = { … }` descriptor, so the fix flips broadly.
- gc/host lane **byte-inert** (SHA-identical binaries pre/post; both arms are
  singleton-regime-gated).
- Sibling suites clean: `issue-2992*` (42 + 2 skips), `issue-2106-s1-*`
  (singleton + RegExp hoisted-var), 64/64 in the combined run.

## Follow-up (noted, not blocking)

- Consider scoped-suite CI coverage for `tests/issue-2992-accessor-merge.test.ts`
  so a repeat regression doesn't go silent again (needs its own CI-config
  discussion).
- The two pre-existing gOPD residuals above (issue-2874 / issue-2896 shapes)
  are the same #2106-flip family in other arms — candidates for a small
  follow-up issue.
