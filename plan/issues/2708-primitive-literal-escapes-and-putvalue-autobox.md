---
id: 2708
title: "primitive & literal edge cases: legacy string escapes \\8/\\9/octal, regexp \\u atoms, PutValue primitive-base auto-box"
status: ready
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: multi
language_feature: primitives
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2708 — primitive/literal: legacy escapes, regexp \\u, PutValue primitive-base auto-box

## Problem

Three sub-bugs in primitive and literal handling:

**(a) Legacy string escape sequences `\8`, `\9`, and octal escapes in non-strict mode.** ECMAScript Annex B §12.9.4 / B.1.2: in sloppy (non-strict) mode, `\8` and `\9` are "LegacyNonOctal" escapes that decode as the literal digit character. `\nnn` octal escapes (`\0` through `\7` variants) are also permitted. We currently reject both with `"Escape sequence '\#' is not allowed"` (for `\8`/`\9`) and `"Octal escape sequences are not allowed"` (for legacy octals).

**(b) Regexp literal `\u` atom escapes (non-`u` flag).** Without the `u` flag, `\uXXXX` in a regexp should be treated as a Unicode escape that matches that code point (ES5 compatible). `S7.8.5_A1.1_T1.js` (`/A/` — fails to match `A`), `S7.8.5_A2.1_T1.js` (`/aA/` — fails to match `aA`), `u-surrogate-pairs-atom-escape-decimal.js` (surrogate pair decimal escape in atom position). These compile/execute but produce wrong match results.

**(c) PutValue with a primitive base auto-boxes via ToObject then silently drops the write (no throw in sloppy mode).** Per §13.15.2 PutValue step 6.b: if the base reference has a primitive value, call `ToObject(base)` and then set the property on the transient object — the assignment is a no-op (the transient object is discarded). In strict mode, step 6.a throws a TypeError. Tests `put-value-prop-base-primitive.js`, `put-value-prop-base-primitive-realm.js`, `get-value-prop-base-primitive.js`, `get-value-prop-base-primitive-realm.js`, `S8.6_A2_T2.js`, `S8.6_A3_T2.js`, `S8.6.2_A5_T1.js`–`T4.js`, `8.7.2-3-s.js`, `8.7.2-5-s.js` — these test that reading properties of primitives (auto-boxed via ToObject) works and that writing to them silently succeeds in sloppy mode (or throws in strict).

**Note on deferred tests:** `mongolian-vowel-separator-eval.js` uses `eval()` → deferred. `named-groups/invalid-lone-surrogate-groupname.js` → may require regexp named-group work.

Spec: §12.9.4 (String literals, legacy escapes), §13.15.2 PutValue, §7.1.18 ToObject (auto-boxing).

## Failing tests (test262 baseline 2026-06-26)

### (a) Legacy string escapes (~3 tests)

```
test/language/literals/string/legacy-non-octal-escape-sequence-8-non-strict.js
test/language/literals/string/legacy-non-octal-escape-sequence-9-non-strict.js
test/language/literals/string/legacy-octal-escape-sequence.js
```

### (b) Regexp \\u atom escapes (~3 tests)

```
test/language/literals/regexp/S7.8.5_A1.1_T1.js
test/language/literals/regexp/S7.8.5_A2.1_T1.js
test/language/literals/regexp/u-surrogate-pairs-atom-escape-decimal.js
```

### (c) PutValue / GetValue on primitive base (~14 tests)

```
test/language/types/reference/put-value-prop-base-primitive.js
test/language/types/reference/put-value-prop-base-primitive-realm.js
test/language/types/reference/get-value-prop-base-primitive.js
test/language/types/reference/get-value-prop-base-primitive-realm.js
test/language/types/object/S8.6_A2_T2.js
test/language/types/object/S8.6_A3_T2.js
test/language/types/object/S8.6.2_A5_T1.js
test/language/types/object/S8.6.2_A5_T2.js
test/language/types/object/S8.6.2_A5_T3.js
test/language/types/object/S8.6.2_A5_T4.js
test/language/types/reference/8.7.2-3-s.js
test/language/types/reference/8.7.2-5-s.js
test/language/types/reference/8.7.2-1-s.js
test/language/types/reference/8.7.2-7-s.js
test/language/types/reference/8.7.2-3-a-1gs.js
```

### Additional in cluster (confirm root cause before including)

```
test/language/types/object/S8.6_A4_T1.js
test/language/types/object/S8.6.2_A1.js
test/language/types/object/S8.6.2_A8.js
test/language/types/reference/S8.7_A5_T1.js
test/language/types/reference/S8.7_A5_T2.js
test/language/types/reference/S8.7.2_A3.js
test/language/types/undefined/S8.1_A5.js
test/language/types/undefined/S8.1_A2_T2.js
test/language/literals/numeric/7.8.3-3gs.js
```

## Root cause (suspected)

**(a)** The TypeScript parser rejects `\8`, `\9` and octal sequences in string literals unconditionally. The fix: when `ctx.isStrict === false`, allow legacy non-octal escapes (`\8`, `\9` → the digit) and octal escapes (`\0nn` → codepoint). The restriction should only be enforced in strict mode.

**(b)** The regexp compiler (`src/codegen/` regexp path) may be treating `\uXXXX` in the absence of the `u` flag differently from a spec-compliant Unicode escape. In non-`u` mode the `\u` atom escape should decode to a single character via `String.fromCharCode`. If we are passing the pattern verbatim to a JS `RegExp` constructor, this may already work; if we are compiling the regexp ourselves, verify the `\u` handling.

**(c)** Member expression assignment (left-hand side) in codegen: when the base is a primitive (string, number, boolean), the spec calls for ToObject boxing. In sloppy mode the transient object is silently discarded; in strict mode a TypeError is thrown. We likely crash with a null-deref or misrouted type cast when attempting to write to a primitive base. The fix: detect primitive base in MemberExpression assignment, create a transient ToObject for the set, then discard in sloppy mode / throw in strict.

## Acceptance criteria

At least 18 of the 32 listed tests flip from fail to pass (3 string escape + 3 regexp + at least 12 of the PutValue/reference tests). No regression in `literals/` or `types/reference/`. Full CI green.

## Notes

- Sub-bugs (a), (b), (c) are independent enough that a dev may tackle them in separate commits within the same PR, or split into sub-PRs if the scope grows.
- `mongolian-vowel-separator-eval.js` is excluded (eval-deferred).
- `named-groups/invalid-lone-surrogate-groupname.js` — investigate; if it requires named-group regexp work beyond unicode escapes, exclude from this issue.
- `S8.6.2_A8.js` ("Prototype of non-extensible object mutated") and `S8.1_A5.js` (stack overflow) may have distinct root causes — confirm before including in the fix count.
