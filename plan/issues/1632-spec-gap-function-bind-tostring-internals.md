---
id: 1632
title: "spec gap: Function.prototype.bind/toString + Function/internals (175 + 7 test262 fails)"
status: ready
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
