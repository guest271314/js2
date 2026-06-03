---
id: 1732
title: "spec gap: builtin method values lack [[Construct]]-absent brand + own length/name descriptors (~40 String.prototype A7/A8 fails)"
status: ready
created: 2026-05-29
updated: 2026-06-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: function, builtin-methods, string
goal: spec-completeness
sprint: Backlog
depends_on: [1632, 1665]
test262_fail: 40
---
# #1732 — builtin method values: unified function-object representation ([[Construct]]-absent brand + own length/name descriptors)

## Problem

~40 test262 failures across ~20 `String.prototype` methods, in two families
(all of the `S15.5.4.*_A7` / `_A8` form):

- **A7 (not-a-constructor):** the method is first assigned to a **local**, then
  `new` is applied to that local:
  ```js
  var __FACTORY = String.prototype.indexOf;
  var __instance = new __FACTORY;   // must throw TypeError (§20.1.3.x / §10.2.2: no [[Construct]])
  ```
  The `new` callee is therefore an **identifier of static type `any`**, not a
  property-access of `prototype`.

- **A8 (.length DontEnum):** the method must expose a real **own,
  non-enumerable, non-writable, configurable** `length` property (value =
  formal-param count), invisible to `for-in`:
  ```js
  String.prototype.indexOf.hasOwnProperty('length')        // true
  String.prototype.indexOf.propertyIsEnumerable('length')  // false
  for (var p in String.prototype.indexOf) { /* never "length" */ }
  ```
  Same descriptor requirement applies to `name` (§20.2.x: own, non-enumerable,
  non-writable, configurable).

### Root cause (confirmed by dev-a + source audit)

The A7 callee flows through a **local** (`__FACTORY`), so **no compile-time
guard can see what value it holds** — the existing `new`-site guards are all
syntactic/type-driven and miss the local-indirection case:

- `src/codegen/expressions/new-super.ts:1515-1543` — the non-identifier guard
  only fires for **direct** `new X.prototype.Y()` (a `PropertyAccessExpression`
  whose object is a `.prototype` access — Pattern 1) and for TS-typed callees
  that have call-sigs but no construct-sigs (Pattern 2). A bare identifier of
  type `any` matches **neither** (it is filtered out by the
  `!ts.isIdentifier(unwrappedNonId)` gate at line 1516).
- `new-super.ts:1571-1583` — the namespace guard only catches the literal
  identifiers `Math`/`JSON`/`Reflect`/`Atomics`.
- For a generic local identifier, control reaches the function-declaration
  resolution at `new-super.ts:2414-2469`. `__FACTORY`'s declaration is a
  `VariableDeclaration` whose initializer is a **`PropertyAccessExpression`**
  (`String.prototype.indexOf`), not a `FunctionExpression`, so it falls through
  to the "unknown constructor" path (`new-super.ts:2471+`), which calls a
  `collectUnknownConstructorImports`-registered import or emits
  `ref.null.extern`. **It never performs `[[Construct]]` on the runtime value
  the local actually holds, so no TypeError is thrown.**

For A8, in **JS-host mode** `String.prototype.indexOf` as an rvalue currently
resolves via `__get_builtin("String")` → `__extern_get(ref, "prototype")` →
`__extern_get(ref, "indexOf")` (`property-access.ts:1330-1410`), i.e. the
**real host method**, which already carries correct `length`/`name`
descriptors — so A8 passes *only* on the JS-host path and *only* when the
member-read chain is taken. It fails in **standalone/WASI mode** (no host
intrinsic) and any time the method is materialized as a Wasm-side value
(closure struct / funcref) without descriptor metadata.

### The architectural call

Both families are symptoms of the same missing capability: **a builtin method,
when materialized as a first-class value, has no runtime function-object
identity.** It is either an opaque host externref (descriptors right by
accident, `[[Construct]]` unobservable to our `new` site) or a bare
funcref/closure-struct (no descriptors, no brand). Per the team principle
*compile away, don't emulate*, the compile-time guards are the right tool **when
the callee is statically known**; but the local-indirection case provably
cannot be resolved statically, so it needs a **runtime** representation.

This is the **same function-object-representation problem** already solved
partially by **#1632** (`__bind_function` → bound-function exotic with
`[[Call]]`/`[[Construct]]`/`name`/`length`) and designed for in the **#1665**
`$Iterator`/generator-prototype work. **Do not** build a String-method-specific
hack. Specify a **unified runtime function-object representation** that bound
functions (#1632), generator/iterator helpers (#1665), and builtin-method
values all share.

---

## Implementation Plan

### Goal

Give every materialized builtin-method **value** a single runtime
function-object representation that:

1. carries a **`[[Construct]]`-absent brand** so `new f` throws
   `TypeError("f is not a constructor")` at the **runtime `new` site**,
   regardless of how `f` was bound (local / param / property / callback);
2. exposes correct **own `length` and `name`** as **non-enumerable,
   non-writable, configurable** descriptors (invisible to `for-in`,
   visible to `hasOwnProperty`, false from `propertyIsEnumerable`);
3. **reuses / extends** the #1632 and #1665 representations rather than forking
   a parallel scheme.

### Scope assessment — this is foundational, slice it

This is genuinely multi-issue. Land it as four slices under #1732 so each is
independently testable and mergeable; A7 and A8 close on different slices.

- **S1 — runtime `new`-site brand check (closes A7, JS-host).**
  Make the runtime `new` site honor `IsConstructor` on the value the callee
  holds. *Smallest viable win for the ~14 A7 files in JS-host mode.*
- **S2 — own `length`/`name` descriptors (closes A8, JS-host).**
  Ensure materialized builtin-method values carry correct own non-enumerable
  descriptors. *Closes the ~14 A8 files in JS-host mode.*
- **S3 — unified `FuncObj` representation + migration.**
  Introduce the shared struct/brand; migrate #1632 bound functions and the
  builtin-method materialization onto it; fold the #1665 iterator-helper
  function values in. *No new test wins required — refactor that removes the
  parallel schemes; guarded by the S1/S2 + #1632 + #1665 test sets staying
  green.*
- **S4 — standalone/WASI parity.**
  Wasm-native brand + descriptor reads so A7/A8 pass with no JS host. *Closes
  the standalone bucket; lowest priority, gated behind S3.*

If sprint capacity is tight, S1+S2 alone bank the full ~40-file test262 delta
in the default (JS-host) config; S3 is the debt-paydown that prevents a third
fork; S4 is standalone parity.

### Representation — the shared `FuncObj` (S3, reused by S1/S2 at the boundary)

Introduce one WasmGC struct used for **all** materialized callable values that
need spec function-object identity. It supersedes the ad-hoc closure-struct
wrapping in `new-super.ts:1370-1387` (`emitCtorFuncrefAsExternref`) and the
host-only metadata stamping in `runtime.ts:__bind_function`.

```wat
;; $FuncObj — unified function-object value (WasmGC)
(type $FuncObj (struct
  (field $callee     funcref)            ;; [[Call]] target (closure-erased entry)
  (field $env        (ref null $env))    ;; captured environment, null for builtins
  (field $flags      i32)                ;; bit0 = HAS_CONSTRUCT ([[Construct]] present)
                                         ;; bit1 = IS_BOUND      (bound exotic, #1632)
                                         ;; bit2 = IS_BUILTIN    (native method)
  (field $length     i32)                ;; own .length value
  (field $name       (ref $String))      ;; own .name value ("" for anonymous)
))
```

Key rule: **builtin methods and bound functions are created with `HAS_CONSTRUCT`
clear.** User function declarations / class constructors that *are*
constructable either keep their existing class-struct path or set
`HAS_CONSTRUCT`. `name`/`length` live **on the struct**, not in a side table, so
the descriptor reads are O(1) and standalone-safe (S4).

Reconciliation:
- **#1632 bound functions** (`runtime.ts:6466 __bind_function`): the host
  currently builds a JS wrapper and stamps `name`/`length` via
  `Object.defineProperty`. Under the unified scheme the **codegen** path
  produces a `$FuncObj` with `IS_BOUND|HAS_CONSTRUCT-from-target`,
  `length = max(0, target.length - boundArgs.length)`, `name = "bound " + …`.
  The host import is retained only as the JS-host fast path that wraps a
  `$FuncObj` into a real callable when one must cross to the host
  (`_wrapWasmClosure` at `runtime.ts:958`); it reads the brand instead of
  re-deriving it. **Do not delete `__bind_function`** — re-point it at the
  struct fields.
- **#1665 iterator/generator helpers**: the `%IteratorHelperPrototype%` methods
  are also non-constructors with own `length`/`name`; materialize them as
  `$FuncObj` with the same `IS_BUILTIN`, `HAS_CONSTRUCT=0` shape. This unifies
  the brand check so `new iterHelper` throws via the **same** S1 runtime path.

### S1 — runtime `new`-site brand check (closes A7)

**File: `src/codegen/expressions/new-super.ts`**
- Function `compileNewExpression` (line 1435).
- The fix is at the **fall-through for an identifier-typed callee that is not a
  known class / function declaration / builtin namespace** — i.e. *before* the
  "unknown constructor" path at line 2471 and *after* the function-declaration
  resolution at 2414-2469 fails.
- When the callee is an identifier (or any expression) whose **static type does
  not statically prove constructability** (type is `any`, or has call-sigs and
  no construct-sigs), do **not** emit `ref.null.extern` / an unknown-ctor
  import. Instead:
  1. compile the callee expression to its runtime value (externref in JS-host;
     `ref $FuncObj` once S3 lands),
  2. route through a new runtime helper `__construct(callee, argsArray)` that
     performs the spec `Construct(F, args)` (§7.3.13) — which throws
     `TypeError` when `IsConstructor(F)` is false.
- Mirror the existing real-TypeError throw plumbing
  (`emitThrowTypeError(ctx, fctx, "<name> is not a constructor")` at lines
  1525/1540/1579) for the **statically provable** non-constructor cases so they
  keep throwing at compile-emit time (zero runtime cost — *compile away*); only
  the *unprovable* (`any`-typed local) case defers to `__construct`.

**File: `src/runtime.ts`** (JS-host helper)
- Add import `__construct(callee, argsArray)`:
  ```ts
  if (name === "__construct")
    return (callee: any, argsArray: any): any => {
      const args = argsArray == null ? [] : Array.from(argsArray);
      // Spec §7.3.13 Construct → §10.2.2 [[Construct]]; IsConstructor false ⇒ TypeError.
      if (typeof callee !== "function" || !_isConstructor(callee)) {
        throw new TypeError(
          (callee && callee.name ? callee.name : String(callee)) + " is not a constructor",
        );
      }
      return Reflect.construct(callee, args);
    };
  ```
  where `_isConstructor` is the standard probe (try `Reflect.construct(Boolean,
  [], callee)` in a `try/catch`, or test for absence of `[[Construct]]` —
  arrow/method/bound-without-construct/builtins return false). Register it via
  the host-import allowlist (`src/codegen/host-import-allowlist.ts`, next to the
  `__bind_function` entry at line 310). The thrown `TypeError` must be a **real
  host `TypeError` instance** so test262 `e instanceof TypeError` holds — this
  is the same instance discipline as `emitThrowTypeError` / `__new_TypeError`.
- The host's real `String.prototype.indexOf` already has no `[[Construct]]`, so
  `__construct` throws for it immediately — **A7 passes without S3** as long as
  the callee value reaching `__construct` is the host method (which it is, via
  the `property-access.ts:1330` `__get_builtin`/`__extern_get` chain).

### S2 — own `length`/`name` descriptors (closes A8)

In JS-host mode the host method already satisfies A8 when read through the
`__get_builtin`/`__extern_get` chain; the failures are the cases where the
value is materialized Wasm-side (closure-struct/funcref) **without** descriptor
metadata, and the `for-in` / `propertyIsEnumerable` / `hasOwnProperty` reads
then hit our generic property machinery.

**File: `src/codegen/property-access.ts`**
- The `BuiltIn.prop` host-read path (line 1330-1410) is correct for JS-host —
  **keep it**; it returns the host method whose descriptors are already
  spec-correct. The bug surface is `hasOwnProperty('length')` /
  `propertyIsEnumerable('length')` / `for-in` **on that value**: confirm these
  member-ops route to the host (`__has_own_property`, `__property_is_enumerable`,
  `__for_in_keys`) on the externref, not to a Wasm struct lookup that lacks
  `length`. Add a regression check that the externref path is taken for a
  builtin-method value (no premature struct cast).

**File: `src/runtime.ts`** (descriptor source of truth for materialized values)
- When a builtin method is materialized as a `$FuncObj` (S3) and must cross to
  the host, `_wrapWasmClosure` (line 958) must stamp the own
  `length`/`name` from `$FuncObj.$length`/`$name` with the spec attributes:
  ```ts
  Object.defineProperty(fn, "length", { value: len, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(fn, "name",   { value: nm,  writable: false, enumerable: false, configurable: true });
  ```
  (JS function `length`/`name` are already non-enumerable/configurable by
  default, but stamp explicitly so re-defined values keep the right attributes —
  same pattern as `__bind_function` at `runtime.ts:6478-6490`.)
- The `$length` value is the method's **formal-param count before the first
  default/rest param** — reuse the #1632 `lengthHint` computation in
  `calls.ts:516` (`staticLengthHint`) and `name` from `calls.ts:477`
  (`staticNameHint`). **Do not re-derive** these — call the existing helpers.

### S4 — standalone/WASI parity

**File: `src/codegen/property-access.ts`** — for `for-in` / `hasOwnProperty` /
`propertyIsEnumerable` against a `$FuncObj`, read `$length`/`$name`/`$flags`
directly via `struct.get` (no host import). `length`/`name` report as own +
non-enumerable; `[[Construct]]` brand read for `new` comes from `$flags & 1`.

**File: `src/codegen/expressions/new-super.ts`** — `__construct` lowering in
standalone mode: `struct.get $FuncObj $flags`, `i32.const 1`, `i32.and`,
`i32.eqz`, `if → emitThrowTypeError("… is not a constructor")`, else perform the
construct via `call_ref $callee`.

### Wasm IR pattern (S1/S4 brand check at the runtime new site)

```wat
;; new f  where f : $FuncObj (standalone) — S4
local.get $f
struct.get $FuncObj $flags
i32.const 1            ;; HAS_CONSTRUCT
i32.and
i32.eqz
if
  ;; throw real TypeError "<name> is not a constructor"  (emitThrowTypeError)
end
;; else: construct via call_ref $callee (...)
```

```wat
;; new f  where f : externref (JS-host) — S1
local.get $f                       ;; the callee value (host method or $FuncObj-as-externref)
<argsArray>                        ;; packed args
call $__construct                  ;; throws TypeError if IsConstructor(callee) is false
```

### Migration touch-points

- `new-super.ts:1370-1387` `emitCtorFuncrefAsExternref` — replace ad-hoc
  closure-struct wrapping with `$FuncObj` construction (S3).
- `new-super.ts:2414-2469` — function-declaration resolution: when the resolved
  declaration *is* a constructable function, keep the existing class-struct
  path; otherwise fall to `__construct` rather than the unknown-ctor import.
- `new-super.ts:2471+` "unknown constructor" path — narrow it to only the cases
  that are genuinely an imported intrinsic ctor; non-constructable values now go
  to `__construct` (S1).
- `runtime.ts:6466 __bind_function` and `runtime.ts:958 _wrapWasmClosure` —
  read brand/descriptors from `$FuncObj` instead of re-deriving (S3).
- `calls.ts:477/516` `staticNameHint` / `staticLengthHint` — reused as the
  `$FuncObj.$name`/`$length` source for builtin methods (S2/S3).
- `host-import-allowlist.ts:310` — register `__construct` alongside
  `__bind_function`.
- #1665 iterator-helper materialization — emit `$FuncObj` (S3) so its
  non-constructor brand check shares the S1 path.

### Edge cases

- **Method re-bound**: `var g = __FACTORY.bind(null); new g` — the bound
  function is also a non-constructor (its target has no `[[Construct]]`), so
  `IS_BOUND` `$FuncObj` must propagate `HAS_CONSTRUCT = target.HAS_CONSTRUCT`
  (here 0). Verifies the #1632 reconciliation.
- **Passed as callback**: `[1].map(String.prototype.indexOf)` — the value
  crosses to the host via `_wrapWasmClosure`; must keep its descriptors and
  brand so a downstream `new` still throws. Covered by S3 (single
  representation, no metadata loss at the boundary).
- **`Function.prototype.call` on it**: `String.prototype.indexOf.call("ab","b")`
  must still **invoke** (`[[Call]]` is present) — only `[[Construct]]` is
  absent. The brand gates `new`, never the call path.
- **`new (String.prototype.indexOf)()`** (direct, parenthesized) — already
  caught by the compile-time Pattern 1/2 guards; S1 must not double-throw or
  regress these. Keep the static guards as the fast path.
- **User shadowing**: `function indexOf(){}; var f = indexOf; new f` — `f` is a
  real constructable function; must **not** throw. The static
  function-declaration resolution (2414-2469) handles this before
  `__construct`; ensure the brand defaults to `HAS_CONSTRUCT` for user function
  declarations.
- **`name`/`length` re-definition**: A8 only requires the *default* descriptor;
  user `Object.defineProperty(f,"length",…)` after-the-fact is out of scope
  here (value semantics, not function-object identity).

### Test files to verify (the ~40-file test set)

A7 (not-a-constructor) and A8 (.length DontEnum), one each per method:
```
test262/test/built-ins/String/prototype/charAt/S15.5.4.4_A7.js              (+ _A8)
test262/test/built-ins/String/prototype/charCodeAt/S15.5.4.5_A7.js          (+ _A8)
test262/test/built-ins/String/prototype/concat/S15.5.4.6_A7.js              (+ _A8)
test262/test/built-ins/String/prototype/indexOf/S15.5.4.7_A7.js             (+ _A8)
test262/test/built-ins/String/prototype/lastIndexOf/S15.5.4.8_A7.js         (+ _A8)
test262/test/built-ins/String/prototype/localeCompare/S15.5.4.9_A7.js       (+ _A8)
test262/test/built-ins/String/prototype/match/S15.5.4.10_A7.js              (+ _A8)
test262/test/built-ins/String/prototype/replace/S15.5.4.11_A7.js
test262/test/built-ins/String/prototype/search/S15.5.4.12_A7.js             (+ _A8)
test262/test/built-ins/String/prototype/slice/S15.5.4.13_A7.js              (+ _A8)
test262/test/built-ins/String/prototype/substring/S15.5.4.15_A7.js          (+ _A8)
test262/test/built-ins/String/prototype/toLowerCase/S15.5.4.16_A7.js        (+ _A8)
test262/test/built-ins/String/prototype/toLocaleLowerCase/S15.5.4.17_A7.js  (+ _A8)
test262/test/built-ins/String/prototype/toUpperCase/S15.5.4.18_A7.js        (+ _A8)
test262/test/built-ins/String/prototype/toLocaleUpperCase/S15.5.4.19_A7.js  (+ _A8)
```
(28 files enumerated above; the remaining count to ~40 is the same A7/A8 shape
on the ES2015+ String methods — `endsWith`, `includes`, `startsWith`, `repeat`,
`codePointAt`, `normalize`, `padStart`/`padEnd`, `trimStart`/`trimEnd` — which
carry the equivalent `not-a-constructor` / `length` descriptor sub-tests under
`test262/test/built-ins/String/prototype/<method>/`. Dev should glob
`String/prototype/**/{S15.5.4.*_A7.js,S15.5.4.*_A8.js,*length*.js,*not-a-constructor*}`
to capture the full set before/after.)

### Regression guards

- Run the **#1632** bound-function test set
  (`test262/test/built-ins/Function/prototype/bind/**`,
  `test262/test/built-ins/Function/internals/**`) — S3 must not regress
  `name`/`length`/`[[Construct]]` on bound functions.
- Run the **#1665** iterator-helper set to confirm the shared brand check
  doesn't break helper invocation.
- `tests/equivalence.test.ts` — add cases:
  - `new (function f(){}); /* ok */` and `var c = function f(){}; new c` stay
    constructable (no false TypeError).
  - `String.prototype.indexOf.call("ab","b") === 1` (call still works).
  - `[1].map(String.prototype.toUpperCase)` callback boundary keeps the value
    callable.
- Confirm no new entries in `scripts/ir-fallback-baseline.json` (the `new`-site
  change is in the legacy direct-AST path; verify it doesn't push an IR
  rejection bucket up).
- Class/elements identity tests (`c.m === C.prototype.m`, 478 tests) must stay
  green — the `emitCachedMethodClosureAccess` singleton at
  `property-access.ts:1660` and `emitCtorFuncrefAsExternref` migration must
  preserve identity.

### Dependency relationship

- **depends_on #1632** — extends the bound-function exotic representation; the
  `$FuncObj` struct subsumes `__bind_function`'s host-stamped metadata. S3 must
  land on top of #1632 (already `status: done`).
- **depends_on #1665** — the iterator/generator-helper function values fold into
  the same `$FuncObj` brand; coordinate so #1665 emits `$FuncObj` rather than a
  third bespoke representation.
- This issue should be treated as the **canonical "function-object value
  representation" tracking issue**; future builtin-method-as-value gaps
  (Array.prototype.*, Number.prototype.*, etc. A7/A8 analogues) close by
  reusing S1-S4 with no new design.

## S1 landed (dev-a, 2026-05-29)

**S1 (runtime `new`-site brand check, JS-host) is implemented** on branch
`issue-1732-s1-construct` (PR #941). Remaining slices S2 (own `length`/`name`
descriptors), S3 (unified `$FuncObj`), S4 (standalone parity) stay open under
this tracking issue; status remains `ready` until they land.

What S1 does:
- New host helper `__construct(callee, argsArray)` in `src/runtime.ts` (next to
  `__reflect_construct`): performs §7.3.13 Construct, throwing a real
  `TypeError("<name> is not a constructor")` when `IsConstructor(callee)` is
  false (probed via `Reflect.construct(function(){}, [], callee)`). Registered
  in `src/codegen/host-import-allowlist.ts` (`(externref, externref) ->
  externref`, trackingIssue 1732).
- Codegen wiring in `src/codegen/expressions/new-super.ts`: a new
  `resolvesToNonConstructableValue(ctx, id)` helper detects when a `new <id>`
  callee identifier's variable-declaration initializer is provably
  non-constructable — a `<...>.prototype.<method>` member access, or a
  `.bind()/.call()/.apply()` result. In the unknown-ctor fall-through (after the
  function-declaration resolution fails), when the unwrapped callee is such an
  identifier (covers `new f`, `new f()`, `new (f as any)()`), the held value is
  routed through `__construct`. The existing compile-time `emitThrowTypeError`
  fast path for the direct `new X.prototype.Y()` form is untouched; user
  constructable function declarations resolve earlier and never reach the guard.

Scope discipline (S1 guardrail): no `$FuncObj` struct migration — the brand
check rides the externref/host path. Conservative initializer detection cannot
intercept a real constructor (ArrayBuffer/DataView/TypedArray/Error/Promise/user
function/class). Standalone parity is S4.

Tests: `tests/issue-1732-s1.test.ts` (7) — A7 bare/no-parens/cast forms throw
TypeError; guards confirm `.call` works, user ctors not intercepted, `.bind()` of
a constructable target still constructs. #1632 bind suite + #1364a class-method
descriptors stay green. Closes the JS-host A7 not-a-constructor cluster
(`built-ins/String/prototype/*/S15.5.4.*_A7.js`, ~14 files).

### S2 follow-up note (dev-a)

While triaging, found that `new Math.f16round()` (and other namespace methods
newer than the TS lib) does NOT throw not-a-constructor: Pattern 1 in
new-super.ts only matches `X.prototype.Y`, not `<NonCtorNamespace>.<method>`
where the method type resolves to `any`. Fold a `<Math|JSON|Reflect|Atomics>.
<method>` member-access arm into the S2 PR (same file). The f16round
`value-conversion.js` fail is a missing test262 harness include
(`byteConversionValues`), not a compiler bug.

## S2 landed (dev-a, 2026-05-29)

**S2 scope refined during implementation.** The A8 own-`length`/`name`
descriptor family (the slice's nominal target) is **already green on main** —
all 14 `String.prototype/*/S15.5.4.*_A8.js` tests pass post-#941/#936. The
host-method values resolve through `__get_builtin`/`__extern_get` and carry
correct descriptors, `hasOwnProperty('length')`/`propertyIsEnumerable('length')`
return true/false correctly, and `for-in` routes through the host key path that
already honors non-enumerability (verified: the `for (p in
String.prototype.charAt)` count-0 assertion passes). So **no codegen change was
needed for A8** — the jsonl baseline listing them as failing was pre-#941/stale.

The one genuinely-unfixed gap in S2's scope was the **`new
<NonCtorNamespace>.<method>()` not-a-constructor arm**: `new Math.f16round()` /
`new Math.sumPrecise()` returned instead of throwing TypeError, because those
methods are newer than the bundled TS lib → type `any` → slip past the
Pattern 2 (call-sigs/no-construct-sigs) guard → reach the unknown-ctor path that
never performs [[Construct]]. Fixed with a Pattern-1 extension in
`src/codegen/expressions/new-super.ts` keyed on the receiver **namespace name**
(`Math`/`JSON`/`Reflect`/`Atomics`), making it lib-version-independent — it
fires for any current or future method on those namespaces. The existing
`new Math.abs()` (Pattern 2) and `new Math()` (namespace guard) paths are
untouched. JS-host realization, no `$FuncObj` struct (that's S3/S4).

Tests: `tests/issue-1732-s2.test.ts` (6) — `new Math.f16round`/`Math.sumPrecise`
/`Reflect.has`/`JSON.parse` throw TypeError; regression guards confirm
`new Math.abs()` and `new Math()` still throw. The 14 A8 tests stay green; #1732
S1 tests stay green. Closes test262
`built-ins/Math/f16round/not-a-constructor.js` and the analogous newer-method
not-a-constructor cases.

## Namespace call-as-function slice landed (2026-06-03)

**Companion to the S2 `new <namespace>()` guard: the call-as-function form.**
The S2 work made `new Math()` / `new <Namespace>.<method>()` throw TypeError,
but `Math()` / `JSON()` / `Reflect()` / `Atomics()` called *as a function*
still returned silently — these namespace objects have **no `[[Call]]`**
internal method (§sec-math-object etc.), so the call must throw TypeError.

Re-validation against current main (baseline 9ee8e92 was 136h stale) showed the
remaining Math-suite failures were almost all already-green or harness-include
gaps; the one genuine localized compiler defect was
`built-ins/Math/prop-desc.js` L28 `assert.throws(TypeError, () => Math())`.

Fix: a guard at the top of `compileCallExpression`
(`src/codegen/expressions/calls.ts`) mirroring the S2 `new`-site
`NAMESPACE_NON_CONSTRUCTORS` set — when the (paren/as/!-unwrapped) callee is a
bare identifier in `{Math, JSON, Reflect, Atomics}`, evaluate the arguments for
side effects, then `emitThrowTypeError("<name> is not a function")`. Member
calls (`Math.abs(-5)`, `Reflect.construct(...)`) keep their existing paths —
the guard only fires when the *whole* callee is the namespace identifier.

Tests: `tests/issue-1732-ns-call.test.ts` (12) — `Math/JSON/Reflect/Atomics()`
throw TypeError in both js-host and standalone modes; guards confirm
`Math.abs(-5)`/`Math.max(1,2)` member calls, `new Math()`, and a user function
named like a namespace all still work. Closes
`built-ins/Math/prop-desc.js` (+ JSON/Reflect/Atomics `prop-desc.js` "no
[[Call]]" arms). S3 (unified `$FuncObj`) and S4 (standalone parity) remain open
under this tracking issue — status stays `ready`.

## Symbol-coercion sub-fix — Math.* ToNumber(Symbol) throws TypeError (2026-06-03)

Distinct from the [[Construct]]-brand and namespace-call work above: a separate
spec-conformance gap surfaced while investigating `Math.*` argument handling.
`Math.abs/floor/ceil/sqrt/round/sign/max/min/pow/clz32/...` run **ToNumber** on
their arguments (§21.3.2.x → §7.1.4 *ToNumber*). ToNumber of a **Symbol** MUST
throw a `TypeError` (§7.1.4 step 5). Compiled `Math.abs(Symbol())` instead
returned a garbage number.

**Root cause.** `compileSymbolCall` (`src/codegen/literals.ts`) lowers a Symbol
to an **i32 id** (the symbol counter). `compileMathCall` compiles each argument
with an `f64Hint`, and an i32 symbol id coerces straight to f64 — the raw
counter leaks as the result, never routing through `__unbox_number` (which *does*
throw on a real boxed Symbol, hence `const s: any = Symbol(); Math.abs(s)`
already threw correctly — only the statically-symbol-typed argument slipped).

**Fix** (`src/codegen/expressions/builtins.ts::compileMathCall`): before the
method-specific lowering, scan the arguments for a `symbol`-typed one
(`isSymbolType`). If found, evaluate every argument up to and including it for
side effects in source order, then `emitThrowTypeError(..., "Cannot convert a
Symbol value to a number")` — exactly mirroring the existing `Number(Symbol())`
guard at `calls.ts:7506`. Override-free numeric Math paths are untouched
(`Math.abs(-5)`, `Math.max(1,2,3)`, NaN propagation all verified intact).

Tests: `tests/issue-1732-math-symbol-coercion.test.ts` (18) — 12 Symbol-throw
cases across the unary/variadic/binary Math methods + 6 numeric regression
guards (incl. `Math.max(NaN,1)` NaN propagation). All green; tsc clean.
