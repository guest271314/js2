---
id: 2746
title: "Object.keys / Object.getOwnPropertyNames: own-enumerable key listing, array-exotic index keys, and non-object receiver handling"
status: in-progress
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
