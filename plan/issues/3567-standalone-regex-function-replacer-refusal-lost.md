---
id: 3567
title: "standalone: regex function-replacer refusal silently LOST — compiles a broken binary instead of refusing (#1539 guard red)"
status: ready
sprint: current
created: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: regexp, string-replace, standalone
es_edition: es2015
goal: standalone-gap
related: [1539, 1474, 2868, 3008]
origin: "2026-07-24 bounded standalone-test audit (dev-opus / #3565 lane): tests/issue-1539-standalone-regex-replace.test.ts silently red on main — outside required checks (#3008)."
---

# #3567 — standalone regex function-replacer refusal silently defeated

## Problem

`tests/issue-1539-standalone-regex-replace.test.ts` is **silently red on current
main** (not PR-touched, not in the required guard suite — #3008 gap). The
subtest "refuses function replacer" asserts that a standalone
`s.replace(/\d/, (m) => ...)` **REFUSES to compile** (clean `#1539`/`#1474`
compile error) because a function replacer is not supported host-free. That
refusal has **silently regressed**: the compile now SUCCEEDS and emits a
**broken binary** instead of refusing.

This is a **lost-refusal regression** in the same family as #3562 (a leaf
exclusion silently defeated) and #3558/#3561 (stale-guard rot): a guard that
protected against silent-wrong-output was defeated, so the compiler now produces
a binary that traps at runtime rather than failing cleanly at compile time.

## Measured evidence (current main, `--target standalone`)

```ts
export function f(s: string): string {
  return s.replace(/\d/, (m: string) => m + m);
}
```

- `compile(...).success` → **true** (the test expects `false` — a `#1539`/`#1474`
  refusal). No refusal error, no warning.
- Instantiate + run `f("a1b")` → **throws `type incompatibility when transforming
from/to JS`** (expected `"a11b"`). So it is NOT "the feature is now supported"
  — the binary is broken; the refusal was the correct behavior and it was lost.

Verified red on clean `origin/main`.

## Root cause (pointer, not yet fixed)

Standalone regex with a **function replacer** is RegExp-carrier substrate
(#2868) — genuinely unsupported host-free. The FIX in scope is to **restore the
`#1539`/`#1474` refusal** (detect a function-argument replacer under
`--target standalone`/`wasi` and emit the clean compile error) so it fails loud
instead of emitting a trapping binary. That refusal path regressed somewhere in
the RegExp-carrier rework; restoring it is more contained than supporting the
feature, but still needs the RegExp-lowering owner. Out of scope for the
guard-audit lane; filed for tracking.

## Guard status

`tests/issue-1539-standalone-regex-replace.test.ts` already detects this
post-merge but is unenforced. Cannot fold into the required suite (#3552) while
red. Fold once the refusal is restored (green).
