---
id: 1567
title: "Builtin subclass prototype splice leaks side effects (TypedArray length descriptor + RegExp brand)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-27
feasibility: hard
sprint: 56
owner: senior-developer
type: fix
source: plan/issues/sprints/53/post-wave-regression-investigation.md
blocks: []
labels: [test262, regression, builtin-subclass]
---
# #1567 — Builtin subclass proto splice leaks side effects

## Background

PR #459 (commit `ca3e37094`, merge `7f38872e8`) added `__set_subclass_proto(instance, subName, parentName)` to make `instance instanceof Sub` work for class-extends-builtin. Net win on test262: ~60/64 `class/subclass-builtins/` tests, but three regressions slipped in.

## Failing tests (post-wave 2026-05-21)

1. `test/built-ins/TypedArray/prototype/length/length.js`
   - Asserts `Object.getOwnPropertyDescriptor(TypedArray.prototype, "length").get.length === 0`.
   - Now fails at `verifyProperty(desc.get, "length", { value: 0, ... })` — the getter's own Function `.length` is wrong (or the descriptor flags are wrong).
2. `test/built-ins/TypedArray/prototype/findLastIndex/BigInt/get-length-ignores-length-prop.js`
   - Does `Object.defineProperty(sample, "length", { get, configurable: true })` on a BigInt TypedArray instance returned by `new TA([42n])`.
   - Now throws `Cannot redefine property: length` at L43:3 — the instance's `length` slot is not configurable after the prototype splice.
3. `test/built-ins/RegExp/prototype/test/S15.10.6.3_A2_T8.js`
   - Stamps `RegExp.prototype.test` onto `Object.prototype`, calls it as `".".test("...")`, expects TypeError.
   - Now reaches `e instanceof TypeError !== true` — either no error was thrown or a non-TypeError leaked through. The brand check for "this is a RegExp" is regressed.

## Root cause hypothesis

`__set_subclass_proto` rewires `instance.__proto__` to the synthetic `Sub.prototype` whose `__proto__` is the parent's prototype. Side effects:

- (#1, #2) The parent's `length` descriptor may now be **re-projected onto each instance** as an own slot (when bumping through the proto chain rewrite), with `configurable: false` carried from the parent class. The original `length` on the host TypedArray instance was a per-instance non-configurable accessor; redefining required `configurable: true` which is no longer in effect after our intervention.
- (#3) The `__instanceof` host import now consults the synthetic-class registry first. When the LHS is the string `"."` rebound to call `RegExp.prototype.test`, the brand check inside `RegExp.prototype.test` (host-side) may resolve `this` through the new registry and find a fallback that doesn't throw.

## Implementation plan

Each of the three failures will need its own micro-fix; not a single root cause:

### Fix 1 — TypedArray.prototype.length getter `.length`

In `src/runtime.ts`, when registering the TypedArray prototype accessor descriptor, ensure the getter `Function.length` is set to 0 (built-in default). This is a `Object.defineProperty(getter, "length", { value: 0, configurable: true })` on the synthetic accessor we expose. Cite: spec §17 ("Every built-in Function object ... has a length property ... value equal to the largest number of named arguments").

### Fix 2 — Configurability of instance `length` after splice

In `__set_subclass_proto` (`src/runtime.ts`), do not project the parent's `length` slot onto the instance. Either:
- (a) After the prototype splice, walk the instance's own keys and ensure any keys that originated from the parent's prototype (not own slots) are removed from the instance's own keys.
- (b) Or: use `Object.setPrototypeOf(instance, syntheticProto)` directly, which does NOT copy parent keys; the failure must be in extra `Object.defineProperty` calls we make inside the helper for TypedArray. Audit those calls and gate them by `parentName === "TypedArray"` to skip when the slot is already accessible via the prototype chain.

### Fix 3 — RegExp brand check via Object.prototype call

In `src/runtime.ts`, the host import that backs `RegExp.prototype.test` (likely `__regexp_test` or routed through host call dispatcher) must verify `this` is a RegExp instance and throw TypeError otherwise. If the call site was already throwing pre-#459, find where #459's `__instanceof` host import or the `classExprNameMap` fallback in `compileHostInstanceOf` (`src/codegen/expressions.ts`) intercepts the brand check and short-circuits it. Solution: brand check is a separate `[[Class]]` check, not an `instanceof` walk — keep them separate.

## Acceptance criteria

- All three test262 tests above pass.
- `tests/issue-1455.test.ts` continues to pass (no regression of the original #1455 fix).
- `language/{statements,expressions}/class/subclass-builtins/` test262 sweep still > 55/64.

## References

- PR #459 / commit `ca3e37094` "fix(#1455): make `instance instanceof Sub` work for builtin subclasses"
- Investigation: `plan/issues/sprints/53/post-wave-regression-investigation.md`
- Failing tests sampled locally on `main` (Wasm-side, not JS host) and still fail.

## Resolution (2026-05-27, senior-dev)

**The root-cause hypothesis above was wrong.** `__set_subclass_proto` was never
involved — none of the three failing tests contain a `class extends`, so the
helper is never invoked for them, and PR #459's runtime changes are unrelated.
The real cause was **test-harness fidelity**, not the runtime.

What actually happened, per failure:

1. **`TypedArray/prototype/length/length.js`** and the `findLastIndex/BigInt/
   get-length-ignores-length-prop.js` family: `wrapTest` injected
   `const TypedArray = Int8Array` as the stand-in for the abstract `%TypedArray%`
   intrinsic. The `length`/`byteLength`/`buffer`/`@@toStringTag` getters live on
   `%TypedArray%.prototype` and are **inherited** by `Int8Array.prototype`, not
   own — so `Object.getOwnPropertyDescriptor(Int8Array.prototype, "length")`
   returned `undefined`, and `desc.get` threw. Every
   `built-ins/TypedArray/prototype/*` descriptor test was silently failing on
   this, far beyond the two named here.
2. **`RegExp/prototype/test/S15.10.6.3_A2_T8.js`** already **passes** on current
   `main` — the brand check was fixed by later work. Locked with a regression
   test, no code change needed.

**Fix** (`tests/test262-runner.ts`, the only source change): bind `TypedArray`
to the real `%TypedArray%` intrinsic, which on the host is
`Object.getPrototypeOf(Int8Array.prototype).constructor`. We route through
`Int8Array.prototype` (member access on a builtin, which the compiler resolves
to the host prototype) rather than the bare `Int8Array` identifier — the
compiler does not evaluate bare builtin-constructor identifiers as first-class
values (`Object.getPrototypeOf(Int8Array)` compiles `Int8Array` → `undefined`
and throws `Cannot convert undefined to object`).

**Validated impact** (per-process, isolated like CI forks — *not* the shared
single-process probe, which produces spurious cascading CEs):

| dir set | before | after |
|---------|--------|-------|
| `prototype/{length,byteLength,byteOffset,buffer,name,toStringTag}` | 37 pass / 27 fail | **53 pass / 11 fail** |
| `prototype/{every,find}` sample (24) | 15 pass / 9 fail | **20 pass / 4 fail** |

Net positive on both descriptor and method tests; zero new compile errors.
The blanket abstract-intrinsic binding is safe because `%TypedArray%.prototype.X`
=== `Int8Array.prototype.X` for every proto method, and the harness's
`testWith*TypedArrayConstructors` helpers iterate the concrete constructors
directly (they never call `new TypedArray()`).

Tests: `tests/issue-1567.test.ts` (4 tests — descriptor getter `.length`,
the wrapped `length.js` end-to-end through `wrapTest`, the shim-binding
assertion, and the RegExp brand-check regression lock).
