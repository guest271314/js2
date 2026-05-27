---
id: 1632
title: "spec gap: Function.prototype.bind/toString + Function/internals (175 + 7 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
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

## Investigation 2026-05-27 (dev-1632) — ESCALATED-NEEDS-SPEC

Reproduced current state against main (HEAD 6d5a806d0) with scoped probes:

- `Function.prototype.bind.length === 1` and `.name === "bind"` **already
  pass** — these resolve to the real host intrinsic. Acceptance criteria 1 & 2
  are likely already green; verify with a smoke run before re-prioritising.
- **Deferred bind is the real gap.** `const bt = target.bind(null, 10); bt(5)`
  is broken: the codegen "identity-bind" path (`calls.ts`, the
  `propAccess.name.text === "bind"` block that is NOT immediately called)
  drops the partial args and bound `this` and returns the bare receiver, so the
  partials are lost and a later call mis-arities the closure.
- **Immediate bind+call works**: `target.bind(null, 10)(5) === 15` is handled by
  a separate path (the `fn.bind(...)(...)` block lower in `calls.ts`) and is
  correct.
- Compiled-function `.name` / `.length` (e.g. `target.name`, `target.length`)
  return wrong/empty values — the wasm closure struct carries **no name/length
  metadata** at all. `bind/instance-name.js` additionally needs the *runtime*
  `name` (set via `Object.defineProperty`), not the static binding name.

### Prototyped fix (reverted — introduced a regression risk)

Added a host import `__make_bound_function(target, boundThis, boundArgs, name,
length)` in `runtime.ts` and rewired the identity-bind callsite to call it,
passing the statically-resolved name + param-count (a new
`resolveFunctionNameAndLength` helper). Result:

- ✅ bound `.name === "bound target"` worked.
- ✅ partial args + bound `this` were applied correctly.
- ❌ **calling a *stored* bound result** (`const bt = ...; bt(5)`) crashed:
  the synthesized value is a real **JS function (externref)**, but the
  closure-call path (`calls-closures.ts`) `ref.cast`s the externref back to a
  **wasm closure struct** — a JS function is not a closure struct, so the cast
  fails → null-deref trap. The old identity-bind returned an actual closure
  struct, so `bt(5)` did *not* crash (it returned a semantically-wrong-but-safe
  value). Shipping the prototype would convert silent-wrong into crashes →
  net regression risk.

### Why this needs an architect spec

The blocker is a missing capability, not a localized bug: **there is no way to
call an arbitrary JS-function value (externref) from compiled Wasm.** The
closure-call path only knows how to dispatch wasm closure structs. A correct
`bind` (and `toString`, and function `.name`/`.length`) requires one of:

1. A **host-callable-value** dispatch: when calling an externref that is a JS
   function (not a wasm closure struct), route through a host import that does
   `fn.apply(thisArg, args)` instead of `ref.cast` → `call_ref`. This unblocks
   bind, stored host callbacks, and `Function`-returning host APIs generally.
2. A **function-metadata side-table** (per the original Implementation Plan):
   emit `{name, length, sourceText}` keyed by function/closure so `.name`,
   `.length`, and `toString` resolve, plus a wasm-native bound-closure struct
   that the closure-call path already understands (avoids the externref-call
   problem entirely). Heavier, but keeps everything in-Wasm and standalone-safe.

Recommend option (1) for bind/toString breadth + option (2)'s metadata table
for `.name`/`.length`/`toString` source. Both are multi-file, core-codegen
changes — `feasibility` should be raised from `medium` to `hard`.

No code changes landed (prototype reverted). Branch `issue-1632-bind-tostring`
holds only this investigation note.
