---
id: 820k
title: "Object.* receiver TypeError on null/undefined (ToObject step) (~39 fails)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: builtins
language_feature: object-builtins
goal: async-model
sprint: Backlog
parent: 820
es_edition: ES2017
test262_fail: 39
---
# #820k — Object.* receiver ToObject TypeError

## Problem

~39 test262 failures across `built-ins/Object/*` where the entry point
fails to throw `TypeError` for null/undefined receivers (or non-object
arguments where the spec requires ToObject coercion). Currently we either
null-deref or silently coerce.

Coordinate with #1129 (ToObject §7.1.18) which closed the primitive
auto-boxing path; this is the entry-point Object.* receiver-validation
residual.

## Sample failing tests
- `test/built-ins/Object/S15.2.1.1_A2_T11.js`
- `test/built-ins/Object/entries/getter-removing-future-key.js`
- `test/built-ins/Object/S15.2.1.1_A1_T1.js`

## Suspected source

- `src/codegen/builtins/object.ts` — entry points for `Object.entries`,
  `Object.keys`, `Object.values`, `Object.assign`, etc. — missing
  RequireObjectCoercible step before ToObject.

## Spec reference

- ECMAScript §7.1.18 ToObject
- §7.2.1 RequireObjectCoercible
- §20.1 Object Constructor (per-method receiver validation)

## Acceptance criteria

- [ ] At least 30 of the ~39 tests flip to `pass`.
- [ ] Object.* throws `TypeError` (not `null deref`) on null/undefined
      receiver/argument where spec requires.
- [ ] No regressions in already-passing Object.* tests.

## Notes

- Likely a small, mechanical fix once #1129 lands. Consider sequencing
  after #1129.

## Resolution 2026-05-27 (dev-1606)

#1129 (auto-boxing) already landed. The residual was in `src/runtime.ts`: the
host-import handlers `__object_keys`, `__object_values`, `__object_entries`, and
`__getOwnPropertyNames` started with `if (obj == null) return [];` — silently
returning an empty array instead of throwing TypeError. Per ES §20.1.2.{5,10,18,22}
these perform ToObject (§7.1.18) which throws on null/undefined.

**Fix:** replaced the four `return [];` early-returns with
`throw new TypeError("Cannot convert null/undefined to object")`.

Verified safe (no regressions):
- `Object.assign(null)` already threw (delegates to native Object.assign).
- `Object.getOwnPropertySymbols(null)` already threw (delegates to native fn).
- `Object.freeze/seal/preventExtensions(undefined)` correctly pass through the
  arg unchanged (ES2015+ non-object passthrough) — left untouched.
- Object spread `{...null}` routes through `__object_assign` (null-tolerant),
  NOT the keys/getOwnPropertyNames handlers — unaffected.
- `__getOwnPropertyNames` has a single codegen caller (`Object.getOwnPropertyNames`),
  so the throw can't break internal enumeration.

Tests: `tests/issue-820k.test.ts` (12 cases, all pass) — keys/values/entries/
getOwnPropertyNames × null/undefined throw TypeError, plus positive cases
(real object enumeration, string auto-box, freeze passthrough).
