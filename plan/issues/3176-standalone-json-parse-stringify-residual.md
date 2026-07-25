---
id: 3176
title: "standalone: JSON.parse/stringify spec residual — reviver array walk illegal-cast, SyntaxError strictness, replacer/space edges (67 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: json
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 2671, 3046, 1353, 1636]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; slices the JSON area of tracking issue #2671"
loc-budget-allow:
  - src/codegen/json-codec-native.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
coercion-sites-allow:
  - src/codegen/json-codec-native.ts
---

# #3176 — standalone: JSON.parse/stringify spec residual

## Problem

**67 host-pass tests are not host-free-standalone passes** under
`built-ins/JSON/` (parse 30, stringify 29, rawJSON 5, isRawJSON 2,
Symbol.toStringTag 1; 58 fail + 9 compile_error; measured 2026-07-12
lane-baseline diff, method in #3169). Slices the JSON area of tracking issue
#2671 for the standalone lane.

Measured signatures:

- **`L80:3 illegal cast [in test()]`** (10 rows, the largest single bucket) —
  the parse **reviver** walking ARRAY holders:
  `reviver-array-non-configurable-prop-delete.js` and siblings. The
  InternalizeJSONProperty walk over array elements (delete-on-undefined,
  `[[Delete]]`/`[[DefineOwnProperty]]` fidelity, holder `this` — #3046 fixed
  the object-holder binding) mis-casts on the array arm.
- **SyntaxError strictness** (6 rows: `assert.throws(SyntaxError, …)` not
  thrown) — the native parser accepts invalid JSON (15.12.2-2-\* corpus:
  bare `+`, trailing garbage, control chars in strings, leading zeros).
- stringify edges: replacer-array key filtering with numeric keys,
  `space` coercion (`JSON.stringify(obj, null, boxedNumber)`), circular
  detection `TypeError`, `Symbol.toStringTag` descriptor row, holes
  (`arr.hasOwnProperty('1')` after roundtrip).
- rawJSON/isRawJSON (7 rows): new ES2025 statics — recognizer + carrier over
  the existing codec.

## ANTI-BLOAT directive

- The native codec EXISTS across `src/codegen/json-codec-native.ts`,
  `json-runtime.ts`, `json-standalone.ts`. Fix the reviver's ARRAY-holder arm
  inside the existing InternalizeJSONProperty walk (it already handles object
  holders per #3046) — do not fork a second walk.
- Grammar strictness: tighten the EXISTING scanner's token rules; add the
  rejected-input corpus as unit tests. No second parser.
- rawJSON: register via the existing builtin-static tables
  (`builtin-static-globals.ts` / `builtin-fn-meta.ts`, the #2933 namespace
  pattern) — table entries, not a new dispatch path.

## Acceptance criteria

- ≥48 of the 67 measured gap tests under `built-ins/JSON/` flip to host-free
  standalone passes (the 9 CE rows must at minimum stop CE-ing).
- Sample tests:
  - `test/built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js`
  - `test/built-ins/JSON/parse/15.12.2-2-9.js` (SyntaxError strictness)
  - `test/built-ins/JSON/Symbol.toStringTag.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, JSON only.

## 2026-07-12 — root-cause correction + honest scoping (dev-json)

Faithful reproduction (via `wrapTest`, gc-vs-standalone scan of all 165
`built-ins/JSON` tests) revised the plan's root-cause attribution:

- **The "illegal cast (10 rows)" bucket is NOT the reviver ARRAY-holder walk.**
  It is the `parse/15.12.2-2-*` SyntaxError-strictness family, and the trap is a
  **general standalone `for (var k in arr)` + array string-index bug in the test
  harness loop** — NOT in the JSON codec (proved by ablation: the trap persists
  after removing the `JSON.parse` call from the loop body). Filed as **#3179**
  (broad-impact standalone for-in bug). Those 10 files are BLOCKED on #3179;
  once it lands they pass, because this PR's SyntaxError strictness already
  makes them reject correctly.
- **The `reviver-array-non-configurable-prop-delete.js` file** is `FAIL`, not
  illegal-cast; array-holder `[[Delete]]` fidelity is separate residual scope.
- **Realistic JSON-only ceiling ≈ 43 rows** (of the 67): 10 illegal-cast rows
  are blocked on #3179 and the 2 `*-proxy-revoked` rows are deferred (Proxy is a
  deferred feature). So the "≥48" threshold is **not reachable via JSON alone** —
  it depends on #3179.

### Shipped in this PR (host-free standalone; all `ctx.standalone`-gated)

1. **JSON.parse SyntaxError strictness** in the native string parser
   (`json-codec-native.ts` `__json_parse_str`): unescaped control chars
   (U+0000..U+001F) and invalid `\uXXXX` escapes (short / non-hex) now throw
   `SyntaxError`. Flips **`parse/15.12.1.1-g4-1..4`, `g5-2`, `g5-3`** (6 files).
2. **ES2025 `JSON.rawJSON` / `JSON.isRawJSON`** (`emitJsonRawJson` /
   `emitJsonIsRawJson` in `json-codec-native.ts` + dispatch in
   `expressions/calls.ts`). The `[[IsRawJSON]]` internal slot is a bit on
   `$Object.flags` (`OBJ_FLAG_RAWJSON`, exported from `object-runtime.ts`), so a
   plain `{ rawJSON: '…' }` is not recognised. `rawJSON` reuses the native
   parser to validate a single-primitive argument. Flips
   **`rawJSON/{returns-expected-object,invalid-JSON-text,illegal-empty-and-start-end-chars}`**
   and **`isRawJSON/basic`** (4 files).

Total shipped: **10 files (~20 rows)** flipped standalone, zero host-lane change
(all changes are standalone/wasi-gated; the native codec is not used in gc mode).

Note on reuse: the plan pointed rawJSON at `builtin-static-globals.ts` /
`builtin-fn-meta.ts`; the actual dynamic `JSON.<method>` call dispatch lives in
`expressions/calls.ts`, and the carrier is minted through the existing
`object-runtime` — that is where the code went. Also: the codec's own
`ToString` is self-contained (tag-dispatch on the boxed value) rather than
`__any_to_string`, because that helper's boxed-number/boolean arms go dead when
it is baked before the union-import box structs are registered (a harness
`assert_compareArray` triggers exactly that order) — a pre-existing shared-codegen
fragility out of scope for a JSON-only PR.

### Remaining (keeps #3176 in-progress)

- **Blocked on #3179**: `parse/15.12.2-2-1..10` (10 files).
- **stringify edges**: `space-number-range`, `space-wrong-type`,
  `space-number-float` (runtime `space` coercion of boxed/out-of-range Number);
  `replacer-array-number`, `replacer-array-wrong-type` (numeric replacer keys).
- **descriptor rows** (`rawJSON/builtin`, `isRawJSON/builtin`, `parse/builtin`,
  `stringify/builtin`, `Symbol.toStringTag`): need real function-object /
  `@@toStringTag` descriptors — separate reflection scope.
- **`parse/S15.12.2_A1`** (`__proto__` own-property on parse),
  `parse/text-negative-zero`, `parse/text-object-abrupt`.
- **ES2025 reviver source-text** (`reviver-context-source-*`): `JSON.parse`
  3rd-arg `context.source` — larger feature.
- **`value-string-escape-ascii`**: blocked on `Object.values` / computed keys,
  not JSON.
- **deferred**: the 2 `*-proxy-revoked` rows (Proxy).

## Stale-verify (2026-07-24, dev-std-4) — headline PASSES, keep ready

MEASURED on current `main` (`--target standalone`, host-free): the JSON headline
now works — `JSON.stringify({a:1})`→`{"a":1}`, `JSON.stringify({a:[1,2]})`→
`{"a":[1,2]}`, `JSON.parse('{"a":7}').a`→7, and (the SyntaxError-strictness
bucket) `JSON.parse("+1")` throws SyntaxError. The native codec + object/array
stringify + parse are solid; #1353 (the open-ended shape-walking spec request)
is now superseded by this issue. Keep `ready` but RE-MEASURE the full
`built-ins/JSON/**` dirs (parse 77 + stringify 66) to size the true residual
against the stale "67 gap tests" figure — the reviver-array-walk illegal-cast
and replacer/space edges likely remain, but the count needs refreshing.
