---
id: 1553
sprint: 52
title: "spec gap: let/const/var destructuring declarations — residuals after #1432/#1450/#1454/#1550"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: declarations, destructuring
goal: spec-completeness
parent: 779
related: [1432, 1450, 1454, 1550]
---
# #1553 — `let`/`const`/`var [pattern] = value` declaration-form destructuring residuals

## Problem

ECMA-262 §14.3 (let/const) and §14.3.2 (var) declaration evaluation uses
`BindingInitialization` with `LexicalEnvironment` / `VariableEnvironment`
respectively. The same algorithm function-decl params use, but the
declaration emitter has its own lowering path in `src/codegen/statements.ts`.

**93 test262 cases** under
`test/language/statements/{let,const,variable}/dstr/` still fail with
`assertion_fail` in the May 2026 baseline, even though the same patterns
in function-decl form (`statements/function/dstr/`) pass.

Top sub-buckets:

| Cluster | Count | Pattern |
| --- | --- | --- |
| `ary-ptrn-elem-*` | 27 | `let [a, b = init] = arr` — init firing or throwing |
| `obj-ptrn-prop-*` | 24 | `let {p: a, q: b} = obj` — property re-key |
| `ary-init-iter-*` | 9 | `let [a] = throwingIter()` — iterator close, get-err |
| `obj-ptrn-id-init-*` | 9 | `let {fn = function(){}} = {}` — fn-name |
| `ary-ptrn-rest-*` | 6 | `let [...rest] = arr` — rest binding |
| `obj-ptrn-rest-getter` | 3 | `let {...rest} = obj` — getter side-effects |
| `obj-init-null` / `obj-init-undefined` | 6 | `let {a} = null` — must TypeError |
| `obj-ptrn-list-err` | 3 | computed key / property eval err propagation |
| `ary-ptrn-empty` | 3 | `let [] = nonIterable` — should observe iterator |
| `ary-ptrn-elision` | 3 | `let [, x] = arr` — elision iter step |

Sample failures:

```js
// statements/variable/dstr/ary-ptrn-elem-id-init-throws.js
var thrown = new Test262Error();
assert.throws(Test262Error, function() {
  var [x = function() { throw thrown; }()] = [];
});

// statements/let/dstr/obj-ptrn-prop-obj-value-undef.js
assert.throws(TypeError, function() {
  let { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: undefined };
  // Wait, this should NOT throw — w's default fires because w is undefined.
  // The current bug: we still try to destructure `undefined` BEFORE checking
  // the default. So we throw "Cannot destructure undefined" instead of using
  // the default.
});
```

(The second example shows the canonical bug: nested default + property
value `undefined` — default must fire before nested destructure.)

## Failure count

**93** tests across declaration-form `dstr/` folders. Estimated unlock
after fix: ~70 (some are downstream of #1454 iterator-protocol; sibling
issues will absorb those).

## Root cause

`src/codegen/statements.ts` `compileVariableDeclaration` (or similar) emits
a declaration-specific destructure loop instead of delegating to the
shared `destructureParam*` helpers used by function declarations:

1. **No re-use of fix from #1432** — `compileVariableDeclaration` likely
   handles trivial patterns inline and bails to a runtime helper for
   non-trivial ones. The bail-out helper may differ from
   `destructureParamArray`.

2. **Nested default not gated** — for `let {w: {x,y,z} = {x:4,y:5,z:6}} = {w:undefined}`:
   - Outer: read `w` → `undefined`.
   - Inner: default `{x:4,y:5,z:6}` should fire because the value (`undefined`)
     equals undefined.
   - Then destructure `{x:4,y:5,z:6}` into x,y,z.
   We probably try to destructure `undefined` *before* checking the default.

3. **`null`/`undefined` source** — `let {a} = null` must throw `TypeError`
   per §7.3.20 `RequireObjectCoercible`. The current code may produce
   `a = undefined` silently.

4. **`var [x = throwingExpr()] = []`** — when the iterator is exhausted,
   `v = undefined`, default fires, throws — we must propagate the original
   thrown value, not swallow.

5. **`let {fn = function(){}} = {}`** — see #1450 NamedEvaluation.
   Declaration-form may not invoke the helper that #1450 fixes.

6. **`let {...rest} = obj`** — rest binding in declarations uses
   `CopyDataProperties`. Non-enumerable filtering must apply (same bug
   as #1552 catch-rest).

## Acceptance criteria

1. `test/language/statements/let/dstr/obj-ptrn-prop-obj-value-undef.js`
   passes — nested default fires when value is `undefined`.
2. `test/language/statements/variable/dstr/ary-ptrn-elem-id-init-throws.js`
   passes — initializer's thrown value propagates.
3. `test/language/statements/const/dstr/obj-init-null.js` passes —
   destructuring `null` throws `TypeError`.
4. `test/language/statements/let/dstr/obj-ptrn-id-init-fn-name-class.js`
   passes — NamedEvaluation via #1450 also fires for `let` declaration.
5. `test/language/statements/variable/dstr/ary-ptrn-rest-obj-prop-id.js`
   passes — rest with object pattern (cross-check #1432).
6. Declaration-form `assertion_fail` count reduces by **≥ 60**.
7. `tests/issue-1553.test.ts` with one focused case per shape.

## Implementation plan

### Step 1 — locate the declaration destructure emitter

```bash
grep -nR "compileVariableDeclaration\|VariableDeclarator\|destructureDecl" src/codegen
```

Identify whether `let [pattern] = expr` / `var {pattern} = expr` /
`const [pattern] = expr` all share one emitter or diverge.

### Step 2 — delegate to the shared helper

Reuse the **same** `destructureParam*` helpers used by function parameters
and (after #1552) catch clauses. The init value to feed them is just
the RHS of the declarator:

```ts
function compileVariableDeclarator(ctx, decl) {
  if (decl.id.type === 'Identifier') {
    // existing simple path
    return;
  }
  // Pattern path:
  compileExpression(ctx, decl.init);  // pushes externref onto stack
  const rhsLocal = ctx.addLocal('__decl_rhs', 'externref');
  emit(Op.local_set, rhsLocal);
  destructureParam(ctx, decl.id, rhsLocal, { mode: 'decl', kind: decl.kind });
}
```

The `mode: 'decl'` flag may be needed so the helper uses
`InitializeReferencedBinding` vs `PutValue` semantics on the LHS
(matters for `const`).

### Step 3 — null/undefined coercibility check at top

Before invoking the destructure loop on an object pattern, emit:

```wasm
local.get $rhs
call $__require_object_coercible    ;; throws TypeError if null/undef
```

For array patterns, the spec calls `GetIterator(rhs)`, which throws
TypeError if `rhs` is `null`/`undefined` (because there's no @@iterator).
This is automatic if we use the IteratorRecord path from #1454.

### Step 4 — nested-default-before-destructure

When emitting destructuring of an object pattern element where the
**target** is itself a pattern with a default initializer
(`{w: {x,y} = {x:1,y:2}}`), the order MUST be:

1. Read property `w` from RHS → `v`.
2. If `v === undefined` AND initializer is present, evaluate initializer
   → `v`.
3. Then destructure `v` into `{x, y}`.

If step 2 is missing, step 3 receives `undefined` and crashes. Verify
the shared helper does step 2 universally.

### Step 5 — `const` immutability

`const [a, b] = arr` — each `a`, `b` is a `const` binding. Re-assignment
attempts must throw `TypeError`. The shared helper should use
`InitializeReferencedBinding` (writeable=false) for const, vs
`PutValue` for let/var. Verify this binding-kind propagation.

### Step 6 — `tests/issue-1553.test.ts`

```ts
runCases('issue-1553 decl dstr', [
  ['let-obj-default-nested',
   `let { w: { x, y, z } = { x: 1, y: 2, z: 3 } } = { w: undefined };
    JSON.stringify([x,y,z])`, '[1,2,3]'],
  ['var-init-throws',
   `let t='ok';
    try{var [x=(function(){throw 'bang'})()]=[]}catch(e){t=e};t`, 'bang'],
  ['const-null-throws',
   `let kind='none';try{const {a} = null}catch(e){kind=e&&e.name||String(e)};kind`, 'TypeError'],
  ['let-rest',
   `let [a,...rest] = [1,2,3,4]; JSON.stringify([a,rest])`, '[1,[2,3,4]]'],
  ['let-rest-non-enum',
   `let o={a:1};Object.defineProperty(o,'x',{value:9,enumerable:false});
    let {...r}=o; JSON.stringify(r)`, '{"a":1}'],
  ['fn-name-decl',
   `let {fn = function(){}} = {}; fn.name`, 'fn'],
]);
```

## Files to inspect

- `src/codegen/statements.ts` — `compileVariableDeclaration`,
  `compileVariableDeclarator`.
- `src/codegen/destructuring-params.ts` — shared helper.
- `src/codegen/destructuring.ts` (if separate) — declaration-form
  legacy path.
- `src/runtime.ts` — `__require_object_coercible` (add if missing),
  `__copy_data_properties`.

## Dependencies

Most of the unlock here is **ripple from #1450/#1454/#1550** once the
shared helper is the single source of truth. Land those siblings first;
the residual focused fixes for declaration-mode (binding kind, top-level
null/undefined coercibility) are then small.

## Out of scope

- Hoisting semantics for `var` (declaration moves to top of enclosing
  function/script) — separate concern.
- TDZ for `let`/`const` before initialization — already supported.
- For-loop init binding pattern scope — tracked by #1452/#1453.
