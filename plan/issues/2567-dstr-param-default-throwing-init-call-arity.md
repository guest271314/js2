---
id: 2567
title: "destructuring-param default whose initializer calls a function emits C_method one operand short for the call — invalid Wasm (4 test262)"
status: done
sprint: Backlog
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
assignee: ttraenkler/sd3
priority: low
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [2565, 2564, 1224]
test262_bucket: dstr-param-default-throwing-init
test262_count: 4
origin: "2026-06-21 sd3, spun out of #2565: pre-existing, distinct from the $shape bucket #2565 closed"
---

# #2567 — destructuring-param default with a function-call initializer is one call-arg short

## Problem

```ts
var initCount = 0;
function thrower() { throw new Test262Error(); }

class C {
  method({ a, b = thrower(), c = ++initCount } = {}) {}
}
new C().method();   // wasm: invalid binary — C_method call arity
```

The validator error (NOT the #2565 `struct.new` shape-id symptom):

```
invalid Wasm binary: Compiling function #N:"C_method" failed:
not enough arguments on the stack for call (need 1, got 0)
```

## Affected files (4 test262, verified INVALID on origin/main 2026-06-21)

- `language/statements/class/dstr/meth-dflt-obj-ptrn-list-err.js`
- `language/statements/class/dstr/meth-static-dflt-obj-ptrn-list-err.js`
- `language/expressions/class/dstr/meth-dflt-obj-ptrn-list-err.js`
- `language/expressions/class/dstr/meth-static-dflt-obj-ptrn-list-err.js`

These are negative-behaviour tests (`assert.throws(Test262Error, () => c.method())`)
of left-to-right param-default evaluation: the **first** binding default (`b =
thrower()`) must throw before the later default (`c = ++initCount`) runs, so
`initCount` stays 0.

## Root cause (distinct from #2565)

Spun out of #2565, which was closed as fixed-by-#2564 (the `$shape`-arity
symptom was a face of the shared-`blockType` DCE bug). This bug is **different**:
it is NOT a nested object pattern (`obj-ptrn-prop-obj`) and NOT a `struct.new`
shape-id arity mismatch. The shape is a **destructuring param whose binding
default is a function CALL** (`b = thrower()`), and the emitted `call` to the
default-initializer function lands one operand short (`need 1, got 0`) — the
materialization of the default-value call in the param-destructuring prologue
fails to push the callee's argument (or pushes the call before its receiver/arg
is staged). Was INVALID on main BEFORE #2564 too — pre-existing, unrelated to
the `$shape` collision-resolution pass.

## Fix direction

Inspect the destructuring-param default-initializer lowering (the
`__ext_dparam` / class-method param-default prologue) for the case where the
default value is a `CallExpression`: ensure the call's argument(s)/receiver are
staged on the stack before the `call`. Likely the default-slot guard
(`if arg === undefined → evaluate default`) emits the call body without first
materializing its operands, or drops them when the default expression itself
has side effects / throws.

## Acceptance criteria

- The 4 `*-list-err` files compile to valid Wasm and pass (the throwing default
  throws `Test262Error`, `initCount` stays 0).
- No regression in existing destructuring-param-default / class-method suites.

## Resolution (2026-06-21, sd3) — DONE

The original "fix direction" was a near-miss: the call is NOT one operand short
at emit time. It's a **late-import index-shift on a detached buffer** — the same
hazard family as #2158 / #1553d / #1109.

In `destructureParamObjectExternref` (`src/codegen/destructuring-params.ts`) the
identifier-with-initializer arm compiles the default-value expression into a
DETACHED `thenInstrs` buffer (swapped out of `fctx.body`) before splicing it into
the `if (__extern_is_undefined) { …default… }` guard. When the default is a
function CALL (`b = thrower()`), compiling it registers a late import and fires a
func/global-index shift. That shift walks `fctx.body` + `fctx.savedBodies` +
`ctx.liveBodies` — and the detached `thenInstrs` was on **none** of them. So the
already-emitted `call <thrower>` (emit-time funcIdx, e.g. 66) missed the shift and
was mis-remapped at finalize onto an unrelated import — observed landing on
`__typeof_bigint` (i32-returning) + `__box_number` scaffolding, i.e.
`call __typeof_bigint` with nothing on the stack →
`C_method: not enough arguments on the stack for call (need 1, got 0)` → invalid
Wasm. Verified by instrumentation: at emit `thrower()` compiled to a single clean
`call:66` returning externref; the corruption was purely the missed shift.

**Fix:** register the detached default buffers (`thenInstrs`, the `elseCoerce`
buffer, and the OUTER `savedBody` for the recursion window) in `ctx.liveBodies`
around the `compileExpression(element.initializer)` call, then remove them once
the `if` is spliced into `fctx.body` (avoiding the #1109 double-shift). This
mirrors the #2158 struct-fast-path then/else `liveBodies` tracking a few lines
below in the same file. One-file change, ~15 lines.

**Result:** all 4 `*-list-err` files → valid Wasm + PASS (throw Test262Error,
`initCount` stays 0). Regression test `tests/issue-2567-dstr-param-default-call-arity.test.ts`
(4 cases incl. a non-throwing call default) fails without the fix, passes with it.
Broad class-category sweep (statements + expressions, ~8426 files): 0 regressions.
