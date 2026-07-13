---
id: 3025
title: "with statement: closed object-literal shape residual (~167 default-lane fails, CE leaks into unrelated with-adjacent tests)"
status: done
sprint: 71
created: 2026-07-03
updated: 2026-07-13
completed: 2026-07-05
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: with-statement, dynamic-scope
goal: spec-completeness
test262_category: language/statements/with
test262_fail: 167
related: [1387, 2663, 2580]
---

# #3025 — `with` statement: closed-shape residual

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). **167**
official fails in `language/statements/with`: 140 runtime assertion failures
+ 27 compile errors of the form `with statement requires a proven closed
object-literal shape`. #1387 implemented `with`'s dynamic-scope lookup; this
residual is the CE-gate + correctness tail for object shapes the closed-shape
prover can't (yet) prove closed, plus runtime behaviors (unscopables,
property-get error propagation) not fully wired.

## Sample failing files

- `language/statements/with/unscopables-prop-get-err.js`
- `language/statements/with/S12.10_A1.12_T2.js`

## Suggested approach

1. Check whether the "proven closed object-literal shape" CE gate can be
   relaxed for more shapes (e.g. object literals with computed keys, spread,
   or method shorthand) without giving up soundness, or whether those shapes
   need a slower dynamic-lookup fallback instead of an outright refusal.
2. For the runtime tail: verify `Symbol.unscopables` filtering is applied to
   every property-get/set inside a `with` body, and that thrown errors from
   the object's property accessors propagate correctly through the `with`
   scope chain lookup.

## Acceptance criteria

- `language/statements/with` fail count drops materially below 167.
- The "requires a proven closed object-literal shape" CE no longer fires on
  a representative sample of the 27 currently-affected files, without
  regressing any test that correctly relies on the refusal for genuinely
  unprovable shapes.

## Measure-first findings (2026-07-03, dev-3025)

Reproduced against current `origin/main` (HEAD `014b49b1d`) by compiling all
181 `test262/test/language/statements/with/*.js` files and cross-checking the
stale baseline jsonl (run `20260703-2109`, 40 CE entries for this dir).

**1. The "proven closed object-literal shape" CE gate is ALREADY RESOLVED.**
Of the 40 files the baseline still records as failing with that exact CE,
**0 reproduce the CE on current main**: 22 now compile cleanly, 18 are correct
`'with' statements are not allowed in strict mode` rejections (`onlyStrict`
negative tests). A full sweep of all 181 files produced **zero** closed-shape
CEs. The gate was superseded by the #2663 Tier-2 dynamic-scope path
(`compileDynamicWithStatement` in `src/codegen/with-scope.ts:244`), which routes
every non-proven `with` target to a runtime HasBinding+Get select instead of
refusing at compile time. The only surviving CE from that file fires solely for
a `with` body containing a nested function/class boundary
(`with-scope.ts:245-251`) — not hit by any test262 `with` file. **The baseline
jsonl is stale; the CE portion of this issue is effectively done.** The issue's
suggested approach #1 ("relax the closed-shape prover") is therefore moot.

**2. The real remaining tail is a substrate bug in the Tier-2 dynamic path,
NOT a prover-relaxation problem.** The dominant runtime buckets
(`p1 ===null` x35, `p1 is not defined` x20, `result ===null` x8) all trace to
one cause: **the dynamic-with path does not work when the `with` target is a
WasmGC struct** (the common test262 pattern `var myObj = {...}; with(myObj){...}`).

Minimal reproduction (host lane, `src/runtime.ts` `buildImports`):

```ts
// PASSES — Tier-1 static path (target is a direct object literal):
with ({ p1: 7, p2: 8 }) { out = p1 + p2; }        // => 15  OK

// FAILS — Tier-2 dynamic path (target is a struct-typed variable):
const myObj = { p1: 7, p2: 8 };
with (myObj) { out = p1 + p2; }                    // RUNTIME ReferenceError: p1 is not defined
```

Root cause: `compileDynamicWithStatement` coerces the target to `externref`
(`with-scope.ts:256-263`, `extern.convert_any` on the GC struct ref) and gates
reads with the host import `__extern_has(recv,name)` + `emitDynGet`
(`emitDynamicWithGet`, `with-scope.ts:317`). But a WasmGC struct wrapped as an
opaque externref does **not** expose its fields to host `name in recv` /
property-get reflection, so `__extern_has` returns `false` for every own field →
the else/fallback arm resolves `p1` as a bare global → ReferenceError (or `null`
when an outer binding of that name exists). This is the same "$Object dynamic
reader can't see native/struct values" substrate family as #2580/#2151. The
dynamic path was built for genuine host objects, not for locally-constructed
struct literals bound to a variable.

## Re-scoped remaining work (for the next window)

- **CE acceptance criterion: MET** — no change needed for the closed-shape CE.
- **Tractable primary fix (biggest bucket, ~55 files):** extend the **Tier-1
  static** path to accept a `with(<expr>)` whose TS static type
  `resolveStructName`s to a closed struct (not just a syntactic object-literal
  expression). Compile the target via `compileExpression` into a struct-typed
  local and push a `static` `WithScope` so field reads/writes route to direct
  struct get/set — exactly as the literal path already does. Gate carefully:
  refuse (fall to dynamic) when the body references an inherited
  `Object.prototype` key, or when the static type could be a widened
  supertype whose runtime value carries extra own fields (soundness — `with`
  must see ALL own+inherited props of the actual object).
  Touch points: `proveObjectLiteralWithTarget` / `compileWithStatement`
  / `compileClosedObjectLiteralTarget` in `src/codegen/with-scope.ts`.
- **Deeper substrate fix (or alternative):** teach the dynamic reader
  (`emitDynGet` / the `__extern_has` gate) to resolve WasmGC struct fields, so
  the Tier-2 path works for struct targets too. Larger; overlaps #2580.
- **Unscopables / accessor-error tail** (`unscopables-prop-get-err.js`,
  `has-property-err.js` — small buckets): issue's suggested approach #2 still
  applies, but is a minor tail relative to the struct-target fix.

Status left `ready` (unclaimed) — this window banked measurement + root cause
only; no code change, so no risk of regression. The next dev can go straight to
the Tier-1 struct-target extension above.

---

## Architect ruling (2026-07-04, #3031)

The dynamic-MOP umbrella spec **#3031**
(`plan/issues/3031-dynamic-mop-extensions-spec.md`, Part 3) rules on the two
banked fix directions: **both, ordered, different owners** —

1. **Tier-1 extension to closed-struct-typed targets** (slice **W1**,
   OPUS-executable, bounded, ~55 files) is the primary near-term fix, with
   conservative fall-through-to-Tier-2 soundness gates (inherited
   `Object.prototype` key referenced in body; widened supertype; `any`/
   Proxy-shaped target).
2. **Teaching the dynamic reader struct fields** is owned by **#3027** (the
   `$Object` dynamic-reader substrate) — `with` Tier-2 inherits it for free
   via `__extern_has`/the dynamic getter. No with-local struct-reflection
   hack.

@@unscopables + abrupt-propagation tail = slice **W2**. Interpreter split:
the compile path owns `with` in compiled source; the interpreter (#2929 §2)
owns `with` inside eval/Function-ctor text only — one shared MOP surface
(#3031 §3.4).

---

## Slice W1 landed (2026-07-05, dev-3025)

**Implemented the Tier-1 struct-typed-target extension** in
`src/codegen/with-scope.ts` (`compileWithStatement` +
`proveStructTypedWithTarget` + shared `finalizeStaticWithScope`). A
`with (<identifier>)` whose target's **declaration** type `resolveStructName`s
to a closed WasmGC struct is now compiled into a struct-typed local and pushes a
`static` `WithScope`, so bare-identifier reads/writes route to direct
`struct.get`/`struct.set` — closing the dominant `var o = { … }; with (o) { … }`
bucket that Tier-2 could not serve (a struct wrapped `extern.convert_any` is
opaque to host `in`/get reflection → every own-field read missed → `ReferenceError`).

Key implementation notes:

- **Declaration-site typing.** Inside a `with` body the TS checker widens every
  identifier to `any` and returns no symbol, so the target type is resolved via
  `getSymbolAtLocation` → `getTypeOfSymbolAtLocation(symbol, valueDeclaration)`,
  which is immune to the widening and matches the WasmGC local's struct.
- **No forced `ensureStructForType`.** Only a variable the compiler *already*
  lowered to a struct is accepted; an object demoted to an externref `$Object`
  (e.g. mutated with `env[Symbol.unscopables] = …`) resolves to `undefined` and
  stays on Tier-2 (whose host reflection honours @@unscopables).
- **Conservative soundness gates — all fall through to Tier-2, never a CE:**
  bare-identifier target only; reject `any`/`unknown`/`null`/`undefined`/union/
  intersection; reject a `@@unscopables` struct member; reject if the target
  receives a computed/Symbol-keyed element **write** anywhere in scope
  (`o[k] = v`); reject bodies containing `delete <identifier>` (cascade/
  configurability is Tier-2-only); reject a body-referenced name that is an
  inherited `Object.prototype` key or an own member the struct dropped.
- **Partial nested-`with` improvement:** the OUTER struct scope's fields now
  resolve inside a nested `with` (was a hard `ReferenceError` on main); the inner
  target stays Tier-2 (checker types it `any`) until #3027's substrate reader
  lands, at which point nested works for free.

Tests: `tests/issue-3025.test.ts` (8 cases). #2663 (delete/var-precedence) and
#2663 unscopables suites stay green (the gates route those back to Tier-2). The 4
pre-existing `issue-1387*` diagnostic-test failures are stale (pre-#2663 CE
assertions superseded by the dynamic path) and fail identically on `origin/main`
— untouched here, and not in the required CI checks.

Substrate follow-up (Tier-2 struct-field visibility, nested inner targets) stays
owned by **#3027**; the @@unscopables + abrupt-propagation tail stays **W2**.
