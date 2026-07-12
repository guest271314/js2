---
id: 3179
title: "standalone: `for (var k in arr)` + array element read `arr[k]` (string index) traps `illegal cast` — general, broad-impact"
status: ready
created: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: for-in
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [3176, 2860]
origin: "Discovered while working #3176 (standalone JSON residual). The 10 `built-ins/JSON/parse/15.12.2-2-*` rows attributed to a JSON reviver-array illegal-cast are actually blocked on THIS general standalone bug — the trap persists with JSON.parse removed."
---

# #3179 — standalone: for-in over Array + array string-index read traps `illegal cast`

## Problem

In `--target standalone`, iterating an **Array** with `for..in` and reading an
element back by the (string) loop key **traps at runtime** with
`RuntimeError: illegal cast`. Minimal reproduction (compiles clean, traps on
`instance.exports.test()`):

```ts
export function test(): number {
  var nullChars = new Array();
  nullChars[0] = '"a"';
  nullChars[1] = '"b"';
  let s = '';
  for (var index in nullChars) { s = s + nullChars[index]; }
  return s.length;
}
```

- Not JSON-specific: the trap persists after removing every JSON call
  (proved by ablation — replacing the `JSON.parse(...)` body of the harness
  loop with a plain `throw` still traps).
- `gc`/host lane does not trap (returns wrong value — a separate correctness
  gap — but no illegal-cast).
- The read `arr[index]` with `index` a **string** key (from `for..in`) appears
  to `ref.cast` the `$ObjVec` array element / receiver on a path that assumes
  a numeric-index or `$Object` shape.

## Impact (broad)

This is the root cause of the **10 `built-ins/JSON/parse/15.12.2-2-*`** rows
(SyntaxError-strictness family) mis-attributed in #3176 to the JSON reviver.
Their test bodies wrap `JSON.parse(...)` in `for (var i in nullChars) { ...
nullChars[i] ... }` inside `assert.throws`; the illegal-cast trap escapes the
harness `try` (a Wasm trap is uncatchable), aborting the test. Because the
pattern (`for..in` over an array + string-index element read) is generic, it
almost certainly blocks rows in OTHER test262 categories too — hence
broad-impact.

## Acceptance criteria

- The minimal repro above returns `2` in standalone (no trap).
- `for..in` over an array yields the string index keys `"0".."n-1"` and
  `arr[key]` reads the element (spec: for-in over an array enumerates own
  enumerable string keys, which are the index strings).
- The 10 `built-ins/JSON/parse/15.12.2-2-*` rows stop trapping (they then pass
  given #3176's SyntaxError strictness already landed).
- Zero host-lane / standalone high-water regressions.

## Notes for the implementer

- Look at the array element-access lowering for a **string** subscript in
  standalone (`src/codegen/property-access.ts` element-access arms /
  `__extern_get_idx` vs `__extern_get`), and the `for..in` key materialization
  for `$ObjVec` receivers. The failing `ref.cast` is likely a `$Object`-shape
  assumption on the array receiver when the key is a string rather than an i32.
