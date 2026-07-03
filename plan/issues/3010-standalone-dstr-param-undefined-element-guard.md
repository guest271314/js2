---
id: 3010
title: "Standalone regression: dstr-param `[x = init]` called with a single-element array literal holding `undefined` throws `TypeError: Cannot destructure` at runtime (55 test262 class/dstr files)"
status: done
completed: 2026-07-03
assignee: ttraenkler/senior-developer
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: destructuring
goal: standalone
related: [2979, 2938, 2106]
---

# #3010 — standalone destructuring-param container guard misreads a scalarized single-element array as `undefined`

## Problem (measured on main `0f4ad3231`, `--target standalone`)

55 test262 files in the `language/statements/class/dstr/*meth-ary-ptrn-elem-id-init-*`
cluster regressed from `pass` → runtime `type_error`. They **compile fine** but
throw at runtime:

```
TypeError: Cannot destructure 'null' or 'undefined'
```

Minimal repro (throws in standalone, passes in host):

```ts
function m([x = 23]: any): void {
  /* x should be 23 */
}
m([undefined]); // throws "Cannot destructure 'null' or 'undefined'"
```

The same shape inside a class method is the exact test262 cluster:

```ts
class C {
  method([x = 23]) {
    /* ... */
  }
}
new C().method([undefined]);
```

Confirmed shared identically across three unrelated queued PRs (#2562, #2521,
#2541 — none touch class codegen), proving it is inherited from `main`, not
caused by any PR. The standalone regression baseline was stale at `b9c970f`
(the commit immediately **before** the culprit merged), so every queued PR's
`merge_group` re-validation failed on drift it did not cause — stranding the
whole merge queue.

## Bisect

`git`-verified: culprit is **#2979 (PR #2488, merge `8d971b7a1`)** —
"native gen-result undefined carrier (UNDEF_F64 sentinel producer +
sentinel-aware readers)". Its first parent is exactly the stale baseline
`b9c970f`. Parent = 54/60 cluster pass; merge = 0/60.

## Root cause

`[undefined]` — a **single-element array literal passed directly as an
argument** — is _scalarized_ at the call site in standalone to a
`$BoxedNumber` holding the **UNDEF_F64 sentinel** (`i64 0x7FF8000000000001`),
i.e. the same representation `undefined` itself uses. (Host mode builds a real
array, which is why host passed.)

#2979 made the shared native `__extern_is_undefined` **sentinel-aware**: for a
non-null externref it now also tests `ref.test $BoxedNumber` and compares the
f64 bits to `UNDEF_F64_BITS`, reporting `true` for a boxed sentinel. That is
**correct for value sites** (`g.next().value === undefined`, element-default
application) — the purpose of #2979.

But the destructuring **OUTER container null-guard**
(`emitExternrefDestructureGuard`, `destructuring-params.ts`) _also_ calls
`__extern_is_undefined` — on the array being destructured. After #2979 it read
the scalarized `[undefined]` container as `undefined` and threw. Pre-#2979 that
second call was bare `ref.is_null` (redundant with the guard's first check), so
the container was let through and the element-default produced the right value.

## Fix

`emitExternrefDestructureGuard`: keep the sentinel-aware `__extern_is_undefined`
container check **only in host mode**; under `--target standalone`/`wasi` rely on
`ref.is_null` alone (the canonical standalone undefined, already the guard's
first check). This exactly restores pre-#2979 container-guard behaviour in the
host-free lanes while leaving #2979's sentinel awareness intact at every VALUE
site (element-default checks call `__extern_is_undefined` at separate call sites;
`===`/arithmetic lowering is untouched). Host-mode codegen is byte-identical by
construction (the sentinel-aware arm is wrapped in `if (!ctx.standalone &&
!ctx.wasi)` — the original instruction sequence, unchanged in host mode).

## Verification

- Cluster `statements/class/dstr/*meth-ary-ptrn-elem-id-init*` (60 files):
  fixed = **54 pass / 6 fail**, byte-for-status-identical to the clean baseline
  `b9c970f`. The 6 residual fails are the `*-skipped` variants failing a
  _semantic_ assertion (`assert.sameValue(y, false)` — a hole/elision gap), a
  pre-existing failure present on `b9c970f` too, orthogonal to this regression.
- All 10 `tests/issue-2979.test.ts` still pass (generator `.value === undefined`
  fix preserved).
- Standalone dstr suites green: issue-2568, 2611, 2904, 2878, 2512, 2567, 2545,
  2169, 820, issue-1021 (null-vs-undefined), issue-1025 (param-default-null),
  issue-2158.
- `tests/issue-3010.test.ts` — new regression test (function + class-method
  forms, multi-element, and the null-container-still-throws guard preservation).
