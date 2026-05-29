---
id: 1728
title: "internal call to a module-level `const` arrow traps with illegal cast"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: medium
task_type: bugfix
area: codegen
language_feature: closures, arrow-functions
goal: test262-conformance
related: [1727, 1115]
---

# #1728 — internal call to a module-level `const` arrow → "illegal cast"

## Problem

Calling a module-level `const`-bound arrow function from another function
(internal wasm `call_ref` dispatch, not the export boundary) traps at runtime
with `RuntimeError: illegal cast`. This is **independent of async** — a plain
synchronous arrow reproduces it:

```ts
const f = (x: number): number => x * 2;
export function main(): number { return f(21); }
// RuntimeError: illegal cast (expected 42)
```

The async variant traps identically:

```ts
const double = async (x: number): Promise<number> => x * 2;
export function main(): number { return double(21) as any as number; }
// RuntimeError: illegal cast (expected 42)
```

## Root cause (narrowed — dev, 2026-05-29)

NOT the #1727 Promise-wrap path. With the #1727 fix in place,
`asyncResultConsumedAsValue` correctly skips the wrap and the recorded
`callResult` ValType is `f64` — the value path is correct. The trap is at the
**closure dispatch site**: the `ref.cast` of the stored closure ref to its
specific wrapper struct type fails. The module-level `const` arrow is stored /
re-resolved in a way that the call-site `ref.cast` does not match (compare the
inline arrow / passed-as-arg paths, which work). Lives in `src/codegen/closures.ts`
closure call_ref dispatch (the `ref.cast typeIdx structTypeIdx` at the call
site, see closures.ts ~1699 / dispatch ref.cast), not in the async wrap.

## Repro / acceptance

- `const f = (x:number):number => x*2; main(){ return f(21); }` → 42 (no trap).
- The async-arrow variant (the `it.skip("async arrow function (#1728 ...)")`
  case in `tests/equivalence/async-function.test.ts`) flips green; un-skip it.
- No regression in inline-arrow / callback-arrow dispatch.

## Source

Surfaced while fixing #1727 (async-call NaN). The async-arrow equivalence case
was attributed to async but is a general module-const-arrow dispatch bug;
split out so #1727 ships the actual Promise-wrap fix without expanding into
closure-ABI work.
