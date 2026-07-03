---
id: 3006
title: "Genuine reified builtin-constructor identity: <Builtin>.prototype.constructor === <Builtin> (standalone) — supersede the #2537 null-fold"
status: done
completed: 2026-07-03
assignee: ttraenkler/senior-dev
sprint: 69
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: builtins
goal: standalone-mode
related: [2963, 2999, 2537, 2555]
supersedes: [2537, 2999]
origin: "Extend #2963's builtin-value reification substrate to constructor identity; supersede #2537's null-fold (#2999)"
---

# #3006 — genuine reified builtin-constructor identity (supersedes #2537 null-fold)

## Problem

Round-5 leak analysis (#2999) flagged **9 standalone passes** whose sole `env::`
import is `Object_get_constructor`: all `<Builtin>.prototype.constructor === <Builtin>`
(Set / WeakMap / WeakRef / WeakSet / RegExp / FinalizationRegistry /
DisposableStack / SuppressedError) plus instance forms
(`(new WeakMap()).constructor`, `/re/.constructor`).

Reading `.constructor` on a builtin extern-class receiver walks the extern
inheritance chain to the `Object` base extern class (the only declarer of
`constructor`, `importPrefix: "Object"`), emitting an `env::Object_get_constructor`
host import — a standalone leak (the binary imports a host getter it should not
need).

**PR #2537 (issue #2999) took a WEAKER approach** — it folded `.constructor` to
`ref.null.extern`. That passed only via a **null≡null tautology**: the bare
builtin identifier (`Set`) ALSO compiled to the null carrier, so both sides of
`===` collapsed to null and compared equal. The predecessor's own cross-check
proved it hollow — `Set.prototype.constructor === Map` **also passed** (both
null). #2537 was flagged as "honest-accounting: host-import elimination, NOT a
correctness fix" and should NOT be the final answer.

## Root cause of the null≡null tautology

Builtins had **no reified constructor-object identity** in standalone mode. Both
the bare identifier `Set` (as a value) and the `.constructor` read resolved to
the shared null-externref carrier — so every comparison was `null === null`, true
regardless of which builtins were being compared.

## Fix — extend #2963's "reify builtins as first-class values" substrate

Give each target builtin constructor a **genuine, identity-stable reified
`$Object` singleton** — one `externref` mutable global `__builtin_ctor_<Name>`
per constructor name, lazily materialized once to a fresh `__new_plain_object`
behind an `if (ref.is_null) { … }` guard (`emitBuiltinConstructorIdentity`,
`src/codegen/builtin-static-globals.ts`). This is exactly the substrate #2963's
issue plan calls for ("synthesize … a `$Object`-backed … module-level singleton
slot per reified builtin; the same builtin reference must yield the same
object"). It is the natural vehicle for a constructor **object** (an object with
identity), whereas #2963's static-method `pushBuiltinFnSingletonValueInstrs`
requires a real lifted `funcIdx` per builtin, which a bare constructor lacks.

**Both** sites route to the SAME per-name global:

1. **Bare identifier** (`… === Set`, `assert.sameValue(…, Set)`) —
   `src/codegen/expressions/identifiers.ts`, standalone, after all
   local/module/declared-global shadowing and the class-object / promise-subclass
   singleton blocks, before the null-externref fallback.
2. **`.constructor` read** (`Set.prototype.constructor`,
   `(new WeakMap()).constructor`, `re.constructor`) —
   `src/codegen/property-access.ts` `compilePropertyAccess`, placed EARLY (after
   the existing `.constructor` special-cases, before the builtin-specific
   `.prototype`/regexp/native-proto member paths). Gated on the receiver being a
   genuine ambient-declared builtin (`isExternalDeclaredClass` + the narrow
   `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` set).

Because both resolve to the same `__builtin_ctor_<Name>` global,
`<Builtin>.prototype.constructor === <Builtin>` is **GENUINELY true** (same
WasmGC object, `ref.eq`) and the swap-wrong-builtin cross-check
`Set.prototype.constructor === Map` is **GENUINELY false** (distinct singletons).

### Why the `.constructor` fold is placed early (not in `compileExternPropertyGet`)

Routing `RegExp.prototype.constructor` through `compileExternPropertyGet` (where
an earlier draft put it, and where #2537 folded) never fires: a RegExp-specific
member path returns first (`Set.prototype` DOES reach `compileExternPropertyGet`,
but `RegExp.prototype` does not — verified by tracing). Placing the fold in
`compilePropertyAccess` before those builtin-specific paths makes it fire
UNIFORMLY for every target builtin.

### Scope discipline

`BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` is the NARROW subset of `BUILTIN_CTOR_NAMES`
whose bare value currently resolves to null standalone (verified: all read falsy)
and whose `.constructor` leaks `Object_get_constructor`: Set, Map, WeakMap,
WeakSet, WeakRef, RegExp, FinalizationRegistry, DisposableStack,
AsyncDisposableStack, SuppressedError. It EXCLUDES builtins that already carry a
genuine bare-value identity — `Math`/`JSON`/`Reflect` and the `Error` family
(#2907 namespace-object carriers), `Array`/`Object` (namespace objects),
native-error-tag constructors, TypedArrays, `Promise`, `Date`, etc. — so those
keep their existing lowering untouched.

### Not affected by the #2963 Phase-2 (Number.isInteger) blocker

#2555/#2963 documented a Phase-2 blocker: a reified static method CALLED as a
value (`const f = Number.isInteger; f(x)`) mis-dispatches because the any-callable
dispatch keys on arity, not exact param type, so a scalar-param closure traps.
That blocker is about **calling** a reified value. This issue's reified
constructor object is only ever **read and compared by identity**, never called —
so it does not hit the arity-dispatch blocker (confirmed: all 9 tests + swap
guards run without trapping).

## Genuine-correctness verification

Verified with `--target standalone --nativeStrings` (run, not just compiled),
using clean identity oracles (inline `===` → concrete-ref `ref.eq`; and a CLEAN
`if (a===b) return true` SameValue helper across the externref-widening
function-param boundary):

- `<Builtin>.prototype.constructor === <Builtin>` → **1** for all 8 named builtins
  - `(new WeakMap()).constructor` + typed `re.constructor` (host-free).
- **Swap-wrong-builtin guard** (`project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`):
  `Set.prototype.constructor === Map` → **0**, `WeakMap.prototype.constructor === Set`
  → **0**, `re.constructor === Set` → **0** (GENUINELY false — the #2537 null-fold
  returned true here).
- Bare identifiers: `Set === Set` → **1**, `Set === Map` → **0**, inline
  `(Set as any) === (Map as any)` → **0**.
- All **9 origin test262 files pass** in the standalone lane, host-free
  (`env::Object_get_constructor` absent).
- gc/host lane byte-inert (sha256 `7892df4bdd0bf146` unchanged) and retains the
  real `Object_get_constructor` import (fold is `ctx.standalone`-gated).
- Standalone programs with no builtin-constructor value reads byte-inert
  (plain-math `d14df15d9255a873`, `[1,2,3].map(Number)` `869c424a2ae36eaf`).

## Adjacent discovery (pre-existing, out of scope) — the verbatim test262 `_isSameValue` confound

The verbatim test262 harness `assert._isSameValue` is
`if (a === b) { return a !== 0 || 1/a === 1/b; } return a !== a && b !== b;`. The
`1/a === 1/b` sub-expression makes the compiler ToNumber-coerce the `any`
operands, which **collapses the `a === b` reference comparison for ALL objects** —
reproducible with two distinct plain object literals (`{p:1} !== {p:2}` returns
**1** under this exact harness but **0** under a clean `if (a===b) return true`
helper), using NONE of this issue's code. So the verbatim harness is NOT a
faithful identity oracle. It does **not** cause a false pass here: the 9 tests
only assert the spec-TRUE case (`.constructor === <same Builtin>`), which passes,
and test262 has no `notSameValue(<Builtin>.prototype.constructor, <other>)` test.
The genuine identity above is validated with clean oracles instead. This
harness-lowering bug (an `any`-operand `1/a` numeric-coercion issue, #2058 family)
is a separate pre-existing defect; filing a follow-up is warranted but out of
scope for #3006.

## Deferred — `Object_set_constructor` / RegExp `Symbol.split`/`matchAll` species (~5 tests)

The task flagged the `Object_set_constructor` tail (~5 tests) as conditional ("if
related"). It is a distinct **write-path** concern (`obj.constructor = X` /
species-constructor derivation), not a value-READ, so this read-identity fix does
not address it and it is not trivially reproduced on current main (no
`constructor` import leaked by the probed species/split shapes). Deferred to a
follow-up; the read-identity substrate here is the prerequisite it would build on.

## Acceptance criteria

- The 9 listed test262 files pass in the standalone lane, host-free. ✅ (9/9)
- `env::Object_get_constructor` eliminated from those binaries. ✅
- Identity is GENUINE, not a null≡null tautology — swap-wrong-builtin returns
  false. ✅
- gc/host lane unchanged — `Object_get_constructor` retained; byte-inert. ✅
- No regression in Set/Map/RegExp/Weak\*/DisposableStack/SuppressedError suites.
  ✅ (101 passing tests across 10 suites; the 4 `issue-2175` failures are
  pre-existing on `origin/main`, identical without this change.)

## Files

- `src/codegen/builtin-static-globals.ts` — `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`,
  `isBuiltinConstructorIdentityName`, `emitBuiltinConstructorIdentity`.
- `src/codegen/property-access.ts` — early `.constructor` fold in
  `compilePropertyAccess`.
- `src/codegen/expressions/identifiers.ts` — bare builtin-constructor identifier
  value read.
- `tests/issue-3006-builtin-constructor-identity.test.ts` — genuine-identity +
  swap-guard + host-free + gc/host-retains-import (14 tests).
