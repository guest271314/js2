---
id: 1680b
title: "Private getter/method read missing PrivateBrandCheck — TypeError not thrown for non-brand receiver"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: class, class-methods-private, private-accessors
goal: spec-completeness
sprint: Backlog
related: [1680, 1365, 1456]
---
# #1680b — Private getter/method read missing PrivateBrandCheck

## Problem

Out-of-scope cluster carved from #1680. Reading `o.#m` where `#m` is a
private **getter** (`get #m()`) or **method** (`#m() {}`) and `o` lacks the
declaring class's brand did NOT throw the spec-mandated TypeError — it
silently returned a wrong/undefined value.

Per ECMA-262 §sec-privatefieldget (PrivateFieldGet step 4, PrivateBrandCheck):
when reading `o.#m`, if `O.[[PrivateBrands]]` does not contain the declaring
class's brand, throw a TypeError.

The prior #1365 brand check only covered struct-backed private **fields**:
its `ctx.structFields` lookup returns `fieldIdx < 0` for getters/methods
(they live in `classAccessorSet` / `classMethodSet`, not `structFields`), so
the check was skipped and the generic getter dispatch ran with a wrong-brand
receiver.

Probe (`get #m()` accessor, receiver `{}`):
```ts
class C { get #m(): string { return "ok"; } access(o: any): string { return o.#m; } }
// c.access({}) returned 0 (no throw) — should throw TypeError
```

## test262 cases (read path)

- `language/statements/class/elements/private-getter-brand-check.js`
- `language/statements/class/elements/private-method-brand-check.js`
- `*-brand-check-super-class.js` variants

The `private-setter-brand-check.js` (`o.#m = v` write path) is NOT covered
here — that is the assignment path tracked by #1680.

## Fix (done 2026-05-27)

`src/codegen/property-access.ts` `compilePropertyAccess` — extended the
#1365 brand-check block. After the field path (which only fires for
`fieldIdx >= 0`), added a fallback using `classifyPrivateMember` (from
`expressions/helpers.ts`). For `method` / `accessor` / `accessor-readonly`
kinds (and a non-`this` receiver), emit the same `ref.test` brand guard
against the declaring class struct:

- success → `ref.cast` + call the `<Class>_get_<__priv_name>` getter
  (accessor) or `extern.convert_any` the cast receiver (method-as-value);
- failure → `emitThrowTypeError` (real `TypeError` instance via
  `__new_TypeError`, so `e instanceof TypeError` passes).

The throw branch is emitted FIRST so any late imports it registers settle
their funcMap-index shifts before the getter funcIdx is read (the field path
is immune because it only emits `struct.get`). The `this`-receiver case is
skipped — TS guarantees the brand structurally, matching the existing
static `this.#x` path.

Scope: read path only. The `o.#m()` method-CALL path is in calls.ts (not
this read path) and was left untouched; the private setter WRITE path is
#1680.

## Test Results

`tests/issue-1680-brand.test.ts` — 3/3 pass:
- private getter read on same-brand receiver returns the value
- private getter read on a non-brand receiver throws `TypeError`
- private field read brand check (regression of #1365) still throws

Regression: `tests/class-static-private-this.test.ts` 3/3 still pass
(this-receiver path unaffected). `tests/classes.test.ts` failures are a
pre-existing empty-`env:{}` harness limitation (no `string_constants`
import), reproduced identically without this change.
