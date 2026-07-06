---
id: 3024
title: "codegen: invalid Wasm binary emission residual — default (JS-host) lane (~131 fails, externref/f64 type-mismatch emitter bugs)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: codegen-correctness
goal: correctness
test262_category: language/expressions/object/dstr, built-ins/AsyncFromSyncIteratorPrototype, language/expressions/in
test262_ce: 131
related: []
---

# #3024 — invalid Wasm binary emission residual (default lane)

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). **131**
official tests compile to a Wasm module that fails validation. Unlike the
several `standalone-invalid-wasm-*` issues already tracked (#2039, #2878,
#2934 — all standalone-target-specific), this bucket is on the **default
`gc` target**, so it's a distinct residual not covered by those.

## Breakdown by validator error

| reason | count |
|---|--:|
| `call[N]` expected `(ref null T)`, found other | 14 |
| `struct.new` — not enough args | 11 |
| `local.set` expected `(ref null T)` | 7 |
| `fN.ne`/`fN.trunc` expected `fN`, found `externref` | 13 (7+6) |
| `array.set` type error inside `__vec_from_extern` | (part of remainder) |
| other/remainder | ~76 |

Failing function names cluster around `test` (64 — top-level test body),
`testCompoundAssignment` (11), `__closure_*` (async-gen closures),
`__vec_from_extern_*`, `__obj_meth_tramp_*` (object-method trampolines).
Root cause is an externref-vs-f64/ref-null type mismatch at emit time in (a)
async-generator destructuring, (b) compound assignment operators, (c) the
"vec from extern" array-materialization helper.

## Sample failing files

- `language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-ary-elision.js`
- `built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
- `language/expressions/in/private-field-rhs-non-object.js`

## Suggested approach

1. Start with `testCompoundAssignment` (11 fails, single named function) —
   smallest, most concentrated sub-bucket; likely one type-coercion bug in
   compound-assignment codegen (`x += y` where `x`/`y` cross the
   externref/f64 boundary).
2. `__vec_from_extern_*` `array.set` type errors — check the element-type
   assumed by the array-materialization helper against the actual value
   representation of the source (likely a boxed-any vs. typed-element
   mismatch, similar in shape to the already-fixed #2379
   `new-array-n-boxed-any-elem-rep`).
3. Async-gen destructuring `__closure_*` failures — trace one repro through
   `-O0` unoptimized output (`--target gc` with binaryen disabled) to see
   the exact instruction sequence at the reported `call[N]`/`local.set` site.

## Acceptance criteria

- `wasm-validate`-class compile errors on the default `gc` target drop
  materially below the 131 recorded here.
- No regression in the standalone-lane invalid-Wasm counts (#2039/#2878/#2934)
  — this issue is scoped to the default target only.

---

## Banked root-cause: the `testCompoundAssignment` / numeric-operator sub-bucket (sr-interp, 2026-07-03)

Measure-first reduction of the **11-fail `testCompoundAssignment`** cluster (and,
by shared mechanism, the **`fN.ne`/`fN.trunc` expected fN found externref** rows,
13). Verified on default `gc` lane (`compile(src, {})`, `WebAssembly.compile`).

### Minimal repro (default gc lane → invalid Wasm)
```ts
export function test(): number { var x = 3; x = x * eval("var x = 2;"); return x; }
// → f64.mul[0] expected type f64, found local.tee of type externref
```
`x *= eval("var x = 2;")` fails identically (compound-assign desugars to `x = x * …`).

### Discriminators (why the bucket is narrow — all verified)
| variant | result |
|---|---|
| `x * eval("var x = 2;")` (same-name var-declaring eval) | **INVALID** |
| `x * eval("var y = 2;")` (different name) | VALID |
| `x * eval("2")` (eval, no var-decl) | VALID |
| `x += eval("var x = 2;")` (`+` / `+=`) | VALID |
| `eval("var x = 2;"); x *= 4;` (eval as separate stmt) | VALID |
| `x * e()` where `e():any` (any RHS, no eval) | VALID |

So the trigger is precisely: a **non-strict direct `eval` that declares a `var` of
the SAME name** as a numeric local used as an operand of a **numeric-only**
operator (`*`,`-`,`/`,`%`; unary `fN.ne`/`fN.trunc`). `+`/`+=` is immune (its
string-or-number lowering coerces the operand); a separate-statement eval is
immune (only the operand of the SAME expression is mis-typed).

### Root cause (representation vs static-type DESYNC)
`eval("var x = …")` promotes the binding `x`'s **slot** to `externref` (the
dynamic / eval-reachable representation, so the eval can read/redefine it), while
the TS checker still types `x` as `number`. The numeric-operator codegen emits a
raw `local.get`/`local.tee` of the externref slot but treats the operand as `f64`
(its static type), so **no `externref → f64` coercion is inserted** and it bakes
`f64.mul`/`f64.ne`/… directly on an externref → `expected fN, found externref`.

### Fix LOCATION (verified by elimination — turnkey)
- **NOT `compileBinaryNumeric`** (binary-ops.ts ~156): it `return null`s on the
  `any` guard (L169) because the eval RHS is typed `any`, so the multiply is NOT
  emitted there. I applied the slot-type-trust fix there and it did **not** change
  the repro — confirming the emit is elsewhere. (Reverted; do not re-attempt there.)
- **The emit is in the general `compileBinaryExpression`** (binary-ops.ts ~254,
  the mixed `number × any` arithmetic path — note the pre-existing "the receiver
  `id` is typed `number`/`any`, so the operand's *TS* type…" desync comment at
  ~L1141). The fix mirrors the **`in`-operator precedent** (binary-ops.ts
  ~L605-618, "Trust the ACTUAL slot type: if the receiver is an identifier whose
  local slot is externref/anyref…"): before emitting the numeric op, if an
  identifier operand's **actual** `fctx` slot type is `externref`/`anyref` (even
  though its TS type is `number`), route it through the existing
  `externref → f64` coercion (`coerceType(…, {kind:"f64"}, "number")`).

### Blast radius (why this is banked, not landed, at 4% budget)
This is a **shared desync class**, not one operator: the same "static type says
`number`, slot is `externref` (eval-promoted / dynamically boxed)" mismatch is the
likely root of the issue's other rows — `fN.ne`/`fN.trunc` externref (13),
`local.set expected (ref null T)` (7), and possibly `call[N] expected (ref null T)`
(14). A root fix (make identifier compilation report the true slot type, or coerce
at every numeric consumer) would clear multiple buckets but is **broad-impact
codegen** requiring full test262 CI validation — not safe to land + verify at 4%
budget. Banked as a turnkey next step; the `in`-operator precedent makes the
localized `compileBinaryExpression` fix low-risk for a fresh window.

### Not started (roll forward)
- The `__vec_from_extern_*` `array.set` bucket and async-gen `__closure_*` buckets
  (issue's approach steps 2–3) are un-investigated here.

---

## Landed: eval-var-promotion numeric-operand desync (dev-selfserve-1, 2026-07-04)

**PR:** `issue-3024-numeric-slot-desync` — fixes the `testCompoundAssignment` /
numeric-operator eval sub-cluster (the `x op eval("var x = …")` shape).

### The banked "trust slot type at the numeric path" fix is UNSAFE — disproven
The sr-interp banked plan (mirror the `in`-operator precedent: at the numeric
emit, if an identifier operand's slot is externref, coerce) **cannot work as
written**. Instrumentation on current `main` shows both the failing case
(`x * eval("var x = 2;")`) and the passing control (`x * eval("var y = 2;")`)
report `leftType = f64` at the numeric path, and in BOTH the slot is externref
by the time the op emits. So slot-kind + reported-type at the emit point does
**not** discriminate a stale-boxed operand from a genuinely-unboxed f64 — a naive
"slot is externref ⇒ coerce" would double-unbox the already-correct unbox that
`compileIdentifier` emits for a `number`-narrowed externref local.

### True root cause (verified by WAT diff + `compileIdentifierCore` instrument)
It is a **timing / mid-expression slot-promotion** bug, not a numeric-path bug:
1. `x` starts as an `f64` local. In `x * eval("var x = 2;")`, the LEFT operand
   `x` compiles first → emits a raw `local.get` of the f64 slot, no unbox.
2. The RIGHT operand `eval("var x = 2;")` is a constant string, so
   `tryStaticEvalInline` inlines the body. Compiling the inlined `var x = 2`
   (a foreign `ts.createSourceFile` node the checker cannot type ⇒ `wasmType`
   resolves to `externref`) hits the re-declaration re-type at
   `statements/variables.ts` (~L1071–1072) and **flips `x`'s slot f64 → externref**.
3. The already-emitted `local.get` now loads an externref, feeding `f64.mul`/
   `f64.sub`/… → `expected fN, found externref`. Compound `x *= …` is worse: the
   pre-RHS `local.get` (no coerce) AND the post-op `local.tee` (f64 into an
   externref slot) are both invalidated.

### The safe fix (byte-inert, proven)
Detect the **primitive→externref slot flip across operand compilation** by
snapshotting the identifier operand's slot kind before compiling and comparing
after — a flip only ever happens on this eval-redeclaration path, so ordinary
code is untouched.
- `src/codegen/binary-ops.ts` (`compileBinaryExpression`): snapshot
  `leftSlotBefore`/`rightSlotBefore`; if an operand flipped primitive→externref,
  re-label its type `externref` so the existing numeric externref-unbox path
  (~L2255) inserts the coercion.
- `src/codegen/expressions/assignment.ts` (`compileCompoundAssignment`, local
  path): re-read the slot after the RHS; on a flip, unbox the buried left
  operand (save RHS / coerce left / restore RHS) and switch the writeback to the
  externref re-box path.

**Proofs:** repro + discriminators pass (`x*`, `x*=`, `x-`, `x/` eval-redeclare
→ VALID; `var y` / `eval("2")` / plain arithmetic controls unchanged); runtime
output matches Node (NaN/NaN, 21/21); inject-throw shows each guard fires ONLY on
its promotion case and on NO control; a 10-program corpus (arithmetic, compound,
loops, strings, objects, any, bitwise, for-of) is **byte-identical** (sha256) to
`origin/main`; `issue-2923`, `compound-assignment-property/-unresolvable`,
`issue-2045` suites (38 tests) pass.

### Still open (roll forward — NOT this PR)
- `{} << 0` / non-object numeric operands (`private-field-rhs-non-object.js`) —
  a DISTINCT root cause (object left operand of a shift, no eval involved).
- `__vec_from_extern_*` `array.set`, async-gen `__closure_*`, `struct.new` arg
  count. The 131 bucket has multiple independent root causes; this PR clears the
  eval-redeclaration numeric/compound sub-cluster only.

---

## Landed: nested-object-destructuring shared-struct `struct.new` sub-cluster (dev-3024, 2026-07-04)

**PR:** `issue-3024-dstr-nested-objlit-structnew` — clears the `struct.new` "not
enough arguments" cluster (9 test262 files) whose shape is a nested object
pattern with an object-literal default, e.g.
`const { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } }`.

### Root cause (orphaned buffer misses the field-pad patch — verified by instrument)
An anonymous struct registered for the RHS (or param OUTER-default) **sub-object**
`{ x, z }` (2 fields) is later **grown** to 3 fields by the nested pattern's
DEFAULT literal `{ x, y, z }`: both resolve to the SAME `__anon_N`, and when the
larger default compiles, `ensureComputedPropertyFields` (literals.ts) appends the
missing field `y` and calls `patchStructNewForAddedField` to pad every already-
emitted `struct.new` of that type with a default operand.

That pad walks only `mod.functions` + `fctx.body` + `fctx.savedBodies` +
`ctx.liveBodies`. The RHS/param-default `struct.new` sits in an **orphaned outer
body** — swapped off `fctx.body` by a plain JS-local swap that never lands on
`savedBodies` (the destructure helpers descend into detached branch buffers to
compile the nested default). So the pad could not reach it and left it one operand
short of the grown 3-field type → `struct.new (need 3, got 2)` invalid Wasm.
Instrumentation confirmed `reach=0, orphanBufs=1, saved=2, live=0` at patch time.

Same bug **class** as the #2503 / #2158 / #779d param-branch late-shift fixes, but
for the field-pad patch and for the **outer** destructuring/param-default body.

### Fix (register the orphaned body in `ctx.liveBodies` for the destructure window)
Byte-inert, mirrors the existing `liveBodies` precedents. Three call-sites, each
registering the current (outer-materialization-holding) `fctx.body`/`liftedFctx.body`
around the destructure that compiles the nested default, then removing it:
- `src/codegen/statements/destructuring.ts` (`compileObjectDestructuring`) — the
  variable-declaration path (`const/let/var/for` object destructuring).
- `src/codegen/function-body.ts` — top-level function-declaration params.
- `src/codegen/statements/nested-declarations.ts` (both param loops) — hoisted /
  nested function declarations (covers the `function`/`generators`/`async-generator`
  `dflt-obj-ptrn-prop-obj` cases, which route through `compileNestedFunctionDeclaration`).

### Proofs
- Repro + discriminators VALIDATE (`WebAssembly.compile`): `x`-only, `default-fires`,
  `full-object-bypass` all VALID; the `rhs-has-all3` / `default-2fields` controls
  were already valid and stay valid.
- **All 9 real test262 files PASS end-to-end** via `runTest262File` (oracle-checked,
  not merely valid): `{const,let,variable}/dstr/obj-ptrn-prop-obj`,
  `for/dstr/{const,let,var}-obj-ptrn-prop-obj`,
  `{function,generators,async-generator}/dstr/dflt-obj-ptrn-prop-obj`.
- Full 198-file default-lane invalid-Wasm harvest re-run: **STILL-invalid 113 → 104**
  (net −9, exactly this cluster), **zero new invalid signatures**.
- **Byte-identical** (sha256) output vs base across a 14-program corpus (plain /
  default / nested / param destructuring, arrays, classes, strings, closures,
  for-of, spread, optional-chaining) — the fix only toggles `liveBodies` around the
  destructure and is a no-op for code that does not grow a shared struct.
- 71 adjacent destructuring/param unit tests pass (default-params, issue-1025/1128/
  1553a/b/c/1372, fn-param-dstr-rest, class-dstr-rest, generator-method-dstr) plus
  the new `tests/issue-3024.test.ts` (4 tests).

### Still open (roll forward — NOT this PR)
- The remaining ~104 default-lane invalid-Wasm files are scattered across ~40
  distinct signatures (mostly singletons): `f64.local.tee`/`externref.local.get`
  numeric/eval residue, `__cb_0` / `Parent_new` / iterator-close shapes, the
  `Array.from` source-object-iterator pair, `class super in-static-methods`,
  `AsyncFromSyncIteratorPrototype`. These are independent root causes tracked under
  this same issue; this PR clears the largest *concentrated* remaining cluster only.

---

## Fresh measurement + banked root-cause (opus-3024, 2026-07-06)

Re-harvested the 214 stale-cache invalid-Wasm candidates against **current
`origin/main`** via `runTest262File` (default gc lane, oracle path). **The stale
cache badly overstates** — the two biggest cache clusters are already fixed on
main and must NOT be re-chased:
- `extern.convert_any expected shared anyref, found array.get` (cache 53) — now
  mostly **Temporal `skip`** (not a real default-lane floor loss).
- `struct.new expected f#, found ref.as_non_null of type (ref N)` (cache 34) — the
  `object/dstr` array-pattern method-destructuring family; on current main these
  **compile validly** (now `pass` or plain oracle-fail), cleared by #2666 + follow-ons.

### Actual current-main residual: **102 files across ~40 signatures, largest 7**
No concentrated cheap slice remains. Top real signatures (function `test` dominates, 54):

| reason (numbers normalised) | count |
|---|--:|
| `call[#] expected (ref null #)` (loose group, mixed root causes) | 12 |
| `fN.ne expected fN, found local.tee of type externref` | 7 |
| `array.set expected i#, found call of externref` | 4 |
| `array.set expected externref, found local.get of f#` | 4 |
| `call expected fN, found if of (ref null #)` | 4 |
| `struct.set expected (ref null #)` | 4 |
| `call expected externref, found ref.func of (ref #)` | 4 |
| `type error in fallthru (expected externref, got (ref null #))` | 4 |
| `call expected externref, found fN.mul of fN` | 4 |
| everything else | ≤3 each (mostly singletons) |

### The largest real cluster (`fN.ne`, 7) is the #2657 family — CROSS-STATEMENT variant
All 7 are `language/line-terminators/S7.3_A7_T1..T7`. Despite the `line-terminators`
name, the trigger is the **eval-var-promotion desync of #2657**, in the variant
#2657 explicitly left open ("separate-statement eval → thought immune"):

Minimal repro (default gc lane → INVALID; `f64.ne[0] expected f64, found local.tee externref`):
```ts
function test(){
  var y=2,z=3;
  var x=y+z;
  if (x !== 5) throw 1;      // fN.ne read of x's slot emitted HERE (f64)
  eval("var x = y+z; r=x;");  // LATER stmt: inlined var x re-decl flips x slot f64→externref
}
test();
```
Discriminators (verified): plain `var x` redeclaration (no eval) → VALID; eval with
no prior `var x`+`x!==5` → VALID; top-level (unwrapped) → VALID (only fails inside the
harness `test()` fn, where `x` is a function local). So the precise trigger is: a
**function-local numeric `var x`** consumed by a numeric-only op (`fN.ne`/`!==`), then a
**later** direct `eval("var x = …")` whose static-inline re-declaration
(`statements/variables.ts` ~L1071 re-type) flips the shared hoisted slot to externref,
**retroactively invalidating the already-emitted f64 read in the earlier statement**.

### Why banked, not landed (blast radius; no bounded byte-inert slice exists)
#2657's landed fix is a **within-expression** before/after slot snapshot — it cannot
cover this case because the flip happens in a *later statement* than the read, so
there is no consumer-side "after" to snapshot. The only fixes are (a) suppress the
spurious f64→externref downgrade at the redeclaration re-type when the inlined
initializer is statically numeric (an *untypeable foreign AST node* ≠ a genuinely
dynamic binding), or (b) a post-emit patch that re-coerces prior reads when a slot
flips. **Both are broad-impact codegen** and (a) directly touches the promotion
contract #2657 *relies on* (its coercion depends on the flip firing) — so it needs
full test262 CI, not a low-budget land. Turnkey next step for a fresh window:
option (a) in `src/codegen/statements/variables.ts` (redeclaration re-type), gated
to "existing slot is concrete numeric AND new type is externref *only* via
untypeable-node fallback", validated against the #2657 suite + these 7 files.

Everything below the top cluster is ≤4 files/signature — genuine independent
singletons (iterator-close `__cb_N`, `__vec_from_extern` element-rep, async-gen
`__closure_N`, `Parent_new` super-in-ctor, `__obj_meth_tramp_*_valueOf`), each its
own root cause. No cheap concentrated default-lane slice exists at this point;
future work on #3024 is per-root-cause, not per-cluster.
