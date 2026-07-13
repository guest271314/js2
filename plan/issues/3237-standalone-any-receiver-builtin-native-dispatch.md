---
id: 3237
title: "Standalone: any-receiver dispatch for builtin-native methods (DisposableStack/Map/Set/…) leaks host imports"
status: done
assignee: opus-anyrecv2
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: methods, dynamic-dispatch, disposablestack
goal: standalone
related: [2151, 3231, 3234]
umbrella: 1781
# Slice 1 wiring: the bulk of the logic lives in the disposable-runtime.ts
# subsystem module; these two driver files grow only by the minimal dispatch
# hookup (dispose interception in tryExternClassMethodOnAny; disposed getter in
# compilePropertyAccess). Genuine, minimal growth — allowance granted per #3102.
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/expressions/calls-closures.ts
---

# Standalone: any-receiver dispatch for builtin-native methods leaks host imports

## Problem

Native builtin-runtime method dispatch is keyed on the receiver's **static
class name**, so a call on an `any`/externref receiver never takes the native
path and leaks the host import — which is unsatisfiable standalone, so the whole
module fails to instantiate.

Concretely for `DisposableStack` (`src/codegen/expressions/extern.ts:133`):

```ts
if (className === "DisposableStack" && ctx.nativeStrings) {
  const dsResult = tryCompileNativeDisposableStackMethodCall(...);
}
```

`className` comes from the receiver's TS type. When the receiver is `any`
(e.g. `let s: any = new DisposableStack(); s.defer(fn); s.dispose();`), the
native arm is skipped and `s.defer(fn)` / `s.dispose()` lower to
`DisposableStack_defer` + `__make_callback` / `DisposableStack_dispose` host
imports.

This is why the `built-ins/DisposableStack/prototype/dispose` **SuppressedError**
tests (and any dispose/defer test whose `stack` the test262 runner hoists to
`let stack: any` because it is captured in a nested closure like
`assert.throws(() => stack.dispose())`) still fail standalone even though the
native dispose driver + #3234 SuppressedError aggregation are correct — the leak
happens **before** dispose runs. This is the real ~7-flip lever the #3234 work
was a prerequisite for.

## Distinct from #2151

#2151 (DONE) closed any-receiver dispatch for **user object-literal closed
structs** (`const o: any = { next() {…} }; o.next()`). This issue is the
**builtin-native runtime** analog: the receiver is an externref-carried native
struct (`$DisposableStack`, and likely `$Map`/`$Set`/…) whose methods are
intercepted by a `className ===` gate, not the generic object-literal method
path. The two do not overlap.

## Scope (likely broader than DisposableStack)

Any native-method dispatch that keys on `className ===` for a builtin (grep
`expressions/extern.ts` + `property-access.ts` for the `className === "<Builtin>"
&& ctx.nativeStrings` arms — Map `.size`, Set `.size`, DisposableStack
`disposed`/`defer`/`adopt`/`use`/`move`/`dispose`, …). An `any`-typed receiver
should still reach the native path.

## Design sketch (to be refined by the implementer)

Runtime `ref.test`-based dispatch when the static receiver is `any`/externref
and the method name is a known native-builtin method:

- For zero-arg / value methods (`dispose`, `disposed`, `size`, `move`): emit
  `ref.test $<NativeStruct>` on the receiver; if it matches → the native op;
  else a clean TypeError (**not** the host import — the import must never be
  emitted standalone, or the module can't instantiate).
- For callback methods (`defer`/`adopt`/`use`): the callback must compile as a
  native closure (the `closures.ts` standalone gate) rather than
  `__make_callback`; that gate is currently reached only when the call is
  recognised as a native DisposableStack method. Route the any-receiver call
  through the same native path so the closure gate fires.

Gate strictly on `ctx.nativeStrings`; host lane byte-identical. Validate on the
`merge_group` standalone floor (broad-impact — never scope-check only). Slice if
it balloons past one PR (start with `dispose`/`disposed`, then the callback
methods).

## Acceptance

- `built-ins/DisposableStack/prototype/dispose/throws-error-as-is…` and the
  broader dispose/defer cluster pass standalone in the test262 runner (the ones
  gated purely by the any-receiver leak).
- No `DisposableStack_*` / `__make_callback` host import for a standalone
  DisposableStack method call regardless of receiver static type.
- Host lane byte-identical; NET ≥ 0 on the standalone floor.

## Slice 1 — DONE (PR #3023)

**Scope shipped:** `dispose()` (call) + `disposed` (accessor) on an `any`/union
receiver carrying a native `$DisposableStack`.

**Root cause confirmed (measure-first, on current main):**
- `dispose()` on an `any` receiver did NOT go through the `className ===` gate at
  `extern.ts:133` at all — an `any` receiver has no nominal symbol, so
  `isExternalDeclaredClass` is false and `compileExternMethodCall` is skipped.
  The leak actually came from the **any-receiver first-match extern loop**
  `tryExternClassMethodOnAny` (`calls-closures.ts:1463`): it iterates
  `ctx.externClasses`, first-matches `DisposableStack.dispose`, and lazily adds
  the `DisposableStack_dispose` **host import** → module fails to instantiate.
- `disposed` on an `any` receiver did NOT leak — it fell to the generic
  `__extern_get` dynamic reader (`property-access.ts`), a MISS on the non-`$Object`
  native struct → always `false` (silently wrong after dispose;
  `sets-state-to-disposed.js`).

**Why the interception is regression-safe (the key subtlety):** a user
object-literal `{ dispose(){} }` on an `any` receiver ALREADY works host-free —
the #3033 user-function-member refusal (`calls-closures.ts:1438`) fires first and
routes it to the #2151 closed-struct dispatcher. So the fix intercepts `dispose`
**after** that refusal, right before the host-import loop — exactly (and only)
where the loop would otherwise bind the host import. Both interceptions are
additionally gated on `DisposableStack` being a registered extern class, so they
are inert for programs that don't use it.

**Implementation:**
- `tryCompileNativeDisposableStackAnyMethodCall` (disposable-runtime.ts) — `dispose`
  only: `ref.test $DisposableStack` → native driver on a hit, clean TypeError on a
  miss (never the host import). Value vs statement position handled (undefined
  singleton in value position).
- `tryCompileNativeDisposableStackAnyDisposedGet` (disposable-runtime.ts) —
  `ref.test $DisposableStack` → struct disposed flag (boxed boolean) on a hit,
  generic `__extern_get` read on a miss (user object's own `.disposed` preserved).
- Wired into `tryExternClassMethodOnAny` (calls-closures.ts) and
  `compilePropertyAccess` (property-access.ts).

**Remaining (future):** the broader `Map`/`Set`/`WeakMap`/… any-receiver
`className ===` arms (out of scope here — DisposableStack-specific).

## Slice 2 — DONE (PR pending)

**Scope shipped:** the callback methods `defer(cb)` / `adopt(value, cb)` /
`use(value)` on an `any`/externref receiver, plus a value-position `undefined`
correctness fix that also covered a latent Slice-1 `dispose` bug.

**Root cause confirmed (measure-first, on current main):** a `let s: any = new
DisposableStack(); s.defer(fn)` / `s.adopt(v, fn)` / `s.use(v)` reached
`tryExternClassMethodOnAny`'s first-match extern loop and lazily bound
`env::DisposableStack_defer` / `_adopt` / `_use` HOST imports — module fails to
instantiate standalone, exactly the Slice-1 `dispose` leak for the callback
methods. (Reproduced: each leaked its sole `DisposableStack_*` import.) The
`__make_callback` bridge did NOT additionally leak — the #3235 standalone gate
already degrades the `defer`/`adopt` arrow callbacks to native first-class
closures.

**Implementation** (`disposable-runtime.ts`, gated `ctx.nativeStrings`; host lane
byte-identical because the whole path is unreachable in host mode):
- `tryCompileNativeDisposableStackAnyMethodCall` now routes `defer`/`adopt`/`use`
  to `compileNativeDisposableStackAnyCallbackMethod`.
- `compileNativeDisposableStackAnyCallbackMethod` — evaluates receiver + args ONCE
  into externref locals (call-site order), then `ref.test $DisposableStack`: hit →
  the native `__disposablestack_append` (defer/adopt) substrate; miss → a clean
  TypeError (RequireInternalSlot, §12.3.3.{2,4}) — never the host import, never a
  `ref.cast_null` trap on a non-stack ref (the append/use helpers cast externref→
  struct and would trap without the brand gate). `use` delegates to
  `compileNativeDisposableStackAnyUse`, wrapping the typed use logic
  (disposed-throw + `GetDisposeMethod(value, @@dispose)` read + conditional
  append) in the same guard; a non-stack `this` → TypeError, null/undefined
  `value` → return value with no resource added.
- **funcIdx-ordering (the crux):** every late import is registered FIRST (the
  append/check helpers → `__new_ReferenceError`; object substrate →
  `__extern_get`/`__box_symbol`/`__extern_is_undefined`); the guard TypeError's
  `buildThrowJsErrorInstrs` performs the final `flushLateImportShifts` against
  `fctx.body`; only THEN are the native helper funcIdxs re-fetched from
  `ctx.funcMap` (post-shift, final) and baked into the nested `if` arms. No late
  import registers after the re-fetch. (The value-position `emitUndefined` runs
  AFTER the `if` is in `fctx.body`, so any shift it triggers correctly updates the
  baked `appendIdx` via the recursive nested-body shifter.)

**Value-position `undefined` fix (Slice-1 defect, also affected Slice 2 `defer`):**
`dispose()`/`defer()` in value position returned a raw `ref.null.extern`, but
under the #2106 undefined-singleton regime `x === undefined` compares against the
SINGLETON, not null — so `let u = s.dispose(); u === undefined` was FALSE
(`returns-undefined.js`). Fixed to emit the canonical undefined via
`emitUndefined` (the singleton in standalone, `__get_undefined` in host). This
un-breaks the pre-existing Slice-1 `returns undefined (value position)` unit test
(deterministically red on main, but not in the `quality` CI gate's named-file
allowlist, so it never blocked main).

**Verified host-free + correct** (`tests/issue-3237-…`): defer LIFO, adopt returns
value + disposes it, use runs `value[Symbol.dispose]()`, use(null) returns value,
reverse-order dispose across all three registrars, `=== undefined` for
dispose/defer value position, user-object `defer` still routes to the #2151
closed-struct path (via the #3033 refusal), typed nominal path unchanged. No
`DisposableStack_*` / `__make_callback` import on any. This slice + the landed
#3234 SuppressedError aggregation flip the dispose-SuppressedError cluster
host-free.
