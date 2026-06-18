---
id: 2193
title: "standalone: builtin .prototype / static-property value reads refuse (~83 tests) — register $NativeProto glue for Array/Object/Promise"
status: in-progress
assignee: ttraenkler/sdev-proxy3
sprint: Backlog
created: 2026-06-18
updated: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
language_feature: builtins, reflection
goal: standalone-mode
related: [2175, 1907, 1888]
origin: "2026-06-18 — #43 standalone failure-bucket harvest (2nd-biggest tractable bucket, ~83)"
---

# #2193 — standalone builtin `.prototype` / static-property value reads

## Problem

Reading a builtin's `.prototype` (or a static property) **as a value** refuses in
standalone:

```ts
const p = Array.prototype; // Codegen error: Array.prototype ... not supported (#1907 / #1888 S6-b)
const q = Object.prototype; // same
const f = arr[Symbol.iterator]; // Symbol.iterator built-in static property value read ...
const r = Promise.resolve; // Promise.resolve ... not supported
```

Confirmed live on current main (`Array.prototype` / `Object.prototype` both CE).

## Root cause

`property-access.ts:~2304` resolves a `<Builtin>.prototype` value read via
`tryEnsureNativeProtoBrand(ctx, builtinName)` + `emitLazyNativeProtoGet` — but
`tryEnsureNativeProtoBrand` only returns a brand for builtins whose
**`NativeProtoBuiltinGlue` is already registered** (`getNativeProtoBuiltinGlue`).
Only **RegExp** registers glue today (`ensureRegExpNativeProtoGlue`,
regexp-standalone.ts). `Array` (brand `BUILTIN_BRAND_BASE+2`) and `Object`
(`+18`) have **reserved brands but no glue**, so the read falls to
`reportUnsupportedStandaloneBuiltinValueRead`.

## Bucket (from the #43 harvest, 06-12 standalone JSONL, epics excluded)

~83 standalone failures: `Array.prototype` value read (25) + `Symbol.iterator`
read (40, many async-gen-adjacent — those stay blocked on #1373b) +
`Object.prototype` (11) + `Promise.resolve` (7). The non-async slice is the
genuinely tractable portion.

## Implementation plan

Model on `ensureRegExpNativeProtoGlue` (regexp-standalone.ts:1968) +
`emitRegExpProtoMemberBody`:

1. **`ensureArrayNativeProtoGlue(ctx)`** (new, in array-methods.ts or a new
   `array-native-proto.ts`): `getBuiltinBrand(ctx,"Array")`, build a
   `memberCsv` of `Array.prototype`'s own method names
   (`at,concat,copyWithin,…,values,@@iterator`), `memberKind` (all `method`
   except none — Array.prototype has no accessors except `@@unscopables` data),
   `memberLength` from the spec arities, and `emitMemberBody(c,fctx,member,kind)`
   that runs a brand-recovery prologue on the externref `this` (recover the
   `$ObjVec`/array backing) then **delegates to the existing native array-method
   lowering** (`compileArrayMethodCall`-equivalent body) where one exists, and
   returns `null` (graceful refusal) for not-yet-native members. Call it from
   `tryEnsureNativeProtoBrand` (add an `Array` arm beside the `RegExp` one).
2. **`ensureObjectNativeProtoGlue(ctx)`**: same shape for `Object.prototype`
   (`hasOwnProperty,isPrototypeOf,propertyIsEnumerable,toString,valueOf,
toLocaleString`). Bodies are small; `hasOwnProperty`/`toString`/`valueOf`
   already have native standalone forms to delegate to.
3. **`arr[Symbol.iterator]` value read** (computed `@@iterator` member): route
   through the same `$NativeProto` member lookup so the iterator-protocol value
   read resolves host-free. (Overlaps task #42/#18 — the iterator consumer.)
4. **`tryEnsureNativeProtoBrand`**: replace the RegExp-only special-case with a
   small dispatch table `{ RegExp: ensureRegExp…, Array: ensureArray…, Object:
ensureObject… }` so any registered builtin resolves.

**Dual-mode:** host mode is unaffected (`__get_builtin` path stays). Pure Wasm,
no new host import. Reuse existing native method lowerings — do NOT hand-roll a
parallel array/object method matrix (respect the coercion-drift gate #2108 and
the any-box gate).

## Acceptance criteria

- `const p = Array.prototype` / `Object.prototype` compile + read a stable
  `$NativeProto` externref standalone (reference identity:
  `Array.prototype === Array.prototype`).
- `Array.prototype.slice` / `arr[Symbol.iterator]` as values resolve to a
  closure (callable where the member body is native; graceful refusal otherwise).
- The standalone `built-ins/Array/prototype/*` + `Object/prototype/*` value-read
  failures drop; RegExp proto reflection (#2175) stays green.
- No host-import leak; tsc + prettier + coercion + any-box gates clean.

## Notes

This is a sizable multi-method registration (Array.prototype alone has ~30
members). Recommend slicing: PR-A `Array.prototype` value read + `@@iterator`

- the 4–6 already-native methods; PR-B `Object.prototype`; PR-C the remaining
  Array methods. The harvest ranked this the 2nd-biggest tractable bucket (#43).

## PR-A (2026-06-18, sdev-proxy3) — the proto OBJECT value reads

**Landed (this PR).** `Array.prototype` AND `Object.prototype` value reads now
resolve to a host-free `$NativeProto` object in standalone, with reference
identity, instead of the hard compile refusal. New module
`src/codegen/array-object-proto.ts` registers lightweight `NativeProtoBuiltinGlue`
for both (proto member-name CSV + brand name); `tryEnsureNativeProtoBrand`
(property-access.ts) gains `Array`/`Object` arms beside the existing `RegExp`
one. **Key insight:** `emitLazyNativeProtoGet` builds the `$NativeProto` struct
purely from `glue.memberCsv` + `glue.name` and NEVER calls `emitMemberBody`, so
the value-read object works immediately with just the CSV; per-member native
closure bodies are deferred to PR-C and degrade to a catchable TypeError (not a
compile refusal) meanwhile.

High-value side effect: `Object.prototype.hasOwnProperty.call(o, key)` — the
frequent `assert(Object.prototype.hasOwnProperty.call(...))` idiom (>=12 in the
harvest) — now compiles + runs (the inner `Object.prototype` read no longer
refuses).

Verified: 7/7 `tests/issue-2193-builtin-proto-value-read.test.ts`; 17/17
existing #2175 native-proto suites unchanged; coercion + any-box gates clean;
no host-import leak.

**Remaining (PR-B/PR-C, issue stays in-progress):** per-member native closure
bodies for Array/Object.prototype (delegate to existing array/object-method
lowering); `arr[Symbol.iterator]` computed read; `Promise.resolve` static read.

## PR-B scoping finding (2026-06-18, sdev-json3) — needs a local-driven array-method entry first

Investigated the `emitMemberBody` wiring for Array.prototype member CLOSURES. The
crux: `emitMemberBody`'s body runs on RUNTIME values — `this` is closure-param 1
(externref), args at 2.. — but EVERY existing array-method lowering is **AST-driven**:
- `compileArrayMethodCall` (array-methods.ts:2557) takes `propAccess`/`callExpr`/
  `receiverTsType` and even synthesizes `syntheticPropAccess`/`syntheticCall` AST nodes
  internally (1910-1924) to route array-likes;
- the per-method helpers (`compileArraySlice` 4497, `compileArrayJoin` 4959, …) each
  call `compileExpression(ctx, fctx, propAccess.expression)` to materialise the receiver.

So a closure body (which has a recovered externref `this` local, not an AST receiver)
cannot delegate to these as-is. The RegExp precedent (`emitRegExpProtoMemberBody`)
works because it calls **struct-local-driven** helpers (`emitRegExpTestFromLocals`,
`emitRegExpReflectionFieldRead`) that take recovered locals — Array has NO such
local-driven variants.

**PR-B therefore needs a prerequisite refactor:** extract the body of each target
array method (after the `compileExpression(receiver)` line) into a
`compileArray<Method>FromVecLocal(ctx, fctx, vecLocal, argLocals…)` entry, then have
`emitArrayProtoMemberBody` (1) recover the `$ObjVec`/vec from the externref `this`,
(2) lower closure args 2.. into locals, (3) call the local-driven entry. This is the
"sizable / dedicated-session" work the spec flagged — it touches the hot array-method
lowering surface, so it must be floor-gated hard (the #1673 discipline) and is not a
quick slice (even a 1-method first cut needs the local-driven entry-point refactor).

Recommendation: PR-B as its own focused session — refactor ONE method (e.g. `slice`)
to a `*FromVecLocal` entry + wire `emitArrayProtoMemberBody` for it end-to-end (proves
the closure-this → local-driven bridge), floor-gate, then expand method-by-method.
Branch `issue-2193-pr-b` is set up on current main (incl PR-A #1685); claim released
for a clean-context pass.
