---
id: 3231
title: "Standalone: native DisposableStack (sync) — replace host imports with a WasmGC class"
status: done
assignee: ttraenkler/opus-dispose
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: 71
horizon: l
related: [830, 1433, 1695, 2861, 2860, 3132]
umbrella: 2860
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/property-access.ts
  - src/codegen/closures.ts
  - src/codegen/index.ts
---

# Standalone: native DisposableStack (sync) — WasmGC class

## Problem

In `--target standalone` the `DisposableStack` / `AsyncDisposableStack` **class**
(constructor + `use`/`adopt`/`defer`/`move`/`dispose`/`disposed`) is entirely
host imports (`DisposableStack_new`, `DisposableStack_use`, …). Any test that
`new DisposableStack()`s and calls a method leaks the host import and fails at
instantiation. The `using`/`await using` statements and `.prototype`/`.length`/
`.name` value reads are already native (#2861 glue); the method *bodies* degrade
to a catchable TypeError. Callbacks route through host `__make_callback`
(closures.ts:1419/1475).

## Measured flip-count (test262, current main)

- DisposableStack: 91 files → **47 behavioral** (construct+call) currently leaky;
  44 descriptor-only already pass via #2861. Host passes 77/91.
- AsyncDisposableStack: 52 files → 10 behavioral (Phase 2), 42 descriptor-only.
- Sampled 25 DS behavioral → 18 are DS-host-leak-ONLY (rest are harness artifacts).
- **Realistic sync flip: ~21 (conservative) to ~35-40.** No cheap subset: 26 need
  disposed-throw, 11 LIFO order, 7 SuppressedError aggregation.

## Scope

**Phase 1 (this issue): native SYNC DisposableStack.** AsyncDisposableStack
(`disposeAsync` → Promise, async `[Symbol.asyncDispose]`) is Phase 2, gated on
opus-asyncgen (#3132).

## Implementation Plan

1. Backing WasmGC struct: `{ disposed: i32, entries: vec }`. Each entry = a native
   closure struct (funcref + captured env) + optional captured `value` (adopt/use).
2. Native method bodies, `ctx.standalone`-gated, host lane byte-identical:
   - `new DisposableStack()` → alloc, disposed=0, empty vec.
   - `use(value)` → null/undefined passthrough; runtime `value[Symbol.dispose]`
     lookup (TypeError if not callable, no trap); store bound entry; return value;
     throw if disposed.
   - `adopt(value, onDispose)` → store (onDispose, value); return value; throw if disposed.
   - `defer(onDispose)` → store (onDispose); throw if disposed.
   - `move()` → new struct, transfer vec, mark this disposed; return new stack; throw if disposed.
   - `dispose()` / `[Symbol.dispose]` → if disposed return; set disposed=1; run
     entries LIFO via `__call_fn_N`; each runs even if a prior threw; chain errors
     into a native SuppressedError.
   - `disposed` getter → boolean.
3. Native SuppressedError struct (error, suppressed, message) for aggregation.
4. Switch DisposableStack use/adopt/defer off host `__make_callback` onto native
   closure-struct storage when `ctx.standalone`.

## Architecture (substrate map — de-risked 2026-07-13)

**Model on `src/codegen/map-runtime.ts`** (but far simpler — plain entry array,
no hashing/buckets/iterators). New file `src/codegen/disposable-runtime.ts`.

**Types** (`ensureDisposableStackTypes`, mirrors `ensureMapRuntimeTypes`):
- `$DisposeEntry`: struct { callback: externref(mut); value: anyref(mut); kind: i32 }
  — kind 0=defer `cb()` via `__call_fn_0`; 1=adopt `cb(value)` via `__call_fn_1`;
  2=use `value[Symbol.dispose]()` via `__call_fn_method_0(value, method)`.
- `$DisposeEntries`: array (mut (ref null $DisposeEntry)).
- `$DisposableStack`: struct { disposed: i32(mut); entries: ref(mut $DisposeEntries); count: i32(mut) }.

**The funcIdx-ordering crux → reserve/fill driver** (established pattern:
`src/codegen/accessor-driver.ts` `reserve*`/`fill*`). The dispose loop must
invoke HETEROGENEOUS stored closures, which only `__call_fn_N` /
`__call_fn_method_N` (funcref-type dispatch, emitted LATE at finalize) can do.
So reserve `__disposablestack_dispose(stackExternref)` early (placeholder body so
`.dispose()` sites can `call` its funcIdx), then FILL its body at finalize once
`__call_fn_0/1`/`__call_fn_method_0` exist: cast → $DisposableStack; if disposed
return; set disposed=1; loop i=count-1..0 LIFO: switch entry.kind → the right
`__call_fn*`; wrap each in try/catch; aggregate multiple throws into a native
SuppressedError (single throw rethrown as-is).

**Method intercept** — `tryCompileNativeDisposableStackMethodCall` in
`src/codegen/expressions/extern.ts` (add before the generic host fallthrough at
line ~126, gated `ctx.nativeStrings`, mirroring the Map/Set arms at 61/89):
- `dispose`/`[Symbol.dispose]` → `call __disposablestack_dispose`.
- `defer(cb)` → disposed? throw ReferenceError; append entry{cb,null,0}. cb must
  compile as a first-class CLOSURE (flip the standalone exclusion in
  `closures.ts:1419/1475` + `DEFERRED_CALLBACK_METHODS_BY_CLASS`), not `__make_callback`.
- `adopt(value,cb)` → disposed? throw ReferenceError; append entry{cb,value,1}; return value.
- `use(value)` → disposed? throw ReferenceError; null/undefined passthrough; else
  extract `value[Symbol.dispose]` REUSING the `using`-statement native disposer
  read (already host-free in standalone — see repro); TypeError if not object /
  missing / not callable; append entry{method,value,2}; return value.
- `move()` → disposed? throw ReferenceError; new $DisposableStack, copy
  entries+count, this.disposed=1; return new stack.

**`new DisposableStack()`** — intercept in `src/codegen/expressions/new-super.ts`
`compileNewExpression` (mirrors native `new Map()`): alloc $DisposableStack{0, new
$DisposeEntries(cap), 0}. **`disposed` getter** — intercept in
`property-access.ts` next to `tryCompileNativeMapSizeGet` (line 6827): return
disposed i32 as boolean.

**Native SuppressedError** — 3-field struct {error, suppressed, message}; needed
by the 7 aggregation tests (host `__new_SuppressedError` leaks in standalone).

**Staging if budget-bound**: 1a = types + new + defer + adopt + dispose(LIFO +
SuppressedError) + move + disposed-throw + [Symbol.dispose] (~26 flips, all
self-contained). 1b = `use()` Symbol.dispose extraction/validation (~14 flips,
reuses `using` substrate). Async = Phase 2 (#3132).

## Test plan

`tests/issue-3231-standalone-native-disposablestack.test.ts` — construct/disposed,
use/adopt/defer LIFO, move transfer, disposed-throw, SuppressedError aggregation;
host lane byte-identical; NET≥0 merge_group standalone floor.

## Landed (Phase 1a — PR #3009)

`src/codegen/disposable-runtime.ts` (new) + wiring in `expressions/extern.ts`
(method dispatch), `expressions/new-super.ts` (`new`), `property-access.ts`
(`disposed` getter), `closures.ts` (native-closure gate for defer/adopt),
`index.ts` (finalize fill). Externref-carried `$DisposableStack` struct; disposer
callbacks stored as WasmGC closures + invoked LIFO via a reserve/fill driver
calling `__call_fn_0`/`__call_fn_1` (funcIdx resolved from `mod.exports` — the
`__call_fn_N` exports are NOT in `funcMap`, unlike `__call_fn_method_N`). Host lane
proven byte-identical. 11 local tests green; no Map-native / #2029 regression.

## Landed (Phase 1b)

**`use(value)` — native dynamic `[Symbol.dispose]` lookup.** `DisposableStack.
prototype.use` is now host-free in standalone/nativeStrings. Implementation
(`src/codegen/disposable-runtime.ts` `compileNativeDisposableStackUse` +
`ensureDisposableStackCheckActive`, plus a third dispatch arm in
`fillDisposableStackDisposeDriver`; wired in `expressions/extern.ts`):

- Spec order: RequireInternalSlot + disposed-throw (ReferenceError) FIRST — even
  for `use(null)`/`use(undefined)` on a disposed stack — via the new
  `__disposablestack_check_active` helper; then null/undefined value → passthrough
  (no resource added); else `GetMethod(value, @@dispose)`.
- The method is read ONCE at `use()` time via `__extern_get(value,
  __box_symbol(13))` over the native `$Object` substrate (the same substrate the
  object-literal writer stores `[Symbol.dispose]` methods into — `literals.ts`).
  A non-object receiver / missing / null / undefined method → TypeError (the
  spec's two distinct TypeError sources collapse to one observable result).
- Stored as `ENTRY_KIND_USE` (kind 2); the dispose loop invokes
  `__call_fn_method_0(value, method)` so the disposer's `this` binds to the used
  value. Interleaves correctly with defer/adopt in LIFO order.
- Nullish detection is regime-independent (`ref.is_null` ∨ `__extern_is_undefined`)
  because `__extern_is_nullish` exists only under the undefined-singleton regime.
- Host lane byte-identical (gc/host `use()` still emits `DisposableStack_use`).
  9 new local tests; no #2029/#2861/#1433/#1695 regression.

## Phase 1b follow-ups (still host-fallthrough / NET-neutral — not regressions)

- **SuppressedError multi-error aggregation** (7 tests) — the dispose loop must run
  every disposer even when a prior threw, chaining into a native `SuppressedError`
  (`.error`/`.suppressed` with object identity + nesting). Needs: `SuppressedError`
  in `BUILTIN_TYPE_TAGS` (+ Error parent) so `instanceof SuppressedError` resolves
  (today it hits the degenerate "unknown class → false" arm); a native
  `__new_SuppressedError` ctor storing error+suppressed (via the `$Error_struct`
  `$props` sidecar for identity); and try/catch (`op: "try"`, `js-errors` `$exc`
  tag) per disposer in `fillDisposableStackDisposeDriver` with reverse-accumulation.
  Self-contained but multi-file; deferred to keep this PR to the `use()` slice.
- **`returns-value` / identity tests** are blocked by a PRE-EXISTING object-identity
  gap, NOT by `use()`: `x === r` returns `false` for ANY object carrying a
  symbol-keyed member in standalone (`{a:1}` identity works; `{[Symbol.dispose](){}}`
  does not — verified on this base). `use()` returns the correct value; the `===`
  substrate is the blocker (tag-5/tag-6 boxing family). Separate value-rep issue.
- **defer-in-a-loop closures** — a loop-body arrow passed to `defer` does not run at
  dispose. Root-caused to a GENERAL mutable-capture-in-loop closure bug, NOT
  disposable-specific: an array of loop-created closures that write an outer
  captured variable also loses the writes (`Array<()=>void>` pushed in a `for`
  loop, invoked later, returns 0). Explicit defers past capacity work. Needs its
  own issue against the closure-capture substrate — out of scope here.
- `AsyncDisposableStack` (`disposeAsync` → Promise) — Phase 2, gated on #3132.
- `stack[Symbol.dispose]()` element-access call (vs `.dispose()`).
