---
id: 2788
title: "malformed_wasm: __module_init call type mismatch (array/01-basic, closures/10-mutual)"
status: done
assignee: ttraenkler/sdev-2788-malformed
completed: 2026-06-28
sprint: 69
created: 2026-06-28
updated: 2026-07-03
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

## Implementation notes (resolution)

**Root cause (single, shared between both cases).** `compileConsoleCall`
(`src/codegen/expressions/builtins.ts`) selects the host import variant
(`console_${method}_{number|bool|string|externref}`) from the argument's
**static TS type**, then compiled the argument with **no expected-type hint** and
emitted the call. When the argument's *emitted* ValType did not match the
selected import's parameter ValType, the operand was left mistyped → invalid
wasm. The two corpus failures are mirror images of this one skew:

- **`array/01-basic` (the regression).** `console.log(a[i])` for a `number[]`.
  The TS type is `number` → `console_log_number` (f64 param). But #2760 (the
  bounds-checked OOB→undefined element read) widens an *unproven* primitive
  element read to a boxed-or-undefined **externref**, and that widening only
  self-suppresses when a numeric `expectedType` is threaded into the element
  access (#2760 did this for `Math.*`, not for `console.log`). So the read
  produced `if (result externref)` where the call wanted f64 →
  `call[0] expected type f64, found if of type externref`. This is what flipped
  the file from `match` → `malformed_wasm`.
- **`closures/10-mutual`.** `console.log(isEven(n))` for a mutually-recursive
  boolean kernel. TS can't resolve the circular return type → reports `any` →
  `console_log_externref` (externref param). But the compiler lowers `isEven` to
  return a **primitive scalar** — f64 via `inferNumericReturnTypes`' implicit-any
  promotion on the legacy path, and i32 on the default IR path (the IR selector
  re-types the kernel to its true boolean i32 *after* `__module_init` has already
  compiled the legacy call). Either way a raw scalar reached an `externref`
  parameter → `call[0] expected type externref, found call of type {f64,i32}`.
  (The legacy-vs-IR signature skew is incidental; the bug reproduces with
  `experimentalIR:false` too — the fix is robust to both.)

**Fix.** In `compileConsoleCall`, coerce each argument to the selected import's
parameter ValType using the existing coercion machinery (no special-case
lowering):

- number variant → compile the arg with `expectedType {kind:"f64"}` (the #2760
  hint suppresses the element-read widening at the source, so the read emits an
  unboxed f64 directly — no box/unbox round-trip);
- bool variant → `expectedType {kind:"i32"}`;
- externref variant → compile the arg **without** an `expectedType` hint, then
  `coerceType(result, externref)` **only when `result` is a primitive scalar**
  (f64/i32/i64). This is the load-bearing nuance: threading
  `expectedType:externref` into the element/array path would route an *array*
  operand through the iterable adapter (`__make_iterable`) and change the printed
  output. Ref/externref operands already match the param and are left untouched.

**Byte-neutrality.** Verified SHA-identical output vs `origin/main` for every
already-valid `console.log` shape (number/bool/string literals & vars, object,
array, template, concat, `any`-returning fn). The only byte change is at the
two call sites that were *already invalid* before the fix — coercion can only
turn a mismatched operand into a matching one, so it cannot regress a
previously-valid module.

**Scope boundary.** `array/01-basic` now prints `3,1,3` (fully `match`).
`closures/10-mutual` now emits **valid wasm** but prints `1`/`0` rather than
`true`/`false`, because the boolean kernel's i32 result carries no boolean brand
at module-init time (TS reports `any`; `inferNumericReturnTypes` treats booleans
as numeric). That residual is *valid wasm, wrong output* — explicitly **#2787**'s
lane, not this issue's ("scoped to the 2 invalid-module codegen bugs only"). The
diff-test delta gate only fails on `match → non-match`; `closures/10-mutual` was
`runtime_error` in the baseline (never `match`), so moving it to a mismatch is
not a gate regression and it leaves the malformed lane as required.

**Regression test:** `tests/issue-2788.test.ts` pins validity for both shapes
under IR on/off, the `3,1,3` array output, and the array-operand byte-path
guard.
