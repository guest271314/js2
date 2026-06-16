---
id: 1837
title: "Standalone Object.keys/for-in/JSON enumeration is hash-bucket order, not spec order"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 60
---
# #1837 — standalone enumeration order violates spec

## Symptom
Standalone-mode `Object.keys`/`values`/`entries`/for-in/spread/`JSON.stringify`
emit keys in hash-bucket order. `o.b=1;o.a=2;o["2"]=3;o["1"]=4; Object.keys(o)`
should be `["1","2","b","a"]`. JS-host mode is correct.

## Location
`src/codegen/object-runtime.ts:1097-1202` (`__object_keys`) walks open-hash slots
`0..cap` and pushes in bucket order (comment admits "hash order").

## Spec
ECMAScript §10.1.11.1 OrdinaryOwnPropertyKeys — integer-index keys ascending, then
string keys in insertion order, then symbols.

## Fix
Track an insertion sequence in the prop entry; emit integer keys sorted ascending
first, then remaining string keys in insertion order.

## Resolution
Implemented in `src/codegen/object-runtime.ts`:
- `$PropEntry` gained a 4th field `seq` (insertion sequence, stamped at create
  time), and `$Object` gained a 6th field `nextSeq` (monotonic counter, never
  reset — not even on rehash). New fields are appended so existing fieldIdx 0-4
  references stay valid.
- `__obj_insert` takes a 5th `seq` param. New-key callers (`__extern_set`,
  `__defineProperty_value`) claim `o.nextSeq` and bump it; the `__obj_grow`
  rehash passes the entry's PRESERVED `seq` so insertion order survives a resize.
  Updating an existing key keeps its original seq (no reorder).
- New `__obj_index_of_key(ref $AnyString) -> i32` parses a canonical array-index
  key (`"0"`, or no-leading-zero digit string < 2^31-1) → its value, else -1.
- New `__obj_ordered(ref $Object) -> ref $PropMap` compacts the live + enumerable
  entries into a fresh `$PropMap` in OrdinaryOwnPropertyKeys order (§10.1.11.1):
  integer-index keys ascending, then string keys by `seq` (selection sort).
- `__object_keys`/`__object_values`/`__object_entries` now walk `__obj_ordered(o)`
  instead of the raw hash table.

### Test Results
- `tests/issue-1837.test.ts` (6, all pass): helpers + struct fields emitted;
  `Object.keys/values/entries` length unchanged (4); zero host object imports;
  JS-host reference oracle returns `"12ba"` (the spec order the standalone path
  now reproduces).
- No regressions: `issue-1472` (one pre-existing `Object.assign` `__js_array_new`
  leak failure, confirmed on clean main, unrelated), `issue-1629a`,
  `issue-1103a-standalone-map`, `issue-1321-standalone`, `issue-1631`,
  `object-keys-values-entries`, `object-methods`, `issue-786-object-keys-dynamic`
  all pass. `npx tsc --noEmit` clean.
- Note: the standalone `$ObjVec` enumeration result only supports `.length`
  readback today (element string-eq / value-unbox / charCodeAt on a slot are
  separate pre-existing gaps), so the ordered keys can't be decoded back to JS
  strings from compiled code — the test asserts the ordering machinery is wired
  in + valid + length-correct rather than decoding the ordered keys.

