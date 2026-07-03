---
id: 2995
title: Standalone tuple-from-iterable destructure fallback leaks env::__array_from_iter
status: done
assignee: ttraenkler/agent-a67bcee7
sprint: 69
priority: high
horizon: s
feasibility: medium
goal: standalone-host-free
created: 2026-07-02
completed: 2026-07-02
---

## Problem

Origin: `plan/log/investigations/2026-07-02-leak-analysis-round5.md`
(iterator-protocol tail lever, execution-verified GENUINE). On
`--target standalone` / `--target wasi`, destructuring an `any`-typed
(externref) source into a **tuple** via the iterable fallback
(`buildTupleFromIterableFallback` in `src/codegen/type-coercion.ts`) leaks the
host import `env::__array_from_iter`. This is the object-pattern-with-array-
subpattern-default shape, e.g.:

```js
function f({ w: [x, y, z] = [4, 5, 6] } = { w: [7, undefined,] }) { … }
```

The sibling issue #2904 already gave fixed-arity **destructuring-param** array
patterns a native `__array_from_iter_n`; but the tuple-from-iterable fallback in
`type-coercion.ts` still unconditionally emitted the host `__array_from_iter`
even in host-free targets — unlike its neighbour `buildVecFromExternref`, which
already has a native ObjVec path. The round-5 report counted **10** sole-import
leaky standalone passes on `env::__array_from_iter` from this cluster:

- `language/statements|expressions/class/dstr/(private-)meth(-static)-dflt-obj-ptrn-prop-ary.js`
- `language/statements/function/dstr/{ary-init-iter-no-close,dflt-obj-ptrn-prop-ary}.js`

## Fix

`buildTupleFromIterableFallback` now routes host-free targets
(`ctx.standalone || ctx.wasi`) through the NATIVE `__array_from_iter_n`
(registered by `ensureNativeArrayFromIterN`, #2904) with count `-1` — an
unbounded drain that is byte-semantics-equivalent to the host
`__array_from_iter` (fully drain the iterable, then index each tuple slot via
`__extern_get_idx`). Host (gc) mode keeps the JS-host `__array_from_iter` path
unchanged.

Single file: `src/codegen/type-coercion.ts`.

## Verification

- **Leak-elim**: all 10 cluster tests compile with **0 `env::` imports** on
  `--target standalone` (were `env(1): __array_from_iter`).
- **Correctness**: all 10 pass via the real `runTest262File(..., "standalone")`
  runner (10/10). A 70-test destructuring regression sample shows an
  **identical** pass/fail set before and after (47/70, zero pass→fail flips).
- **Vacuity**: inject-throw probe (throw before first assert) flips the target
  tests to `fail` — GENUINE, the body executes.
- **Host lane byte-inert**: sha256 of the gc-lane binary is identical
  before/after for the affected tests (change is gated on standalone/wasi).
