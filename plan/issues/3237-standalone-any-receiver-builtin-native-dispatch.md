---
id: 3237
title: "Standalone: any-receiver dispatch for builtin-native methods (DisposableStack/Map/Set/…) leaks host imports"
status: ready
created: 2026-07-13
updated: 2026-07-13
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: methods, dynamic-dispatch, disposablestack
goal: standalone
related: [2151, 3231, 3234]
umbrella: 1781
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
