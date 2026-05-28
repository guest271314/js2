---
id: 1632
title: "spec gap: Function.prototype.bind/toString + Function/internals (175 + 7 test262 fails)"
status: done
completed: 2026-05-28
created: 2026-05-08
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: function
goal: spec-completeness
sprint: 50
renumbered_from: 1338
parent: 1328
---
# #1338 — Function objects: bind, toString, length, internals

## Problem

`built-ins/Function`: **207 / 509 (40.7%) — 301 fails** (assertion_fail=122, type_error=65,
runtime_error=43, other=30, wasm_compile=21).

`built-ins/Function/internals`: **1 / 8 (12.5%) — 7 fails**.

Spec §20.2 (Function objects) requires:
1. **`Function.prototype.bind`** (§20.2.3.2): produce a bound function whose
   - `[[BoundTargetFunction]]` is the original
   - `[[BoundThis]]` is set
   - `[[BoundArguments]]` is the partial-application arg list
   - `length` is `max(0, target.length - boundArgs.length)`
   - `name` is `"bound " + target.name`
2. **`Function.prototype.toString`** (§20.2.3.6): return either the source text or a
   `"function name() { [native code] }"` representation for built-ins.
3. **`length`** is the count of formal parameters before the first default-valued or rest param.
4. **`name`** is the binding name (or computed-property name in a class).

Current state:
- `bind` produces a callable, but `length` and `name` aren't recomputed.
- `toString` returns an opaque marker, not the original source — fails any spec test that
  parses the result with `eval`.
- `Function/internals` tests check the [[Call]] / [[Construct]] receiver semantics; we throw
  TypeError on receivers we shouldn't (e.g., calling a bound function with the wrong this).

## Acceptance criteria

1. `built-ins/Function/prototype/bind/length.js` passes.
2. `built-ins/Function/prototype/bind/name.js` passes.
3. `built-ins/Function/prototype/bind/instance-name.js` passes.
4. `built-ins/Function/prototype/toString/built-in-function-object.js` passes.
5. Pass-rate for `built-ins/Function` rises from 40.7% to ≥65%.

## Files to modify

- `src/codegen/closures.ts` — bind closure struct (add length/name fields)
- `src/codegen/index.ts` — function metadata (length, name, source)
- `src/runtime.ts` — `__function_to_string` (returns source or native marker)

## Implementation Plan

### Root cause

`bind` is implemented as a thin externref wrapper that forwards to host `Function.prototype.bind`
when the receiver is externref, and as a closure-allocating Wasm helper for typed functions —
but the typed helper allocates a generic closure struct with no `length` or `name` fields,
so accessing them returns the **target's** values (wrong by spec).

`toString` for compiled-Wasm functions has no source-text reference (the source is parsed and
then discarded). We need to either:
1. Keep the source-text alive in a string table, or
2. Re-emit a synthetic `"function name() { [native code] }"`.

### Approach

1. Extend the bound-function closure struct with `length: i32` and `name: ref string` fields.
   Compute them at the bind callsite when arg count is statically known; otherwise emit an
   inline computation.
2. For `toString`, store a per-function source-text string in a side-table indexed by function
   index. Load it on demand in `__function_to_string`. Fall back to `[native code]` for
   imported/host functions.

### Edge cases

- bind on arrow function (no `this` binding) — bind succeeds; the resulting `this` is ignored.
- bind on a class constructor — must be callable with `new`.
- name on anonymous function (let f = function(){}) is the binding name `"f"`.

### Test262 sample

- `test262/test/built-ins/Function/prototype/bind/length.js`
- `test262/test/built-ins/Function/prototype/toString/built-in-function-object.js`

## Investigation 2026-05-27 (issue-1318-v2 / dev-1608)

Smoke-tested current main (`a619649a`) against the three target buckets via
`runTest262File`:

| Bucket | Pass / Total |
|--------|--------------|
| `built-ins/Function/prototype/bind` | **34 / 100** (66 fail) |
| `built-ins/Function/prototype/toString` | **67 / 80** (13 fail) |
| `built-ins/Function/internals` | **3 / 8** (5 fail — Proxy/realm, hard) |

The acceptance-criteria probes are **already split**: `bind/length.js`,
`bind/name.js` already PASS (they test `Function.prototype.bind`'s OWN
`.length===1`/`.name==="bind"`, which the codegen resolves). What FAILS is
`bind/instance-name.js` — the **bound function's** `.name` must be
`"bound target"` (criterion 3).

### Root cause confirmed — identity-bind is the blocker

`fn.bind(...)` lowers via the **identity-bind** path at
`src/codegen/expressions/calls.ts:2068`: it drops all bind args and returns the
**target receiver externref unchanged** (an intentional documented
simplification). Consequences, all confirmed by probe:

- `target.bind().name` → `"target"` (should be `"bound target"`) — the bound
  object IS the target, so it carries the target's name.
- `target.bind(undefined,1).length` → `0` (should be recomputed
  `max(0, target.length - boundArgs.length)`) — the result is plain externref,
  losing the TS call signatures the `.length` branch
  (`property-access.ts:1552`) needs.
- `target.bind(undefined,5)()` → RUNERR — the externref isn't a real callable
  bound function with `[[BoundArguments]]` prepending.

These three are NOT independently fixable on the identity-bind path: correct
`.name`/`.length`/`[[Call]]`/`[[Construct]]` all require the bound function to
be a **distinct object** carrying its own metadata. 19 of the 66 bind fails
also need `[[Construct]]` (`new`/`instanceof`).

### A localized hack is not viable

Prepending `"bound "` only when `.name` is accessed directly on a `bind()`
call-expression would fix exactly one shape (`target.bind().name`) and miss the
dominant via-local form (`const b = target.bind(); b.name`), which has already
collapsed to the target externref by the time `.name` is read. It would not
touch `.length` or call semantics. Net test262 movement ≈ 1, with fragility
risk. Rejected.

### toString sub-bucket (13 fail) is a separate feature

The `prototype/toString` failures need **verbatim source-text retention**
(including interior comments like `async f /* a */ ( /* b */ )`) or a
`[native code]` form that matches the `NativeFunction` grammar in
`nativeFunctionMatcher.js`. Two are `compile_error` on async/getter
class-expression parsing. This is orthogonal to bind and warrants its own
sub-issue.

### Recommendation — ESCALATE for architect spec, then carve

The load-bearing change is the **bound-function representation**, which is a
real WasmGC design decision (matches the issue's own `feasibility: medium /
reasoning_effort: high` and "Files to modify" list spanning `closures.ts` +
`index.ts` + `runtime.ts`). Suggested carve:

1. **#1632a — bound-function object** (architect spec needed): WasmGC closure
   struct (or host-`Function.prototype.bind` delegation in JS mode) carrying
   `[[BoundTargetFunction]]`/`[[BoundThis]]`/`[[BoundArguments]]` + recomputed
   `length`/`name` (`"bound "` prefix) + `[[Call]]`/`[[Construct]]`. Closes the
   bulk of the 66 bind fails. The JS-host-delegation angle is attractive but
   blocked by the fact that a compiled local `var f = function(){}` is a WasmGC
   closure, not a host callable — so the host's real `bind` can't be applied
   without first wrapping the closure as a host function (see `_wrapForHost`,
   `src/runtime.ts:2118`).
2. **#1632b — Function.prototype.toString source retention** (13 fail):
   per-function verbatim source slice in a side-table, surfaced by
   `__function_to_string`.
3. **#1632 internals** (5 fail): Proxy/realm `[[Call]]`/`[[Construct]]`
   receiver semantics — likely defer (Proxy is a skip-filter feature).

No code change landed; reverted worktree to clean. Recommend re-routing #1632
to architect for the #1632a spec before any dev implementation.

## Implementation Plan (#1632a — bound-function representation)

### Goal

Replace the identity-bind hack at
`src/codegen/expressions/calls.ts:2069-2087` with a real **bound-function
object**: a distinct externref carrying `[[BoundTargetFunction]]`,
`[[BoundThis]]`, `[[BoundArguments]]`, recomputed `length`, and recomputed
`name = "bound " + target.name`. Property access (`.name`, `.length`),
direct call, and `new` on the bound value must all observe the spec.

### Representation decision — host-side bound functions, NOT a new WasmGC struct

The naive answer is "add a Wasm `$BoundFunction_struct` with the four
internal slots, define a `__call_bound_fn_<arity>` export that prepends
`[[BoundArguments]]`, and have callsites dispatch through it." We reject
that for these reasons:

1. **Targets are already heterogeneous at the call site.** `fn.bind(...)`
   receives one of: (a) a Wasm closure struct (typed function literal /
   arrow / named func expr), (b) a class method extracted via
   `C.prototype.m`, (c) a host JS function value (handed to user code by
   `Reflect.get`, an external import, etc.), (d) a host-wrapped closure
   produced by `_wrapForHost`. Any Wasm-side struct would have to dispatch
   into all four target shapes — re-implementing what `Function.prototype.bind`
   on the host already does for free.
2. **Spec semantics for `.name`/`.length` are observable from JS.** Tests
   like `bind/instance-name.js`, `bind/length.js`, and the
   `instanceof`-checks all run on a JS-host value path (`__extern_get`).
   The host already returns the spec-correct `.name`/`.length` for
   `Function.prototype.bind`'s result; we'd be re-deriving these inside
   Wasm only to push them back out as externref strings.
3. **`[[Construct]]` on a bound function** must invoke the target's
   `[[Construct]]`. Host `Function.prototype.bind` does this; a Wasm
   struct path would need a parallel `__construct_bound_fn` machinery
   that ultimately funnels back into `Reflect.construct` against the
   target — wasted plumbing.
4. **Existing precedent.** `_wrapForHost` (runtime.ts:8097) and
   `_wrapWasmClosure` (runtime.ts:946) already round-trip Wasm closures
   through host JS functions when host code needs `[[Call]]`. A bound
   function is the natural extension: bind the **host-wrapped** target,
   not the raw Wasm struct.

So the spec is: **lower `fn.bind(thisArg, ...partialArgs)` to a host
import `__bind_function(target, thisArg, argsArray)` that returns a real
JS `BoundFunction` exotic via `Function.prototype.bind.call(...)`** —
wrapping the target as a host-callable first when needed. The result is
a regular JS Function externref; `.name`/`.length`/`.call`/`new` all
observe spec automatically.

### Spec citations

- ECMA-262 §20.2.3.2 **Function.prototype.bind(thisArg, ...args)**
  — performs `? BoundFunctionCreate(F, thisArg, args)`, sets
  `length = max(0, F.[[Length]] - args.length)` (after `HasOwnProperty`
  check), sets `name = "bound " + F.[[Name]]` (string-prepend), and
  copies `[[Prototype]]` from F.
- §10.4.1 **Bound Function Exotic Objects** — defines
  `[[BoundTargetFunction]]`, `[[BoundThis]]`, `[[BoundArguments]]`, and
  the `[[Call]]` / `[[Construct]]` essential internal methods that
  prepend `[[BoundArguments]]` before delegating to the target.
- §20.2.4.2 **Function.prototype.length** — own data property,
  configurable: true, value computed at bind time.
- §20.2.4.5 **Function.prototype.name** — own data property,
  configurable: true.

Host `Function.prototype.bind.call(target, thisArg, ...args)` performs
**all of the above** when `target` is a JS-callable. Our job is to make
sure `target` IS a JS-callable before calling host bind.

### Host import contract

```
(import "env" "__bind_function"
  (func (param externref)   ;; target — Wasm closure struct OR host fn
        (param externref)   ;; thisArg
        (param externref)   ;; argsArray — JS Array built via __js_array_new
        (result externref)));; the BoundFunction exotic (real JS function)
```

Runtime binding (add to `src/runtime.ts` next to `__reflect_apply`,
~line 5478):

```ts
if (name === "__bind_function")
  return (target: any, thisArg: any, args: any): any => {
    const exports = callbackState?.getExports();
    // 1. Target must be JS-callable. _maybeWrapCallable handles WasmGC
    //    closure structs by wrapping them via __call_fn_<arity>. For
    //    bind, arity is read off the target if available — but the
    //    wrapper handles excess/missing args, so passing the closure's
    //    declared param count is sufficient. Read it from a side-table
    //    populated at codegen time (see "Closure metadata table" below)
    //    or default to 0 (host fn.bind will still work since real Function
    //    bind uses [[Call]] regardless of declared arity).
    let callableTarget: any = target;
    if (_isWasmStruct(target)) {
      const arity = _closureArity(target, exports) ?? 0;
      callableTarget = _wrapWasmClosure(target, arity, callbackState) ?? target;
      if (typeof callableTarget !== "function") {
        throw new TypeError("Function.prototype.bind called on non-callable");
      }
      // Preserve target's spec-name on the wrapper so the bound
      // function's name is "bound <originalName>", not "bound ".
      const origName = _closureName(target, exports) ?? "";
      try {
        Object.defineProperty(callableTarget, "name", {
          value: origName,
          configurable: true,
        });
        Object.defineProperty(callableTarget, "length", {
          value: arity,
          configurable: true,
        });
      } catch { /* readonly host envs */ }
    }
    if (typeof callableTarget !== "function") {
      throw new TypeError("Function.prototype.bind called on non-callable");
    }
    // 2. argsArray is the JS Array of partial args built by codegen via
    //    __js_array_new + __js_array_push, OR ref.null.extern for the
    //    zero-partial-args case. CreateListFromArrayLike is unnecessary
    //    because we control the array shape.
    const partial: any[] = Array.isArray(args) ? args : [];
    // 3. Delegate to host bind. The host computes length/name per spec.
    return Function.prototype.bind.apply(callableTarget, [thisArg, ...partial]);
  };
```

`_closureArity` and `_closureName` are new helpers — see
"Closure metadata table" below. If they can't resolve, default to `0`
and `""` respectively; the result is observable but matches the existing
"function name missing" fallback that already returns `""` from
`__function_to_string`.

### Closure metadata table (codegen → runtime side-channel)

The bound-function spec needs the **target's** `name` and `length` so
the bound function's `name` is `"bound <name>"` and `length` is
`max(0, length - boundArgsLen)`. For a Wasm closure struct, those
values are not stored in the struct today — they're a property of the
emitting source function. Add a runtime-exported metadata table:

**New Wasm exports** (emitted in `src/codegen/index.ts` near the
existing `__call_fn_<arity>` block):

```
(global $__closure_meta_<i> externref (ref.null extern))  ;; one per defined closure-struct typeIdx
(func $__closure_name_for (param $c externref) (result externref) …)
(func $__closure_length_for (param $c externref) (result i32) …)
```

Or simpler: a **side-table** indexed by `closure.__brand` (a deterministic
i32 written into a new `meta` field of every closure struct). At
emission time, every closure-struct fab site (closures.ts:1497, :2729,
:2813, and the wrapper-subtype variant :1559) writes `i32.const <metaIdx>`
into the struct, where `metaIdx` indexes into a Wasm-global array of
`{ name: ref string, length: i32 }` records populated at module
top-level.

**Simpler yet — accept the cost of a host-import for metadata.** The
identity-bind hack already only fires when the TS checker resolves
`recv.getCallSignatures().length > 0`, so the codegen path has access
to the declared name and arity at the bind callsite. Pre-bake them:

**File: `src/codegen/expressions/calls.ts` (the bind lowering at 2069)**

Replace the identity-bind body with a call to a new helper
`compileFunctionBind(ctx, fctx, expr, propAccess)` that:

```ts
function compileFunctionBind(
  ctx, fctx, expr: ts.CallExpression, propAccess: ts.PropertyAccessExpression,
): ValType | null {
  const externRef: ValType = { kind: "externref" };

  // 1. Resolve the target's static name + length for the host wrapper.
  //    The receiver type may carry call signatures (TS checker), or the
  //    receiver may be an identifier we can map to a known closure.
  const targetName = resolveStaticFunctionName(ctx, propAccess.expression) ?? "";
  const targetLength = resolveStaticFunctionLength(ctx, propAccess.expression) ?? 0;
  // Both helpers do best-effort lookup against:
  //   - ctx.funcMap / ctx.funcParamCounts for known closures
  //   - the TS checker's call signatures (param count minus optional/rest)
  //   - identifier-binding lookup for `function f(){}` declarations
  // Return undefined when nothing matches; the host wrapper falls back.

  // 2. Compile the receiver as externref. Wasm closure structs become
  //    externref; host functions stay externref. Both are accepted by
  //    __bind_function.
  const recvTy = compileExpression(ctx, fctx, propAccess.expression, externRef);
  if (recvTy && recvTy.kind !== "externref") coerceType(ctx, fctx, recvTy, externRef);

  // 3. If we have a static name/length, stamp them onto the closure via a
  //    fresh host helper `__brand_closure_meta(c, name, length)` that
  //    setProperty's them. The metadata stays attached to the wrapper
  //    created by _wrapWasmClosure inside __bind_function — but we can't
  //    rely on that wrapper being identity-stable, so the cleaner path is
  //    to pass name+length to __bind_function directly. Extend the import:
  //
  //    (import "env" "__bind_function"
  //      (func (param externref)        ;; target
  //            (param externref)        ;; thisArg
  //            (param externref)        ;; argsArray
  //            (param externref)        ;; targetNameHint (string or null)
  //            (param i32)              ;; targetLengthHint (-1 = unknown)
  //            (result externref)))
  //
  // Updating the runtime signature accordingly; the host falls back to
  // _closureArity/_closureName when hints are null/-1.

  // 4. Build thisArg externref.
  const args = expr.arguments;
  if (args.length >= 1) {
    const t = compileExpression(ctx, fctx, args[0]!, externRef);
    if (t && t.kind !== "externref") coerceType(ctx, fctx, t, externRef);
    else if (t === null) fctx.body.push({ op: "ref.null.extern" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 5. Build argsArray (partial-application args, args[1..]).
  emitJsArrayFromArgs(ctx, fctx, args, 1);
  // helper exists in calls.ts — see the Reflect.apply path (line 4146)
  // and the __reflect_construct array-pack pattern.

  // 6. Push targetNameHint (string or ref.null.extern) and targetLengthHint i32.
  if (targetName) {
    fctx.body.push(...stringConstantExternrefInstrs(ctx, targetName));
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "i32.const", value: targetLength >= 0 ? targetLength : -1 });

  // 7. Call __bind_function. Result is externref (the BoundFunction).
  const externT: ValType = externRef;
  const i32T: ValType = { kind: "i32" };
  const bindIdx = ensureLateImport(
    ctx,
    "__bind_function",
    [externT, externT, externT, externT, i32T],
    [externT],
  );
  flushLateImportShifts(ctx, fctx);
  if (bindIdx === undefined) {
    // Standalone fallback: degrade to identity-bind + drop partial args
    // so user code at least gets a callable value back. Document gap.
    fctx.body.push({ op: "drop" }); // i32 length hint
    fctx.body.push({ op: "drop" }); // name hint
    fctx.body.push({ op: "drop" }); // args array
    fctx.body.push({ op: "drop" }); // thisArg
    // receiver still on stack; return it as identity-bind degraded path.
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__bind_function") ?? bindIdx });
  return externRef;
}
```

### Changes (by file)

**`src/codegen/expressions/calls.ts`**

1. Replace the identity-bind body (lines 2069–2087) with a call to
   `compileFunctionBind(ctx, fctx, expr, propAccess)`. Keep the outer
   guard (`recvHasCallSig` + `expr.parent !== CallExpression`).
2. Add the helper near the top of the file or in a new
   `src/codegen/expressions/bind.ts` (preferred — `calls.ts` is
   already 10k+ lines). If split out, re-export from calls.ts.
3. Add `resolveStaticFunctionName` and `resolveStaticFunctionLength`
   helpers (or co-locate in `bind.ts`). They probe, in order:
   - `ts.isIdentifier(expr) && ctx.funcMap.get(name)` → look up
     `ctx.funcArities.get(funcIdx)` (existing) for length; identifier
     text for name.
   - `ctx.checker.getSymbolAtLocation` for a function declaration →
     declared parameter list (count params before the first optional /
     rest / default-valued) for length; symbol name for name.
   - Call signatures from `objType.getCallSignatures()` for length
     (mirrors property-access.ts:1682 logic).
   - Otherwise `undefined` (host fallback handles it).

**`src/codegen/expressions/calls.ts` — `.call`/`.apply` path (lines 2089+)**

No change. Those are handled separately and already produce correct
behaviour for the cases that matter; the bound function returned by
`__bind_function` is a real JS function so `.call`/`.apply` on it
work via the host through the existing `__extern_method_call` path.

**`src/codegen/expressions/calls.ts` — bind followed by immediate call**

`fn.bind(a)(b)` already has a dedicated path further down (see the
exclusion comment at line 2068). That path must continue to take
precedence — the immediate-call shape is a static reduction that
doesn't need an exotic bound-function object. Verify by adding a
focused equivalence test: `(function(x){return x}).bind(null)(42)`
must compile to `f(42)` directly, not allocate a host bound function.

**`src/runtime.ts`**

1. Add the `__bind_function` import binding (~line 5478, near
   `__reflect_apply` / `__reflect_construct`). Implementation per
   the contract above.
2. Add a small `_closureArity(closure, exports)` helper that reads
   the matching `__call_fn_<arity>` from exports: probe arities 0..16
   and return the largest arity for which `exports['__call_fn_<n>']`
   exists AND would accept this closure (the call_fn_N exports use
   funcref dispatch — they all accept any closure struct; the
   "right" arity is the function's declared param count, which we
   don't have without metadata). **Pragmatic decision**: use the
   length hint passed from codegen; if the hint is `-1`, default to
   `0`. The bound function's `length` becomes `max(0, hint - partial.length)`,
   which matches spec when the hint is known and degrades gracefully
   otherwise.
3. Add `_closureName` similarly, defaulting to `""` when the hint is
   null. Spec allows `.name === ""` for anonymous functions, so this
   is conformant.

**`src/codegen/property-access.ts`**

No structural changes. The `.name`/`.length` paths at lines 1678/1771
ALREADY fall through to `__extern_get` for runtime values when static
resolution fails. The bound function is a real JS Function externref,
so `.name` and `.length` are read via the existing `__extern_get`
host path — which returns the spec-correct values that
`Function.prototype.bind` baked in.

**`src/codegen/host-import-allowlist.ts`**

Add `__bind_function` to the allowlist (mirrors `__reflect_construct`).

**`src/codegen/closures.ts`** — **no struct change required**.
The "extend closure struct with length/name fields" approach from the
original 2026-05-08 Implementation Plan is **superseded** by this
spec — the host owns the bound function, so the source closure
doesn't need new fields. Keep `closures.ts` unchanged.

### `[[Construct]]` on a bound function

`new (target.bind(null, 1, 2))(3)` → host `Function.prototype.bind`
result IS construct-compatible: its `[[Construct]]` prepends bound
args and delegates to `target.[[Construct]]`. Since the bound result
flows back to user code as externref, `new <externref>(...)` hits the
dynamic-construct path specified in #1528a (Implementation Plan in
issue 1528) — which routes to `__reflect_construct`, whose host
binding invokes `Reflect.construct` on the JS-host bound function.
That delegates to the original target's `[[Construct]]`. No new
codegen required for this case.

### Edge cases

- **bind on arrow function** — arrows ignore `this`; host
  `Function.prototype.bind` still applies the partial args. Name
  hint = `""` (arrows are typically anonymous unless bound to a
  name). Length hint = arrow's param count. ✅
- **bind on `function f(){}` declaration** — name hint = `"f"`,
  length hint = param count. Bound result has `name === "bound f"`. ✅
- **bind on `const g = function h(){}`** — named-fn-expr keeps its
  own name per spec (`name === "h"`). Name hint = `"h"`. ✅
- **bind on `function f(){}` then `f.bind(null).bind(null)`** —
  double bind. `target.[[Name]]` is already `"bound f"` after the
  first bind (a property the host set), so the second bind reads
  `name === "bound bound f"` (per spec). Host `Function.prototype.bind`
  handles this transparently. ✅
- **bind on a class method via `c.m.bind(c)`** — receiver is a
  closure-struct externref (the cached method closure from
  property-access.ts:1618 `emitCachedMethodClosureAccess`).
  `_isWasmStruct` is true → wrap via `_wrapWasmClosure`. Method
  signature includes the receiver as param 0, so the wrapper handles
  arity correctly via `__call_fn_<arity>`. ✅
- **bind on a non-callable** — receiver TS type has no call sigs →
  the outer guard at calls.ts:2071 short-circuits and falls through
  to the legacy path (which throws). Host fallback inside
  `__bind_function` also throws `TypeError` if the target isn't
  callable. ✅
- **bind partial args contain a Wasm vec or struct** — `__js_array_push`
  marshals them as externref via the existing boxing path. The host's
  `Function.prototype.bind` accepts any value type. ✅
- **`(fn.bind(null, 1))(2)` immediate call** — taken by the
  immediate-call exclusion (calls.ts:2069 condition). Static reduction
  preserved. ✅
- **`fn.bind === Function.prototype.bind` identity** — `fn.bind`
  property access on a Wasm closure returns a method bound via
  `__extern_method_call` /  `__extern_get`, NOT a stable singleton.
  The static `fn.bind(...)` call shape never observes the prop access
  in isolation. No new code required. Tests that check
  `fn.bind === Function.prototype.bind` already pass for host fns
  and don't exist for Wasm closures (Wasm closures aren't `instanceof
  Function` and have no Function.prototype chain).
- **Standalone (`--target wasi` / `noJsHost`)** — there is no
  `Function.prototype.bind` host. Degrade to identity-bind (drop
  partial args, return target unchanged), exactly mirroring the
  current behaviour. Document in a follow-up "native bind" issue
  scoped to standalone. The four hint params are dropped before
  the import call is skipped (see step 7 fallback in the helper).

### Acceptance criteria

1. `built-ins/Function/prototype/bind/length.js` passes (already does, keep).
2. `built-ins/Function/prototype/bind/name.js` passes (already does, keep).
3. **NEW** `built-ins/Function/prototype/bind/instance-name.js` passes —
   `target.bind().name === "bound target"`.
4. **NEW** `target.bind(undefined, 1).length === target.length - 1`
   for `target.length >= 1`; `=== 0` otherwise. Verified via
   `instance-length-*.js` test262 cases.
5. **NEW** `target.bind(thisArg, 1, 2)(3)` calls
   `target.call(thisArg, 1, 2, 3)` — verified by the existing
   bind-arg-threading tests that today fall to runtime errors.
6. **NEW** `new (target.bind(null, 1))(2)` constructs `new target(1, 2)`
   — routes through #1528a dynamic-construct path; both #1528a and
   #1632a must be merged before this case is fully covered. Either
   order works; the two are orthogonal at the file level (#1528a is
   `new-super.ts`, #1632a is `calls.ts` + `runtime.ts`).
7. Pass-rate for `built-ins/Function/prototype/bind` rises from 34/100
   to ≥75/100 (≥41-test delta from this slice; remainder are
   `[[Construct]]` cases gated on #1528a and Proxy/realm cases
   tracked elsewhere).
8. No regression in `built-ins/Function/prototype/bind/length.js`,
   `bind/name.js`, or `built-ins/Function/prototype/call/`,
   `prototype/apply/`, `prototype/toString/` (orthogonal — toString
   is #1632b).
9. Standalone (`--target wasi`) keeps identity-bind degraded
   behaviour — no new host import required to instantiate.

### Out of scope (carved as separate issues)

- **#1632b — Function.prototype.toString verbatim source retention**
  (~13 fails). Investigation 2026-05-27 already nominated this as a
  separate sub-issue; needs a side-table from `ts.SourceFile` slices
  into the Wasm-string-literal pool. **NOT** spec'd here; create
  follow-up issue.
- **#1632 internals** (5 Proxy/realm fails). Proxy is a skip-filter
  feature; defer.
- **Native bind in standalone** — needs a Wasm-native bound-function
  struct + `__call_bound_fn_<arity>` after all. Open as separate
  issue if a standalone target hits it. Not required for the 79-test
  Promise cluster.

### Test files to verify (canonical sample)

- `test/built-ins/Function/prototype/bind/instance-name.js` —
  `"bound " + name` prepending.
- `test/built-ins/Function/prototype/bind/instance-length.js` —
  recomputed length.
- `test/built-ins/Function/prototype/bind/instance-length-exceeds-int32.js`
  — large-arity edge.
- `test/built-ins/Function/prototype/bind/F-internal-slots-bound-function-target.js`
  — `[[BoundTargetFunction]]` introspection (works because we return a
  real JS bound function).
- `test/built-ins/Function/prototype/bind/length-set-error.js` —
  `length` configurability per spec (host `bind` already sets
  `configurable: true`).
- `test/built-ins/Function/prototype/bind/bound-function-this.js`
  — `[[BoundThis]]` semantics via host.

### Estimated impact

- 40–50 of the 66 bind fails immediately addressable via this slice
  (`.name`/`.length`/`.call` correctness).
- ~10–15 more flip via the joint #1528a + #1632a path
  (`new (bind(...))(...)`).
- ~5 remaining are Proxy/realm tests deferred under "internals".

Net: 50–65 test262 wins on `built-ins/Function/prototype/bind`,
moving pass-rate to ~75%+. Plus uncountable downstream wins from
real-world JS code that currently identity-binds and gets wrong
.name/.length back.

### Risks / open questions for the dev

1. **`_closureName` / `_closureArity` reliability.** The hint-passing
   path makes the host indifferent to closure introspection — but
   the static resolvers in codegen must NOT mis-identify a non-closure
   value as a closure (e.g. an externref reassigned from a host fn).
   The `recvHasCallSig` outer guard already filters; double-check
   with a focused test where the receiver is a TS `Function`-typed
   variable holding a host fn.
2. **Bound-function `Function.prototype` chain.** Real
   `Function.prototype.bind` sets the bound function's `[[Prototype]]`
   to `target.[[Prototype]]`. For Wasm closure targets wrapped via
   `_wrapWasmClosure`, that prototype chain is **host** `Function.prototype`
   — not whatever Wasm-side prototype the closure pretended to have.
   This is consistent with how Wasm closures already appear to host
   code (`_wrapForHost` doesn't preserve a Wasm-side prototype). Tests
   that check `Object.getPrototypeOf(bound)` will see Function.prototype.
   Accept the divergence; document in the bound-fn test bucket.
3. **GC of the wrapper closure.** `_wrapWasmClosure` creates a fresh
   JS wrapper on each call. `Function.prototype.bind` captures it in
   the BoundFunction's `[[BoundTargetFunction]]`. That keeps the
   Wasm closure alive through the externref chain — verify with a
   manual GC probe if the bound function outlives its source scope
   (no test today, but worth a focused equivalence case).
