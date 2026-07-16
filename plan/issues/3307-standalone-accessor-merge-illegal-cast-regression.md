---
id: 3307
title: "Standalone regression: dynamic-descriptor accessor merge illegal-cast (4 issue-2992-accessor-merge cases, passed on 026f40f771-era main)"
status: done
assignee: ttraenkler/fable-mop
completed: 2026-07-16
sprint: current
priority: high
horizon: m
feasibility: medium
task_type: fix
area: codegen, runtime
language_feature: object-property-descriptors
goal: standalone-mode
created: 2026-07-16
related: [2992, 3246, 3274]
# LOC-ratchet allowance (#3102): both arms are regime-gated bug fixes with
# root-cause commentary in two pre-existing god-files — no new subsystem fits.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/statements/variables.ts
origin: "flagged by fable-mop during #2992 slice-5 validation — pre-existing on current main, not caught by scoped CI suites"
---

# #3307 — standalone dynamic-descriptor accessor merge regressed (illegal cast)

## Problem

4 of 18 standalone cases in `tests/issue-2992-accessor-merge.test.ts` (the
#2992 slice-3 suite, 18/18 green when PR #2893/#2898 landed on 2026-07-11)
now fail on current main:

- `get-only redefine preserves the live setter (15.2.3.6-4-107 shape)` — **illegal cast**
- `flags-only redefine of an accessor preserves both halves (15.2.3.6-4-82-* shape)` — **illegal cast**
- `explicit { get: undefined, set: undefined } creates an accessor visible to gOPD (15.2.3.6-4-439)` — value mismatch (+0 !== 1)
- `non-configurable accessor rejects a getter change with TypeError` — **illegal cast**

Common shape: **dynamic descriptors** (`var d: any = { get: g, … };
Object.defineProperty(o, "foo", d)`) on a bracket-poisoned `$Object` receiver
(`o["q"] = 0`). The gc lane passes all 18; only the standalone lane regressed.

## Culprit range

`c78ac50702` (slice-4 merge, 18/18 pass) .. `503b64ac35` (4 fail; also fails
at `a83f59a27f` #3246 and at current `7e9d22a66e`). 205 first-parent commits;
bisect in progress — culprit recorded below when found.

## Repro

```bash
npx vitest run tests/issue-2992-accessor-merge.test.ts   # 4 standalone fails
```

Not caught by CI: the `quality` gate runs scoped vitest suites only, and the
test262 baseline gates key on test262 files, not this unit suite.

## Root cause (bisected + fixed 2026-07-16, fable-mop)

First bad commit: `f78be06991` — merge of PR #3020, **feat(#2106): flip
$undefined singleton default ON (standalone/nativeStrings)**. A deliberate
feature flip, so the fix is targeted (not a revert). Two mechanisms:

1. **Carrier-hoist illegal cast (the 3 trap cases — and every
   `var d: any = { … }` in a function body, minimal repro
   `var d1: any = { value: 5 }`):** `hoistVarDecl` allocates the slot
   externref and initializes it with the tag-1 `$undefined` singleton; the
   #3037 CS1a any-object-carrier retype then flips the slot to
   `(ref null $Object)` up front, and the `local-set-coerce` stack-balance
   fixup splices an unguarded `any.convert_extern; ref.cast_null` over the
   non-null singleton → trap at the function's first instruction. Fix:
   `hoistedVarRetypesToConcreteRef` (statements/variables.ts) now also covers
   the CS1a carrier shape, so the hoist emits the flag-OFF `ref.null.extern`
   (exactly the pre-existing RegExp-retype discipline, #2106 S1 PR-2).
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

## Acceptance

- `tests/issue-2992-accessor-merge.test.ts` back to 18/18 (gc + standalone).
- No regressions on the #2992 sibling suites (`issue-2992.test.ts`,
  `issue-2992-delete-widening.test.ts`, `issue-2992-accessor-widening.test.ts`)
  and a defineProperty/defineProperties standalone spot-sample.

## Measured (2026-07-16, fable-mop)

- `tests/issue-2992-accessor-merge.test.ts`: **18/18** (was 14/18).
- New `tests/issue-3307.test.ts`: 8/8 (gc + standalone) — minimal carrier
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
