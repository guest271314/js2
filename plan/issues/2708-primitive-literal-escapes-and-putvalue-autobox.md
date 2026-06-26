---
id: 2708
title: "primitive & literal edge cases: legacy string escapes \\8/\\9/octal, regexp \\u atoms, PutValue primitive-base auto-box"
status: done
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
completed: 2026-06-26
assignee: ttraenkler/dev1
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

## Resolution (2026-06-26, dev1)

Sub-bugs (a) and (b) are fixed. Sub-bug (c) was verified **out of scope** for
this issue — its tests require large, unrelated features.

### (a) Legacy string escapes — FIXED (+3)

The TS scanner reports `\8`/`\9` as code **1488** and legacy octal (`\251`) as
code **1487**, but TS *already decodes the text correctly* (`'\8'.text === "8"`,
`'\251'.text === "©"`). The fix mirrors the existing numeric-octal treatment
(1121/1489):

- `src/compiler/import-manifest.ts` — add 1487/1488 to `DOWNGRADE_DIAG_CODES`
  (TS error → warning, so sloppy code compiles).
- `src/compiler.ts` — add 1487/1488 to `TOLERATED_SYNTAX_CODES` (so they don't
  trip the `hasSyntaxErrors` gate).
- `src/compiler/early-errors/node-checks.ts` — re-raise a hard early error for a
  legacy escape inside a string literal **when `isStrictMode(node)`**, so the
  strict-mode negative tests still reject (`hasLegacyStringEscape` helper detects
  `\1`–`\9` and `\0`+digit while skipping the lone `\0` NUL and escaped `\\`).

Flips: `legacy-non-octal-escape-sequence-{8,9}-non-strict.js`,
`legacy-octal-escape-sequence.js`. The 7 strict negative counterparts continue
to pass; full `language/literals/string` dir = 73/73.

### (b) Regexp `\u` atom escapes — FIXED (+2)

Root cause was in the **test harness**, not the compiler: the compiler returns
`/A/.source === "\\u0041"` and matches `"A"` correctly. The test262 runner's
`resolveUnicodeEscapes` (tests/test262-runner.ts) only skipped *string* literals,
so it rewrote the `A` inside the regexp literal to `A`, corrupting
`/A/` → `/A/` and breaking `.source`. Rewrote it as a small tokenizer that
also copies regexp literals, line/block comments through verbatim (with a
standard regex-vs-division heuristic). Verified behaviour-preserving: across all
11,036 `language/expressions` tests the old and new functions produce *identical*
output; the only files whose output changes are regexp-literals-containing-`\u`.

Flips: `S7.8.5_A1.1_T1.js`, `S7.8.5_A2.1_T1.js`.
`u-surrogate-pairs-atom-escape-decimal.js` (surrogate-pair backreference matching
under the `u` flag) and `mongolian-vowel-separator-eval.js` (eval) remain failing
— both out of scope.

### (c) PutValue / GetValue on primitive base — OUT OF SCOPE (deferred)

Ground-truthed all 26 (c)-cluster tests through the runner. None are a clean
"write-to-primitive-base auto-box" fix; each needs a large unrelated feature the
compiler does not have:

- `put/get-value-prop-base-primitive[-realm]` — require **Proxy** + `Object.setPrototypeOf(Number.prototype, …)` (+ `realm`/**eval**).
- `S8.6.2_A5_T1`–`T4` — depend on **global-object `this` binding** (`this.count=0` creating a bare global `count`).
- `8.7.2-{1,3,5,7}-s`, `7.8.3-3gs` — **strict-mode write semantics**: throw on non-writable / non-extensible / undeclared, `Object.preventExtensions`.
- `S8.6_A2_T2`/`A3_T2` — **dynamic property addition** to a plain object via `++` (our object literals are fixed-shape WasmGC structs).
- `S8.6.2_A1`, `S8.6.2_A8`, `S8.6_A4_T1`, `S8.7_A5_*`, `S8.7.2_A3`, `S8.1_A5` — distinct root causes (prototype chains, for-in enumeration, stack overflow).

These should be tracked under their respective feature goals (Proxy, global-this,
strict-mode write, dynamic object shape), not under a "primitive/literal" issue.

**Net result:** +5 test262 (3 string-escape + 2 regexp), 0 regressions.
Implementation tests in `tests/issue-2708.test.ts`.
