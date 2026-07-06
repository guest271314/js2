---
id: 3049
title: "Iterator.prototype helper methods (map/filter/take/drop/flatMap/…): 'X is not a function' + this-plain-iterator / return-forwarding residual (~27 fails)"
status: in-progress
assignee: ttraenkler/dev-3049
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
architect_spec: done
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: iterator-helpers
goal: spec-completeness
test262_category: built-ins/Iterator/prototype
related: [3023]
---

# #3049 — Iterator.prototype helper methods residual

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02). Of the ~158 fails under
`built-ins/Iterator/prototype/*`, **27** fail with a codegen/dispatch signature
(`object is not a function` / `undefined is not a function` /
`Cannot read properties of null`) rather than a pure assertion — i.e. the helper
method itself isn't wired, not just a semantic edge.

This is the **Iterator Helpers** surface (Stage-4: `map`/`filter`/`take`/`drop`/
`flatMap`/`reduce`/`some`/`find`/`every`/`forEach`/`toArray`). Distinct from
**#3023** (synthesized-iterator `.next` callability + for-of/for-await abrupt
completion) — this is the built-in `%Iterator.prototype%` helper methods.

## Root-cause hypothesis

The failing subset clusters on:
- **`this-plain-iterator`** twins across every helper — calling a helper with a
  plain (non-generator) iterator receiver resolves the helper (or its inner
  `next`) to a non-function.
- **`return-is-forwarded` / `exhaustion-does-not-call-return`** — the helper's
  wrapper iterator must forward/close the underlying iterator's `return`.
- **`flattens-iterable` / `iterable-to-iterator-fallback`** (flatMap) — GetIterator
  fallback on the flattened value.

Likely a single root: the helper wrapper's `GetIteratorDirect(O)` / `next`
resolution off a plain-object iterator receiver (vs a generator) yields
undefined/non-callable. Verify whether the helpers are registered at all on
`%Iterator.prototype%` for a non-generator receiver.

## Sample failing files (27 in the codegen subset; ~158 total incl. assertions)

- `built-ins/Iterator/prototype/map/this-plain-iterator.js` (+ filter/drop/find/every twins)
- `built-ins/Iterator/prototype/drop/return-is-forwarded.js`
- `built-ins/Iterator/prototype/filter/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/flatMap/flattens-iterable.js`, `iterable-to-iterator-fallback.js`
- `built-ins/Iterator/prototype/Symbol.iterator/return-val.js`

## Suggested approach

Start with one helper (`map`) + its `this-plain-iterator` case; trace how
`GetIteratorDirect` / the underlying `next` is resolved for a plain-object
iterator receiver and fix the resolution, then confirm the sibling helpers
inherit the fix. Coordinate with #3023 so the shared `.next`-callability path
isn't double-fixed.

## Acceptance criteria

- The 27 codegen-signature files (`this-plain-iterator`, `return-is-forwarded`,
  `flattens-*`) pass; helper `next`/`return` resolution works on a plain-object
  iterator.
- No regression in the generator-receiver helper paths or in #3023.

## Investigation (2026-07-05, dev-3042) — root cause pinned; handing off with findings

**Confirmed root cause: the array-iterator prototype chain does not reach the
helper-bearing `%IteratorPrototype%`.** The 27 `*/this-plain-iterator.js` files
all call `Iterator.prototype.<helper>.call(plainIter, …)`, where the runner
injects `Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
(test262-runner.ts:1938). So the fix is purely: **that expression must resolve
to the object carrying the helper methods.** It currently does not —
`Iterator.prototype.<helper>` is `undefined` → "object is not a function".

What I verified:
- The 11 helpers (map/filter/take/drop/flatMap/reduce/some/find/every/forEach/
  toArray) **are implemented** in `runtime.ts` and installed by
  `_installIteratorHelperPolyfills()` (called from `buildImports`) onto `Iproto`
  = the host's native `globalThis.Iterator.prototype` (Node ≥22 has it), with
  `_getIteratorPrototype()` (our `compilerIteratorProto`) `setPrototypeOf`-chained
  to it. So the helpers ARE reachable **from** `_getIteratorPrototype()`.
- **Generators** work: a generator instance chains
  `instance → GeneratorPrototype → _getIteratorPrototype()` (runtime.ts:403), so
  generator receivers resolve the helpers.
- **Array iterators do NOT.** `[][Symbol.iterator]()` lowers to the
  `env::__iterator` host import → `__call_@@iterator` (the **compiled** array
  iterator), NOT the runtime synthesized fallback. Probe:
  `getPrototypeOf(getPrototypeOf([][Symbol.iterator]())).map === undefined`, and
  its `.__proto__.map` is also undefined — i.e. the chain lands on
  `Object.prototype`, one level shy of (and never reaching) the helper proto.

Two candidate emission sites, **neither chains to `%IteratorPrototype%`**:
1. Compiled `%ArrayIteratorPrototype%` — `emitArrayIteratorPrototypeSingleton`
   (`src/codegen/array-object-proto.ts:2001`) builds it via `__new_plain_object()`
   and never sets its `[[Prototype]]` to the runtime `_getIteratorPrototype()`.
   Spec §23.1.5.2: array iterators are `ObjectCreate(%ArrayIteratorPrototype%)`
   and `%ArrayIteratorPrototype%.[[Prototype]] === %IteratorPrototype%`.
2. Runtime synthesized fallback (`runtime.ts` `__iterator`, ~line 12403) uses a
   **one-level** `Object.create(nativeIteratorPrototype)`; a two-level
   `Object.create(Object.create(_getIteratorPrototype()))` fixes the off-by-one
   there (drafted + reverted — it compiled clean but is NOT the path
   `[][Symbol.iterator]()` takes, so it didn't move the 27; keep as a follow-up).

**Suggested fix (bounded, but cross codegen/runtime boundary — take care):** wire
the compiled `%ArrayIteratorPrototype%` singleton's `[[Prototype]]` to the
runtime helper-bearing `%IteratorPrototype%` (`_getIteratorPrototype()`), so
`getPrototypeOf(getPrototypeOf(arrayIter))` === that proto. Confirm the same for
string/map/set iterators. Then the `.call(plainIter, …)` helper body runs on the
plain-object receiver via `GetIteratorDirect` (already implemented). The
`return-is-forwarded` / `exhaustion-does-not-call-return` / `flattens-iterable`
files share the same resolution root — retest after the chain fix.

**Status:** claim released; feasibility stays `medium` (bounded dev fix, just
spans codegen↔runtime prototype identity). Not started as a code change — no PR
beyond this findings note.

## Implementation Plan (arch, 2026-07-05)

**Bumped `feasibility: hard` / `reasoning_effort: max` / `model: fable`.** dev-3042's
first read ("bounded medium") is right about the *mechanism* but understates the
scope: the fix must make `getPrototypeOf(getPrototypeOf(arrayIter)) === the
helper-bearing %IteratorPrototype%` hold **by object identity in BOTH lanes**
(JS-host and standalone), for **four iterator kinds** (array / string / map /
set), **without** regressing the already-shipped #3013 array-iterator-proto
identity assertion or the generator-receiver path. That is a cross-lane
prototype-identity change → silently-wrong-code risk if the two lanes disagree.

### Root cause (confirmed, dev-3042)

The 27 `*/this-plain-iterator.js` files call
`Iterator.prototype.<helper>.call(plainIter, …)`, where the runner injects
`Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
(`tests/test262-runner.ts:1938`). The helper bodies are implemented and
installed on `_getIteratorPrototype()` (runtime.ts:346) by
`_installIteratorHelperPolyfills()` (runtime.ts:729). Generators reach that proto
(`instance → GeneratorPrototype → _getIteratorPrototype()`, runtime.ts:403).
**Array iterators do not** — `[][Symbol.iterator]()`'s 2-levels-up prototype is
`Object.prototype`, one level shy of the helper proto, so `Iterator.prototype`
resolves to a helper-less object and `<helper>` is `undefined`.

### The two lanes need DIFFERENT fixes — do BOTH and keep them identity-consistent

**Lane A — JS-host (default, the 27 harvested fails run here).**
`[][Symbol.iterator]()` lowers to the `env::__iterator` host import
(`src/runtime.ts` `__iterator`, runtime.ts:12438) which, for a compiled array
(a WasmGC vec struct), dispatches `__call_@@iterator(obj)` → a compiled
`$__IterRec` struct (`src/codegen/iterator-native.ts`, struct built via
`getOrRegisterIterRecType`, iterator-native.ts:89). That struct is opaque to V8;
`Object.getPrototypeOf` on it (via the `__getPrototypeOf` host import,
`src/codegen/expressions/calls.ts:7073`) does not chain to the helper proto.

- **Fix site:** in the `__iterator` host import (runtime.ts:12438), when the
  result comes back from `__call_@@iterator` for a vec/array (the
  `_isWasmStruct(obj)` arm, runtime.ts:12454-12461), the returned iterator must
  be presented to the host with a `[[Prototype]]` chain reaching
  `_getIteratorPrototype()`. Two viable shapes (pick one, document why):
  1. **Wrap** the returned `$__IterRec` in a host proxy / plain object whose
     `[[Prototype]]` is `Object.create(_getIteratorPrototype())` (a fresh
     `%ArrayIteratorPrototype%`-analog, cached module-wide so identity is stable
     across all array iterators) and that forwards `next`/`return`/`@@iterator`
     to the struct's dispatchers (mirror the existing vec-fallback synthesis at
     runtime.ts:12469-12486, which ALREADY does `Object.create(iterProto)` — but
     with `iterProto = _getIteratorPrototype()`, NOT
     `globalThis.Iterator.prototype`, and at ONE level below a stable
     `%ArrayIteratorPrototype%` so the runner's DOUBLE `getPrototypeOf` lands on
     the helper proto, not on `Object.prototype`). The current fallback is
     one-level (`Object.create(iterProto)`), so `getPrototypeOf(getPrototypeOf(
     it))` overshoots — build `Object.create(Object.create(_getIteratorPrototype()))`
     so the 2-hop walk lands exactly on the helper proto. dev-3042 drafted+reverted
     exactly this two-level fix in the fallback; it compiled clean but did not move
     the 27 because `[][Symbol.iterator]()` takes the `__call_@@iterator` arm, NOT
     the fallback — so apply the same two-level shape to the `__call_@@iterator`
     RESULT (12454-12461), where the 27 actually flow.
  2. Alternatively special-case the `__getPrototypeOf` host import to return the
     stable `%ArrayIteratorPrototype%` singleton for an `$__IterRec` struct — but
     this splits proto identity between "what getPrototypeOf reports" and "what the
     object actually inherits", which breaks `.map` resolution on the iterator
     itself. Prefer shape (1) (real inheritance) so `arrayIter.map(...)` ALSO works,
     not just the `.call(plainIter)` form.

**Lane B — standalone/WASI.** `Object.getPrototypeOf(<array iterator>)` routes to
`emitArrayIteratorPrototypeSingleton` (`src/codegen/array-object-proto.ts:2001`,
called from `src/codegen/expressions/calls.ts:7043` under
`(ctx.standalone || ctx.wasi) && argTsType.getSymbol()?.name === "ArrayIterator"`).
That singleton is built via `__new_plain_object()` and **never sets its
`[[Prototype]]`**.

- **Fix site:** in `emitArrayIteratorPrototypeSingleton` (array-object-proto.ts:2019),
  after `call __new_plain_object` and before the `global.set`, set the new object's
  `[[Prototype]]` to the standalone helper-bearing `%IteratorPrototype%`. This
  requires a standalone `%IteratorPrototype%` that carries Wasm-native helper
  methods — check whether one exists (grep `iterator_prototype` /
  `%IteratorPrototype%` in `src/codegen/` and `src/runtime-standalone*`); if the
  helpers are host-only today, standalone helper resolution is a **separate,
  larger** slice — in that case scope Lane B to *chaining* to whatever standalone
  `%IteratorPrototype%` object exists (even if helper-less) so the identity graph
  is correct, and file a follow-up for standalone helper bodies. Use the same
  `__set_prototype` / `Object.setPrototypeOf` runtime the class-proto singletons
  use (`emitLazyProtoGet` path); confirm `__new_plain_object` results accept a
  proto set.

### Extend to string/map/set iterators

The same 2-levels-up gap exists for `""[Symbol.iterator]()`,
`new Map()[Symbol.iterator]()`, `new Set()[Symbol.iterator]()` (test262 has
`this-plain-iterator` twins under those too, though the harvested 27 are
array-keyed). Whatever wrap/chain Lane A applies in `__iterator` is kind-agnostic
(it wraps the `__call_@@iterator` result), so it should cover all four for free —
**verify** with the string/map/set `this-plain-iterator` files, don't assume.

### Edge cases / regression guards

- **#3013 identity assertion must still hold**: `getPrototypeOf([].values()) ===
  getPrototypeOf([][Symbol.iterator]())` (same singleton) AND `!==
  getPrototypeOf([1,2])` (distinct from Array.prototype). The Lane-A wrap must
  cache the `%ArrayIteratorPrototype%`-analog module-wide (one object) so all
  array iterators share it by identity — do NOT `Object.create` a fresh proto per
  `[][Symbol.iterator]()` call.
- **Generator receivers unaffected**: generators already chain correctly; the
  Lane-A change only touches the array/vec `__call_@@iterator` arm, so confirm a
  `function*(){}` iterator's `.map` still resolves (regression file: any
  `Iterator/prototype/*/proto-from-ctor-realm.js` that uses a generator).
- **`return()` forwarding** (`drop/return-is-forwarded.js`,
  `filter/exhaustion-does-not-call-return.js`): once the helper resolves, its
  body's `GetIteratorDirect` + IteratorClose runs on the plain-object receiver
  (already implemented in `_installIteratorHelperPolyfills`, runtime.ts:765+). If
  a wrap is used in Lane A, the wrapper's `return` MUST forward to the underlying
  `$__IterRec`'s `return` dispatcher — else the `-does-not-call-return` files
  regress the other way.
- **flatMap `flattens-iterable` / `iterable-to-iterator-fallback`**: these drive
  `GetIteratorFlattenable` (runtime.ts:795+) on the yielded value — should fall
  out of the resolution fix; retest, do not special-case.

### Verification plan

1. Repro in `.tmp/`: compile a program doing
   `Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).map` and
   assert it is a function (host lane). Confirm it is `undefined` on main first.
2. Local default-lane sweep of `built-ins/Iterator/prototype/*` before/after;
   target: the 27 codegen-signature files (`this-plain-iterator`,
   `return-is-forwarded`, `flattens-*`, `exhaustion-does-not-call-return`) flip to
   pass, and the generator-receiver corpus is unchanged.
3. Sweep `built-ins/Array/prototype/Symbol.iterator`, `String.prototype/@@iterator`,
   `Map/Set` iterator suites for identity regressions (#3013 guard).
4. Full `merge_group` (cross-lane prototype identity is broad-impact — no scoped
   sweep suffices; standalone floor must stay green).
