---
id: 1665
title: "host-indep: Wasm-native generators (retire __gen_* / __create_generator host scheduler)"
status: done
created: 2026-05-25
updated: 2026-06-03
completed: 2026-06-03
priority: medium
feasibility: hard
task_type: feature
area: codegen, standalone
language_feature: generators, iterators
goal: standalone-mode
sprint: 58
required_by: [1344, 1732]
related: [1662, 1376, 1103, 1320, 1340, 1464, 1718]
claimed_by: sd-1665
claimed_at: 2026-06-03T00:00:00.000Z
---
# #1665 — Wasm-native generators for standalone mode

## Problem

`function*` generators (and `for-of` over them) emit a large family of
JS-host scheduler imports under `--target wasi`:

```
env.__gen_create_buffer, env.__gen_push_f64, env.__gen_push_i32,
env.__create_generator, env.__create_async_generator, env.__gen_throw,
env.__get_caught_exception,
env.__iterator, env.__iterator_next, env.__iterator_done,
env.__iterator_value, env.__iterator_return
```

Probe (`.tmp/probes/generator.ts`):
```ts
function* gen() { yield 1; yield 2; }
export function test(): number { let s = 0; for (const x of gen()) s += x; return s; }
```
→ all twelve imports above; the module also fails WASM validation (#1666).

The allowlist entries for `__gen_` / `__create_generator` /
`__create_async_generator` (lines 273–291) cite **#1376**, but #1376 is the
*IR fallback telemetry gate* (done) — it tracks generators as an IR
*fallback*, not a native-implementation issue. There is no issue that owns a
**Wasm-native generator engine**. This issue fills that ownership gap.

## Evidence: refreshed standalone test262 artifact 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The ordered root-cause classifier assigns these primary standalone buckets to
the generator/iterator work:

| Rows | Bucket |
| ---: | --- |
| 532 | Generic/custom iterable `for-of` and `for-await-of` still require the JS-host iterator protocol (#681 shared owner) |
| 154 | Iterator protocol / for-of semantic failures after compile (#1718 shared owner) |
| 86 | Generator and async-iteration semantics |
| 6 | Recursive/generator/iterator stack-overflow residuals |

Representative compile diagnostic:

```text
Codegen error: #681 standalone/WASI for-of over this iterable still requires
the JS-host iterator protocol; known array for-of lowers to an index loop, but
generic/custom iterables need a future pure-Wasm Iterator implementation.
```

This confirms the original decomposition: #1665 should not grow a
generator-only local iterator path. The pass-rate recovery needs the shared
pure-Wasm iterator interface, then native generator lowering on top.

## Standalone alternative

Generators are coroutines. Two viable lowerings without a JS host:

1. **State-machine transform (preferred, no proposal dependency)** — lower a
   generator body to a switch over a `state: i32` field stored in a WasmGC
   `$GeneratorState` struct: each `yield` is a state checkpoint that saves
   live locals into struct fields and returns; `next()` re-enters the switch
   at the saved state. This is the classic Babel/regenerator approach,
   expressed in WasmGC. No host scheduler, no stack-switching proposal.
2. **Wasm stack-switching proposal** (`cont`/`resume`) — cleaner but the
   proposal is not yet broadly shipping; defer.

The iterator-protocol helpers (`__iterator*`) are shared with #1664 and
#1103 (for-of over Map/Set) — a native `$Iterator` interface (a WasmGC
struct with a `next` funcref returning a `{value, done}` struct) lets
for-of, generators, and collection iteration all share one native path.
`__get_caught_exception` is owned by #1473 (landed) but reappears here via
the generator `throw()` path.

## Acceptance criteria

- [ ] The generator probe emits **zero** `__gen_*` / `__create_generator*`
      / `__iterator*` imports under `--target wasi` / `--target standalone`,
      and the module validates (coordinate with #1666).
- [ ] `for (const x of gen()) s += x` yields `s === 3` standalone.
- [ ] `gen().next()` returns `{value:1, done:false}` then `{value:2,…}` then
      `{value:undefined, done:true}`.
- [ ] `yield*` delegation works standalone (separate phase acceptable).
- [ ] async generators may remain deferred (document; out of standalone
      scope short-term per the IR fallback "deferred" bucket).
- [ ] Remove `__gen_*` / `__create_generator*` allowlist entries on landing.

## Files

- `src/codegen/closures.ts` / generator lowering (search `__create_generator`).
- New `src/codegen/wasm-helpers/generator-state.ts` — `$GeneratorState`
  struct + native iterator interface.
- `src/codegen/host-import-allowlist.ts`.

## Senior-dev analysis (2026-05-25) — STOP: spec/design gap, not an impl pass

A senior-dev pass mapped the existing model end-to-end before coding. The
conclusion is that the *smallest coherent slice* cannot land as an isolated
implementation pass without either colliding with in-flight #1664 or baking
wrong semantics into standalone mode. Escalated to tech-lead for a shared
`$Iterator` design decision. Findings:

### How generators are lowered today (the model is already EAGER)

- `closures.ts:2067` — a `function*` body is **run to completion at
  creation time**, inside a try/catch. It is NOT a coroutine/state machine.
- Each `yield v` (`expressions/misc.ts:162`) pushes `v` into a host JS array
  via `__gen_push_f64` / `__gen_push_i32` / `__gen_push_ref` (`runtime.ts:5652`).
  `__gen_create_buffer` returns `[]`. A 1M-yield `__EAGER_GEN_LIMIT` guard
  caps it.
- `__create_generator(buf, pendingThrow)` (`runtime.ts:5685`) wraps
  `{buf, index, pendingThrow}` into an object on `%GeneratorPrototype%`.
- `for-of` (`statements/loops.ts:3314-3465`) and `.next()` walk it via the
  polymorphic host helpers `__iterator` / `__iterator_next` /
  `__iterator_done` / `__iterator_value` / `__iterator_return`
  (`runtime.ts:5762-5906`).

### Why a native slice IS structurally buildable (the good news)

The precedent exists: `addUnionImportsAsNativeFuncs` (`index.ts:6404`, gated
on `ctx.wasi || ctx.standalone`) already emits **native** `__box_number` /
`__unbox_number` as a `$box_number` WasmGC struct + `extern.convert_any`, no
host. So a native eager buffer is feasible: a `$Generator` struct
`{ items: (array (mut anyref)), len: i32, index: i32 }`, native
`__gen_push_*` that box-and-append, native `__create_generator` as identity,
and native `__iterator*` that read the struct when the operand is a
`$Generator`.

### Why it must NOT land as #1665-only (the stop reasons)

1. **`__iterator*` is a shared polymorphic dispatcher, co-owned by #1664 /
   #1103.** A native `__iterator_next` cannot assume `$Generator` — in
   standalone it must also serve arrays, Map/Set, native-string iterators,
   and user `[Symbol.iterator]` structs. The issue text itself (lines 56-62)
   calls for a **shared native `$Iterator` interface** for exactly this.
   #1664 line 56-59 *depends on #1665* for that native iterator
   ("a WasmGC loop calling the iterator protocol helpers (which themselves
   must be native — see #1665)"). #1664 is **in-flight** (`origin/issue-1664`,
   task #91). Building a generator-only `__iterator*` here would either be
   non-reusable (forcing a #1664 rewrite) or require designing the full
   polymorphic discriminator now — the "more design than one pass" line.

2. **The eager model is semantically wrong and would be enshrined.** Running
   the body at creation time mis-handles any generator with an unbounded loop
   or observable interleaved side effects (it runs to completion / hits the
   1M guard up front). The issue's own preferred lowering is the
   state-machine transform precisely to fix this. Shipping a *native eager*
   buffer would make standalone generators silently wrong — worse than the
   current honest host-import leak.

3. **#1666 (invalid-wasm) is an unfixed hard prerequisite.** The audit (#1662)
   shows the generator probe emits **invalid Wasm today**, before the import
   question. Both #1664 and #1665 list "resolve #1666 first." Native lowering
   must land on a module that validates.

### Recommended decomposition (needs architect + tech-lead decision)

- **#1665a (shared, architect-owned):** design + build a single native
  `$Iterator` interface (struct with a `next` funcref returning a
  `{value:anyref, done:i32}` struct) reused by generators, for-of, Map/Set
  (#1103), and `__array_from_iter` (#1664). This is the missing shared
  artifact none of #1664/#1665/#1103 currently owns.
- **#1665b:** native eager `$Generator` buffer on top of #1665a (acceptable
  *only* if the eager-semantics limitation is explicitly documented and
  scoped to the basic slice), OR
- **#1665c (preferred long-term):** state-machine / CPS lowering so
  generators are true coroutines — large, depends on the IR async/CPS work
  (#1373b / #1042).
- All of the above gated on **#1666** landing first.

---

## Implementation Plan — iterator-prototype bridge (host-mode first)

> Architect, 2026-05-29. This plan covers the **iterator-prototype bridge**
> that the #1718 recon (dev-b) isolated as the root blocker for the whole
> iterator-helper cluster: `g().map(f)` → "map is not a function",
> `Iterator.from(it)` in for-of → "dereferencing a null pointer", and
> `Iterator.concat`/`zip`/`zipKeyed` → null-deref / not-iterable. It is
> **scoped to host (JS) mode** — the standalone native `$Iterator`
> (#1665a/b/c above) is a separate, later track and is explicitly NOT
> required to land these slices. The two tracks meet at one design point
> (the prototype object), called out under "Standalone forward-compat."

### Root cause (two distinct bugs, one shared root)

There are **two `%IteratorPrototype%` objects** in the runtime and the
helper methods live on the wrong one relative to where compiled iterators'
proto chains terminate:

1. **`_getIteratorPrototype()`** — `src/runtime.ts:131`. The
   **compiler-built** prototype. `%GeneratorPrototype%` inherits from it
   (`src/runtime.ts:188`: `Object.create(_getIteratorPrototype())`), so a
   compiled generator instance built by `__create_generator`
   (`src/runtime.ts:7163`, chain
   `instance → genFn.prototype → %GeneratorPrototype% → _getIteratorPrototype()`)
   reaches this object. **Its only own property is `[Symbol.iterator]`**
   (lines 145-150). It carries **NO** `map`/`filter`/`take`/`drop`/`flatMap`/
   `every`/`some`/`find`/`reduce`/`forEach`/`toArray`.
2. **`globalThis.Iterator.prototype`** — the **host** prototype.
   `_installIteratorHelperPolyfills()` (`src/runtime.ts:480`, called once
   from `buildImports` at `src/runtime.ts:8822`) installs `zip`/`zipKeyed`/
   `concat` on `globalThis.Iterator` and relies on the host's native
   `map`/`filter`/`flatMap`/… already living on `globalThis.Iterator.prototype`.
   The synthesized array/string iterator in the `__iterator` host import
   (`src/runtime.ts:7281-7286`) correctly does `Object.create(globalThis.Iterator.prototype)`.

**Bug A — helpers don't resolve on compiled generators.** A compiled
generator's chain terminates at `_getIteratorPrototype()` (object #1), which
has no helpers, while every helper lives on `globalThis.Iterator.prototype`
(object #2). `g().map` therefore resolves to `undefined` → the runtime
dispatch (member-call on the externref generator → `__extern_method_call`,
`src/runtime.ts:5674`) does `wrappedObj["map"]` (line 5735), finds a
non-function, falls through, and throws "map is not a function". This is the
"#1340 shipped the helpers but they don't resolve at runtime" symptom: #1340
fixed the **codegen** of helper call sites; it never connected the
compiler-built prototype to the helper-bearing one.

**Bug B — `Iterator.from`/`concat`/`zip` null-deref in for-of.** The static
call `Iterator.from(it)` / `Iterator.concat(...)` routes via the
`BUILTIN_CLASS_NAMES` path (`Iterator` is registered at
`src/codegen/expressions/calls.ts:137`) → `__get_builtin("Iterator")` +
`__extern_method_call(Iterator, "from"|"concat"|"zip", args)`. The host
returns a **real JS helper iterator** (an externref). But the **for-of
consumer** lowers the loop subject through the `$IteratorResult` struct path
(#1620/#1323, `src/codegen/statements/loops.ts`): it calls `__iterator_next`
and **`ref.cast`s** the result to `$IteratorResult`. When the loop subject is
the externref returned by a static `Iterator.*` call, codegen treats it as a
typed iterator and reads `value`/`done` via the struct getters — but the host
helper iterator is a plain JS object, not a WasmGC struct, so the
`any.convert_extern` + `ref.cast` either traps or, where the typed iterator
binding is null-initialized, dereferences a null `$IteratorResult` ("dereferencing
a null pointer"). This is the same class of wiring gap #1620 fixed for the
`__iterator` host path, but the **`Iterator.*` static-call result never goes
through `__iterator`** — it is consumed directly as a typed iterator.

### The bridge mechanism (the core fix)

**Unify the two prototypes.** Make `_getIteratorPrototype()` return an object
that *carries the iterator-helper methods*, and make every iterator producer
(generators, array/string iterators, custom `[Symbol.iterator]` structs)
terminate at that one object. Concretely:

**File: `src/runtime.ts`**

1. **`_getIteratorPrototype()` (line 131) — link to the host helpers.**
   After building the base `proto` and installing `[Symbol.iterator]`, bridge
   in the host helper methods:
   - If `globalThis.Iterator?.prototype` exists, set the **base** of our
     proto to it: `Object.setPrototypeOf(proto, globalThis.Iterator.prototype)`
     instead of `Object.create(Object.prototype)`. This makes
     `map`/`filter`/`flatMap`/`take`/`drop`/`every`/`some`/`find`/`findIndex`/
     `reduce`/`forEach`/`toArray`/`[Symbol.dispose]` resolve up the chain for
     **every** consumer of `_getIteratorPrototype()` — including
     `%GeneratorPrototype%` (line 188) with zero changes there.
   - Keep our explicit `[Symbol.iterator]` own property (the comment at
     lines 124-129 explains why we don't *borrow* the host proto wholesale —
     test262 walks the generator's own proto chain and expects our object as
     `%IteratorPrototype%`; making it *inherit* from the host proto preserves
     that identity while gaining the methods).
   - **Idempotency / ordering:** `_installIteratorHelperPolyfills()`
     (line 480) installs `zip`/`concat`/`zipKeyed` on `globalThis.Iterator`
     and is called from `buildImports` (line 8822). Because the helpers are
     resolved **lazily at call time** via the prototype chain (not copied),
     ordering is safe: by the time any compiled iterator's `.map` is
     *invoked*, `buildImports` has run. But `_getIteratorPrototype()` may be
     cached (line 132) before `buildImports` — so do the
     `setPrototypeOf` link **inside `_installIteratorHelperPolyfills()`**
     (after it guarantees `globalThis.Iterator.prototype` exists / is
     polyfilled), targeting the cached `_IteratorPrototypeCache` if already
     built, OR lazily in `_getIteratorPrototype()` guarded by "is the host
     proto present yet." Prefer: have `_installIteratorHelperPolyfills()` call
     `_getIteratorPrototype()` and `Object.setPrototypeOf(thatProto,
     I.prototype)` as its last step, so the link is established exactly once,
     after the host helpers (and our zip/concat) are guaranteed installed.

2. **Standalone fallback (no `globalThis.Iterator`).** When
   `globalThis.Iterator` is absent (older host) **or** in standalone mode,
   `_installIteratorHelperPolyfills()` currently early-returns (line 484).
   Change it to, in that case, install a **compiler-owned helper set** onto
   `_getIteratorPrototype()` directly — JS-side polyfill implementations of
   `map`/`filter`/`take`/`drop`/`flatMap`/`every`/`some`/`find`/`reduce`/
   `forEach`/`toArray` driven through the iterator protocol (each returns a
   helper iterator built by the existing `_makeHelperIterator` pattern, but
   based on `_getIteratorPrototype()` rather than `Iproto`). This is the
   host-mode equivalent that also covers the "host lacks ES2025 helpers"
   gap that #1464 only partially addressed (it polyfilled zip/concat/zipKeyed
   but assumed native map/filter exist). Keep these behind the same
   `_iteratorHelpersInstalled` guard.

### Fix Bug B — `Iterator.*` static-call result must flow through `__iterator`

The static-call result is a host iterator object; the for-of consumer must
treat it as an **opaque iterable** and drive it through the existing
`__iterator` / `__iterator_next` host path (which already handles plain JS
iterators and builds a `$IteratorResult` correctly per #1620), **not** as a
pre-typed `$IteratorResult`-producing iterator.

**File: `src/codegen/statements/loops.ts`** (for-of lowering)
- The for-of subject-classification logic decides whether the loop subject is
  a "known typed iterator" (struct-backed, drive `.next()` directly and
  `ref.cast` to `$IteratorResult`) or an "opaque externref iterable" (route
  through `__iterator(obj)` then `__iterator_next`). Find the branch that
  picks the typed path (grep `__iterator_next` + `ref.cast` near the
  `$IteratorResult` cast added by #1620).
- **When the loop subject is a `CallExpression` whose callee is a static
  member of `Iterator` (`Iterator.from`/`concat`/`zip`/`zipKeyed`)** — or, more
  robustly, whenever the subject's static type is not a concrete struct-backed
  iterator we emitted — force the **opaque externref path**: emit
  `__iterator(<subjectExternref>)` to get the iterator, then `__iterator_next`,
  which returns a host-constructed `$IteratorResult` (per #1620's runtime
  wiring) regardless of whether the source object is a WasmGC struct. This
  reuses the already-correct null-safe path and removes the unconditional
  `ref.cast` on a host object.
- **Null guard:** before the `ref.cast` to `$IteratorResult` on ANY path,
  the existing `emitNullGuard` (`loops.ts:1129` etc.) must cover the
  iterator-result local. If the iterator itself can be null (host returned
  null/undefined), guard the `__iterator_next` call site too. The
  "dereferencing a null pointer" trap is a missing `ref.is_null` check before
  a `struct.get` on the `$IteratorResult` ref — add it on the typed path or
  (preferred) avoid the typed path entirely for `Iterator.*` results per
  above.

**File: `src/codegen/expressions/calls.ts`**
- Verify the `Iterator.from`/`concat`/`zip`/`zipKeyed` static calls return
  `{ kind: "externref" }` (host iterator), NOT a typed iterator struct. They
  route through `__extern_method_call` already (`Iterator ∈ BUILTIN_CLASS_NAMES`,
  line 137); the result type annotation must be externref so the for-of
  classifier (above) takes the opaque path. If a later inference step retypes
  the binding as `Iterator<T>` and triggers struct lowering, suppress it for
  these specific static callees.

**File: `src/runtime.ts` — `_installIteratorHelperPolyfills` zip/concat**
- The polyfill's `_getFlattenable` (line 488) and `concat` arg validation
  (line 655-667) test `obj[Symbol.iterator]` / `obj.next`. A **compiled
  generator** passed to `Iterator.concat(g())` is a real JS object whose
  `[Symbol.iterator]` is inherited from `_getIteratorPrototype()` — after the
  bridge it resolves fine. But a **WasmGC struct iterable** passed in (custom
  `[Symbol.iterator]` returning a closure struct) will fail
  `typeof sym === "function"`. Add a `_isWasmStruct(obj)` branch in
  `_getFlattenable` mirroring the `__iterator` host import (lines 7254-7270):
  invoke the struct's `@@iterator`/closure via `__call_fn_0` /
  `__call_@@iterator` from `callbackState.getExports()`. This is what makes
  "argument is not iterable" go away for the struct-iterable inputs.
  (NOTE: `_installIteratorHelperPolyfills` currently has no `callbackState`
  param — thread it through from `buildImports`, or move the flattenable-coerce
  into a closure that captures `callbackState` like the other env imports.)

### Slice sequence (each net-positive, independently shippable)

**Slice 1 — Bridge (`_getIteratorPrototype` → host `Iterator.prototype`).**
- `src/runtime.ts` only: link the compiler-built proto to
  `globalThis.Iterator.prototype` in `_installIteratorHelperPolyfills`
  (host-mode) + the compiler-owned helper-set fallback (no-host).
- **Proves out:** `g().map(f)` and `g().filter(f)` resolve and run. This is
  Bug A, the highest-volume symptom. Banks the bulk of #1340/#1464's
  prototype/map + prototype/filter buckets that were "shipped but unresolved."
- **Acceptance for the slice:** `(function*(){ yield 1; yield 2; })().map(x => x*2).toArray()`
  returns `[2,4]`; `built-ins/Iterator/prototype/map/*` and `.../filter/*`
  net-positive. No generator/for-of regression (the link only *adds*
  resolvable methods up-chain; `[Symbol.iterator]` identity is preserved).

**Slice 2 — `flatMap` + remaining prototype helpers fall out.**
- With the chain linked, `flatMap`/`take`/`drop`/`every`/`some`/`find`/
  `reduce`/`forEach`/`toArray` resolve to the host natives (or the
  compiler-owned fallback set). Add any missing fallback implementations for
  hosts that lack a given ES2025 helper. `flatMap is not a function`
  (#1718, ~31 tests) → 0.
- **Acceptance:** `built-ins/Iterator/prototype/flatMap/*` net-positive;
  no regression in Slice 1's buckets.

**Slice 3 — `Iterator.from`/`concat`/`zip`/`zipKeyed` null-deref (Bug B).**
- `src/codegen/statements/loops.ts` + `calls.ts`: route static
  `Iterator.*` results through the opaque `__iterator` path; add the missing
  null guard before `$IteratorResult` `struct.get`.
- `src/runtime.ts`: `_getFlattenable` WasmGC-struct branch so struct iterables
  stop reporting "not iterable."
- **Acceptance:** `for (const x of Iterator.from(it))` no longer null-derefs;
  `built-ins/Iterator/from/*`, `concat/*`, `zip/*`, `zipKeyed/*`
  net-positive (#1718 targets ≥40 of ~70 concat/zip).

**Slice 4 — close + trap-order polish (#1464 residual).**
- Argument-validation trap order (`Iterator.prototype.map.call(badNext, …)`
  must throw before reading `next`; abrupt completion must call underlying
  `return()`). Largely satisfied by the host natives once the chain is
  linked; the compiler-owned fallback set must replicate the
  check-callable-first / close-on-abrupt order. Small, optional, net-positive.

### Standalone forward-compat (do not block on it)

The bridge's **design point** is the single `_getIteratorPrototype()` object.
When the native `$Iterator` track (#1665a/b/c) lands, the native generator's
`next` funcref struct still produces JS-visible iterator objects only at the
host boundary; the *helper resolution* continues to go through this one
prototype object. Keep all helper installation centralized in
`_installIteratorHelperPolyfills` so the standalone path (compiler-owned
fallback set) and the host path share one code path and one prototype
identity. Do **not** copy host methods onto the proto as own properties
(breaks `verifyProperty` descriptor tests and forks the two modes) — always
link via prototype so resolution is lazy and single-sourced.

### Risks

- **Touches generator + for-of codegen (Slice 3).** Highest regression
  surface. Mitigate: Slice 1 & 2 are **runtime-only** (`src/runtime.ts`) and
  carry near-zero codegen risk — land them first and independently. Slice 3 is
  the only codegen change; gate it behind a full-CI net ≥ 0 and specifically
  watch `built-ins/Iterator/`, `language/statements/for-of/`, and
  `language/expressions/generators/` buckets.
- **`Object.setPrototypeOf` on the cached proto** changes identity-sensitive
  walks. Verify `getPrototypeOf(getPrototypeOf(g.prototype))` still returns
  *our* `%IteratorPrototype%` object (the comment at lines 124-129 / #1639) —
  it does, because we re-base *our* object rather than replacing it. Add a
  unit assertion for this exact chain.
- **Host without ES2025 helpers** (older Node/V8): the
  `setPrototypeOf(proto, globalThis.Iterator.prototype)` link gains nothing if
  the host proto itself lacks `map`. The compiler-owned fallback set (Slice 1/2)
  is what actually guarantees the methods exist — install it whenever a given
  helper is missing on the host proto, not only when `globalThis.Iterator` is
  entirely absent. Probe `typeof I.prototype.map === "function"` per-method.
- **`callbackState` threading** into `_installIteratorHelperPolyfills` for the
  `_getFlattenable` struct branch — keep it optional (the struct branch is a
  no-op without exports), so the polyfill stays callable in the existing
  unconditional `buildImports` call site.

### Files

- `src/runtime.ts` — `_getIteratorPrototype` (L131), `_getGeneratorPrototype`
  (L188), `_installIteratorHelperPolyfills` (L480, `_getFlattenable` L488,
  `_makeHelperIterator` L507, zip/concat L517-707), `__create_generator`
  (L7163), `__iterator` (L7248, struct branch L7254-7298), `buildImports`
  call site (L8822).
- `src/codegen/statements/loops.ts` — for-of subject classification +
  `$IteratorResult` `ref.cast` / `emitNullGuard` (the #1620 wiring).
- `src/codegen/expressions/calls.ts` — `BUILTIN_CLASS_NAMES` (L137),
  `Iterator.*` static dispatch result typing.

### Test files to verify

- `test/built-ins/Iterator/prototype/map/*.js`, `.../filter/*.js`
  (Slice 1 — proves the bridge)
- `test/built-ins/Iterator/prototype/flatMap/callable.js`,
  `.../flatMap/flattens-iterable.js` (Slice 2)
- `test/built-ins/Iterator/from/iterable-primitives.js`,
  `test/built-ins/Iterator/concat/fresh-iterator-result.js`,
  `test/built-ins/Iterator/concat/get-iterator-method-only-once.js`,
  `test/built-ins/Iterator/zipKeyed/options.js`,
  `test/built-ins/Iterator/zip/option-strict-mode.js` (Slice 3)
- `test/built-ins/Iterator/prototype/filter/argument-order.js`,
  `.../filter/return-on-abrupt-completion.js` (Slice 4)
- Local unit: a `function*` whose `.map(f).toArray()` round-trips, and
  `Object.getPrototypeOf(Object.getPrototypeOf(g.prototype))` identity
  assertion (regression guard for the `setPrototypeOf` re-base).

## Implementation update — 2026-06-03

Landed the iterator-prototype bridge slice, not the full standalone-native
generator state machine:

- `src/runtime.ts` now links the compiler-owned `%IteratorPrototype%` to the
  helper-bearing `Iterator.prototype` when the host provides one, preserving
  the object identity that generator-prototype tests inspect.
- The same install path now creates a compiler-owned `Iterator` fallback when
  the host lacks one and installs missing prototype helpers
  (`map`, `filter`, `take`, `drop`, `flatMap`, `toArray`, `forEach`, `some`,
  `every`, `find`, `reduce`) per method.
- `src/codegen/host-import-allowlist.ts` now assigns the `__gen_*` /
  `__create_generator*` entries to #1665 instead of the stale #1376 IR
  fallback gate.
- `tests/issue-1665.test.ts` covers compiled generator `.map(...).toArray()`,
  the `%IteratorPrototype%` re-base identity, and the allowlist ownership.

Scoped validation:

- `node node_modules/vitest/dist/cli.js run tests/issue-1665.test.ts`
- `node node_modules/vitest/dist/cli.js run tests/issue-1665.test.ts tests/issue-1639.test.ts tests/issue-1718-flatmap.test.ts tests/host-import-allowlist-gate.test.ts`

Remaining standalone work:

- The eager JS-host generator scheduler remains in place; `__gen_*` and
  `__create_generator*` are still allowlisted until the shared native
  `$Iterator` / generator state-machine lowering lands.
- A mis-scoped `pnpm test -- tests/issue-1665.test.ts` run invoked the broad
  suite, reported unrelated existing failures, and ended with a Vitest worker
  OOM. The direct scoped commands above passed.

## Senior-dev recon — 2026-06-03 (standalone native track de-risked + ALLOCATED)

Re-examined the standalone-native track on fresh `origin/main`
(`acbfad032`). Prereqs are met: #1664 (task #91) and #1666 (task #135) are
`done`. Tech-lead allocated the native-generator track to sd-1665.

### The host-import leak is GONE — it is now a hard compile error

`function*` + `for (const x of gen())` under `--target wasi` no longer
*leaks* `__gen_*` / `__iterator*` imports. It hits the `#681` gate
(`src/codegen/statements/loops.ts:3424`; IR twin `src/ir/integration.ts:1245`)
and **fails to compile**. This **invalidates the prior stop-reason #2**
("native eager would be silently wrong → worse than the honest host leak"):
there is no leak anymore. The eager model is *already* what host mode ships
(`closures.ts:2120` runs the body to completion at creation), so a native
eager port makes standalone **equivalent to host** — a strict improvement.
The state-machine/CPS rewrite remains the long-term fix but is orthogonal.

### The native `$Iterator` struct shape ALREADY validates today

`compileForOfDirectIterator` (`loops.ts:3078`) is a complete pure-Wasm
for-of driver. Verified: a hand-written
`class Range { [Symbol.iterator]() { return { next() {…} } } }` compiles
`--target wasi` to a **valid** module with zero `__iterator*` imports. So
#1665a's shared native iterator interface is the de-facto contract that path
already consumes; generators need to *emit into it*.

The driver resolves the contract **by name**: an iterable struct named
`$X` needs a `${X}_@@iterator` func (returns a `ref`/`ref_null` iterator
struct), the iterator struct `$I` needs a `${I}_next` func (returns a
`ref`/`ref_null` result struct), and the result struct needs fields literally
named `done` (i32 or f64) and `value` (loop element type), discoverable via
`ctx.structFields.get("${I}_next_result")` or `findStructFieldsByTypeIdx`.

### Decomposition (allocated, multi-PR)

- **N1 (native generator value):** lower `function*` to a WasmGC
  `$Generator` struct `{ items: (array (mut anyref)), len: i32, index: i32,
  pendingThrow: anyref }`; port the 14 helpers at `index.ts:6930-7027`
  (`__gen_create_buffer`, `__gen_push_{f64,i32,ref}`, `__gen_yield_star`,
  `__create_generator`, `__gen_next/return/throw`, `__gen_result_*`) to
  native funcs in `addUnionImportsAsNativeFuncs` (`index.ts:7459`), reusing
  the `__box_number`/`__box_boolean` precedent.
- **N2 (preferred):** give `$Generator` the `@@iterator`/`next`/`{value,done}`
  triple so it flows through `compileForOfDirectIterator` — **no `#681` gate
  change**, and Map/Set (#1103) reuse the same path.
- **N3:** `.next()`/`.return()`/`.throw()` call sites read the native struct.
- Then drop the `__gen_*`/`__create_generator*` allowlist entries
  (`host-import-allowlist.ts:287-304`). Async generators stay deferred.

### Constraint
Hard rule from tech-lead: do NOT regress the iterator cluster. Land
incrementally per slice (PR → CI → self-merge). Keep `status` until a native
slice actually lands.
