---
id: 3051
title: "RegExp.prototype[@@replace] / [@@split] coercion protocol: ToString/ToInteger/ToLength on result-array + lastIndex/limit/flags args (~48 fails)"
status: in-progress
assignee: ttraenkler/dev-3051
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

## Landed Slice 1 (dev-3051) — result-array coercion via exec-return host-wrap

**PR: exec-override result-object host-wrapping** (`src/runtime.ts`,
`tests/issue-3051.test.ts`). Root cause found by regrounding: in the default
(JS-host) lane, `re[Symbol.replace/split/match/search](...)` is delegated to the
**native V8** protocol via the `__regex_symbol_call` host import. When a test
overrides `regexp.exec = fn` (the bulk of the `result-*` cluster), the compiled
`fn` returns a **compiled object literal** used as the match result. Object
literals are opaque WasmGC structs, so when V8's native protocol did
`Get(result, "0" | "index" | "length" | "groups")` on the returned struct it
read `undefined` — the spec `ToString` / `ToIntegerOrInfinity` / `ToLength`
coercions (and nested `valueOf`/`toString` on capture/index sub-objects) never
ran. Fix: when `regexp.exec = fn` is stored (the `extern_set` / `extern_set_strict`
host bindings, guarded on `key === "exec" && obj instanceof RegExp`), wrap `fn`'s
**return value** in `_wrapForHost` (`_wrapExecReturnForHost`) so the native
protocol observes the struct's fields and dispatches the nested closures.
Arrays / non-struct returns pass through unchanged. Covers @@replace, @@split,
@@match, @@search (all read exec's result the same way).

**Impact (local default-lane, measured):**

- `Symbol.replace`: 39 → 54 pass (**+15**); `Symbol.split`: 28 → 28 (unchanged).
- Newly passing: `result-coerce-{index,index-undefined,matched,matched-global,capture,length,groups}` and their `-err` twins where the throw was already in the coercion arm, plus `coerce-lastindex`, `g-pos-increment`, `g-pos-decrement`.
- No in-corpus regressions; `issue-1329-b3` / `issue-2161` still green. (`issue-682`'s 4 failures are **pre-existing** on `origin/main`, unrelated — standalone refusal tests.)

## Remaining Work (Slice 2+ — several senior-depth)

Not addressed by Slice 1 (still ~30 default-lane fails). Distinct mechanisms:

1. **`result-*-err` abrupt-throw propagation** (`result-get-{index,length,matched}-err`,
   `result-get-groups-prop-err`, `result-coerce-groups-err`): the result object
   has a **throwing getter** (`get index(){ throw new Test262Error() }`). V8 reads
   it through the `_wrapForHost` proxy → invokes the wasm getter closure → the
   wasm `throw` must surface as a JS exception V8 propagates back to the user's
   `try/catch`. Wasm-exception → host → user-catch bridging across the native
   protocol is **senior-depth**.
2. **replaceValue `ToString` (`arg-2-coerce{,-err}`)**: `re[@@replace](s, obj)`
   where `obj` is a non-callable struct with `toString`. `__regex_symbol_call`'s
   `wrapCallable(arg1)` wraps it via `_wrapForHost`, but `ToString(proxy)` returns
   `"null"` instead of the struct's `toString` result — the `wrapCallable` /
   `_wrapForHost` `toString`-field dispatch drops the value. Needs deeper look at
   the non-closure-struct arm of `wrapCallable`.
3. **`Cannot convert a Symbol value to a number` (`coerce-global`, `coerce-unicode`)**:
   the test does `Object.defineProperty(r,'global',{writable:true}); r.global = Symbol.replace`
   (and `= {}`, `= NaN`, …). Assigning arbitrary values to the **typed** `.global`/
   `.unicode` boolean property makes codegen coerce the RHS Symbol → number →
   throw. Static-type-coercion / property-write issue in codegen, not the protocol.
4. **`Cannot convert object to primitive value` (@@split cluster:** `coerce-flags`,
   `limit-0-bail`, `str-coerce-lastindex`, `str-result-coerce-length`,
   `str-set-lastindex-{match,no-match}`): object args / lastIndex round-trips that
   throw before reaching the protocol — same static-coercion family as (3).
5. **`SpeciesConstructor` for @@split** (`species-ctor{,-y,-err,-ctor-non-obj,-species-non-ctor}`,
   `splitter-proto-from-ctor-realm`): `C = SpeciesConstructor(rx, %RegExp%)` then
   `Construct(C, [rx, flags])` — bridging a user constructor through the native
   split. Deep.
6. **method-as-value (`name.js`)**: `RegExp.prototype[Symbol.replace]` accessed as
   a **value** (for `.name`) rather than called — the codegen resolves the member
   to the protocol-id `i32.const 8`, so `verifyProperty(<8>, "name", …)` fails.
   Separate feature (well-known-symbol method as first-class value).

## Test Results (Slice 1)

`tests/issue-3051.test.ts` — 5/5 pass. Local default-lane sweep of
`built-ins/RegExp/prototype/Symbol.{replace,split}`: replace 54/69, split 28/43
(was 39/69, 28/43).
