---
id: 3051
title: "RegExp.prototype[@@replace] / [@@split] coercion protocol: ToString/ToInteger/ToLength on result-array + lastIndex/limit/flags args (~48 fails)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: regexp, symbol-replace, symbol-split, abstract-operations
es_edition: 6
goal: spec-completeness
test262_category: built-ins/RegExp/prototype/Symbol.replace, built-ins/RegExp/prototype/Symbol.split
test262_fail: 48
related: []
---

# #3051 — RegExp `[@@replace]` / `[@@split]` coercion protocol

## Source

Default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02 promoted baseline). **48**
fails under `built-ins/RegExp/prototype/Symbol.replace/*` (31) and
`built-ins/RegExp/prototype/Symbol.split/*` (17). Flagged as dev-sized during the
harvest (dev-3025) but not filed at the time (the `claim-issue.mjs --allocate`
ref was contended). Error breakdown: 35 `assertion_fail`, 11 `runtime_error`
(`Cannot convert object to primitive value` / `Cannot convert a Symbol value to a
number`), 2 `compile_timeout` (`poisoned-stdlib.js`,
`last-index-exceeds-str-size.js` — likely a hot loop / recompile blowup, may be a
separate concern).

## Problem

Our `RegExp.prototype[@@replace]` and `[@@split]` implementations do NOT perform
the spec-mandated abstract-operation coercions on their inputs and on the exec
**result array**. The two clusters:

### A. `@@replace` result-array coercion (spec §22.2.6.11, the bulk — ~20 files)

After each `RegExpExec(rx, S)`, the algorithm reads the result **through the
ordinary Get/ToXxx protocol**, so a user-subclassed / proxied result object's
getters and coercions must run in the right order:

- `result-coerce-matched*` — `matched = ? ToString(? Get(result, "0"))`.
- `result-coerce-index*` — `position = ? ToIntegerOrInfinity(? Get(result, "index"))`, then clamp to `[0, length]`.
- `result-coerce-length*` — `nCaptures = max(? ToLength(? Get(result, "length")) - 1, 0)`.
- `result-coerce-capture*` — each capture `? ToString(capN)` (unless undefined).
- `result-coerce-groups*` / `result-get-groups-prop*` — `groups = ? Get(result, "groups")`; named-group substitution reads coerce.
- `result-get-*-err` / `result-coerce-*-err` — the corresponding getter/coercion **throwing** must propagate (abrupt completion), not be swallowed.

The `*-err` variants prove ordering + abrupt propagation; the plain `*-coerce`
variants prove the coercion actually runs (e.g. an `index` of `"2"` string or a
boxed Number must be `ToIntegerOrInfinity`'d).

### B. arg / lastIndex / limit / flags coercion (~28 files across both)

- `@@replace` `arg-2-coerce*` — the replacement value, when not callable, is
  `? ToString(replaceValue)`; `coerce-global` / `coerce-unicode` — `global` /
  `unicode` flags read via `? ToBoolean(? Get(rx, "global"|"unicode"))` (the
  `runtime_error: Cannot convert a Symbol value to a number` is this flag read on
  a value that must coerce, not trap).
- `@@replace` `coerce-lastindex` / `g-pos-increment|decrement` — after a
  zero-length match with `global`, `lastIndex` is `? ToLength(? Get(rx,
  "lastIndex"))` then `AdvanceStringIndex`.
- `@@split` `coerce-limit-err` / `toint32-limit-recompiles-source` — `limit` is
  `? ToUint32(limit)`; `limit-0-bail` — a `0` limit returns `[]` immediately.
- `@@split` `coerce-flags` / `str-coerce-lastindex` / `str-get-lastindex-err` /
  `str-set-lastindex-*` — flags string via `? ToString(? Get(rx, "flags"))`, and
  the splitter's `lastIndex` get/set protocol.
- `@@split` `species-ctor*` — `C = ? SpeciesConstructor(rx, %RegExp%)`, then
  `splitter = ? Construct(C, [rx, newFlags])`; the `species-ctor-*-non-obj` /
  `-non-ctor` variants must `TypeError`.

## Sample failing files

- `Symbol.replace/result-coerce-index.js`, `result-coerce-length.js`,
  `result-coerce-matched.js`, `result-coerce-capture.js`,
  `result-coerce-groups.js` (+ their `-err` twins).
- `Symbol.replace/arg-2-coerce.js`, `coerce-global.js`, `coerce-unicode.js`,
  `coerce-lastindex.js`, `g-pos-increment.js`.
- `Symbol.split/coerce-limit-err.js`, `coerce-flags.js`,
  `str-coerce-lastindex.js`, `species-ctor.js`, `species-ctor-y.js`,
  `limit-0-bail.js`.

## Suggested approach

1. Locate the `@@replace` / `@@split` lowering (grep `Symbol.replace` /
   `@@replace` / `symbolReplace` in `src/codegen/` and the RegExp runtime helper
   in `src/runtime.ts`). Identify whether these are host-imported JS helpers or
   Wasm-native — the coercions must run either way (dual-mode).
2. Thread the exec **result array** reads through the real Get + ToString /
   ToIntegerOrInfinity / ToLength protocol (Cluster A) — this is the largest,
   most self-contained slice (~20 `result-*` files) and a good first PR.
3. Then the arg/lastIndex/limit/flags coercions (Cluster B) — `ToString` on the
   replacement, `ToBoolean` on flag gets, `ToUint32` on `limit`, `ToLength` on
   `lastIndex`, and `SpeciesConstructor` for `@@split`.
4. The 2 `compile_timeout` files (`poisoned-stdlib.js`,
   `last-index-exceeds-str-size.js`) may be a separate hot-loop/recompile issue —
   defer / split out if they don't fall out of the coercion fixes.

Net-positive slices; verify no regression in the passing
`Symbol.replace`/`Symbol.split` corpus and in `String.prototype.replace` /
`String.prototype.split` (which delegate to these).

## Acceptance criteria

- The `result-coerce-*` / `arg-*-coerce` / `coerce-*` / `species-ctor-*`
  `Symbol.replace` and `Symbol.split` files pass (materially below the 48
  recorded here).
- No regression in currently-passing `RegExp`/`String` replace/split tests.
