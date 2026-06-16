---
id: 2025
title: "calling an extracted method (const f = a.m; f()) traps uncatchably instead of throwing catchable TypeError"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1949, 581]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2025 — null-this trampoline trap escapes try/catch

## Problem

```ts
class A { x = 42; m(): number { return this.x; } }
const a = new A(); const f = a.m;
try { return "got:" + f(); } catch (e) { return "threw"; }
// wasm: trap "dereferencing a null pointer" escapes the try/catch
// node: "threw" (TypeError: this is undefined)
```

Extraction of methods that don't touch `this` works.

## Root cause

`src/codegen/closures.ts:3264-3269` — extraction trampoline passes
`ref.null <objStruct>` for `this` by documented design ("methods that DO
use `this` will trap inside the body"); divergence is trap-vs-catchable
TypeError (error model). Family: #581 (struct.get on ref null
catchability).

## Fix direction

Emit a null-check prologue in the trampoline (or at `this`-deref sites in
methods reachable via extraction) throwing the JS TypeError exception tag
instead of trapping.

## Acceptance criteria

- Repro returns "threw" with TypeError; bound/direct calls unchanged

## Dupe check

#1949 (call/apply thisArg) adjacent but distinct; #581 is the general
family. New.

## Attempt 1 — trampoline-level throw REVERTED (2026-06-16)

First attempt (PR #1571, closed unmerged) emitted the catchable TypeError in
the method-extraction trampoline `buildTrampolineThisSlot` (`src/codegen/
closures.ts`), gated on whether the method body reads `this` (`local.get 0`,
detected by walking the compiled body). It passed 11 hand-written repros
(extracted-this, args, generator/async/HOF extraction, inheritance dispatch)
but the test262 regression gate caught **75 regressions** (net -75 pass, 0
improvements, 71/75 with a wasm-hash change → real, not drift): `wasm_compile`
40 (malformed modules), `runtime_error` 35.

**Why it's the wrong layer:** `buildTrampolineThisSlot` is a SHARED, fragile
path. The same trampoline is reached not only by unbound extraction but by:
- the #2015 `__call_fn_method_N` method-dispatch path (which installs the
  receiver into `__current_this`), and
- the #1602/#1636 finalize/re-resolve paths.
Its null-`this` arm (`__current_this` doesn't `ref.test` as the EXACT object
struct) fires for legitimate calls too — e.g. a receiver that is a subclass /
boxed / structurally-distinct instance. Throwing there breaks valid method
calls and, combined with the late-import/index-shift sensitivity of the
finalize rebuild, emits malformed Wasm in a class of cases the hand repros
didn't cover.

**Recommendation for attempt 2:** do NOT throw in the trampoline. Move the
catchable-TypeError emission to the **`this`-dereference site** in the method
body (guard the `local.get 0; struct.get` of `this` against null with a
TypeError throw) so it fires only when a genuinely-null `this` is actually
dereferenced, independent of which dispatch path reached the method. That is
narrower and path-agnostic. Reference branch (preserved):
`origin/issue-2025-extracted-method-typeerror` (has `buildTypeErrorThrow` in
`destructuring-params.ts` + tests/issue-2025.test.ts, both reusable).

Given #2025 is `priority: low`, this is parked back at `ready` pending a
this-deref-site approach; not worth iterating against the invisible regressed
cluster under the trampoline approach.
