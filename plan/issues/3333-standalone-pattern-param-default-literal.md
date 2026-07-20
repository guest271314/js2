---
id: 3333
title: "standalone: whole-pattern param default OBJECT LITERAL never binds — `function f({a,b}: any = {a:5,b:3}); f()` reads garbage/NaN"
horizon: s
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-s2
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/function-body.ts
sprint: 72
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring-params, default-values
goal: standalone-mode
related: [3245, 3244, 2568, 852]
origin: "2026-07-17 fable-s2 — reduced from #3245's obj-rest residual (dflt-obj-ptrn-rest-val-obj.js) after the #3244 re-measure"
---

# #3333 — standalone pattern-param default literal never binds

## Reduced repro (verified 2026-07-17 on current main, `--target standalone`)

```ts
export function test(): number {
  let got = -1;
  const f = function ({ a, b }: any = { a: 5, b: 3 }) {
    got = a === 5 && b === 3 ? 1 : 0;
  };
  f();
  return got; // → 0 (bindings read garbage/NaN); expected 1
}
```

Precise differential (each single-variable):

| variant                                              | result      |
| ---------------------------------------------------- | ----------- |
| standalone + pattern param + default LITERAL         | **0 (bug)** |
| same, host (default) lane                            | 1           |
| standalone, default is a module-level `const D: any` | 1           |
| standalone, identifier param `o: any = {a:5,b:3}`    | 1           |
| standalone, arg passed explicitly (default unused)   | 1           |
| function DECLARATION form                            | **0 (bug)** |
| with `...rest` in the pattern                        | **0 (bug)** |

`rest.x` reads back NaN; even `a === 5` is false — the whole pattern binds
from the wrong value when the default fires. The default CHECK fires
correctly (the module-var default works), so the mismatch is between the
shape the default LITERAL materializes in (`structHintForBindingPattern`,
#2568 — WAT shows `f64.const 5; f64.const 3; struct.new <anon>`) and the
shape `destructureParamObject`'s read path expects on the standalone lane
(its `ref.test` fast path / dynamic fallback misses that struct, reads 0/NaN).
Suspect: the two "mirrored" struct-type derivations diverge for `any`-typed
patterns on standalone, or the destructure's else-branch (`__extern_get`
dynamic read) cannot read the anonymous f64-field struct (the classic
value-rep substrate gap, cf. project_standalone_any_string_value_read
memory).

## test262 anchor

`language/expressions/async-generator/dstr/dflt-obj-ptrn-rest-val-obj.js`
(fails `assert #1: rest.a === undefined`) — and every `dflt-*` dstr template
sibling that routes a whole-pattern default literal on the standalone lane.
The non-dflt twin (`obj-ptrn-rest-val-obj.js`) passes.

## Acceptance

- The reduced repro returns 1 on `--target standalone` (expression AND
  declaration forms, with and without `...rest`).
- `dflt-obj-ptrn-rest-val-obj.js` passes cold standalone.
- Host lane byte-neutral or verified no-regression on the dstr family.

## Fix (2026-07-17, fable-s2, same-day)

Root confirmed via WAT: the default literal materialized as a typed ANONYMOUS
struct (`f64.const 5; f64.const 3; struct.new <anon>; extern.convert_any`)
because the `any`-typed pattern yields NO struct hint
(`structHintForBindingPattern` → undefined ⇒ bare externref hint), while the
destructure — also hint-less — takes the dynamic `__extern_get` path, which
cannot reflect anonymous typed structs on the host-free lanes (host lane
reflects wasm structs through the host wrapper, hence never broken).

Fix at BOTH whole-param default sites: when `(standalone || wasi)` ∧ object
binding pattern ∧ externref param ∧ object-literal initializer ∧ no struct
hint, materialize the default via `compileObjectLiteralAsExternref` (the
`__new_plain_object` dynamic carrier — the exact shape the dynamic reader
consumes, and why the module-var default control always worked):

- `src/codegen/function-body.ts` (declarations)
- `src/codegen/closures.ts` (function expressions / arrows; this site never
  had the #2568 struct hint either — typed-pattern closure defaults on
  standalone may deserve the #2568 mirror as a follow-up, not folded in)

## Test Results

- `tests/issue-3333.test.ts` (4): expression form, declaration + rest,
  explicit-undefined, and the three controls (passed-arg / module-var /
  ident-param) — all pass host-free.
- test262 anchors cold standalone: `dflt-obj-ptrn-rest-val-obj.js` PASS (was
  fail), `obj-ptrn-rest-val-obj.js` still PASS.
- Sweep: issue-2568, issue-2158, issue-2512, fn-param-dstr-rest-in-rest,
  issue-1372 — 33/33.
