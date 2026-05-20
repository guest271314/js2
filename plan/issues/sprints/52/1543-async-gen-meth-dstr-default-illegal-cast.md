---
id: 1543
title: "Async-generator method with destructured default params throws illegal cast instead of expected error"
status: needs-spec
created: 2026-05-20
parent: 820
priority: high
feasibility: medium
goal: test262-conformance
test262_fail: 74
---

# #1543 — Async-gen-meth destructured default param → illegal cast

## Problem

Async generator methods (`async *method({ x = expr() } = {}) {}`) called from
`assert.throws(Test262Error, () => method())` consistently produce

```
L68:3 illegal cast [in __closure_3() ← assert_throws ← test]
L68:3 illegal cast [in __closure_4() ← assert_throws ← test]
```

instead of the *expected* error the test is probing for (e.g. a `Test262Error`
thrown from the initializer, or a TypeError from destructuring `null`).

The illegal cast happens **inside the lifted closure that wraps the
async-generator body**, before the destructure expression's spec-compliant
exception path can fire. This means the test reports a wasm trap, not a JS
TypeError/Test262Error, and the `assert.throws` check fails.

### Minimal repro

```js
function thrower() { throw new Test262Error(); }
var C = class { async *method({ x = thrower() } = {}) {} };
var method = C.prototype.method;
assert.throws(Test262Error, function() { method(); });
// expected: Test262Error from thrower()
// actual:   wasm "illegal cast" inside the async-gen state machine
```

### Test262 coverage (~74 official fails)

All under `language/{statements,expressions}/class/dstr/`:

- `async-gen-meth-dflt-obj-ptrn-id-init-throws.js`
- `async-gen-meth-dflt-obj-ptrn-id-init-unresolvable.js`
- `async-gen-meth-dflt-obj-ptrn-prop-id-init-throws.js`
- `async-gen-meth-dflt-obj-ptrn-prop-eval-err.js`
- `async-gen-meth-dflt-obj-ptrn-prop-id-get-value-err.js`
- `async-gen-meth-dflt-ary-ptrn-elem-id-init-unresolvable.js`
- `async-gen-meth-dflt-ary-ptrn-rest-id-iter-step-err.js`
- `async-gen-meth-dflt-ary-init-iter-get-err.js`
- `async-gen-meth-static-dflt-*` variants (mirror set)

Bucket counts from latest baseline:
- `L68:3 illegal cast [in __closure_3() ← assert_throws ← test]`: 24
- `L68:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 24
- `L71:3 illegal cast [in __closure_3() ← assert_throws ← test]`: 7
- `L71:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 6
- `L76:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 4
- `L73:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 4
- Long-tail variants: ~5 more

## Root cause hypothesis

Async generator methods are lowered to a two-step state machine:
1. The user's body is hoisted into a closure that suspends on `await` / `yield`.
2. The async generator runtime returns an externref AsyncGenerator object.

When the method has a destructured default param, the destructure code is
emitted into the **outer body** (before the state machine resumes). That outer
body runs with the wasm async-gen closure context, so any cast that succeeds
in a regular method body (where the destructure source is on the stack as a
concrete struct) **fails inside the closure** because the source value has been
moved into the closure environment and re-typed as `anyref` / `eqref` /
`externref`.

Specifically: the destructure entry path expects the source to be the param's
declared type (e.g. `ref_null $vec_*`), but in the lifted closure the param is
captured via a `struct.get` from the closure env (which returns `anyref` or
`externref`) and the subsequent `ref.cast` to the declared param type traps
because the runtime value is the unrelated default object/array struct.

The same shape compiles correctly for sync methods (cluster #1542) because the
destructure runs against the param local directly, not against a captured copy.

### Where to look

- `src/codegen/declarations.ts` — async generator function lowering; search for
  the closure capture loop that builds the env struct
- `src/codegen/class-bodies.ts:1303-1311` — destructure call for class methods;
  this loop runs **before** the body is lifted into the async-gen state machine
  for `async *method`, but the lifted closure may re-execute the destructure
- `src/codegen/destructuring-params.ts:391` (`emitExternrefDestructureGuard`)
  and `:651` (`destructureParamArray`) — the ref.cast site

Grep target: `async *method` lowering path, look for the closure-env capture
of param locals before destructure emission.

## Implementation Plan

### Step 1 — Confirm the cast site

Compile the minimal repro with `--keep-name --debug` and inspect the emitted
wasm for the `async *method` body. The illegal cast will be at the `ref.cast
$vec_*` (or `ref.cast $struct_*`) immediately after the closure-env field
read. The dev should record the exact instruction sequence in this issue
before attempting the fix.

### Step 2 — Reorder: destructure BEFORE async-gen lifting

The cleanest fix is to **destructure the param into plain locals before the
async-gen state machine starts capturing**. The captured locals are the
post-destructure variables (`x`, `y`, ...), not the binding pattern source.

**File: `src/codegen/class-bodies.ts`** — method emission for `member.kind ===
ts.SyntaxKind.MethodDeclaration` with `member.asteriskToken` and
`member.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)`.

The current ordering (~line 1300+) is:
1. Emit param defaults
2. Emit destructure
3. Build async-gen state machine

This is correct in principle but the destructure step must produce **plain
locals** (already does for sync methods). Verify that for async-gen methods
the destructure outputs are captured into the closure env, not the
binding-pattern source struct.

If the destructure source struct (e.g. `[,] = g()` materialised into a vec
ref) is being captured by the closure env, **drop the source from the
capture set** — only the post-destructure identifiers need lifecycle into
the async state machine.

### Step 3 — Defensive: guard ref.cast with ref.test (#778 pattern)

If reordering doesn't fully eliminate the issue (e.g. some other site casts a
captured anyref), apply the `ref.test` guard pattern already used in
`coerceType` (`type-coercion.ts:1019-1048`):

```wasm
local.get $capturedAnyref
ref.test $expectedStruct
if (result (ref null $expectedStruct))
  local.get $capturedAnyref
  ref.cast_null $expectedStruct
else
  ;; throw appropriate TypeError, not wasm trap
  global.get $msg_cannot_destructure
  call $__throw_type_error
  unreachable
end
```

This converts the wasm trap into a JS-visible TypeError, which then **satisfies**
the test's `assert.throws(Test262Error, ...)` (since most of these tests are
checking that the initializer throws Test262Error, not the destructure itself).

### Wasm IR pattern

Outer method body:
```wasm
;; arg0 = method's first param (externref or struct ref)
local.get $arg0
ref.is_null
if (result externref)
  ;; param-default: evaluate `= {}` or `= g()`, materialise to expected vec/obj
  call $emitDefaultExpr
else
  local.get $arg0
end
local.set $patternSource

;; Destructure $patternSource INTO plain locals ($x, $y, ...) BEFORE state machine
;; (no closure capture of $patternSource itself)
... destructure ops, emit init expr if undefined ...

;; Then build async-gen closure capturing $x, $y, NOT $patternSource
ref.func $async_body_lifted
... closure env construct with $x, $y ...
```

### Edge cases

- The initializer expression itself can `throw` (e.g. `{ x = thrower() }`). The
  destructure must propagate that throw to the **outer caller** (not to the
  AsyncGenerator's promise), since these tests use `assert.throws` not
  `assert.throwsAsync`. Per spec the param-default evaluation happens in the
  function's lexical scope before the async body starts, so synchronous throw
  is correct.
- `unresolvable` reference in initializer (e.g. `{ x = undeclaredFn() }`) should
  produce a ReferenceError — verify error type after fix.
- Static and instance methods both need the fix; the lowering path is shared
  for `static async *method` and `async *method`.

### Test files to verify

Smoke:
1. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-throws.js`
2. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-unresolvable.js`
3. `test/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-iter-step-err.js`

Then run all `async-gen-meth-dflt-*` and `async-gen-meth-static-dflt-*` via
test262 runner.

### Estimated impact

~74 official test262 fails should flip to pass. Possibly +10 secondary tests in
the same dirs where the cast was masking a real assertion path.

## Acceptance criteria

- `async-gen-meth-dflt-obj-ptrn-id-init-throws.js` and family pass
- `L68:3 illegal cast [in __closure_3() ← assert_throws ← test]` count drops to
  ≤5 in latest baseline
- No regressions in `async-gen-meth-*` (non-dflt) bucket

## Related

- Parent: #820 (null/TypeError/illegal-cast umbrella)
- Sibling: #1542 (sync class method dstr default not applied)
- Sibling: #1544 (for-of/for-await-of dstr → illegal cast)
- Related: #778 (ref.test before ref.cast guard pattern)
- Related: #826 (illegal-cast umbrella follow-up)

## Findings (2026-05-20, senior-dev investigation)

Triangulated the failure mode with a 7-case minimal probe
(`tests/probe-1543-debug.test.ts`, removed post-investigation). The issue
title is misleading — three distinct sub-bugs surface under this one ID, and
none of them is async-gen-specific.

### Sub-bug 1: wasm-VALIDATION error (compile-time)

The minimal repro `class { method({ x = thrower() } = {}) {} }` (both
plain and async-gen variants) fails at compile time with:

```
WebAssembly.instantiate(): Compiling function #N:"C_method" failed:
local.set[0] expected type externref, found struct.get of type i32
```

WAT dump shows the synthesized `{}` default is emitted as
`i32.const 0 ; struct.new <typeIdx>` where the struct's field 0 has wasm
type `i32`, and the destructure code reads it via `struct.get` expecting
`externref`. The struct-field types in the TS-inferred type don't match
what the destructure emitter expects. **NOT async-gen specific** — same
error fires for plain class methods, async non-generator methods, etc.

### Sub-bug 2: test262-baseline runtime "illegal cast" (74 tests)

Test262 baseline shows `L68:3 illegal cast [in __closure_3()/__closure_4()
← assert_throws ← test]` for ~74 async-gen-meth-dflt-* tests. This is a
runtime trap, distinct from Sub-bug 1's compile-time validation error.
The test262 harness wraps each assertion in an `assert_throws` closure;
that closure's param-passing apparently routes around the validation
error and surfaces the cast failure at runtime instead.

### Sub-bug 3: default-not-fired

When the param is annotated `: any` (e.g. `{ x = thrower() }: any = {}`),
the validation error goes away — the code compiles. But the inner default
`x = thrower()` never fires: `method()` returns "no-throw" instead of
throwing Test262Error. Overlaps with #1542's scope (which fixed some
sub-shapes); this is a sibling shape #1542 didn't cover.

### Root cause (Sub-bug 1)

`src/codegen/literals.ts:447` explicitly excludes
`ts.isParameter(expr.parent) && ts.isBindingElement(expr.parent)` from
the `__new_plain_object` (externref) path, with a comment citing
"150+ dstr regressions" if widened. That exclusion is exactly what
forces the synthesized `{}` through the typed-struct path. The
TS-inferred struct type (from the binding pattern `{ x = thrower() }`
with `never`-typed initializer) yields fields with `i32` types where
the destructure reader expects `externref`. The mismatch trips
wasm validation.

### Three investigation paths (none risk-free)

**Path (a) — field-type widening.** Change the type-resolver so
inferred structural binding-pattern param types use widened field types
(externref/anyref) instead of the narrowest TS-inferred type. Requires
reworking the type-resolver and a regression gate against the 150+
existing dstr cases.

**Path (b) — `__new_plain_object` routing.** Relax the
`literals.ts:447` exclusion specifically for the `{ x = init } = {}`
shape, routing it through the externref plain-object path. Same
regression risk on the 150+ cases the exclusion guards.

**Path (c) — defensive `ref.test` guard.** Apply the #778 pattern
(check `ref.test` before `ref.cast`) at the destructure reader so the
cast traps as a JS-visible TypeError rather than a wasm trap.
**Caveat: this won't help compile-time failures (Sub-bug 1).** It might
address Sub-bug 2's runtime trap, but only for the test262-harness
path that gets past the validation error in the first place.

### Recommendation

Filed as a follow-up architect-spec scope, not a focused PR target.
A focused PR is risky on all three paths. The architect spec should
cover:

1. Type-resolver behaviour for binding-pattern params with
   destructure-with-initializer
2. Field-type widening / coercion strategy compatible with both
   struct-typed and externref-typed dstr paths
3. Explicit regression gate against the 150+ dstr cases the
   `literals.ts:447` comment guards
