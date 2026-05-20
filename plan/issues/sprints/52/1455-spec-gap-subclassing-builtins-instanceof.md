---
id: 1455
sprint: 52
title: "spec gap: subclassing builtins — instanceof and prototype chain (class Sub extends Map / Float32Array / WeakMap / …)"
status: suspended
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, builtins, prototype-chain
goal: spec-completeness
related: [1364, 1366]
---
# #1455 — Subclassing builtins: `instanceof Sub` and `instanceof Parent` must both pass

## Problem

When a user class extends a builtin (e.g.
`class Sub extends Map {}`), instances of `Sub` must satisfy
**both** `instance instanceof Sub` **and**
`instance instanceof Map` (§10.2.1 / §9.1.6 / §22.1.2.1). The
constructor call routes through `Reflect.Construct(Builtin, args, new.target)`
so the new object's `[[Prototype]]` is `Sub.prototype`, and walking the
chain reaches `Map.prototype` → `Object.prototype`.

Today, after `let s = new Sub()`:

- `s instanceof Sub` is **false**
- `s instanceof Map` may be true (the externref carries the JS
  builtin's prototype) but `Sub.prototype` is never inserted into the
  chain.

Sample failures:

```js
class Subclass extends Map {}
const sub = new Subclass();
assert(sub instanceof Subclass);    // fails
assert(sub instanceof Map);
```

## Failure count

**~58 fails** across `language/expressions/class/subclass-builtins/`
and `language/statements/class/subclass-builtins/`. Affected
parents (sample):

- `Map`, `WeakMap`, `WeakSet`, `WeakRef`, `Set`
- `Uint8ClampedArray`, `Float32Array`, `Float64Array`, and the rest
  of the TypedArray hierarchy
- `DataView`, `ArrayBuffer`, `SharedArrayBuffer` (some skipped)
- `Promise`, `AggregateError`
- All `Error` subclasses (`SyntaxError`, `EvalError`, etc.) +
  `verifyProperty` on `.message`

Some of these are tangled with #1364 (descriptor fidelity on subclassed
Error) but the `instanceof` failure is independent.

## Root cause

`src/codegen/class-bodies.ts:931-947` emits the implicit-super path for
externref-backed subclasses by calling `__new_<Parent>(null)` — this
returns an externref carrying a real JS `Map`/`Float32Array`/etc.
instance, then stores it as the `Sub` instance.

But the instance's `[[Prototype]]` is the builtin's prototype, not
`Sub.prototype`. The spec wants:

```js
Object.setPrototypeOf(newInstance, Sub.prototype);
```

after the super-call returns (the equivalent of `Reflect.Construct`'s
`newTarget` parameter). We never set the prototype, so
`instanceof Sub` walks: `instance.[[Prototype]] = Map.prototype` →
`Object.prototype` → null — never hits `Sub.prototype`.

Additionally, for `Sub` declared with `class Sub extends Map { method() {} }`,
the methods on `Sub.prototype` are unreachable from instances created
through the builtin constructor — even if you call `s.method`, our
prototype chain look-up doesn't find it.

## Implementation strategy

1. After the implicit (or explicit) `super(...)` call inside an
   externref-backed subclass constructor, emit a
   `Object.setPrototypeOf(thisLocal, Sub.prototype)` equivalent —
   either via a host import (`__set_prototype_of(externref, externref)`)
   or via direct JS-builtin wiring (the new instance is a JS object,
   so the runtime can call `Object.setPrototypeOf` natively).
2. Register `Sub.prototype` as a real JS object when the class is
   declared — populated with `Sub`'s methods (including inherited
   ones via `Object.setPrototypeOf(Sub.prototype, Parent.prototype)`).
3. Fix `instanceof` lookup to walk the externref's actual `[[Prototype]]`
   chain. Currently `instanceof` for subclasses of builtins likely
   compares the class struct, not the prototype.

There is overlap with #1366 (subclass-extern-backed support). Verify
which path is already in place vs missing.

## Acceptance criteria

1. `test/language/expressions/class/subclass-builtins/subclass-Map.js`
   passes.
2. `test/language/expressions/class/subclass-builtins/subclass-Float32Array.js`
   passes.
3. `test/language/expressions/class/subclass-builtins/subclass-WeakRef.js`
   passes.
4. `test/language/expressions/class/subclass-builtins/subclass-DataView.js`
   passes.
5. `test/language/expressions/class/subclass-builtins/subclass-Uint8ClampedArray.js`
   passes.
6. Sub-of-builtin instance method calls work: `class X extends Map { mine() { return 1; } }; new X().mine() === 1`.
7. Total `subclass-builtins/` fails reduce by **≥ 40**.

## Files to inspect

- `src/codegen/class-bodies.ts:880-947` — externref-backed
  constructor path, `__new_<Parent>` call.
- `src/codegen/class-bodies.ts` — class methods on `Sub.prototype`
  registration.
- `src/codegen/expressions/new-super.ts` — `super(...)` call
  emission and `new.target` plumbing.
- `src/codegen/expressions/identifiers.ts` — `instanceof`
  implementation (search for `__instanceof` or `ref.test`).
- `src/runtime.ts` — possibly add `__set_prototype_of` and
  `__instanceof_chain` host imports.
- `tests/issue-1455.test.ts` — focused subclass-builtin cases.

## Out of scope

- `Promise` subclassing thenable resolution semantics (deeper async
  spec).
- `Symbol.species` overriding `Array.prototype.map` etc. return
  type (separate, sparse failure set).
- `instance instanceof` cross-realm shenanigans.

## Implementation

Three coordinated changes land the `instance instanceof Sub` fix without
disturbing existing externref-backed Error subclassing (#1366a):

1. **Runtime registry of synthetic subclasses (`src/runtime.ts`)**.
   - New host import `__set_subclass_proto(instance, subName, parentName)
     -> externref` is called by the subclass constructor after
     `__new_<Parent>(...)` returns. It lazily creates a `class Sub extends
     Parent {}` JS subclass, caches it in `_subclassCtors` (a `Map<string,
     Function[]>` so name collisions across test fixtures don't shadow each
     other), and `Object.setPrototypeOf(instance, Sub.prototype)`. The cache
     is bucketed because vitest reuses module state and the same `Subclass`
     name appears with different parents across tests.
   - Updated `__instanceof(v, name)` first consults the registry and tries
     each bucket entry; only when nothing matches does it fall back to
     `globalThis[name]` (the legacy path for direct builtin `instanceof`).
   - `builtinCtors` resolver now exposes `Date` plus all TypedArrays and
     `SharedArrayBuffer` so `__new_<TypedArray>` resolves without "No
     dependency provided for extern class".

2. **Codegen: emit `__set_subclass_proto` calls
   (`src/codegen/class-bodies.ts`)**.
   - New helper `emitSetSubclassProto(ctx, fctx, selfLocal, subName,
     parentName)` pushes the instance externref, the two name strings, calls
     the host import, and stores the (still-same) externref back into the
     self local. A `ref.is_null` guard skips the call on the standalone path
     where the import is unavailable.
   - Helper is invoked from both the implicit-super path (no-ctor subclass
     of a builtin) and the explicit-super path inside `compileSuperCall`
     for any class in `classExternrefBackedSet`.

3. **Builtin parent registry (`src/codegen/builtin-tags.ts`)**.
   - `BUILTIN_TYPE_TAGS` now covers `WeakRef`, all TypedArrays, and the
     wrapper types (`Boolean`, `Number`, `String`). They're added solely so
     `isBuiltinTypeName(parentName)` returns true for them.
   - `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` is extended with the same set
     plus `DataView` and `SharedArrayBuffer`, routing them through the
     externref-backed constructor path so `__set_subclass_proto` actually
     fires.

4. **Instanceof dispatch (`src/codegen/expressions.ts` + `identifiers.ts`)**.
   - The static-resolution branch for externref-backed RHS used to emit
     constant 0 when LHS type was unresolvable; it now falls through to
     `compileHostInstanceOf`, which calls `__instanceof(v, name)` so the
     registry walk decides at runtime.
   - `compileHostInstanceOf` maps RHS identifier text through
     `classExprNameMap` so `const Sub = class extends Map {}` lookups go
     against the synthetic name that `__set_subclass_proto` registered.

## Test Results

- `tests/issue-1455.test.ts`: 10 tests across Map, Float32Array, WeakRef,
  Uint8ClampedArray, Set, WeakMap and an Error regression — all pass.
- `tests/issue-1366a.test.ts` and `tests/issue-1366b.test.ts` (existing
  Error / Map / Array / Set / Promise / WeakMap suites): all pass — no
  regression to the static-fast-path or runtime hooks.
- Test262 sweep over `language/{statements,expressions}/class/subclass-builtins/`:
  **60 / 64** scripts now pass (excluding the four out-of-scope skips
  Function / Object / Promise / NativeError). Remaining 4 fails per folder:
  - `subclass-AggregateError.js`: AggregateError requires an iterable arg
    — orthogonal to the instanceof fix.
  - `subclass-DataView.js`: needs a real `ArrayBuffer` externref but the
    compiler short-circuits `new ArrayBuffer(N)` to a Wasm-native vec
    struct (`new-super.ts:2303`). Separate ArrayBuffer-codegen issue.
  - `subclass-WeakRef.js`: implicit `super()` passes null to `new
    WeakRef()`, which is invalid. Needs a follow-up that threads a real
    target.

This satisfies AC1 (Map), AC2 (Float32Array), AC5 (Uint8ClampedArray),
AC6 (instance method dispatch), and AC7 (≥40 fewer fails — closer to
~50 fewer based on the sweep). AC3 (WeakRef) and AC4 (DataView) hit
upstream argument-passing issues that are out of scope for the
prototype-chain fix.

## Suspended Work

- **PR**: https://github.com/loopdive/js2wasm/pull/384
- **Branch**: `issue-1455-builtin-subclass`
- **Worktree**: `/workspace/.claude/worktrees/issue-1455-builtin-subclass/`
- **HEAD SHA**: `96c1b16b0bd5cd9e3fd23538c0588f0c4f7182ac`
- **State**: PR open, branch merged with origin/main, pushed. Waiting on
  CI Test262 Sharded gate (`.claude/ci-status/pr-384.json`).

### What was implemented

Three coordinated changes (full detail in `## Implementation` above):

1. `src/runtime.ts` — new `__set_subclass_proto` host import; bucketed
   `_subclassCtors` registry; updated `__instanceof` to consult registry
   before `globalThis`; added Date / TypedArrays / SharedArrayBuffer to
   `builtinCtors`.
2. `src/codegen/class-bodies.ts` — new `emitSetSubclassProto` helper
   wired into both implicit-super and explicit-super paths.
3. `src/codegen/builtin-tags.ts` —
   `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` extended with WeakRef, DataView,
   SharedArrayBuffer, every TypedArray, plus Boolean/Number/String/Date.
   `BUILTIN_TYPE_TAGS` extended with WeakRef + TypedArrays + wrappers.
4. `src/codegen/expressions.ts` + `src/codegen/expressions/identifiers.ts`
   — instanceof dispatch falls through to host call when LHS is
   unresolvable; `compileHostInstanceOf` maps RHS through
   `classExprNameMap` for class-expression alias support.

### Test status (local)

- `tests/issue-1455.test.ts`: 10 tests pass.
- `tests/issue-1366a.test.ts` + `tests/issue-1366b.test.ts`: green (no
  regression in existing Error / Array / Map / Set / Promise / WeakMap
  subclass paths).
- test262 sweep over `language/{statements,expressions}/class/subclass-builtins/`:
  **60/64** pass. Remaining 4: AggregateError (needs iterable arg),
  DataView (needs real ArrayBuffer externref — out of scope), WeakRef
  (implicit super passes null target).

### Resume steps

1. Check CI status: `cat /workspace/.claude/ci-status/pr-384.json` (SHA
   must match `96c1b16b0bd5cd9e3fd23538c0588f0c4f7182ac`).
2. If CI green and gates pass (`net_per_test > 0`, ratio <10%, no bucket
   >50): `gh pr merge 384 --merge --admin`.
3. If gates fail or regression: read `.claude/ci-status/pr-384.json`,
   run `/dev-self-merge 384`, follow ESCALATE protocol.
4. Post-merge: remove worktree
   (`git worktree remove /workspace/.claude/worktrees/issue-1455-builtin-subclass`)
   and mark task #17 (`#1455`) completed.
