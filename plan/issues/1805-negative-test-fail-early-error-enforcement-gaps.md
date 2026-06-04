---
id: 1805
title: "75 negative_test_fail: early-error enforcement gaps after #774/#927"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: parser, codegen
language_feature: early-errors, module-syntax, destructuring
goal: compiler-correctness
sprint: 59
related: [774, 927, 736]
---
# #1805 — 75 negative_test_fail: early-error enforcement gaps

## Symptom

75 default-lane test262 tests have `error_category: negative_test_fail`:
the test expected a parse/compile/runtime error but js2wasm compiled and
ran the program without throwing.

**Baseline**: sha `f692249d`, 2026-06-03T22:28Z.

Prior work (#774, #927) fixed the bulk of early-error enforcement and were
marked done (2026-04-14). These 75 are the residual unaddressed clusters.

## Breakdown by error type

| Expected error | Count | Description |
|----------------|-------|-------------|
| parse/early SyntaxError | ~60 | compiled+ran when it should be rejected |
| runtime ReferenceError | ~8 | succeeded when accessing unbound name |
| runtime TypeError | ~7 | succeeded when type violation expected |

## Sample test files

```
test/language/module-code/import-attributes/early-dup-attribute-key-import-nobinding.js
test/language/statements/for-of/dstr/obj-rest-not-last-element-invalid.js
test/language/module-code/instn-resolve-err-syntax-1.js
test/language/module-code/instn-resolve-err-syntax-2.js
test/language/expressions/import.meta/syntax/invalid-assignment-target-object-destructuring-expr.js
```

## Root cause clusters

1. **Import attributes early errors** (~10–15 tests): duplicate import attribute
   key should throw a SyntaxError at parse time
   (`import x from "y" with {type: "json", type: "json"}` — duplicate key).
   Our parser accepts this.

2. **Destructuring rest-not-last** (~5 tests): `{...rest, extra}` is a SyntaxError;
   our parser may accept it and produce wrong code.

3. **Module syntax errors** (~10 tests): module-code tests that expect
   resolution or static-analysis errors to propagate as SyntaxError; we may
   be swallowing them.

4. **Runtime ReferenceError cases** (~8 tests): TDZ (temporal dead zone)
   violations where the variable is accessed before its declaration;
   we're not tracking TDZ accurately.

5. **Misc. TypeError cases** (~7 tests): operations that should throw
   TypeError at runtime but we return a value.

## Fix approach

1. Run the 75 failing tests locally and inspect the first assertion.
2. Group by error category and fix the easiest cluster first (destructuring
   rest-not-last is likely purely in the parser).
3. Import-attributes dup-key: add an early-error check after parsing
   import attribute key-value pairs.
4. TDZ cases: audit TDZ tracking in declarations.ts.

## Acceptance criteria

- All 75 negative_test_fail records pass (expected error thrown).
- No regressions in other categories.
