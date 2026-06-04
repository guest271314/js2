---
id: 1320
title: "Runtime bridge: Array.from(externref) / Iterator.from(externref) doesn't preserve own [Symbol.iterator] on plain JS objects (4 test262 fails)"
status: ready
created: 2026-05-07
updated: 2026-06-04
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime+codegen
language_feature: iterators, externref, Array.from
goal: spec-conformance
sprint: 59
related: [1154, 1665, 1472, 1620, 1633, 1684]
---
# #1320 — Array.from / Iterator.from runtime bridge drops own [Symbol.iterator]

> **2026-05-29 — array-receiver case folded into the array object-value
> representation track.** The case where `Array.from` is given a **compiled
> array** whose `Array.prototype[@@iterator]` was overridden cannot be fixed at
> the runtime-bridge layer: `_materializeIterable` (`src/runtime.ts:1185`) walks
> `__vec_len`/`__vec_get` and bypasses `@@iterator` because the compiled array is
> not a host JS Array on the host prototype chain. The fix is **S3** of the
> canonical architecture spec in **#1719** (array object-value representation /
> `$ArrayObj`, the array analog of #1732's `$FuncObj`): route the array-receiver
> through the host-Array reflection so native `Array.from` walks the override.
> The existing `_drainWasmClosureIterable` closure-iterator drain is reused
> unchanged. The remaining `iter-cstm-ctor` deep case stays **gated on #1684**
> (closure-return struct readback) — orthogonal to the representation track.

## Background

Filed as a follow-up to #1154 after closing it as resolved. The original
~378 leak-cluster is fixed; 4 tests still hit the
`%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function` error, but the root
cause is **different** — they fail standalone (verified in isolation),
not from prior-test prototype poisoning.

## Failing tests

- `test/built-ins/Array/from/iter-cstm-ctor.js`
- `test/built-ins/Array/from/iter-set-length.js`
- `test/built-ins/Iterator/from/iterable-primitives.js`
- `test/built-ins/Iterator/prototype/flatMap/iterable-primitives-are-not-flattened.js`

The first two fail with the exact V8 native error. The latter two fail
with `WebAssembly.Exception` (likely the same root cause routed through
a different code path).

## Repro

```bash
npx tsx -e "
import { compile } from './src/index.ts';
import { readFileSync } from 'node:fs';
import { buildImports } from './src/runtime.ts';
const src = readFileSync('test262/test/built-ins/Array/from/iter-cstm-ctor.js', 'utf-8');
const r = compile(src, { fileName: 'test.ts', skipSemanticDiagnostics: true });
const imports = buildImports(r.imports, undefined, r.stringPool);
await WebAssembly.instantiate(r.binary, imports);
"
```

Throws synchronously from `WebAssembly.instantiate`:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

The error originates from V8's native `Array.from` inside our runtime's
host-import bridge for the compiled `Array.from(items)` call.

## Hypothesis

The test source pattern is:

```js
var items = {};
items[Symbol.iterator] = function() {
  return { next: function() { return { done: true }; } };
};
result = Array.from.call(C, items);
```

When this compiles, `items` becomes an externref (a JS object reference)
in wasm memory, and the assignment `items[Symbol.iterator] = ...` routes
through our runtime's safeSet for symbol-keyed properties.

Suspected: the safeSet path for `Symbol.iterator` on a plain JS-host
object (externref-wrapped `{}`) either:

1. Routes the assignment to a sibling property (well-known-symbol ID
   path) instead of installing an own `[Symbol.iterator]` descriptor on
   the target object, OR
2. Installs the descriptor on a wrapper that V8's `Array.from` doesn't
   see when walking `items[Symbol.iterator]`.

When the compiled `Array.from(items)` then calls into the host import,
the host invokes native `Array.from(items)`. V8 reads
`items[Symbol.iterator]`, finds either nothing or a non-function value
(inherited from `Object.prototype` after the safeSet path mis-routed),
and throws.

## Investigation start points

- `src/runtime.ts` — locate the `__safeSet` / `_safeSet` host import for
  symbol-keyed property assignment. Compare its handling of
  `Symbol.iterator` on a plain JS object vs. on a wasm-managed struct
  (`_isWasmStruct(obj)` gate referenced in the worker comment at
  test262-worker.mjs L546–554, which describes a similar miss-route
  pattern that #1160 had to defensively clean up).
- `src/codegen/expressions/calls.ts` (or wherever `Array.from` /
  `Iterator.from` is lowered) — verify the call site emits the
  externref directly without re-wrapping.

## Acceptance criteria

1. The 4 listed tests no longer throw the `%Array%.from requires...`
   error in `WebAssembly.instantiate`.
2. `iter-cstm-ctor.js` instantiates and the test body's
   `assert.sameValue(callCount, 1, ...)` passes.
3. No new regressions in tests under
   `test/built-ins/Array/from/` or `test/built-ins/Iterator/`.

## Out of scope

- Prototype-poisoning leak handling (covered by #1154 — closed).
- Any non-`Array.from` / non-`Iterator.from` symbol-iterator bugs.

## Investigation + partial fix 2026-05-27 (dev-1605)

**Root cause (confirmed, refines the hypothesis above):** the assignment
`items[Symbol.iterator] = fn` is NOT mis-routed — the key arrives at `_safeSet`
as a real `symbol` and the function is stored under the correct
`[Symbol.iterator]` slot. The real problem is that `fn` is a **compiled Wasm
closure struct** — `typeof items[Symbol.iterator] === "object"`, not
`"function"`. Native `Array.from` / `Iterator.from` read the @@iterator method,
see a non-callable object, and throw
`%Array%.from requires that … items[Symbol.iterator] … be a function`. The
iterator object the closure returns (and its `.next`) are likewise Wasm
closures, so even invoking @@iterator isn't enough — the whole protocol must be
driven through `__call_fn_0`.

**Fixed in this PR (the `__array_from` host-import path):** added a module-level
`_drainWasmClosureIterable(obj, callbackState)` in `src/runtime.ts` that, when a
plain JS object's own @@iterator is a Wasm closure, invokes it via `__call_fn_0`,
then walks the returned iterator's (also-closure) `.next`, reading
`value`/`done` via `_safeGet` + `__sget_*`. Wired into the `__array_from`
import. Result: `built-ins/Array/from/iter-set-length.js` now **PASSES** (was
FAIL). Covered by `tests/issue-1320.test.ts` (2 cases: no spurious TypeError;
@@iterator invoked exactly once).

**Residual — the other 3 listed tests need other bridge paths (NOT fixed here):**

1. `iter-cstm-ctor.js` uses `Array.from.call(C, items)` → routes through
   `__extern_method_call` (obj=`Array.from`, method=`"call"`), hits native
   `Array.from` directly. Needs the same drain applied to the `.call`/`.apply`
   dispatch where the iterable is `wrappedArgs[1]`.
2. `Iterator/from/iterable-primitives.js` + `flatMap/...` use
   `Number.prototype[Symbol.iterator] = function*(){…}` (a **generator** on a
   prototype) and `Array.from(5)` (primitive → ToObject). Different facets:
   prototype-level @@iterator + primitive coercion + `function*` lowering.

**Separate lurking codegen bug (carved to #1684):** an iterator-result object
literal returned from a *nested closure* does not round-trip across the
Wasm→host boundary. The 4 listed tests use empty/trivial iterators so they
dodge this. This overlaps the iterator bridge family (#1620 / #1633) and the
live-mirror struct-field readback (#983d).

## `.call` / `Iterator.from` blocker confirmed (2026-05-27, dev-1605)

The `.call`-path drain is correctly wired (`__extern_method_call`,
`wrappedArgs[1]`), and `_drainWasmClosureIterable` is reached for
`Array.from.call(C, items)`. Traced through the real `runTest262File`
harness with `iter-cstm-ctor.js`:

- `items` arrives as a **plain JS object** (`var items = {}`, not a wasm
  struct), passed through unwrapped — correct.
- its own `[Symbol.iterator]` IS a wasm closure struct — drain guard passes.
- `__call_fn_0` is present; the drain invokes `callFn0(iterFn)` to run the
  `@@iterator()` closure.
- **`callFn0(iterFn)` returns `null`** instead of the iterator object
  `{ next: … }`. The closure's object-literal return value does not
  materialize to the host. The drain then bails at the `iteratorObj == null`
  guard and returns `null`, so the native `Array.from.call(C, items)` runs
  with the un-drained object and throws the "items[Symbol.iterator] … must be
  a function" error.

So the residual `.call` / `Iterator.from` failures are **NOT a host-bridge
gap** — the bridge is wired and reached. They are blocked on the
**closure object-literal return readback** carved to **#1684** (a codegen-layer
bug, not a runtime-bridge one). `iter-set-length.js` PASSES because its
iterator round-trips via the already-working `__array_from` path with a
structure that does materialize.

**Recommendation:** land the `__array_from` + `.call`/`.apply` drain wiring
(regression-free, banks 1 test + focused unit tests). The remaining 3 tests
(`iter-cstm-ctor`, `Iterator/from/iterable-primitives`,
`flatMap/iterable-primitives-are-not-flattened`) are gated on **#1684**
(closure-return struct readback) — they cannot go green at the host-bridge
layer. Status `in-review` for the partial PR; residual tracked in #1684 +
the iterator-bridge family (#1620/#1633).

## Architect Spec — standalone (no-JS-host) GetIterator / IteratorStep / IteratorClose bridge (2026-06-04)

**Scope note.** The investigation above is the **JS-host** `Array.from` /
`Iterator.from` bridge (in-review, gated on #1684). This section is the
**orthogonal standalone (`--target wasi` / `nativeStrings`) iteration protocol**
the host imports cannot cover — the lead's "generic GetIterator/IteratorStep/
IteratorClose bridge for standalone." It is a distinct, dev-claimable deliverable
(sprint 59) and does NOT depend on #1684 (that's a JS-host closure-return readback
bug). Track it as sub-issue **#1320-standalone**.

### Root cause (standalone gap)

The iteration protocol is delivered by four **JS host imports** registered in
`addIteratorImports` (`src/codegen/index.ts:8035-8067`):

- `__iterator(externref) → externref` — `obj[Symbol.iterator]()`
- `__iterator_next(externref) → (i32 done, externref value)` — multi-value
  (#1620: a freshly-built `$IteratorResult` struct cannot survive the JS hop, so
  the two primitives cross the ABI instead)
- `__iterator_return(externref) → void` — IteratorClose
- `__iterator_rest(externref) → externref` — drain remainder for `[...rest]`

Under standalone/WASI there is no JS host, so any for-of / spread / array-dstr
over a **non-Array iterable** (a generator, a class with `[Symbol.iterator]`, a
Map/Set, a custom iterator) has no protocol. Today the compiler **errors out**:
`array-methods.ts:3090-3098` (`compileArrayIteratorMethod`) reports
`Codegen error: #681 standalone/WASI ... still requires JS-host iterator
helpers`. Direct-array for-of works (index loop, no imports —
`collectIteratorImports`/`index.ts:7993`), and native generators have their own
state-machine drive (`generators-native.ts`), but the **generic object-iterable
protocol** is host-only.

This is the same dual-mode-completeness gap as #1665 (native generators, DONE)
and #1472 (native open-object runtime, DONE) — both already established the
WasmGC-native runtime patterns this bridge builds on.

### Design: a native iteration protocol over compiled iterators

The protocol consumer side already exists generically (for-of loop, spread,
array-dstr all call `__iterator` / `__iterator_next` / `__iterator_return`).
The fix is to make those four operations resolve to **Wasm-native helpers**
when `ctx.standalone || ctx.wasi`, exactly mirroring the dual-mode funcMap
pattern used by `__box_bigint` (#1644), native strings (#679), native RegExp
(#682). The native helpers operate on the compiler's own iterator
representations — they do NOT need a host because a standalone iterable is
always one of a known set of compiled shapes:

1. **A compiled class instance with a `[Symbol.iterator]` method** — the method
   is a Wasm closure/method returning an iterator object (another compiled
   struct with a `.next` method). Drive via `call_ref` (the mechanism
   `_drainWasmClosureIterable` uses on the host side, but emitted as Wasm).
2. **A native generator** — already has `__gen_resume_<g>` returning
   `__NativeGeneratorResult_f64 {value:f64, done:i32}`
   (`generators-native.ts:148-167`). The bridge's `IteratorStep` reads that
   struct directly.
3. **A native Map/Set iterator** (#1103) / **$ObjVec enumeration** (#1472
   Blocker B) — already have entry-walking helpers; the bridge wraps them.
4. **A `$Vec` array** — direct index loop (already host-free).

### The native iterator-record representation

Define one GC struct that unifies the four shapes behind a `next`-style
interface, mirroring `__NativeGeneratorResult` but for the *iterator object*:

```
(type $IterRec (struct
  (field $kind i32)          ;; 0=closure-iter, 1=native-gen, 2=map/set, 3=vec
  (field $obj  (ref null any));; the underlying iterator object / gen state / vec
  (field $idx  (mut i32))))   ;; cursor for vec/map shapes
(type $IterResult (struct (field $value externref) (field $done i32)))
```

- `$IterResult` is the **internal** step result — value as externref (boxed via
  `coerceType`), done as i32. It NEVER crosses a host boundary (standalone), so
  the #1620 struct-survival problem does not apply here.

### Changes

**File: src/codegen/index.ts — `addIteratorImports` (`:8035`)**
- Split into `addIteratorImports` (JS-host, unchanged) and a new
  `ensureNativeIteratorRuntime(ctx)` that registers the four operations as
  **Wasm functions** (`registerNative`, the pattern in `object-runtime.ts`):
  `__iterator`, `__iterator_next`, `__iterator_return`, `__iterator_rest`.
  Gate the choice at the single `collectIteratorImports` call site and at any
  `addIteratorImports` caller: `if (ctx.standalone || ctx.wasi)
  ensureNativeIteratorRuntime(ctx); else addIteratorImports(ctx);`. Because the
  consumer code looks the operations up by the SAME funcMap names, no consumer
  changes are needed — they transparently bind to native fns in standalone.

**File: new src/codegen/iterator-native.ts (or fold into generators-native.ts)**
- `getOrRegisterIterRecType(ctx)` / `getOrRegisterIterResultType(ctx)` — lazy GC
  type registration (mirror `ensureNativeGeneratorResultType`,
  `generators-native.ts:148`).
- `__iterator(obj) → externref` native body — **GetIterator (§7.4.1)**:
  - `ref.test` obj against native-generator state struct → wrap kind=1.
  - `ref.test` against the class-instance struct types that have a
    `[Symbol.iterator]` method → call that method via `call_ref`, wrap the
    returned iterator object as kind=0.
  - `ref.test` against Map/Set iterator / `$ObjVec` → kind=2.
  - `ref.test` against `$Vec` → kind=3, idx=0.
  - else → `__throw_type_error` ("not iterable", §7.4.1 step 5).
  - Return the `$IterRec` (as externref via `extern.convert_any`).
- `__iterator_next(iterRec) → (i32 done, externref value)` native body —
  **IteratorStep + IteratorValue (§7.4.5/§7.4.6)**: switch on `$kind`:
  - kind=1: `__gen_resume_<g>` → read `{value,done}`; box value f64→externref.
  - kind=0: `call_ref` the iterator object's `.next` closure → read the result
    object's `value`/`done` via the open-object getter (the #1472 native
    `__extern_get_idx`/field read, NOT the host `_safeGet`).
  - kind=2: advance the Map/Set/$ObjVec cursor, read entry.
  - kind=3: `idx < $Vec.len` ? element + idx++ : done=1.
  - Keep the multi-value `(i32, externref)` shape so the consumer code is
    byte-identical to the host path.
- `__iterator_return(iterRec) → void` — **IteratorClose (§7.4.8)**: for kind=0,
  if the iterator object has a `.return` method (open-object getter lookup),
  `call_ref` it; else no-op. kinds 1/2/3 have no user `return` → no-op.
- `__iterator_rest(iterRec) → externref` — drain remaining into a fresh `$Vec`
  by looping `__iterator_next` until done; reuse the `$ObjVec`→`$Vec`
  materialization from #1472 Blocker B Slice 2.

**File: src/codegen/array-methods.ts — `compileArrayIteratorMethod` (`:3090`)**
- Replace the `reportError` standalone bailout with the native path: register
  `ensureNativeIteratorRuntime(ctx)` and emit the native `entries`/`keys`/
  `values` iterator-record over the `$Vec` (kind=3 with an index-pair shape for
  `entries`). This is the concrete consumer that the error currently blocks.

### Wasm IR pattern (IteratorStep for kind=0 closure-iterator)

```wasm
;; __iterator_next(iterRec) — kind=0 arm
local.get $rec
struct.get $IterRec $obj          ;; iterator object (ref any)
ref.cast (ref $SomeIterStruct)
;; load + call its .next closure (open-object getter or known method idx)
... call_ref $next_funcTypeIdx ... ;; → result object (ref)
local.tee $resObj
;; done = resObj.done   (open-object i32/bool field read, #1472 native getter)
... → i32 done
local.get $resObj
;; value = resObj.value (→ externref, boxed)
... → externref value
;; multi-value return (done, value)
```

### Edge cases

- **Non-iterable** → TypeError at GetIterator (§7.4.1 step 5), via the native
  `__throw_type_error` path (#1473, already standalone).
- **IteratorClose on early exit** (for-of `break` / throw): the consumer already
  calls `__iterator_return`; the native body must run the user `.return` for
  kind=0 and swallow nothing (§7.4.8 — a throw from `.return` during a normal
  close propagates; during an abrupt close the original completion wins). Flag
  this completion-precedence subtlety for the dev — it's the one place the
  native body must match §7.4.8 exactly.
- **`.next` returns a non-object** → TypeError (§7.4.5 step 3) — `ref.test` the
  result against the open-object/struct types; if it fails, throw.
- **Generators interop**: kind=1 reuses the existing native-gen drive — do NOT
  duplicate the state machine; just adapt its `{value,done}` struct to the
  `(i32,externref)` multi-value shape.

### Slice breakdown

- **Slice 1 — native runtime skeleton + `$Vec`/native-gen kinds (3 & 1).**
  `ensureNativeIteratorRuntime`, `$IterRec`/`$IterResult` types, GetIterator +
  IteratorStep for the two host-free shapes already present (Vec index loop,
  native generator). Unblocks standalone for-of/spread over arrays + generators
  and removes the `array-methods.ts:3094` error for `entries`/`keys`/`values`.
  ~180 LOC.
- **Slice 2 — closure-iterator kind (0).** Class instances / objects with a
  `[Symbol.iterator]` method driven via `call_ref` + open-object result
  readback. The standalone analog of `_drainWasmClosureIterable`. ~150 LOC.
- **Slice 3 — Map/Set/$ObjVec kind (2) + IteratorClose + rest.**
  `__iterator_return` user-`.return` dispatch, `__iterator_rest` drain. ~120 LOC.
- Slice 1 is load-bearing and independently shippable (clears the hard
  standalone error + the array-iterator-method family). 2/3 widen coverage to
  custom iterables and close.

### Test files to verify (compile with `nativeStrings:true` / `--target wasi`)

- `tests/issue-1320-standalone.test.ts`: standalone for-of over (a) array,
  (b) generator, (c) class with `[Symbol.iterator]`, (d) Map; spread `[...gen]`;
  array-dstr `const [a,b] = iterable`; early `break` runs `.return`.
- test262 under `--target wasi`: `language/statements/for-of/*`,
  `built-ins/Array/from/*`, `built-ins/Iterator/*` — confirm the standalone
  error no longer fires and direct-iterable cases pass.

### Risk / conflicts

- No new host imports — all four operations become emitted Wasm fns in
  standalone, satisfying the dual-mode rule. JS-host mode is untouched (it keeps
  the existing imports). ✓
- File overlap: `index.ts` (`addIteratorImports` split), `array-methods.ts`
  (the `:3090` error site), new `iterator-native.ts`, and the native runtime
  in `object-runtime.ts` / `generators-native.ts` it reuses. Coordinate with any
  in-flight #1665/#1472 follow-ups in the merge queue.
- Depends on (already-DONE): #1665 (native generator `{value,done}` struct),
  #1472 Blocker B (native `$Vec` build/iterate, `__extern_get_idx` native arm),
  #1473 (native throw). All merged — Slice 1 is unblocked now.
- Does NOT depend on #1684 (that gates the JS-host `iter-cstm-ctor` case, a
  different layer).
