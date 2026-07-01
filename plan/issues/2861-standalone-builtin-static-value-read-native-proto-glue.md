---
id: 2861
title: "Standalone: built-in static/prototype property value read not supported — extend native-proto glue (ArrayBuffer, DataView, Promise, Iterator, Error subclasses, …)"
status: done
completed: 2026-07-02
assignee: ttraenkler/fable-dev
created: 2026-06-30
updated: 2026-07-02
priority: high
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 1907, 1888, 2175, 2651, 2193]
umbrella: 2860
---

# Standalone: built-in static/prototype property VALUE read refused — extend native-proto glue

## Problem

In `--target standalone`, reading a built-in's static property or a
`<Builtin>.prototype.<member>` as a **first-class value** (not calling it)
refuses with:

```
Codegen error: <Builtin>.<prop> built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b). Add a native built-in
method closure for this pair.
```

This is a **pure compile-error** cluster (the module never builds), so every
affected test is host-pass / standalone-CE. It is the single largest
compile-error cluster in the standalone gap.

### Impact (measured 2026-06-30, host vs standalone baseline jsonl)

**~882 standalone-only failures** carry this signature. Breakdown by builtin
(top of the residual — these are the ones with NO native-proto glue yet):

| builtin           | tests | builtin                              | tests |
| ----------------- | ----- | ------------------------------------ | ----- |
| ArrayBuffer       | 166   | Atomics                              | 33    |
| DataView          | 89    | SharedArrayBuffer                    | 29    |
| Promise           | 78    | DisposableStack                      | 27    |
| Iterator          | 65    | AsyncDisposableStack                 | 25    |
| Math              | 59    | Symbol                               | 16    |
| TypeError         | 42    | JSON                                 | 16    |
| Object (residual) | 41    | Reflect                              | 13    |
| Array (residual)  | 26    | WeakRef                              | 11    |
|                   |       | FinalizationRegistry                 | 10    |
|                   |       | Error subclasses (Range/Reference/…) | ~30   |

(The `<View>.prototype` TypedArray residual already has glue via #2651; these
are the still-unwired builtins.)

## Completion (2026-07-02)

Landed across several slices. Earlier PRs (2340/2341/2344) wired ArrayBuffer,
DataView, Promise, Iterator, the NativeError subclasses, SharedArrayBuffer,
WeakRef, and FinalizationRegistry. The **final residual slice** (this PR) wires
the Explicit-Resource-Management stacks and ES2026 error aggregation:

- `DisposableStack.prototype` — `dispose`/`use`/`adopt`/`defer`/`move` methods +
  the `disposed` accessor getter (brand slot 41, `makeGlueWithGetters`).
- `AsyncDisposableStack.prototype` — same shape with `disposeAsync` (slot 42).
- `SuppressedError.prototype` — reuses the shared NativeError glue (Error
  subclass; slot 43).

Measured standalone flips (host-pass → standalone-pass): DisposableStack +30,
AsyncDisposableStack +20, SuppressedError +5 (**+55**). Standalone-only change
(arms reached only from `ctx.standalone`-gated proto-value-read/meta paths);
host mode unchanged; purely additive (new brand slots + exact-name arms), so no
regression to the 42 existing native-proto tests.

The namespace static reads (`Math.PI`, `JSON.stringify`, `Reflect.get`,
`Atomics.add`) remain a separate follow-up per the "namespace static reads"
sub-case below — they do not go through `$NativeProto` proto glue.

## Root cause

`tryEnsureNativeProtoBrand` (`src/codegen/property-access.ts:696`) maps a
builtin name to a registered `$NativeProto` brand + glue. It already wires
Array, Object, String, Number, Boolean, Date, Error, Map, Set, Function,
Symbol, BigInt, WeakMap, WeakSet, RegExp, and the TypedArray views. Builtins
**not** in that switch fall through to
`reportUnsupportedStandaloneBuiltinValueRead` (`property-access.ts:624`), which
emits the refusal.

The glue is cheap: a `$NativeProto` value object is materialized from the
glue's `memberCsv` + `name` only — `emitLazyNativeProtoGet` never calls
`emitMemberBody` for a plain value read. Reflective member-CLOSURE reads degrade
to a **catchable TypeError** until a native body lands (the established #2193 /
#2651 pattern). So wiring a builtin's glue flips the value-read CE to a working
value object without needing every method body implemented.

## Implementation Plan

### Pattern to follow (already used for Error/Map/Set, `array-object-proto.ts:661`)

```ts
export function ensureArrayBufferNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "ArrayBuffer");
  if (brand === undefined) return undefined;
  if (!getNativeProtoBuiltinGlue(ctx, brand)) {
    registerNativeProtoBuiltin(ctx, makeGlue(ctx, brand, "ArrayBuffer", ARRAYBUFFER_PROTO_METHODS));
  }
  return brand;
}
```

### Changes

**File: `src/codegen/array-object-proto.ts`**

- Add a `*_PROTO_METHODS` member list per builtin (the spec'd
  `<Builtin>.prototype` own enumerable + standard method/getter names — pull
  from the ES spec / the host-mode member set; getters like `ArrayBuffer.prototype.byteLength`,
  `DataView.prototype.byteLength/buffer/byteOffset` must be marked `memberKind: "getter"`
  so `.length` meta folds to 0, see `makeTypedArrayGlue` at line 570 for the getter pattern).
- Add `ensure<Builtin>NativeProtoGlue` for each, mirroring `ensureErrorNativeProtoGlue`
  (line 661). Reuse `makeGlue` (line 536); for builtins with accessor getters,
  add a `makeGlue`-variant that takes a getter-name set (model on `makeTypedArrayGlue`).
- Member bodies degrade to `emitProtoMemberBodyRefusal` (catchable TypeError) —
  do NOT implement every method body in this issue. The value-read object only
  needs the member CSV.

**File: `src/codegen/property-access.ts`**

- In `tryEnsureNativeProtoBrand` (line 696), add a `if (builtinName === "ArrayBuffer") return ensureArrayBufferNativeProtoGlue(ctx);`
  arm per newly-wired builtin, before the final `getBuiltinBrand` fallthrough (line 781).
- Order by impact: ArrayBuffer, DataView, Promise, Iterator, then the Error
  subclasses (TypeError/RangeError/ReferenceError/SyntaxError/EvalError/URIError —
  these likely already share the `Error` glue brand; verify `getBuiltinBrand`
  returns a brand for each, or alias them to the Error glue member set).

### Sub-case: namespace static reads (Math.PI, JSON.stringify, Reflect.get, Atomics.add)

`Math`, `JSON`, `Reflect`, `Atomics` are **namespaces**, not ctors — the read is
`Math.LN2` (a static data prop), not `Math.prototype.x`. These do NOT go through
`$NativeProto` proto-glue. Handle them in a **separate follow-up** (note in
umbrella #2860): emit the constant value directly for the data props
(Math.PI/LN2/…) and a native static-method closure for the methods. **Scope THIS
issue to the ctor/prototype value reads** (ArrayBuffer, DataView, Promise,
Iterator, Error subclasses, WeakRef, FinalizationRegistry, DisposableStack,
AsyncDisposableStack) — ~700 of the 882. Math/JSON/Reflect/Atomics (~120) split out.

### Edge cases

- A builtin whose ctor brand isn't reserved (`getBuiltinBrand` returns
  `undefined`) → return `undefined` (caller keeps the refusal — no fabricated
  value). Confirm ArrayBuffer/DataView/Promise/Iterator brands ARE reserved
  (they're real ctors; if not reserved, the brand reservation must be added
  first — check `BUILTIN_CTOR_NAMES` includes them in property-access.ts:818).
- Shadowed builtin identifier (`const ArrayBuffer = …`) → `isShadowed` guard
  already handles it (property-access.ts:819/854).
- Promise proto glue was **deliberately excluded** for instance reads in #1907
  (a runtime null-deref in a passing Promise test — async-capability state
  collides with the value-read path, see property-access.ts:736-739 comment).
  For Promise, wire ONLY the static `.prototype` VALUE read (pure value object,
  `emitLazyNativeProtoGet` never touches runtime state) and re-run the Promise
  tests to confirm no regression before keeping it; if it re-traps, drop Promise
  from this issue and defer to a dedicated investigation.

## Test plan

These standalone-CE tests must flip to **pass** (host already passes them):

- `test/built-ins/ArrayBuffer/prototype/**` (byteLength getter, slice, etc.)
- `test/built-ins/DataView/prototype/**` (byteLength/buffer/byteOffset getters)
- `test/built-ins/Promise/prototype/**` (finally/then/catch name+length reads)
- `test/built-ins/Iterator/prototype/**`
- `test/built-ins/{TypeError,RangeError,ReferenceError}/**` prototype reads
- `test/built-ins/Boolean/S15.6.3_A3.js` (`Boolean.length`)

Validation: full `merge_group` (test262 merge shard reports) + standalone-floor
high-water (`check-standalone-highwater.mjs`). Expect a net standalone pass gain
of several hundred with **zero** host-mode regression (these paths are
`ctx.standalone`-gated).

## Reconciliation note (shepherd, 2026-07-01)

Landed slices (native-proto glue wired, verified present in `src/codegen/`): **ArrayBuffer, DataView** (PR #2340), **Promise, Iterator, NativeError subclasses** (PR #2341), **SharedArrayBuffer, WeakRef, FinalizationRegistry** (PR #2344). **Remaining (issue stays `ready`)**: `DisposableStack` / `AsyncDisposableStack` proto glue not yet wired (no `ensureDisposableStack*NativeProtoGlue` in source), plus the `Math`/`JSON`/`Reflect`/`Atomics` namespace static reads explicitly split out per the Implementation Plan.
