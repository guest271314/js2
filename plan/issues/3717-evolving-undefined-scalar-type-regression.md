---
id: 3717
title: "Checker regression: scalar `var x = (void 0)` / `let x;` locals stay permanently typed `undefined`, rejecting later reassignment — acorn dogfood no longer compiles"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: checker
language_feature: type-inference
goal: core-semantics
origin: "tests/dogfood/acorn-harness.mjs — re-run 2026-07-27 while investigating #3715/#3716"
related: [3715, 1710, 1711, 1725]
---

# #3717 — Scalar evolving-`undefined` type regression (acorn dogfood now red)

## Problem

Re-running `pnpm run dogfood:acorn` locally (2026-07-27, main `85ab628b`) to
sanity-check the new marked dogfood harness (#3716) turned up a regression:
**acorn no longer compiles at all.**

The #1711 triage (2026-05-29) recorded `compile.success: true` (827,839-byte
binary, 471 non-blocking diagnostics) — the only blocker at the time was a
*validation*-layer bug (#1725, `any.convert_extern` on a narrowed ref),
since fixed. As of this run, `compile()` itself returns `success: false`,
`binaryBytes: 0`, 491 diagnostics — 5 of which are `severity: "error"`
(TS2322, hard-blocking), up from 0 previously.

## Repro (minimal, verified against real `tsc` — zero errors there)

```ts
function test(): number {
  var elt = (void 0);
  if (Math.random() > 0.5) {
    elt = null;
  } else {
    elt = 5;
  }
  return elt as any;
}
```

js2wasm:

```
Type 'null' is not assignable to type 'undefined'.
Type 'number' is not assignable to type 'undefined'.
```

Real `tsc --noEmit --target es2022 --lib es2022 --skipLibCheck`: no errors.

## Root cause (hypothesis)

TypeScript widens an annotation-less `var`/`let` initialized to
`undefined`/`void 0` based on control-flow-visible later assignments,
rather than permanently fixing its type to `undefined`. js2wasm's
checker/oracle appears to keep the initializer's literal type
(`undefined`) forever, same failure shape as **#3715** (evolving array
types: `let x = []` stuck at `never[]`) — this looks like the scalar
sibling of that same missing "evolving type" feature family, not the
identical code path (arrays vs. `undefined`-initialized scalars are
different TS mechanisms), but likely worth investigating together since a
fix to one checker area may inform the other.

Found live in acorn's own dist bundle (`dist/acorn.mjs`), e.g.:

```js
// line 3622 area (readExprList):
var elt = (void 0);
if (allowEmpty && this.type === types$1.comma) { elt = null; }
else if (...) { elt = this.parseSpread(...); }
...

// line 5865-5868 (readInt):
var code = this.input.charCodeAt(this.pos), val = (void 0);
...
if (code >= 97) { val = code - 97 + 10; }
else if (code >= 65) { val = code - 65 + 10; }
else if (code >= 48 && code <= 57) { val = code - 48; }
else { val = Infinity; }
```

Both are ordinary, idiomatic "declare then conditionally assign" JS —
exactly the shape a Babel/pre-ES2015-var-hoisting-era codebase like acorn
uses throughout. That's likely why this wasn't caught earlier: it's common
enough that it's probably not new to acorn's source (acorn hasn't changed
under us — a committed pinned tarball), so the regression is on the
js2wasm checker side, introduced sometime between the 2026-05-29 #1711
triage and now.

## Why this wasn't caught by CI

The dogfood harnesses (#1710/#3716) are **not currently wired into any CI
gate** — `pnpm run dogfood:acorn`/`dogfood:marked` are manual/local-only
invocations, and `tests/dogfood/*.test.ts`'s heavy diff loop is opt-in via
an env var (`DOGFOOD_MARKED=1` etc.), skipped by default in the vitest
suite. So a regression here has no automated tripwire — worth a follow-up
issue to at least run these on a schedule/nightly and alert on
`compile.success` flipping to `false`, separate from this bug itself.

## Scope

- [ ] Bisect what changed between 2026-05-29 (#1711, acorn compiled) and
      now that turned these TS2322s from absent/warning into hard
      `severity: "error"` blockers — could be a checker tightening, could
      be a genuine new gap that was always latent but only recently
      started emitting `error` instead of `warning` severity.
- [ ] Fix or extend the checker's evolving-type handling to cover
      `undefined`-initialized scalars reassigned under visible control
      flow (mirrors #3715's array case).
- [ ] Re-run `pnpm run dogfood:acorn` — expect `compile.success: true`
      again (matching the #1711 baseline), then re-triage whatever the
      binary-validation layer shows now that #1725 is fixed.

## Acceptance criteria

- [ ] The minimal repro above compiles successfully and `test()` returns
      the assigned value.
- [ ] `pnpm run dogfood:acorn` regains `compile.success: true`.
- [ ] No regression in the currently-passing evolving-array fix path once
      #3715 lands (if the fixes end up sharing code, both repros must keep
      passing).
