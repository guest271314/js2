---
id: 1822
title: "String#replace/replaceAll ignore $ substitution patterns ($$, $&, $`, $')"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

