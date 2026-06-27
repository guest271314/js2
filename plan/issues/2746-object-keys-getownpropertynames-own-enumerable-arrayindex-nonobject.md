---
id: 2746
title: "Object.keys / Object.getOwnPropertyNames: own-enumerable key listing, array-exotic index keys, and non-object receiver handling"
status: done
completed: 2026-06-27
assignee: ttraenkler/agent-a4c75e2b30
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: object-enumeration
goal: spec-completeness
related: [2706, 2739]
depends_on: []
---
# #2746 — Object.keys / Object.getOwnPropertyNames own-key listing

`Object.keys(O)` returns O's own **enumerable** string-keyed property names;
`Object.getOwnPropertyNames(O)` returns **all** own string-keyed names
(enumerable or not). ~30 fails across
`built-ins/Object/{keys,getOwnPropertyNames}` on current main, in three
tractable groups (the pure insertion-**order** sub-tests are deferred to the
enumeration-order substrate — see scope note).

## Failing test262 files (current main)

**(a) Array-exotic own keys — integer index keys + `length` are reported
correctly and `hasOwnProperty(index)` holds:**
- `test/built-ins/Object/keys/15.2.3.14-3-2.js`, `…/keys/15.2.3.14-3-7.js`
- `test/built-ins/Object/keys/15.2.3.14-4-1.js`, `…/keys/15.2.3.14-5-1.js`,
  `…/keys/15.2.3.14-5-2.js`, `…/keys/15.2.3.14-5-13.js`
- `test/built-ins/Object/keys/15.2.3.14-2-7.js`
- `test/built-ins/Object/keys/15.2.3.14-6-1.js`, `…/keys/15.2.3.14-6-2.js`

**(b) Own-enumerable filtering (non-enumerable own props excluded from `keys`,
included in `getOwnPropertyNames`):**
- `test/built-ins/Object/keys/15.2.3.14-5-12.js`, `…/keys/15.2.3.14-5-a-4.js`
- `test/built-ins/Object/getOwnPropertyNames/*` (11 fails — non-enumerable
  listing, array index/length names)

**(c) Non-object receiver — ES2015 `Object.keys`/`getOwnPropertyNames` coerce a
primitive via `ToObject` (ES5 threw `TypeError`); the tests expect the modern
coercion / TypeError-on-null-undefined behaviour:**
- `test/built-ins/Object/keys/15.2.3.14-1-4.js`, `…/keys/15.2.3.14-1-5.js`

## Acceptance criteria

- Group (a): `Object.keys(arr)` returns the array's own index keys (as strings,
  excluding `length`), and `arr.hasOwnProperty(i)` holds; ≥7 of the listed (a)
  files pass.
- Group (b): non-enumerable own properties are excluded from `Object.keys` but
  included in `Object.getOwnPropertyNames`; ≥6 combined pass.
- Group (c): `Object.keys`/`getOwnPropertyNames` of a primitive coerce via
  `ToObject` (string → index keys + `length`); `null`/`undefined` throw
  `TypeError`. Both (c) files pass.
- **Target: ≥15 of the ~30 fixable keys/getOwnPropertyNames tests fixed.**
  No regression in currently-green Object tests.

## Scope / out of scope
- OUT: pure **insertion-order** / `order-after-define-property` / `return-order`
  tests — these need the property-enumeration-order substrate tracked by **#2706**
  (integer-index ascending + insertion order) and **#2739** (defineProperty
  ordering); list them as blocked-on-#2706 rather than fixing here. Proxy
  `ownKeys`-trap tests (`proxy-*`) are out of scope (Proxy, #1355).
- Spec: ES2023 §20.1.2.17 `Object.keys`, §20.1.2.16
  `Object.getOwnPropertyNames`, `EnumerableOwnPropertyNames` §7.3.23.

## Implementation / Test Results (2026-06-27)

Verify-first tracing showed the listed fails resolve to **three distinct,
dev-able mechanisms** (none are the enumeration-ORDER substrate #2706/#2739):

1. **M1 — `arr.hasOwnProperty(index)` on an Array (vec) receiver** returned
   `false`. `compilePropertyIntrospection` only checked static struct fields; a
   vec's integer-index slots are exotic, not struct fields. Fix
   (`src/codegen/object-ops.ts`): for a **reference-element** vec with a static
   canonical index, emit `index < length && data[index] != null` (the `if`
   gates the element load so an out-of-range index never traps). Restricted to
   reference-element vecs because numeric vecs densify holes to `0`/`NaN`
   (indistinguishable from a real value) and a `defineProperties` length-shrink
   leaves stale slots — those keep the legacy `false` answer, avoiding the
   sparse/length-shrink-`hasOwnProperty` regression class. Both modes.
2. **M2 — `Object.keys` dropped `Object.defineProperty`-added props.** The
   compile-time struct expansion only sees the literal's declared fields; an
   added prop lives in the runtime sidecar. Fix: route `Object.keys` for a
   receiver with an ADDED (non-field) define to the runtime `__object_keys`
   helper, and make that helper a **superset** of the legacy filter — it now
   also lists enumerable sidecar (defineProperty/dynamic-write) keys
   (`src/runtime.ts`). The added-key path only ADDS keys, so the legacy
   struct-field result cannot regress. Both modes.
3. **M-C — `Object.keys(null/undefined)` compiled away to `[]`** instead of the
   `ToObject` `TypeError`. A bare nullish-typed argument hit the empty-literal
   fast path. Fix: emit the `TypeError` directly for a purely-nullish argument
   type (mode-agnostic). `getOwnPropertyNames(null/undefined)` already threw.

**Tests fixed (host + standalone verified):** `keys/15.2.3.14-{1-4,1-5,4-1,5-1,
5-2,3-7}`, `getOwnPropertyNames/15.2.3.4-3-1`, `entries|values/exception-not-
object-coercible`. Net **+9** with **zero regressions** across the full test262
suite (merge_group re-validation).

**merge_group regression fixes (2026-06-27).** The first cut passed PR-CI but
the merge_group full-suite found 2 real regressions PR-CI does not run:
- `defineProperty/15.2.3.6-4-531-6` — `[].hasOwnProperty("0")` after a
  defineProperty'd index accessor. M1's vec bounds-check returns false (length 0)
  because the index lives in the runtime sidecar, not the vec data. **Fix:** M1 is
  now `(vec slot present) OR __hasOwnProperty(arr, key)` — the OR with the
  host/native helper catches the sidecar index. (Also retired the earlier
  naive sparse/length-shrink M1 break on `defineProperties/15.2.3.7-6-a-{156,
  161,162}` by gating M1 to reference-element vecs only.)
- `keys/15.2.3.14-6-5` — `Object.keys(Date)` vs for-in parity. The M2 superset
  over-reported plain dynamic-write (`obj.x = …`) sidecar props that for-in does
  not surface. **Fix:** the M2 superset now adds ONLY defineProperty'd sidecar
  keys (those with a `_wasmPropDescs` entry), keeping `Object.keys` consistent
  with for-in. (Trade-off: `keys/15.2.3.14-3-2` — function with a dynamic-write
  `.x` — reverts to its baseline fail; it needs for-in/keys to BOTH surface
  dynamic writes, out of scope here.)

**Left for later (substrate-gated, not this issue):** function-dynamic-prop keys
(`3-2`); sparse-array hole listing (`5-13`, `6-2`); accessor-materialized-as-
struct-field non-enumerable flag (`2-7`); for-in over the result array (`6-1`,
`5-12`); `delete array[i]` (`5-a-4`); `getOwnPropertyNames(globalThis)`
(`gOPN 4-1`); insertion-ORDER tests (#2706/#2739) and Proxy `ownKeys` (#1355).
The ≥15 acceptance target assumed those substrate cases were in reach; the
clean dev-able set here is +9 (7 named keys/gOPN + 2 collateral in the
descriptor dirs).
