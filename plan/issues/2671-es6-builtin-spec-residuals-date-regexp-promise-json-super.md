---
id: 2671
title: "ES2015 builtin/feature spec residuals: Date, RegExp, Promise, JSON, super (~400 fails — tracking, slice per area)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: builtins, regexp, promise, date, json, super
goal: spec-completeness
related: [1343, 1440, 1444, 1439, 1465, 1368, 1551, 1342]
sprint: 66
---
# #2671 — ES2015 builtin/feature spec residuals (Date / RegExp / Promise / JSON / super)

## Edition / impact

- **Edition:** ES2015.
- **Fail count (residual after the canonical done issues):**
  - `built-ins/Date` — **104** (residual of #1343, #1440)
  - `built-ins/RegExp` — **95** (residual of #1444, #1439, Symbol.* protocol)
  - `built-ins/Promise` — **76** (residual of #1465, #1368)
  - `built-ins/JSON` — **44** (#1342 was wont-fix; reviver/replacer descriptor edges)
  - `language/expressions/super` — **68** (residual; #1551 ready covers eval order)
- **Tracking issue.** The canonical per-feature issues are all `done`; these are
  the long tails. This bundles them so the lead can slice one area at a time
  rather than leave the residuals un-issued. Lower priority than the structural
  clusters (#2666–#2670) — these are narrower, more scattered edge cases.

## Sub-area notes & sample failures

### Date (104)
Missing/incomplete `toISOString` (`toISOString is not a function`),
`set*`-with-`ToNumber`-coercion side-effect ordering, `proto-from-ctor-realm-*`,
annexB `getYear`/`setYear` + not-a-constructor checks.
```
built-ins/Date/prototype/toISOString/15.9.5.43-0-11.js
built-ins/Date/prototype/setSeconds/arg-ms-to-number.js
annexB/built-ins/Date/prototype/getYear/not-a-constructor.js
```

### RegExp (95)
`Symbol.split` / `Symbol.match` / `Symbol.replace` / `Symbol.search` protocol
edge cases: `lastIndex` get/coerce errors, species constructor validation,
`exec` lastIndex access ordering, ToPrimitive on species ctor.
```
built-ins/RegExp/prototype/Symbol.split/str-get-lastindex-err.js
built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-non-obj.js
built-ins/RegExp/prototype/exec/success-lastindex-access.js
```

### Promise (76)
resolve-element function attributes (extensible/own-props), invoke-resolve
error-close paths, race/all resolver-element edge cases, `then` spec asserts.
```
built-ins/Promise/all/resolve-element-function-extensible.js
built-ins/Promise/all/invoke-resolve-error-close.js
built-ins/Promise/prototype/then/S25.4.5.3_A1.1_T2.js
```

### JSON (44)
reviver/replacer with non-configurable / define-prop-err properties
(`Object.defineProperty called on non-object` — ties to #2668), replacer
wrong-type handling, function values.
```
built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js
built-ins/JSON/stringify/replacer-wrong-type.js
```

### super (68)
super-property access on null-proto / computed key errors, `super(...spread)`
argument-list evaluation + getter side effects (eval order is #1551).
```
language/expressions/super/prop-dot-cls-null-proto.js
language/expressions/super/call-spread-err-sngl-err-expr-throws.js
```

## Acceptance criteria

- This is a **tracking issue**; ship by area. Per-area target: pass **≥ 50%** of
  that area's residual fails.
- When an area is taken on, either reopen the canonical issue (#1343/#1440 Date,
  #1444/#1439 RegExp, #1465/#1368 Promise, #1551 super) or spin a child issue;
  update this tracker.
- No regression in currently-passing tests for the touched area.

## Notes

- JSON reviver descriptor failures partially resolve once #2668 (defineProperty
  fidelity) lands — sequence JSON after #2668.
- Deprioritized relative to #2666–#2670; pick up after the structural clusters.
