---
id: 1719
title: "Array destructuring ignores overridden Array.prototype[Symbol.iterator] ('items[Symbol.iterator] must be a function', 71 fails)"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring-iterator-protocol
goal: test262-conformance
sprint: Backlog
es_edition: 2015
test262_fail: 71
test262_category: language/expressions, language/statements
related: [1016, 1320, 1021]
---

# #1719 — Array destructuring must use the (possibly overridden) Array iterator (71 fails)

## Problem

71 tests fail with:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

All are `*-iter-val-array-prototype.js` array-destructuring tests across
`language/expressions/{class,object,function,async-generator}/dstr/` and
`language/statements/{class,for,for-of,function,generators}/dstr/`. Each test
overrides `Array.prototype[Symbol.iterator]` (or `Array.prototype.values`) with
a custom generator and asserts that **array destructuring uses the overridden
iterator**.

## Root-cause hypothesis

ArrayAssignmentPattern / ArrayBindingPattern destructuring (§8.5.2
IteratorBindingInitialization / §13.15.5.3 DestructuringAssignmentEvaluation)
must call `GetIterator(rhs)` which reads `rhs[Symbol.iterator]` **dynamically at
runtime**. Our codegen takes a fast static path for array RHS values that
iterates the backing store directly (or calls a fixed `%Array%.from`-style
bridge) and therefore **ignores a user-monkeypatched `Array.prototype[Symbol.
iterator]`**. When the test replaces the prototype iterator with a value the
fast path doesn't recognise, the bridge reports "items[Symbol.iterator] … be a
function" instead of invoking the override.

The fix is to route array destructuring through a real `GetIterator` that reads
the live `@@iterator` method off the value's prototype chain (honouring
overrides), rather than a compile-time-specialised array walk — at least when
the static type cannot prove the prototype iterator is intact.

Spec: [§7.4.2 GetIterator](https://tc39.es/ecma262/#sec-getiterator),
[§8.5.2 IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization).

## Example failing tests

- `test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/statements/class/dstr/meth-static-dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/class/dstr/private-meth-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-val-array-prototype.js`

## Acceptance criteria

- The four example tests pass.
- The `iter-val-array-prototype` cluster drops from 71 to ≤ 10.
- No regression in the broad destructuring fixes (#1016, #1021, #1024, #1025)
  nor in #1320 (Array.from(externref) iterator bridge).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).
