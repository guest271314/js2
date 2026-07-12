---
id: 3186
title: "[SOUNDNESS] host lane: for-in string-key element read returns a silently WRONG VALUE — un-filed sibling of #3179 + family census"
status: ready
created: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: for-in
goal: core-semantics
sprint: current
horizon: m
related: [3179, 3162, 3176]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F3); documented but un-filed in #3179's own ablation notes"
---

# #3186 — host lane: for-in string-key element read returns silent wrong value

## Problem

#3179 filed the **standalone** half of the boxed-string-index family
(`for (var k in arr)` + `arr[k]` → uncatchable `illegal cast` trap). Its own
ablation explicitly records the **host-lane** half and left it un-filed:

> `gc`/host lane does not trap (**returns wrong value** — a separate
> correctness gap — but no illegal-cast).

Same minimal repro (from #3179), default `gc`/JS-host target:

```ts
export function test(): number {
  var nullChars = new Array();
  nullChars[0] = '"a"';
  nullChars[1] = '"b"';
  let s = '';
  for (var index in nullChars) { s = s + nullChars[index]; }
  return s.length; // host lane: WRONG value, silently (expected 6)
}
```

Mechanism: the for-in loop key is a **string** at runtime; the element read
`arr[index]` flows into a numeric-index lowering. Standalone `ref.cast`s and
traps; the host lane coerces/mis-routes and produces a wrong value **with no
error at all**.

## Why silent-wrong-value outranks the trap variant

- A trap self-announces (own error categories; #3179 got found through 10
  mis-attributed JSON tests). A silent wrong value surfaces only if a
  downstream assertion happens to compare it — it is invisible to the
  trap-census tooling and to `error_category` bucketing.
- Adjacent baseline evidence on the same surface (default lane):
  `language/statements/for-in/order-after-define-property.js` (wrong key set),
  `S12.6.4_A3.js` (`__str is not defined`), `scope-head-var-none.js`
  (null deref), `cptn-expr-itr.js` (internal compiler error). The generic
  pattern (string key from for-in / `Object.keys` indexing a vec-backed array)
  appears in test bodies across many categories, so the conformance footprint
  is under-counted by the 48 `for-in`-path fails.

## Scope

1. **Fix**: host-lane `arr[k]` element read where `k` is a runtime string that
   is a canonical numeric index — must read the element (spec: array index
   property). Reads first; verify writes (`arr[k] = v`) on the same path.
2. **Family census (deliverable, cheap)**: a short table in this file —
   {read, write} × {vec-backed array, TypedArray, `any`-receiver} × {host,
   standalone} for a string key, each cell: correct / wrong-value / trap /
   already-tracked(#). This is how the remaining siblings get filed with
   evidence instead of rediscovered bucket-by-bucket (#3176 → #3179 → here).

## Verified anchors

- Coordinate with #3179's implementation (same decision point, other lane);
  #3179 identifies the element-read path that assumes a numeric-index or
  `$Object` shape.
- The host-lane element read for dynamic receivers routes through the
  `__vec_get`/host-bridge family (see #3007 for the desync precedent on the
  any-context computed-index read).

## Acceptance criteria

1. The repro above returns 6 on the default lane (and stays a fix — add an
   equivalence test `tests/equivalence/` with a for-in string-key read).
2. `order-after-define-property.js` and `scope-head-var-none.js` flip or get
   root-caused as distinct (note in this file).
3. Family census table filled in; each non-correct cell either fixed here,
   or filed as a child issue with a measured count.
4. No standalone regressions (#3179 owns that lane).

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F3.
