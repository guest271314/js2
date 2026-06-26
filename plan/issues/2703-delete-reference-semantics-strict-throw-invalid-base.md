---
id: 2703
title: "delete reference semantics: strict-mode TypeError throws, null/undefined base TypeError, super-property ReferenceError"
status: done
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: ES5
language_feature: delete
task_type: bug
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
assignee: ttraenkler/dev1
---

## Resolution (2026-06-26)

The **throw semantics** that name this issue — strict-mode TypeError, null/
undefined base TypeError, super-property ReferenceError — are implemented in
`src/codegen/typeof-delete.ts` (ECMA-262 §13.5.1.2). 14 of the 28 listed tests
now pass; the delete category moved 41 → 55 with **0 regressions** (verified
against the test262 baseline, incl. `built-ins/Object/defineProperty/`).

**Fixed (throw cases):**
- super: `super-property.js`, `super-property-method.js`,
  `super-property-null-base.js`, `super-property-uninitialized-this.js`
- null/undefined base: `member-computed-reference-null.js`,
  `member-identifier-reference-null.js`,
  `member-computed-reference-undefined.js`,
  `member-identifier-reference-undefined.js`,
  `delete-unresolvable-base-object-reference-throws-typeerror.js`
- strict non-configurable: `11.4.1-4.a-9-s.js`, `11.4.4-4.a-3-s.js`,
  `11.4.1-4-a-1-s.js`, `11.4.1-4.a-3-s.js`, `11.4.1-4.a-8-s.js`

Also makes the struct-field clobber conditional on a *successful* delete, so a
refused non-configurable delete leaves the field value intact (latent sloppy
bug, e.g. `11.4.1-4-a-1-s`'s `obj.prop === 'abc'` post-throw assert).

**Deferred to #2726** (non-throw concerns, each a distinct subsystem):
sloppy unresolvable-identifier → true; sloppy global-object model
(`delete this.y`, implicit globals, ReferenceError-after-delete); hasOwnProperty
false after a configurable defineProperty delete; non-configurable accessor
descriptor; mapped-arguments delete; preventExtensions; prototype-chain read.
---
# #2703 — delete reference semantics: strict-mode throws, null base, super property

## Problem

The `delete` operator has multiple gaps in its throw-on-error semantics vs ECMAScript §13.5.1:

**(a) Strict mode: deleting a non-configurable property or an unqualified identifier must throw TypeError.** Tests like `11.4.1-4.a-9-s.js`, `11.4.4-4.a-3-s.js`, `11.4.1-4-a-4-s.js`, `delete Math.LN2` (non-configurable) — we return `false` instead of throwing.

**(b) `delete base.x` / `delete base[k]` where base is null or undefined must throw TypeError.** `member-computed-reference-null.js`, `member-identifier-reference-null.js`, `member-computed-reference-undefined.js`, `member-identifier-reference-undefined.js`, `delete-unresolvable-base-object-reference-throws-typeerror.js` all assert a TypeError we currently skip.

**(c) `delete super.prop` must throw ReferenceError.** `super-property.js`, `super-property-method.js`, `super-property-null-base.js`, `super-property-uninitialized-this.js` — deleting a super property is always a ReferenceError per spec §13.5.1 step 5.f.i.

**(d) Sloppy-mode: `delete x` of a `var`/function-level variable returns false; `delete` of a deletable global returns true.** `S11.4.1_A2.2_T1.js` (delete x === true for a deletable global), `S11.4.1_A3.1.js` (delete this.y === false), `S11.4.1_A3.2_T1.js`, `S11.4.1_A3.3_T1.js`, `S11.4.1_A3.3_T6.js`, `11.4.1-3-1.js`, `11.4.1-4.a-1.js`, `11.4.1-4.a-2.js`, `11.4.1-4.a-8.js`, `11.4.1-4.a-17.js`, `S8.12.7_A2_T2.js`.

Spec: ECMAScript §13.5.1 — The `delete` Operator; §7.2.9 OrdinaryDelete; §9.1.10 ordinary [[Delete]].

Note: #124 is `wont-fix` (old/superseded); #1112 (undefined-sentinel happy path for `delete`) is done — this issue targets the throw/edge semantics layered on top of that foundation.

## Failing tests (test262 baseline 2026-06-26)

```
test/language/expressions/delete/S11.4.1_A3.1.js
test/language/expressions/delete/11.4.1-4.a-9-s.js
test/language/expressions/delete/super-property-null-base.js
test/language/expressions/delete/super-property-method.js
test/language/expressions/delete/11.4.1-4-a-4-s.js
test/language/expressions/delete/S11.4.1_A3.2_T1.js
test/language/expressions/delete/11.4.1-4.a-2.js
test/language/expressions/delete/member-computed-reference-null.js
test/language/expressions/delete/member-identifier-reference-undefined.js
test/language/expressions/delete/11.4.1-4-a-2-s.js
test/language/expressions/delete/S11.4.1_A3.3_T1.js
test/language/expressions/delete/11.4.4-4.a-3-s.js
test/language/expressions/delete/S11.4.1_A2.2_T1.js
test/language/expressions/delete/member-identifier-reference-null.js
test/language/expressions/delete/S8.12.7_A2_T2.js
test/language/expressions/delete/S11.4.1_A3.3_T6.js
test/language/expressions/delete/11.4.1-4.a-8.js
test/language/expressions/delete/11.4.1-4.a-3-s.js
test/language/expressions/delete/delete-unresolvable-base-object-reference-throws-typeerror.js
test/language/expressions/delete/11.4.1-4.a-17.js
test/language/expressions/delete/11.4.1-4-a-1-s.js
test/language/expressions/delete/11.4.1-4.a-8-s.js
test/language/expressions/delete/11.4.1-3-1.js
test/language/expressions/delete/11.4.1-5-a-27-s.js
test/language/expressions/delete/11.4.1-4.a-1.js
test/language/expressions/delete/super-property.js
test/language/expressions/delete/member-computed-reference-undefined.js
test/language/expressions/delete/super-property-uninitialized-this.js
```

### Sub-groups

**Strict-mode non-configurable property TypeError (~10 tests)**
- `11.4.1-4.a-9-s.js`, `11.4.1-4-a-4-s.js`, `11.4.1-4-a-2-s.js`, `11.4.1-4.a-3-s.js`, `11.4.1-4-a-1-s.js`, `11.4.1-4.a-8-s.js`, `11.4.4-4.a-3-s.js`, `11.4.1-5-a-27-s.js`

**Null/undefined base TypeError (~4 tests)**
- `member-computed-reference-null.js`, `member-identifier-reference-null.js`
- `member-computed-reference-undefined.js`, `member-identifier-reference-undefined.js`
- `delete-unresolvable-base-object-reference-throws-typeerror.js`

**super property ReferenceError (~4 tests)**
- `super-property.js`, `super-property-method.js`, `super-property-null-base.js`, `super-property-uninitialized-this.js`

**Sloppy-mode return value semantics (~10 tests)**
- `S11.4.1_A2.2_T1.js`, `S11.4.1_A3.1.js`, `S11.4.1_A3.2_T1.js`, `S11.4.1_A3.3_T1.js`, `S11.4.1_A3.3_T6.js`
- `11.4.1-3-1.js`, `11.4.1-4.a-1.js`, `11.4.1-4.a-2.js`, `11.4.1-4.a-8.js`, `11.4.1-4.a-17.js`, `S8.12.7_A2_T2.js`

## Root cause (suspected)

The `delete` codegen in `src/codegen/expressions.ts` (UnaryExpression `delete`) handles the basic "delete configurable own property" case but:
1. Does not check strict mode before returning `false` for non-configurable deletes — should throw TypeError instead.
2. Does not guard against null/undefined base before doing a property lookup — null-deref.
3. Does not reject `super` property delete — needs a compile-time or runtime ReferenceError path.
4. Sloppy-mode `delete varIdentifier` return value may be wrong (always returning `true`/`false` without checking environment record configurability).

## Acceptance criteria

All 28 listed tests flip from fail to pass. No regression in `expressions/delete/` (currently-passing tests stay green). Full CI green.

## Notes

- Strict-mode detection: the codegen already has access to `ctx.isStrict` or similar — use it to switch behavior at the delete site.
- Super-property: can be caught at compile time (the AST `delete super.x` node is identifiable) and lowered to an unconditional `throw new ReferenceError(...)`.
- Sloppy-mode global-delete requires access to the property descriptor of the global object — may need a host import or a __has_own_configurable runtime helper.
