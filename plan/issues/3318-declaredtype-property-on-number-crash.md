---
id: 3318
title: 'Compiler crash: "Cannot create property ''declaredType'' on number ''1''" (prototype-delete pattern)'
status: ready
sprint: current
created: 2026-07-16
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
related: [3170]
origin: "PO re-scope split of #3170 (2026-07-16) — bucket 6 of the verified 42-test residual, unrelated to search-method coercion, split out on its own merits as a compiler crash"
---

# #3318 — compiler crash on a prototype-delete pattern

## Problem

Found via #3170's residual measurement (`-9-a-14`, `-8-a-14` in
`built-ins/Array/prototype/{indexOf,lastIndexOf}`), but the crash mechanism
is unrelated to search-method semantics — it's a general TypeScript-checker/
codegen crash triggered by a prototype-delete pattern:

```
Cannot create property 'declaredType' on number '1'
```

This is a **compiler crash** (hard failure, not a semantic gap), which makes
it independently worth fixing regardless of the array-search-methods theme
it was found under — split out on its own merits per this repo's usual
practice of not bundling drive-by fixes into an unrelated method-family PR.

## Task

1. Reproduce standalone: `test/built-ins/Array/prototype/indexOf/15.4.4.14-9-a-14.js`
   and `.../lastIndexOf/15.4.4.15-8-a-14.js` (or a reduced repro isolating the
   prototype-delete pattern that trips it).
2. Root-cause where `'declaredType'` gets set on a number literal/value
   (likely a type-inference or shape-widening internal map keyed incorrectly
   when a numeric-valued property is later treated as an object needing type
   annotation) — find the actual crash site, not just the symptom.
3. Fix so the compiler either handles the pattern correctly or fails with a
   normal diagnostic instead of an internal crash.

## Acceptance criteria

- Both reproducer files compile without crashing (pass or a clean expected
  failure, not an internal exception).
- No regressions in the existing array-prototype / shape-widening test
  suites.
