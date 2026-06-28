---
id: 2788
title: "malformed_wasm: __module_init call type mismatch (array/01-basic, closures/10-mutual)"
status: ready
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: compiler-internals
goal: trustworthiness
related: [2787, 2143]
origin: "2026-06-28 — diff-test job 83903650345; reproduced locally on origin/main @867cdfbdb"
---

# #2788 — malformed_wasm: `__module_init` call argument type mismatch

## Problem

Two differential-test corpus programs compile **successfully** (the compiler
reports `r.success === true`) but emit a binary that **fails
`WebAssembly.validate`** — i.e. the codegen produces an invalid module. These
are genuine correctness bugs (split from the #2787 umbrella because invalid
output is higher severity than a wrong-output mismatch). Both fail at a
**call site inside `__module_init`** with an argument-type mismatch, which
points at the top-level / module-init lowering picking the wrong operand
representation (boxed `externref` vs unboxed `f64`/`i32`) at a call.

## Reproductions (origin/main @ 867cdfbdb)

Both reproduce exactly as the `diff-test` harness classifies them — default
pipeline, in-process `compile()` then `WebAssembly.validate`:

### Case 1 — `tests/differential/corpus/array/01-basic.js`

```js
const a = [1, 2, 3];
console.log(a.length);
console.log(a[0]);
console.log(a[a.length - 1]);
```

```
compile success: true   binary bytes: 1335   WebAssembly.validate: false
WebAssembly.compile() error:
  Compiling function #4:"__module_init" failed:
  call[0] expected type f64, found if of type externref @+442
```

The callee expects an `f64` argument but receives an `externref` produced by
an `if` — most likely the `a[a.length - 1]` computed-index read (the
`length - 1` index expression) lowering to a boxed `any`/`externref` where the
call wants an unboxed `f64`. This is also flagged by the delta gate as a
**new regression** (`match → malformed_wasm`), so it is the immediate cause of
the red diff-test gate.

### Case 2 — `tests/differential/corpus/closures/10-mutual.js`

```
compile success: true   binary bytes: 343   WebAssembly.validate: false
WebAssembly.compile() error:
  Compiling function #3:"__module_init" failed:
  call[0] expected type externref, found call of type i32 @+262
```

Mutual-recursion closures: the callee expects an `externref` argument but
receives an `i32` produced by a nested `call` — the inverse representation
skew (unboxed `i32` where a boxed `externref` is required).

### Local repro harness

```ts
import { readFileSync } from "node:fs";
import { compile } from "../src/index.ts"; // run from a .tmp/ file via `npx tsx`
for (const file of ["tests/differential/corpus/array/01-basic.js", "tests/differential/corpus/closures/10-mutual.js"]) {
  const r = await compile(readFileSync(file, "utf-8"), { fileName: file });
  if (!r.success) {
    console.log(file, "compile_error", r.errors[0]?.message);
    continue;
  }
  if (!WebAssembly.validate(r.binary)) {
    try {
      await WebAssembly.compile(r.binary);
    } catch (e) {
      console.log(file, (e as Error).message);
    }
  }
}
```

## Hypothesis / where to look

Both failures are a **call-argument coercion skew in `__module_init`** (the
top-level statement function): the emitted argument's value type does not
match the callee signature's parameter type. The two cases are mirror images
(`externref` supplied where `f64` expected, and `i32` supplied where
`externref` expected), so the root cause is likely a missing/incorrect
`coerceType` (see `src/codegen/type-coercion.ts`) at the top-level call-emit
path — possibly the boxing/unboxing decision for computed array-index reads
and for closure-call arguments when emitted at module-init scope rather than
inside a regular function body.

## Acceptance criteria

- `array/01-basic.js` and `closures/10-mutual.js` both pass
  `WebAssembly.validate` after compile (no more `malformed_wasm`).
- The `diff-test` delta gate no longer reports the `array/01-basic.js`
  `match → malformed_wasm` regression.
- An equivalence/regression test pins both programs (or the minimal computed-
  index + mutual-recursion shapes) so the invalid-module skew can't recur.

## Notes

- Umbrella / sibling conformance failures (valid wasm, wrong output) are
  tracked in **#2787**; this issue is scoped to the **2 invalid-module**
  codegen bugs only.
- #2143 added the default-pipeline `WebAssembly.validate` lane that catches
  exactly this class of "compiler said success but the module is malformed"
  bug.
