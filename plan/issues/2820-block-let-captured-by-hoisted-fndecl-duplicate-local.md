---
id: 2820
title: "Bug C: block-scoped let captured by hoisted FunctionDeclaration reads null (duplicate-local desync)"
parent: 2669
related: [2811, 1205, 1607, 1177]
status: done
completed: 2026-06-29
assignee: ttraenkler/bugC
created: 2026-06-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: closures
goal: spec-completeness
sprint: 69
horizon: m
---

# #2820 — Bug C: block-scoped `let` captured by a hoisted FunctionDeclaration reads null

Carved out of #2811 (parent #2669). Keystone for the remaining ~57 of the
`ary-ptrn-rest-obj-prop-id` cluster (function-declaration / class-method
contexts) **plus** a broad block-let-capture class suite-wide. Bug A + Bug B
landed in #2289; this is the third, scoping-layer bug.

## Reproduction (verify-first, host/gc lane)

```ts
export function test(): string {
  { let s = "outer"; function f(): string { return s; } return f(); }
}
// => null   (should be "outer")
```

Controls that PASS (isolate the bug to the hoisted-FunctionDeclaration + block path):
- block-let captured by **arrow** → "outer" (closures.ts has the #1177 name-scan fallback)
- block-let captured by **function expression** → "outer"
- **fn-scope** let captured by hoisted fn decl → "outer" (no block → no shadow save)
- block-**var** captured by hoisted fn decl → "outer" (var is not block-scoped)
- `let s = 42` numeric variant → reads `0` (default), confirming a stale slot read, not a string bug.

The real test262 cluster member compiles (via `wrapTest`) to
`export function test() { try { let length = "outer"; function f([...]) { ... length ... } f(...) } catch {...} }`
— the `let length` lands **inside the `try` block** → block-scoped → captured by
the hoisted `function f` → reads null → the `length` assertion fails (test
returns the assert index, e.g. 6, instead of 1). The `try` block is the "block".

## Root cause — duplicate-local desync (WAT-confirmed)

`$test` ends up with **two** `$s` externref locals:

```
(local $s externref)              ;; 0  pre-hoisted slot  (stale, never written)
(local $__tdz_s i32)              ;; 1  pre-hoisted TDZ flag
(local $s externref)              ;; 2  re-allocated `let s`  ("outer" stored here)
(local $__tdz_box_s (ref null 1)) ;; 3
...
global.get <"outer">  local.set 2     ;; let s = "outer"  → slot 2
i32.const 1           local.set 1     ;; tdz flag init      → slot 1
local.get 0           ;; capture VALUE  ← slot 0  (STALE → null)   <-- THE BUG
local.get 1           ;; capture FLAG   ← slot 1  (correct)
struct.new 1  local.tee 3  call 2      ;; build closure cell, call f
```

Instrumented lifecycle (single block, no outer shadow):

1. `hoistLetConstWithTdz` (`index.ts: walkStmtForLetConst`) **recurses into the
   block** and pre-allocates the block-`let s` at the *function* level:
   value → slot 0, `__tdz_s` → slot 1. Registered in `fctx.localMap` /
   `fctx.tdzFlagLocals`. (This flattening is deliberate: it lets closures lifted
   during the hoist pass capture block-lets — the #1177 TDZ-through-closure
   machinery.)
2. `hoistFunctionDeclarations` recurses into the block and compiles `f` via
   `compileNestedFunctionDeclaration`. Its capture loop
   (`nested-declarations.ts:295`) reads `fctx.localMap.get("s") = 0` and records
   `ctx.nestedFuncCaptures["f"] = [{ name:"s", outerLocalIdx:0, tdzFlagIdx:1 }]`.
   **This path has NO #1177 name-scan fallback** (unlike the arrow path at
   `closures.ts:1687`), so it is locked to the pre-hoist slot.
3. Normal compile reaches the block → `saveBlockScopedShadows`
   (`statements/shared.ts:100`) sees `s` in `localMap` (slot 0), **saves +
   deletes** it (and `__tdz_s`) so the inner `let` will "allocate a fresh local".
4. `compileVariableStatement` (`statements/variables.ts:811`): `existingIdx`
   is now `undefined` → `freshLocalForLetConst = true` → `allocLocal` makes a
   **fresh** value slot 2 and writes "outer" there.
5. At `f()` the call-site closure construction reads `cap.outerLocalIdx = 0`
   (stale, never written → null). The TDZ flag is fine (slot 1, reused), only the
   **value** slot desyncs (0 vs 2).

So `saveBlockScopedShadows` re-introduces block-scoping (delete + re-allocate)
for a name that `walkStmtForLetConst` had already flattened to the function
level — and the hoisted-fn capture is pinned to the pre-flatten slot. Genuine
shadowing (`let s; { let s; }`) *needs* the re-allocate; Bug C is the case where
the deleted slot **is the block-let's own** pre-hoisted slot (no outer binding),
so re-allocating just produces a useless duplicate that the capture can't follow.

## Why the obvious capture-side fix was reverted (must not re-attempt)

The "localMap-first" capture resolution
(`localMap.get(cap.name) ?? cap.outerLocalIdx`) was tried and reverted —
`expressions/calls.ts:12906` and `closures.ts:3494` ("Stage 1 localMap-first
lookup reverted"). It caused **100+ test262 regressions** "where main's
'wrong-slot' behavior was load-bearing for tests that relied on a null deref
throwing inside an async fn body."

Why it cannot work as a blanket rule: `cap.outerLocalIdx` is meaningful **in the
fctx where the capture was recorded**, but the capture is *consumed* at the call
site, which may run inside the **lifted body of an enclosing closure** (a
different fctx — async continuations especially). There `fctx.localMap.get(name)`
resolves to a *different* binding (a leading param, or a slot that legitimately
holds the uninitialized/TDZ value whose null deref is the spec-correct throw).
Blanket localMap-first overrides that correct slot → the TDZ throw stops firing.
The discriminator that separates "stale-from-block-realloc" (Bug C) from
"intentionally-the-uninitialized-slot" (async TDZ) is **not available at the
consumption site**. So the fix must NOT live on the capture-consumption side.

## Chosen design — re-align the producer, not the consumer (decl-keyed pre-hoisted-slot reuse)

Fix the **root** (the duplicate local), and do it at the producer
(`compileVariableStatement`), leaving every capture-resolution path byte-for-byte
unchanged. The capture already references the pre-hoisted slot (slot 0); make the
block-`let` **reuse that same slot** instead of re-allocating slot 2. Then
value-slot == capture-slot, and nothing downstream changes.

The reuse must fire **only** for a block-let that is the block's *own* pre-hoisted
slot (no genuine outer/param/var shadow). The precise, already-available signal:
**did `walkStmtForLetConst` pre-allocate *this exact declaration*?** It
pre-allocates a name only when `localMap` did not already hold it (i.e. no param,
no `var`, no earlier flattened binding) — exactly the no-outer-shadow condition.
Genuine shadows are *skipped* by the pre-pass and therefore not recorded.

Implementation (3 small, additive touch-points):

1. **`index.ts: walkStmtForLetConst`** — when it pre-allocates a let/const value
   slot (and optionally a TDZ flag), record it keyed by the **declaration node**:
   `fctx.preHoistedLetConstSlots.set(decl, { valueSlot, flagSlot })`.
   (New optional field on `FunctionContext`; populated only by the pre-pass.)

2. **`statements/variables.ts: compileVariableStatement`** — for an identifier
   let/const decl whose name is **absent from `localMap`** (i.e.
   `saveBlockScopedShadows` removed it) **but** has a `preHoistedLetConstSlots`
   record for *this decl*: re-register `localMap[name] = valueSlot` (and
   `tdzFlagLocals[name] = flagSlot`) **before** the `existingIdx`/`isHoistedLetConst`
   computation. The existing reuse path then treats it as a hoisted slot
   (`isHoistedLetConst = true`) → reuses slot 0 → writes "outer" to slot 0 →
   capture reads slot 0. Effectively *undoes* the shadow-deletion for the
   block's-own-slot case only.

3. No change to `saveBlockScopedShadows`, the capture loops, or any
   capture-consumption site. `restoreBlockScopedShadows` already restores the
   saved (slot-0) mapping after the block, which now matches.

### Why this is precise (regression analysis)

- **Genuine shadow** (`let s; { let s; }`, or `function f(s){ { let s; } }`):
  the inner decl was *skipped* by the pre-pass (param/outer occupied localMap) →
  **no** `preHoistedLetConstSlots` record → no reuse → fresh slot (current
  behavior, correct shadowing). ✓
- **Nested same-name** (`{ let s; { let s; } }`): inner decl skipped → not
  recorded → fresh slot for the inner, outer untouched (current behavior). ✓
- **#1607 TDZ self-ref** (`{ const x = x + 1; }`): the reused flag slot is the
  pre-hoisted (zero-init) flag; the self-reference reads it as 0 → ReferenceError
  still throws. ✓ (covered by a test below)
- **async TDZ (#1177)**: untouched — capture consumption still reads
  `cap.outerLocalIdx`; we only re-align the producer's store slot in the
  enclosing fctx. The flag-based TDZ throw is unaffected. ✓
- **Known non-fix (out of scope, no regression):** sibling-block-after-block with
  the same name (`{ let s; } { let s; function f(){return s;} }`) — block B's
  decl is *skipped* by the pre-pass because block A flattened the name first, so
  it is not recorded and not reused. It remains as-is (rare, not in the cluster);
  fixing it needs nested-vs-sibling AST analysis and is deferred.

Blast radius: `compileVariableStatement` block-let path + a pre-pass record.
No capture-resolution change → the reverted-attempt failure mode cannot recur.

## Acceptance criteria

- `{ let s="outer"; function f(){return s;} f(); }` returns "outer" (string + numeric).
- The real `ary-ptrn-rest-obj-prop-id` func-decl cluster member returns 1 (pass).
- Controls stay green: arrow/fn-expr/var/fn-scope captures, genuine shadowing
  (`let`/param/var), nested same-name shadowing, #1607 TDZ self-ref, #1177 async
  TDZ throw.
- `tests/issue-2820.test.ts`: bug repros + representative cluster slice + broad
  regression-control set.

## Scope landed here vs. carved (IMPORTANT)

Investigation showed the cluster's "remaining 57" splits into **two distinct
bugs** with different capture mechanisms — only the first is the duplicate-local
desync this PR fixes:

1. **Function-declaration context (FIXED here).** Nested `function f` captures
   the outer local via lifted leading params (`nestedFuncCaptures`). The
   duplicate-local desync is the root, and the producer-side slot reuse fixes it.
   Reliable per-process verdicts: `function/dstr/ary-ptrn-rest-obj-prop-id.js`
   and `…/dflt-…` flip **FAIL→PASS**; generator/async-func-decl variants share
   the same hoisted-fn path.

2. **Class-method context (CARVED → #2818).** Class methods capture an
   outer local by promoting it to a global (`__captured_<name>`), driven by
   `promoteAccessorCapturesToGlobals` in `compileNestedClassDeclaration`
   (`statements/nested-declarations.ts:125`). For a **block-nested** class the
   body is compiled/collected BEFORE the block-let initialises, so
   `compileNestedClassDeclaration` hits its already-collected early-return
   (`:99`) and the promotion loop never runs → the method body resolves the name
   to the `ref.null.extern` fallback (returns null). This is a
   class-collection-ordering + captured-globals issue, NOT the duplicate-local
   desync — a separate, more entangled subsystem (#1672 territory). Repro:
   `{ let s="outer"; class C { m(){ return s; } } new C().m(); }` → null (also
   fails for an arrow inside the method — the global channel never fires). The
   `meth-…`/`gen-meth-…` cluster members stay FAIL(6) until that lands.

The decision to carve #2 follows the design-first mandate: the function-decl fix
is precise and low-blast-radius; the class-method fix touches the delicate
captured-globals promotion ordering and is sized as its own change.

## Test Results (fresh single-file, host/gc lane)

- `tests/issue-2820.test.ts` — **15/15 PASS**: 8 Bug-C repros (plain block,
  string value, try-block cluster shape, post-construction mutation,
  builtin-named `length` block-capture [A+C], `const` binding, two-fn-decls
  sharing the capture) + 7 regression controls (arrow / fn-expr / fn-scope /
  block-`var` captures, genuine fn-scope-shadow, genuine param-shadow, #1607 TDZ
  self-ref, nested same-name shadow).
- Real cluster member `function/dstr/ary-ptrn-rest-obj-prop-id.js`: **FAIL→PASS**
  (returned the failing assert index 6 → now 1). `dflt-…` likewise.
- **Deterministic per-process count over the 44 non-class fn-family cluster
  files: baseline (origin/main + #2289) = 29 PASS → with this fix = 35 PASS
  (+6).** The 9 still-failing are top-level binding-form (`const`/`let`/`var-…`)
  and `async-*-dstr-*` members that fail at assertion #2 (`w`), a separate
  rest-into-object-pattern / async destructuring bug — NOT the closure-capture
  desync this PR addresses.
- Class-method members (`meth-…`, `gen-meth-…`): still FAIL(6) — carved (#2818).
- Regression suites — **no delta** vs. the merged base (origin/main + #2289):
  - GREEN with fix: `issue-1177`, `issue-723-tdz`, `issue-1607`,
    `issue-2200-annexb-block-fn-hoist`, `issue-2811`, `issue-1128-dstr-tdz`,
    `tdz-reference-error` (56/56).
  - Pre-existing-FAIL on the base, **identical** with/without the fix (env-only:
    IR/binaryen + host-bridge `__call_fn`): `ir-let-const-equivalence`,
    `issue-1690b`, `var-hoisting-scope`, `illegal-cast-closures-585`,
    `issue-1712` (23 fail both ways → my delta = 0).

## merge_group regression (full-test262) + narrowing fix

The first revision (unconditional reuse) was CLEAN at PR level but the
`merge_group` full-test262 re-validation caught a **real** regression
(`check for test262 regressions`): **net −14 (29 improvements − 43 regressions)**,
all 43 with a **wasm-hash change** (not flake). The 43 were
**`for-await-of/async-{func,gen}-decl-dstr-*`** (+ one `async-generator-interleaved`):
a block-`let` captured by a hoisted **async / generator** function declaration.
Those capturers are CPS-lowered — they spill captures into a continuation state
struct — so collapsing the block-let's duplicate slot perturbs the state machine
(`assertion_fail` ×42, `null_deref` ×1). The reverted-localMap-first attempt
broke the SAME async-CPS neighborhood; both slot-axis directions touch it.

**Fix — narrow the reuse:** reuse the pre-hoisted slot ONLY when the name is
captured by ≥1 **plain (non-CPS) function declaration** AND by **zero**
async/generator declarations (`ctx.asyncFunctions` / `ctx.generatorFunctions`).
An UNcaptured block-let needs no reuse (the desync requires a hoisted-fn capture),
so it is left alone too — which keeps non-Bug-C functions byte-identical to
baseline.

**Verification (local, deterministic):**
- **42 / 43** regressed paths recompile **byte-identical to baseline** (SHA over
  the wrapped binary) — regression eliminated by construction.
- The 43rd (`async-generator-interleaved`, only `expected` — a const captured
  solely by a sync fn — still reuses) was driven locally through its microtask
  chain: **un-gated → `dereferencing a null pointer`; baseline & gated → returns
  1, no unhandled rejection.** Causation confirmed, regression gone.
- The **+6** sync fn-family recovery still holds (`function/dstr/…`, `dflt-…`,
  `for-of/for …iter-close` all PASS with the gate); `tests/issue-2820.test.ts`
  15/15. The async/generator cluster recovery is deferred to the architect
  follow-up (#2818).
