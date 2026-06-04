---
id: 1822
title: "String#replace/replaceAll ignore $ substitution patterns ($$, $&, $`, $')"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1822 — `String#replace`/`replaceAll` don't expand `$` patterns

## Symptom
- `"abc".replace("b","$&$&")` → `"a$&$&c"` instead of `"abbc"`.
- `"a-b".replace("-","$$")` → `"a$$b"` instead of `"a$b"`.
- `"ab".replaceAll("","-")` → `"ab"` instead of `"-a-b-"` (empty-search interleaving).

## Location
`src/codegen/native-strings.ts:3217` (`__str_replace`) and `:3294`
(`__str_replaceAll`) concat the replacement verbatim.

## Spec
ECMAScript §22.1.3.19 GetSubstitution.

## Fix
Scan the replacement for `$` and expand `$$`/`$&`/`` $` ``/`$'` against the match;
special-case empty-search interleaving in replaceAll.

## Resolution
Added a pure-Wasm `__str_getSubstitution(replacement, matched, prefix, suffix)`
helper in `src/codegen/native-strings.ts` that scans the replacement char by
char, flushing literal runs via `__str_substring` + `__str_concat` and
expanding `$$` → `$`, `$&` → matched, `` $` `` → prefix, `$'` → suffix.
Unrecognised `$X` (incl. `$1`..`$9`, which have no captures in the
string-search form) stay literal.

- `__str_replace` now calls `getSubstitution(replacement, search, s[0..idx],
  s[idx+searchLen..])` instead of concatenating the replacement verbatim.
- `__str_replaceAll` does the same per occurrence (prefix/suffix use the FULL
  surrounding text per spec, not the inter-match slice).
- The `searchLen == 0` branch of `__str_replaceAll` now interleaves the
  replacement before every code unit and at the end (`"ab".replaceAll("","-")`
  → `"-a-b-"`) instead of returning the receiver unchanged.

ECMAScript §22.1.3.19 GetSubstitution.

## Test Results
`tests/issue-1822.test.ts` — 8/8 pass ($&, $$, $\`, $', replaceAll $&,
unrecognised-$X literal, no-$ regression guard, empty-search interleave).
Existing `tests/native-strings.test.ts` — 86/86 still pass (no regression).

