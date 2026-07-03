---
id: 2756
title: "Array-pattern element with an object-literal / class-expression default value null-derefs (the fn-name-class dstr cluster)"
status: done
assignee: ttraenkler/sd-dstr-objdefault
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
parent: 2669
related: [2669, 2203, 2032]
sprint: 69
---

# #2756 — array-pattern element with object/class default value null-derefs

Carved from the #2669 destructuring umbrella (sd-dstr-objdefault, 2026-06-28).
The single largest **clean** (non-#2566, non-#2662, non-generator-source)
residual cluster.

## Repro (verified on current `origin/main` @ #2201, fresh single-file)

```ts
// TRAP: dereferencing a null pointer  (want c.a === 1)
let [c = { a: 1 }] = [];
// TRAP even when the element IS present (member read returns null)
let [c = { a: 1 }] = [{ a: 9 }]; // c.a => null
// the test262 `fn-name-class` template — null-derefs at the dstr line
let [cls = class {}] = []; // want cls.name === 'cls'
// partial source, absent element with object default — TRAP
let [a, c = { x: 9 }] = [1]; // dereferencing a null pointer
```

Contrast — these all **work** today, isolating the bug to _array-pattern +
object/class default value_:

| case                                                        | result |
| ----------------------------------------------------------- | ------ |
| `let [a = 5] = [] as number[]` (numeric default)            | 5 ✓    |
| `let [c = [1,2]] = []` (**array-literal** default)          | 2 ✓    |
| `let [{a} = {a:5}] = []` (object **sub-pattern** default)   | 5 ✓    |
| `let {c = {a:1}} = {}` (**object**-pattern, object default) | 1 ✓    |
| `let [c = {a:1}] = [] as any[]` (source widened to `any[]`) | 1 ✓    |

So the trigger is: an **array binding/assignment pattern**, a **SingleNameBinding
identifier element** (not a sub-pattern), whose **default initializer evaluates to
a heap value** (object literal, class expression, arrow/closure object), where the
destructured source vec has a **narrow element type** (`never[]` from `[]`, or a
numeric/typed vec). The default branch coerces the heap (struct/externref) default
_through the vec's narrow element fieldType/targetType_ → produces a null →
later member access / `.name` read derefs null.

## Why it matters / scale

This is the `*-init-fn-name-class` test262 family plus the object-literal-default
array cases. **~180** `fn-name-class` failures across all wrapper contexts
(function / generator / async-generator / class-method / for-of / for-await), plus
the object-literal-default subset. The wrapper context is irrelevant — the matched
sweep confirms the **identical** failure across function/generator/async-gen/method
(the value codegen is shared), so one core fix in the dstr lowering recovers the
whole family. Est net recovery: **~120–180**.

NOTE on `fn-name-class`: these also assert NamedEvaluation
(`cls.name === 'cls'`). The **function** variant (`fn-name-fn`) already passes —
NamedEvaluation is implemented for functions-as-default. Verify whether fixing the
class/object null-deref lets the existing NamedEvaluation cover anonymous classes
too; if not, extend NamedEvaluation to assign the binding identifier name to an
anonymous class/arrow default (a small, contained add).

## Root-cause pointer

- `src/codegen/statements/destructuring.ts`
  - `emitDefaultValueCheck` (L553) — the default arm
    (`emitDefaultIntoLocal`, L570) compiles the initializer with `hintType =
targetType ?? fieldType` and coerces `initType → localType`. For a `never[]` /
    numeric vec the `fieldType`/`hintType` is wrong for a heap default → the heap
    struct is coerced to a scalar/never and lost.
  - `emitNestedBindingDefault` (L453) and the array element loop — confirm the
    `localType` used for an identifier element with an object/class default is the
    **default value's** representation (boxed-any / externref), not the vec's
    narrow element type.
  - The vec element-read for an out-of-bounds (absent) slot returns null; the
    default must be produced **without** routing through the narrow `fieldType`.
- Cross-check the analogous param path `src/codegen/destructuring-params.ts` and
  the for-of/for-await loop path `src/codegen/statements/loops.ts` so the fix
  propagates (the umbrella's prior slice touched these too).

## Acceptance criteria

- `let [c = {a:1}] = []` ⇒ `c.a === 1`; `let [c = {a:1}] = [{a:9}]` ⇒ `c.a === 9`.
- `let [cls = class {}] = []` ⇒ `cls.name === 'cls'` (NamedEvaluation) and no trap.
- `let [a, c = {x:9}] = [1]` ⇒ `a===1, c.x===9`.
- The `fn-name-class` test262 family flips fail→pass across all wrapper contexts.
- No regression in the currently-passing numeric/array-literal/object-pattern
  default cases (table above) or in the closure-box (#2692) / iterator
  (#1642) buckets.
- Guard test `tests/issue-2756.test.ts`.

## Validation

Broad-impact dstr change → validate on the full `merge_group` floor (not a scoped
sweep): paired baseline-vs-branch per-test diff, net positive with zero
unexplained regression. Targeted fresh-single-file probes for every row of the
table above plus the `fn-name-class` samples.

## Slice landed (sd-dstr-objdefault, 2026-06-28)

Two codegen fixes:

1. **`src/codegen/destructuring-params.ts`** — tuple-struct path (the path an
   empty/short array literal takes: `[]` of element-type `{a}` lowers to a 1-tuple
   `$__tuple_0 { _0: (ref null 8) }` with a null `_0`). An identifier element with
   a default whose field is a `ref`/`ref_null` now routes through
   `emitDefaultValueCheck` instead of `coerce(field→local); local.set;
emitNestedBindingDefault`. The old path coerced the raw field up front, and for
   a `ref_null`→`ref` (non-null) local that coercion is a `ref.as_non_null` that
   **TRAPPED on the wasm-null (absent) slot before the default could fire**
   (`let [c = {a:1}] = []` → "dereferencing a null pointer"). `emitDefaultValueCheck`
   tees the field, checks `ref.is_null`, applies the default in the missing arm,
   and coerces to the local ONLY in the value-present arm. Non-ref fields keep the
   prior path (f64 sentinel / numeric / array-literal defaults were already safe).
2. **`src/codegen/property-access.ts`** — NamedEvaluation `.name` synthesis now
   skips a class expression that declares its own `static name` member (or is a
   named class) via the new `classExpressionDefinesOwnName` guard, at both
   synthesis sites. §15.7.14 ClassDefinitionEvaluation defines static members
   AFTER `SetFunctionName`, so the static `name` overrides the binding name — the
   test262 template's `xCls2 = class { static name() {} }` asserts
   `xCls2.name !== 'xCls2'`.

**Validation:** `tests/issue-2756.test.ts` 10/10. The `fn-name-class` family flips
fail→pass across `let`/`const`/`var`/function/method/gen-meth/async-gen-meth/
object-meth/class-meth/arrow/for-await contexts (verified fresh single-file).
Regression: 18/18 baseline-passing dstr default tests still pass; prior guards
`issue-2669` (10/10) + `issue-2203` (11/11) green; non-dstr `.name` reads (named
fn/class, anon, arrow, static-name) all correct; tsc clean.

**Residual (NOT this slice):**

- **3 assignment-context** `fn-name-class` (`expressions/assignment/dstr/`) — the
  assignment-destructuring path is separate (→ #2757 domain).
- **for-of `array-elem-init-fn-name-class`** uses `verifyProperty(cls,'name',{...})`
  — needs a real property descriptor on the synthesized `.name`
  (enumerable/writable/configurable), a separate `.name`-descriptor modeling gap.
