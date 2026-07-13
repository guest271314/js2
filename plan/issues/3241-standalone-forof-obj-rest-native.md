---
id: 3241
title: "Native object-rest CopyDataProperties for for-of/for-await loop-var rest (standalone)"
status: done
sprint: 71
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
assignee: opus-restobj
completed: 2026-07-13
loc-budget-allow:
  - src/codegen/destructuring-params.ts
  - src/codegen/statements/loops.ts
---

## Problem

Under `--target standalone`/`wasi`, the object-rest loop-var binding in a
`for (const { a, ...rest } of arr)` / `for await (...)` still emitted the
`env.__extern_rest_object` **host import** (`src/codegen/statements/loops.ts`).
That leaks an `env::` import — breaking zero-import instantiation — and, once
the DEFINED native `__extern_rest_object` (from #3223) was registered by another
rest site in the same module, was **silently miscompiled**: the loop site passed
a comma-joined excluded **string** as the 2nd arg, but the native helper takes an
exclusion **object** (its `__extern_has(excl, key)` membership probe), so a
string arg reports every key "absent" ⇒ NO key excluded ⇒ the rest object
wrongly keeps the destructured keys.

opus-leak2's standalone leak re-rank flagged `__extern_rest_object` as ~9
sole-import host-free flips. Investigation on current main found the **9
`for-await-of` tests were already host-free** via #3223's externref decl path
(the standalone baseline was captured pre-#3223, so it was stale). The remaining
real leak was the **for-of/for-await struct-typed loop-var rest** path — the 9
`for-of/dstr/{const,let,var}-obj-ptrn-rest-{val-obj,getter,skip-non-enumerable}`
tests — which this issue de-leaks.

## Fix

Extracted the #3223 native-rest emission into a shared
`emitStandaloneObjectRest(ctx, fctx, emitSource, excludedKeys, restIdx)` helper
(`src/codegen/destructuring-params.ts`): it builds the exclusion `$Object` (own
keys = excluded names), invokes `emitSource` (which must leave an **open
`$Object`** externref on the stack), and calls the native `__extern_rest_object`.

- **loops.ts** (for-of/for-await struct-rest): added a `ctx.standalone||wasi`
  branch that reifies the CLOSED-shape loop-element struct into an open
  `$Object` via `materializeStructAsObject` (#3222 C1 — a bare
  `extern.convert_any` is invisible to `__object_keys` and yields an EMPTY rest)
  and routes to the shared helper. Host/gc lane below is byte-identical.
- **destructuring-params.ts** (function-param rest): refactored its inline #3223
  native branch to call the shared helper (behavior-identical; the param source
  is already an open `$Object` externref, so no reification).
- **assignment.ts** (`({a,...rest} = obj)`): **deferred** to a follow-up slice —
  this path has two entangled sub-paths (an externref-RHS reader that never
  collects the rest, and a struct-RHS path where `resultType` can be externref
  while `structTypeIdx` names a struct), so a correct native route needs that
  untangling first. Its test262 cases are all `fail` for INDEPENDENT reasons
  (getter side-effects, computed keys, descriptor checks), so de-leaking flips
  nothing today; deferring avoids regressing shim-provided runs. It keeps the
  host import (leak), matching prior behaviour.

## Acceptance

- for-of/for-await object-rest instantiates host-free (empty imports `{}`) in
  standalone AND wasi.
- Correct own-enumerable copy semantics: excluded keys dropped, own getters
  invoked ([[Get]]), non-enumerable props skipped.
- Host/gc lane byte-identical (changes gated on `ctx.standalone || ctx.wasi`).
- Regression test: `tests/issue-3241-standalone-forof-obj-rest.test.ts` (6
  tests, all green). Existing `tests/issue-3222-standalone-closed-struct-enum`
  + destructuring/rest suites still green.

Flips the 9 `for-of/dstr` object-rest tests to host-free passes (the 9
`for-await` siblings were already host-free via #3223).

## Follow-up

- Assignment-target object-rest (`({a,...rest} = obj)`) standalone de-leak —
  needs the externref-RHS vs struct-RHS sub-path untangling. All-`fail` tests,
  no flip today; low priority.
