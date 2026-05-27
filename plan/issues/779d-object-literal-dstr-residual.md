---
id: 779d
title: "Object-literal destructuring (non-class, non-for-of) residuals (~132 fails)"
status: in-review
created: 2026-05-21
updated: 2026-05-21
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-destructuring
goal: property-model
sprint: 56
parent: 779
es_edition: ES2018
test262_fail: 132
---
# #779d — Object-literal destructuring residuals

## Problem

~132 test262 `assertion_fail` failures under
`language/expressions/object/dstr/*`. These are destructuring patterns inside
plain object literals (not class methods, not for-of headers). The methods
inside object literals (e.g. `{ async *m([x, y, ...rest]) {} }`) compile and
run but bind wrong values.

This pattern is the object-literal analogue of #779a; it slips through the
class-only paths fixed by #1543/#1544 and the for-of paths fixed by
#1396/#1454/#1468.

## Sample failing tests
- `test/language/expressions/object/dstr/async-gen-meth-ary-ptrn-elem-id-iter-step-err.js`
- `test/language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-ary-empty.js`
- `test/language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-obj-prop-id.js`

## Suspected source

- `src/codegen/literals.ts` — object-literal property emission for
  method/gen/async-gen property values. Binding-element params on these
  method values do not route through the destructuring helper.
- `src/codegen/destructuring-params.ts` — likely needs to be invoked from
  the object-literal method-value emission path.

## Spec reference

- ECMAScript §13.2.5 Object Initializer (PropertyDefinitionEvaluation for
  MethodDefinition)
- §14.1.18 IteratorBindingInitialization

## Investigation (2026-05-27, dev)

Baseline JSONL (2026-05-22, commit 1f5208c8) marked 155 `object/dstr` tests
non-pass. Re-ran all 154 in **process isolation** (the compiler is not safe to
call repeatedly in one process — accumulates global module state, so in-loop
sweeps are invalid) against current main:

- **6 now pass** (fixed since baseline by #1542/#1543/#1544/#1550/#1553x/#1151-GapB)
- **146 still fail**: 112 runtime FAIL + 34 compile_error

The 146 residuals are **NOT one bug** — they split across several root causes,
many already owned by other in-flight issues:

1. **`assert#2` cluster (~40)** — `method([[,] = g()])` style: inner array
   elision/rest **over-consumes the iterator**. This is **#1592**
   (already ESCALATED-NEEDS-SPEC, task #100). Not unique to #779d.
2. **`Cannot destructure 'null'/'undefined'` (~14)** — array elision/empty/
   exhausted patterns throw when they should bind `undefined`. Overlaps #1592.
3. **invalid-wasm `obj-ptrn-*-init-throws / -init-skipped` (~14)** — UNIQUE to
   #779d. Root cause confirmed below.
4. **`assert#4`/`assert#6` (fn-name, rest)** — later-assertion mismatches.
5. **CE noise (~25)** — TS-checker diagnostics on the wrapped *JS* harness
   (`Argument of type '{}' is not assignable to '[any]'`, `Cannot find name 's'`,
   Proxy types). These are wrapper/`allowJs` artifacts, not codegen bugs the
   real sharded runner necessarily hits the same way.

### Confirmed unique root cause (cluster 3)

`meth-obj-ptrn-id-init-throws.js`: `method({ x = thrower() })` where
`function thrower(){ throw … }` is declared **after** the object literal.
Emits invalid wasm: `not enough arguments on the stack for call (need 2, got 0)`.

WAT of `__anon_0_method` default-fires branch (via
`emitDefaultValueCheck` f64 path, `src/codegen/statements/destructuring.ts:365`)
shows the default initializer `thrower()` compiled to **`call 18`**
(= `__anon_0_method`, the enclosing method **itself**) instead of **`call 19`**
(= `$thrower`) — an **off-by-one funcIdx**, plus two stray `ref.null extern`
left on the stack. Index map: imports 0-10; defined fns start at 11; 17=`test`,
18=`__anon_0_method`, 19=`thrower`.

This is the **late-import / addUnionImports funcIdx-shift hazard** (CLAUDE.md
"addUnionImports" section): compiling the binding default inside the
object-literal method body adds late imports (`__extern_get`,
`__extern_is_undefined`) which shift function indices, but a forward call
reference resolved against pre-shift indices (or `thrower`'s funcMap entry not
shifted).

**Minimal repros do NOT reproduce it** — `method({ x = thrower() })` with
thrower before/after the literal, and `{ x = 42 }`, all instantiate fine in
isolation. The off-by-one only manifests with the FULL test262 harness present
(Test262Error struct + 5 assert helpers + closures), i.e. once enough
functions/late-imports exist for the shift to mis-align a forward call. This
confirms the defect is in the shared late-import index-shift machinery, not in
the destructure helper's local logic — a fragile, broadly-shared area (also
touched by #1529). Recommend senior-dev ownership for the shift fix.

### Recommendation

#779d as scoped (~132 obj-literal dstr) is **not a single fix** — it's an
umbrella overlapping #1592 (escalated), #1529, #820c. Suggest: (a) split out
the unique funcIdx-shift bug (cluster 3, ~14 tests) as its own narrow fix, and
(b) fold the rest into the existing #1592 / #779 umbrella tracking rather than
re-fixing here. Awaiting tech-lead direction on scope before implementing.

## Acceptance criteria

- [ ] At least 100 of the ~132 tests flip to `pass`.
- [ ] No regressions in passing `language/expressions/object/dstr` tests.
- [ ] Fix is symmetric with #779a (class-method) — same helper, same call
      site shape.
