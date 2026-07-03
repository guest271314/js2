---
id: 3010
title: "Standalone regression: dstr-param `[x = init]` called with a single-element array literal holding `undefined` throws `TypeError: Cannot destructure` at runtime (55 test262 class/dstr files)"
status: done
completed: 2026-07-03
assignee: ttraenkler/senior-developer
sprint: 69
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

## Fix (corrected — supersedes the first #2570 attempt)

`emitExternrefDestructureGuard`: keep the sentinel-aware `__extern_is_undefined`
container **throw check** only in host mode; under `--target standalone`/`wasi`
rely on `ref.is_null` alone (the canonical standalone undefined, already the
guard's first check). This restores pre-#2979 container-guard behaviour in the
host-free lanes while leaving #2979's sentinel awareness intact at every VALUE
site.

**CRITICAL correction over the first attempt (why #2570 regressed):** the first
attempt wrapped the ENTIRE block — the `ensureLateImport("__extern_is_undefined")`
+ `flushLateImportShifts` side effects AND the three emitted instructions —
inside `if (!ctx.standalone && !ctx.wasi)`. Skipping the *registration/flush* in
standalone perturbed the late-import/funcIdx bookkeeping for the rest of the
enclosing method body: a later `call funcIdx` got miswired, so an empty array
pattern `[]` (§13.3.3.6 — NO iterator observation) instead invoked the argument
iterator's `.next()`. That silently regressed all **24
`class/dstr/*ary-ptrn-empty`** files (statement + expression
meth/gen/private/static/async), which PASS on plain main. The first attempt's
"0 regressions" claim was wrong because it validated only the `elem-id-init`
cluster the fix restores, never the `empty` cluster it broke.

The corrected fix keeps `ensureLateImport` + `flushLateImportShifts`
**unconditional in every mode** (identical to main's bookkeeping — the import is
already registered unconditionally at the value-default sites, so this is
host-free-safe and adds no leaked host import) and gates **only** the three
emitted throw-check instructions to host mode. This makes host-mode codegen
byte-identical to main, and standalone a pure removal of the three erroneous
instructions with funcIdx accounting preserved exactly as main computes it.

## Verification (independent, on current main — both clusters + host byte-inertness)

Measured with the standalone runner (`runTest262File(..., "standalone")`) over
statement + expression `class/dstr` variants:

| Cluster | plain main | first attempt (#2570) | corrected fix |
| --- | --- | --- | --- |
| `*ary-ptrn-empty` (48) | **48 pass** | 24 pass (**−24**) | **48 pass** |
| `*ary-ptrn-elem-id-init` (480) | 402 pass | 450 pass (**+48**) | **450 pass** |

- Corrected fix = **best of both**: eliminates the 24-file empty-pattern
  regression AND keeps the +48 elem-id-init restoration. The 30 residual
  elem-id-init fails are pre-existing `*-skipped` semantic fails (present on both
  main's 78 and the attempt's 30), orthogonal to this guard.
- **Host byte-inertness (sha256):** the whole `class/dstr` host-mode corpus
  (3840 files, 3552 compiled) hashes **identically** for the corrected fix and
  plain main (`0f2a5bab…d606cc10`), proving the change is a no-op in host mode.
- `tests/issue-3010.test.ts` — regression tests: the original elem-id-init
  shapes (function + class-method), multi-element, null-container-still-throws,
  **plus two new empty-pattern iterator-observation guards** (class generator
  method + plain function `[]` → generator body never runs).
