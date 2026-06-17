---
id: 2166
title: "Standalone JSON conformance residual (~76 tests)"
status: in-progress
assignee: sdev-json
sprint: 63
created: 2026-06-15
updated: 2026-06-17
priority: low
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: json
goal: standalone-mode
parent: 1599
---

# Standalone JSON conformance residual

## Problem

The standalone JSON parser/stringifier landed in #1599 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**76 tests pass in host mode but fail standalone**, attributed to JSON
parse/stringify residuals — currently **untracked**.

## Evidence

- Gap category: `built-ins/JSON` 76; mix of runtime `fail` (reviver/replacer
  behavior, number formatting) and a few compile errors.

## Acceptance criteria

- Standalone pass count for `built-ins/JSON` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1599. Part of sprint-62 standalone catch-up (rank 12 by gap
impact). Likely benefits from the coercion engine (#1917) number/string path.

---

## Progress (2026-06-15, dev3) — boolean-typed `JSON.stringify` slice

**Status stays `ready`** — this is one slice of the 76-test bucket, not the
whole residual.

Investigation against `origin/main` @ `516feec44` found the standalone
`JSON.stringify` primitive/static-fold slices (#1324 / #1599) are in much
better shape than the gap suggests; verified working in standalone (compared
INTERNALLY, since standalone native strings don't marshal across the JS export
boundary):

- `JSON.stringify` of **static** object/array/number/string/nested literals →
  correct (folded by `tryEmitJsonStringifyStatic`).
- `JSON.stringify` of a **dynamic** number / string → correct.
- `JSON.parse` of a runtime number/`true`/`false`/`null` string → correct.

**One concrete bug fixed (this PR):** `JSON.stringify` of a **`boolean`-typed**
value (`const b: boolean = …`) refused to compile in standalone. TypeScript
models `boolean` as the union `true | false`, so the value carries the `Union`
type flag and was wrongly rejected by the ambiguous-shape early-return in
`tryEmitJsonStringifyPrimitive` (`src/codegen/expressions/calls.ts`) before
reaching the boolean stringify branch. The fix recognizes the `boolean` union
(`Boolean` flag + `intrinsicName === "boolean"`) ahead of the mask. Static
`true`/`false` literals were unaffected and keep working; a genuinely mixed
union (`boolean | number`) still falls through to the host import (intrinsicName
guard). Regression test: `tests/issue-2166.test.ts` (8 cases, host + standalone).

**Still open (the bulk of the 76):** `JSON.stringify` / `JSON.parse` of
**dynamic object graphs** (runtime-built objects, runtime JSON text →
object/array) still refuse with the #1599 Phase-2 compile error — they need the
pure-Wasm JSON codec + a dynamic value representation. That is the #1599 Phase 2
architect-spec follow-up (large; benefits from the #1917 coercion engine and the
value-rep work), not a point fix.

## Tech-lead note (2026-06-15, from dev3)

PR #1488 fixed one slice (standalone `JSON.stringify` of a boolean-typed value).
Stays `ready`: the ~75-test bulk is dynamic object-graph stringify/parse, needing
the #1599 Phase-2 pure-Wasm JSON codec + dynamic value rep (architect/senior).

## Progress (2026-06-16, d2) — `JSON.stringify(value, null, space)` indentation slice

**Status stays `ready`** — another increment of the bucket, not the whole residual.

Probing standalone JSON against `upstream/main` @ `cc833a2c9` surfaced a concrete
compile-error gap independent of the dynamic-graph bulk: the common pretty-print
form **`JSON.stringify(obj, null, 2)`** (and any call with a `space` argument) hit
the #1599 refusal. The static-fold caller in `src/codegen/expressions/calls.ts`
was gated on `expr.arguments.length === 1`, so a `space` argument was never
threaded into the compile-time fold.

**Fix (this PR):**
- `src/codegen/json-standalone.ts` — `tryEmitJsonStringifyStatic` now accepts the
  optional `replacer` and `space` args. A `null`/`undefined`/omitted replacer is
  honoured; a static numeric/string `space` is resolved (`staticSpaceValue`) and
  forwarded to JS's own `JSON.stringify(value, null, space)`, which applies the
  §25.5.2 clamping/indentation. A function/array replacer or a dynamic space
  returns `undefined` → the caller keeps the #1599 refusal (no silent wrong
  output).
- `src/codegen/expressions/calls.ts` — relaxed the gate to `>= 1` arg and pass
  args 1 (replacer) and 2 (space) through.

Regression test: `tests/issue-2166.test.ts` (+10 cases: numeric/string space,
nested, space 0, `null` replacer, `--target wasi`, 1-arg compact regression
guard, and refusal for function/array replacer + dynamic space). No `JSON_*`
host-import leak. Existing 8 boolean-slice cases + #1599/#1636 suites stay green.

**Still open (the bulk of the 76):** dynamic object-graph `JSON.stringify` /
`JSON.parse` (runtime-built objects, runtime JSON text → object/array) — needs
the #1599 Phase-2 pure-Wasm JSON codec + dynamic value rep (architect/senior).

---

## Implementation Plan

> Architect spec, 2026-06-17. Based on `upstream/main` @ `79e16bb37`.
> Anti-dup: no `## Implementation Plan` existed before this; no open PR speccs
> the Phase-2 codec. This is the #1599 Phase-2 design the prior dev slices defer
> to. **Architect/senior-scale, NOT a dev point-fix.**

### Root cause / scope (what is actually missing)

The remaining ~75 of the 76-test bucket are **dynamic object-graph**
`JSON.stringify` and **runtime-text** `JSON.parse`. Today these hit the #1599
Phase-1 refusal in `src/codegen/expressions/calls.ts` (~line 6016,
`reportError(... "not yet supported in --target standalone/wasi (#1599)")`)
because:
- `tryEmitJsonStringifyStatic` (json-standalone.ts) only folds **compile-time-
  constant** graphs — a runtime-built object (`const o = {}; o.x = f();
  JSON.stringify(o)`) has no static value.
- `tryEmitJsonParsePrimitive` only parses runtime strings whose value is a lone
  number/`true`/`false`/`null`; objects/arrays/strings refuse.

The good news: the **dynamic value representation already exists** in the
standalone object runtime (`src/codegen/object-runtime.ts`,
`ensureObjectRuntime`). The codec is a **traversal + formatter** over types that
are already defined; almost no new representation work is required. Key existing
building blocks:

- **`$Object`** struct — `proto`, `props: (ref $PropMap)`, `count`, `nextSeq`.
- **`$PropMap`** = `(array (ref null $PropEntry))`; **`$PropEntry`** =
  `{ key: (ref $AnyString), value: anyref, flags: i32, seq: i32, get/set: anyref }`.
- **`__obj_ordered(ref $Object) -> ref $PropMap`** (object-runtime.ts ~line 2619)
  — returns a compacted `$PropMap` of **live + enumerable** entries in
  **OrdinaryOwnPropertyKeys insertion order** (the exact order JSON.stringify
  needs). This is the spine of the stringify walk.
- **`__json_quote_string`** (calls.ts ~line 603 / a runtime helper) — quotes a
  native string per §25.5.2 QuoteJSONString. Reuse verbatim for keys + string
  values.
- **`number_toString`** (`emitNativeNumberFormat`) — pure-Wasm f64→native-string,
  Number::toString. JSON needs a thin wrapper (NaN/±Inf → `null`, `-0` → `0`).
- **`$AnyValue`** tagged union (`any-helpers.ts`, fields tag/i32val/f64val/refval/
  externval) — the natural carrier for JSON.parse output and for typing the
  `anyref` values read out of `$PropEntry.value` during the stringify walk.
- Native arrays are the `$ObjVec`/`__vec_*` structs (`{len, data}`) already used
  by array codegen — the array arm of the walk reads `len` + element `i`.

So Phase-2 is: **(1) a recursive pure-Wasm SerializeJSONValue over the runtime
value rep, (2) a pure-Wasm parser producing that same rep, (3) routing the
dynamic call sites to them instead of the refusal.** No host import; standalone +
WASI only (host mode keeps `JSON_stringify`/`JSON_parse` imports unchanged).

### Design

New file `src/codegen/json-codec-native.ts` (companion to the static-fold
`json-standalone.ts`), emitting lazily-registered runtime functions. Keep the
emit-once / `ctx.funcMap.has(name)` guard idiom every other runtime in
`object-runtime.ts` uses.

#### A. Native `JSON.stringify` — `__json_stringify_value`

Signature (pure Wasm, no host):
```wat
(func $__json_stringify_value
  (param $v anyref)            ;; the value to serialize (instance/object/array/boxed primitive)
  (param $gap (ref null $AnyString))  ;; indent unit ("" = compact); PR-2
  (param $depth i32)           ;; current nesting depth, for indentation
  (result (ref null $AnyString)))      ;; the JSON text, or null for "undefined"/function/symbol
```

Implements §25.5.2 SerializeJSONProperty by **runtime type discrimination** on
`$v` (a sequence of `ref.test` guards, the same discipline the property
front-guards use):
1. `ref.is_null` → the value is JS `null`/absent. (Distinguish JSON `null`
   literal from "omit" at the caller per array vs object context.)
2. `ref.test $AnyValue` → unbox via tag: number → `number_toString` (with the
   NaN/Inf→`null`, `-0`→`0` JSON rule), boolean → `"true"`/`"false"`, string →
   `__json_quote_string`, null → `"null"`.
3. `ref.test $NativeString` (or `$AnyString` subtype) → `__json_quote_string`.
4. `ref.test $ObjVec`/native-array struct → **array arm**: emit `"["`, loop
   `i in 0..len`: recurse on element `i` (a null/undefined/function element
   serializes as `"null"` inside an array — §25.5.2), join with `","`, append
   `"]"`. Apply indentation when `$gap != ""`.
5. `ref.test $Object` → **object arm**: `__obj_ordered` → walk the compacted
   `$PropMap`; for each entry, recurse on `$PropEntry.value`; **skip** entries
   whose serialized value is null/undefined/function/symbol (§25.5.2 step: a
   property with an undefined-serialization is omitted from an object); emit
   `quote(key) ":" value`, join with `","`, wrap in `"{" … "}"`. Indentation as
   §25.5.3.
6. user-class **instances** (`(ref $ClassName)` structs): two routes —
   - if the instance has a `toJSON` method, call it first (§25.5.2 step 2) and
     serialize the result. Defer `toJSON` to a follow-up PR if it complicates
     the first cut; note it.
   - otherwise enumerate the instance's **own enumerable string-keyed fields**.
     Closed-struct instances expose fields by name, not via `$PropMap`; the
     simplest correct route is to reuse the **existing instance→`$Object`
     reflection** the object runtime already does for `Object.keys(instance)`
     (find that path — `__obj_ordered` works on `$Object`; instances may need
     the `__to_object`/own-keys bridge). **Scope the first PR to plain `$Object`
     graphs + arrays + boxed primitives**; instance-field stringify is a
     separate slice (it overlaps the closed-struct reflection work in #2042).

String building: reuse the native-string concat helpers
(`ensureNativeStringHelpers`, the `__str_concat`/builder the array `join` path
uses — see array-methods.ts ~line 4832). For large graphs prefer a growable
builder over O(n²) concat; a simple concat is acceptable for the first cut.

#### B. Native `JSON.parse` — `__json_parse_text`

Signature:
```wat
(func $__json_parse_text
  (param $text (ref $AnyString))
  (result anyref))      ;; $AnyValue for primitives; $Object / $ObjVec for graphs; traps→throw SyntaxError
```

A standard recursive-descent JSON grammar (§25.5.1) over the native string's
i16 code units:
- a scanner reading code units by index (`array.get` on the native-string
  backing array); skip insignificant whitespace (space/tab/LF/CR only — JSON is
  strict).
- `parseValue` dispatch on first non-ws char: `{` → object, `[` → array,
  `"` → string, `-`/digit → number, `t`/`f`/`n` → literal.
- object → build a fresh `$Object` via `__new_plain_object` + `__extern_set`
  (or the lower-level `__obj_insert`) per member; preserve insertion order
  (the runtime already records `seq`).
- array → build `$ObjVec` (or the native array struct) via the existing array
  push/append helper.
- string → unescape per §25.5.1 (`\"` `\\` `\/` `\b\f\n\r\t` `\uXXXX`) into a
  native string.
- number → parse via the existing **`emitNativeParseNumber`**
  (`parse-number-native.ts`) → f64 → box as `$AnyValue`.
- on any grammar violation (or trailing non-ws): `throw SyntaxError` via the
  existing `emitThrowTypeError`-style error path (use a SyntaxError variant —
  `__new_SyntaxError` is already wired for standalone, see new-super.ts
  `emitWasiErrorConstructor` / `isWasiErrorName`).

The parser's output rep MUST be the SAME rep stringify consumes and the same rep
the rest of standalone codegen reads `any`/object values as, so a round-trip
`JSON.parse(JSON.stringify(o))` and downstream `.x` property reads work through
`__extern_get`.

#### C. Routing (calls.ts)

In `compileCallExpression`'s JSON arm (`src/codegen/expressions/calls.ts`
~line 5955), BEFORE the Phase-1 refusal at ~line 6016:
- `stringify`: after the existing primitive (`tryEmitJsonStringifyPrimitive`)
  and static-fold (`tryEmitJsonStringifyStatic`) attempts miss, and we are
  `ctx.standalone || ctx.wasi`: compile arg0 to its natural rep (object/array/
  any → `anyref`), ensure `__json_stringify_value`, push the gap (from a static
  `space`, reusing `staticSpaceValue`; dynamic space → first cut passes `""` or
  refuses — note), `depth=0`, `call`. Result native string.
- `parse`: after `tryEmitJsonParseLiteral` / `tryEmitJsonParsePrimitive` miss
  and standalone/WASI: compile arg0 to native string, ensure
  `__json_parse_text`, `call`. Result `anyref` (the value graph). A `reviver`
  arg (2nd) → first cut: refuse if present, or apply in a follow-up PR
  (§25.5.1 InternalizeJSONProperty is a post-walk; defer).

### Slicing into dev-sized PRs

- **PR-A (stringify, plain graphs)** — `__json_stringify_value` for
  `$Object` + native array + `$AnyValue`/boxed primitive, compact output only.
  Route dynamic `JSON.stringify(obj)` / `(arr)`. Tests: runtime-built object,
  nested object/array, numbers (incl. NaN/Inf→null, -0→0), strings with escapes,
  booleans, null. This alone should reclaim a large chunk of the bucket.
- **PR-B (stringify, indentation + space)** — thread `$gap`/`$depth` for
  `JSON.stringify(o, null, 2)` dynamic form (the static form already works via
  #2166 prior slice). Tests: indented nested output, string space, space 0.
- **PR-C (parse, primitives + graphs)** — `__json_parse_text` full grammar →
  `$Object`/`$ObjVec`/`$AnyValue`; route dynamic `JSON.parse(text)`. Tests:
  parse object/array/nested/escapes/numbers; SyntaxError on malformed input;
  round-trip `JSON.parse(JSON.stringify(o))`.
- **PR-D (instance fields + toJSON + reviver/replacer)** — stringify of
  user-class **instances** (own enumerable fields; reuse #2042 closed-struct
  reflection), `toJSON`, and reviver/replacer. Larger; overlaps #2042/#1917.

### Edge cases (§25.5)

- `JSON.stringify(undefined)` / a function / a symbol at top level → returns
  JS `undefined` (NOT the string "undefined"); inside an array → `"null"`;
  as an object value → the key is omitted. The recursion's null-result return
  encodes this; the caller picks array-vs-object behaviour.
- Numbers: `NaN`/`±Infinity` → `null`; `-0` → `0`; otherwise Number::toString.
- Strings: full QuoteJSONString escaping incl. control chars `\u00XX` and
  surrogate handling — reuse `__json_quote_string` exactly (do not re-implement).
- Property order: insertion order via `__obj_ordered`/`seq` — already correct.
- Circular references → `JSON.stringify` must throw TypeError. First cut: bound
  recursion depth and throw on overflow (note the limitation); a proper
  seen-set is a follow-up.
- Parse strictness: leading/trailing whitespace OK; trailing junk → SyntaxError;
  no comments, no trailing commas, no single quotes.

### Files to touch
- NEW `src/codegen/json-codec-native.ts` — `ensure`/`emit` of
  `__json_stringify_value` + `__json_parse_text`.
- `src/codegen/expressions/calls.ts` (~line 5955–6020) — route dynamic
  stringify/parse to the native codec before the Phase-1 refusal.
- Reuse (no edit): `object-runtime.ts` (`__obj_ordered`, `$Object`/`$PropMap`/
  `$PropEntry`, `__new_plain_object`, `__obj_insert`), `any-helpers.ts`
  (`$AnyValue`), `parse-number-native.ts` (`emitNativeParseNumber`),
  native-string helpers (`__json_quote_string`, concat builder), the
  standalone SyntaxError constructor (`emitWasiErrorConstructor`).

### Test files to verify
- Extend `tests/issue-2166.test.ts` per-PR (host + `--target wasi`/standalone):
  - dynamic-graph stringify (runtime-built object/array, nesting, escapes,
    NaN/Inf→null, -0→0) — PR-A
  - indented dynamic stringify — PR-B
  - parse → graph, SyntaxError on malformed, round-trip — PR-C
- Standalone-vs-host gap diff for `built-ins/JSON` should drop from ~75 toward
  near-parity as PR-A/PR-C land (verify via CI test262 bucket).
- No regression to the existing #1599/#1636 static-fold suites or the boolean/
  space slices already merged.

---

## Progress (2026-06-17, sdev-json) — PR-A: dynamic object-graph stringify codec

PR-A of the Implementation Plan above. New module
`src/codegen/json-codec-native.ts` emits a recursive pure-Wasm
`__json_stringify_value(v: anyref, depth) -> ref null $AnyString` (+ a
`__json_stringify_root` entry that coalesces a top-level undefined-serialisation
to `"null"`) over the **existing** standalone value rep — no new representation
work:

- `$Object` graphs: own enumerable string keys in insertion order via the
  existing `__obj_ordered`; recurses on `$PropEntry.value` (anyref); omits a
  property whose value serialises to undefined (§25.5.2).
- nested `$Object`, native-string values (`__json_quote_string` reused verbatim
  for keys + string values), `$box_number_struct` numbers (NaN/±Inf → `null`,
  `-0` → `0` via `number_toString`), `null`, and `$AnyValue`-carried primitives.
- `$ObjVec` array arm (enumeration-vector arrays).

Routing (`src/codegen/expressions/calls.ts`, the standalone/wasi JSON arm): when
the static fold (`tryEmitJsonStringifyStatic`) declines and the call is the
1-arg / null-replacer-no-space shape, compile arg0 to `anyref` and call the
codec. **Arrays/tuples (closed `__vec_*` structs) are NOT routed** — they are not
`$ObjVec` and stay on the #1599 refusal path until the array sub-slice (PR-A2).

**Correctness bug also fixed (`src/codegen/json-standalone.ts`):** `staticJsonValue`
followed a `const` identifier into an object/array literal initializer and folded
it, but such bindings are **mutable in place** (`const o = {}; o.x = f()`), so it
silently dropped runtime mutations and emitted `"{}"`. Now a `const` is only
followed to a **primitive** initializer; object/array bindings route to the codec
(or the refusal) instead of a wrong static fold.

Regression tests: `tests/issue-2166.test.ts` (+10 PR-A cases — runtime `let`/param
object, nested graph, QuoteJSONString escaping, NaN/Inf→null, -0→0, null value,
empty object, wasi host-import-free, reassigned-`let` no-stale-fold). Updated
`tests/issue-1599-json-standalone-refuse.test.ts`: dynamic **object** now compiles
(was refused); dynamic **array** still refuses (PR-A2). All 40 cases green; the
two pre-existing host-mode failures (`json.test.ts` number→host-import,
`issue-json-stringify-structs.test.ts` array-of-structs) are upstream, not from
this PR (verified by stashing). PR #1653.

**PR-A known limitations → follow-up slices:**
- **PR-A2:** closed typed-array (`number[]`) serialisation — a separate vec-struct
  discrimination, not `$ObjVec`.
- **boolean object-property values** serialise as `1`/`0`: the i32→externref
  coercion boxes a boolean as `$box_number` (indistinguishable from a number).
  A proper fix needs `__box_boolean` + an `__unbox_number` boolean arm — broad
  blast radius, overlaps #1917; deferred.
- **PR-B:** dynamic-space indentation. **PR-C:** `__json_parse_text`. **PR-D:**
  instance fields + toJSON + reviver/replacer.
