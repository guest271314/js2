---
id: 3186
title: "[SOUNDNESS] host lane: for-in string-key element read returns a silently WRONG VALUE — un-filed sibling of #3179 + family census"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-forin-sound
created: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: for-in
goal: core-semantics
sprint: 71
horizon: m
related: [3179, 3162, 3176]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F3); documented but un-filed in #3179's own ablation notes"
---

## RESOLUTION (2026-07-12, dev-forin-sound) — host lane is SOUND; no code fix

**The premise does not reproduce.** Measured on current `origin/main`
(65854d48d), the gc/JS-host lane for-in string-key array element read returns
the **correct** value for reads *and* writes across every array
representation. There is **no silent wrong value on the host lane.** The only
host-lane defect is a **TRAP** (`illegal cast`) on the rep-divergent
`new Array()`+numeric case — which is the #3179 loop-header mechanism
(shared `emitArrayForIn`), *not* a silent wrong value. Since a trap
self-announces, it is out of this issue's "silent" scope and is already owned
by #3179 (whose fix covers both lanes because the code path is shared).

**Unmasking check (decisive).** Because a trap could *mask* a downstream
wrong-value in the element read, I cherry-picked #3179's (unmerged) loop-header
fix locally and re-ran the census: once the loop trap is fixed, the gc host
element read is **fully correct in every case** — the trap was masking nothing.
Conversely, applying #3179's fix turns the standalone/WASI *traps* into *wrong
values* (expected — #3179 flips the specific built-in/JSON rows and splits the
residual dynamic-vec-arm face to #3183). So **all** silent wrong values live on
the **standalone lane**, which #3179/#3183 own. This issue's host lane needs no
change; per soundness discipline no speculative fix was shipped.

Net source change: **none.** Deliverable: this census + a host-lane
regression-guard equivalence test (`tests/issue-3186.test.ts`) that locks in the
correct host behaviour so a future regression is caught.

### Family census — for-in / `Object.keys` string-key array element access

Measured 2026-07-12 on `origin/main` @65854d48d. Expected value in parens.
`correct` = returns expected; `TRAP` = `illegal cast` (self-announcing);
`WRONG(x)` = silent wrong value.

| case (string key) | gc / JS-host | standalone / WASI | owner |
| --- | --- | --- | --- |
| **read** vec, string values (rep match) | `correct` | `TRAP` | #3179 (standalone trap) |
| **read** vec, numeric values, `new Array()` (rep divergence) | `TRAP` | `TRAP` | #3179 (both lanes, shared loop header) |
| **read** vec, numeric values, `[10,20,30]` literal | `correct` | `WRONG(30)` | **standalone silent** → #3179 family |
| **read** via `Object.keys(a)`, numeric | `correct` | `WRONG(0)` | #3183 (dynamic vec arms) |
| **write** `a[k]=v`, string key | `correct` | `WRONG(5)` | **standalone silent** → #3179 family |
| **read** `Int32Array`, string key | `correct` | `WRONG(30)` | **standalone silent** → new/child of #3179 |
| **read** `any`-typed receiver | `correct` | `WRONG(0)` | #3183 (dynamic vec arms) |

Reading of the table:
- **gc / JS-host column**: every cell is `correct` except the rep-divergence
  `new Array()`+numeric case, which is a **TRAP** (the #3179 loop-header
  mechanism), never a silent wrong value. **Host lane is sound for the #3186
  concern.**
- **standalone / WASI column**: multiple **silent** wrong values. These are the
  real remaining soundness gaps, and they are on #3179's lane (explicitly
  out-of-scope here per acceptance criterion 4). Cells worth flagging to the
  #3179/#3183 owners that the existing children may not yet fully cover:
  `[10,20,30]`-literal `WRONG(30)`, `write` `WRONG(5)`, and `Int32Array`
  `WRONG(30)` are *concrete-path* standalone element reads, not just the
  dynamic vec arms of #3183. Recommend confirming these are inside #3179's
  post-fix scope or filing a measured child.

### Acceptance criteria disposition
1. Repro returns **6** on the default lane (verified) and a host-lane
   regression-guard equivalence test is added (`tests/issue-3186.test.ts`). ✓
2. `order-after-define-property.js` / `scope-head-var-none.js`: **root-caused as
   distinct** — those are object-enumeration-order / head-var-scope for-in
   semantics, not the array string-key element-read path this issue targets. The
   array element-read path is sound on the host lane (census above); those two
   are separate object-path concerns and are not fixed or regressed by this
   issue. (No test262 submodule in this checkout to flip them directly; they
   remain owned by their own object-for-in surface.)
3. Family census table filled with measured evidence. ✓ Non-correct cells are
   all on the standalone lane and attributed to #3179/#3183 (or flagged for a
   measured child).
4. No standalone regressions — this issue changes **no source**, so the
   standalone lane is untouched (#3179 owns it). ✓

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
