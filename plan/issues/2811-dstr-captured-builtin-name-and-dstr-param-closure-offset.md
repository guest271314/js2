---
id: 2811
title: "Destructuring closure-capture residual: captured builtin-named var (length/concat/…) + dstr-param closure TDZ-flag offset (split from #2669)"
parent: 2669
status: done
completed: 2026-06-29
created: 2026-06-29
assignee: ttraenkler/dstr3
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
sprint: 69
horizon: m
related: [2669, 2758, 2808, 1205, 1607, 1177]
---

# #2811 — destructuring closure-capture residual (captured builtin-named var + dstr-param closure offset)

## Cluster

Highest-yield residual under #2669, found by re-sweeping `/dstr/` fails on
current `origin/main` (post-#2808). The dominant clean cluster is
**`ary-ptrn-rest-obj-prop-id`** (73 tests, all FAIL):
`[...{ 0: v, 1: w, 2: x, 3: y, length: z }]` destructured against `[7,8,9]`,
guarded by an outer `let length = "outer"` + the assertion *"the length prop is
not set as a binding name"*. Every test262 dstr file of this family pairs the
pattern with a captured outer variable named `length`.

Net recovery of **this PR (fixes A+B below): +16** on that 73-cluster
(generator / async-generator function bodies, named function expressions, and
object-method contexts), plus the broader builtin-named-capture family across
the suite. The remaining 57 (function-declaration / class-method contexts) are
gated by bug **C** (carved below, → architect).

## Root causes (three distinct bugs on the path)

Verify-first, fresh single-file process repros (host/gc lane). All three are
**pre-existing**; the cluster needs all three. A and B are fixed here; C is
carved to architect.

### A — a module/outer variable named like a wasm:js-string builtin is never globalized / captured  (FIXED)

`addStringImports` (`src/codegen/index.ts`) registers the five wasm:js-string
builtins — `concat`, `length`, `equals`, `substring`, `charCodeAt` — into
`ctx.funcMap` (and mirrors them in `ctx.jsStringImports`, #1072). Multiple
capture/global gates skip a name when `ctx.funcMap.has(name)`, intending to skip
*user functions*. The builtin names collide:

- `registerModuleGlobal` (`declarations.ts`) skipped a module-level `let length`
  → it stayed a `__module_init` local, invisible to every other function (reads
  return null).
- the closure/nested-fn capture-collection loops (`closures.ts`,
  `nested-declarations.ts`) skipped `length` from the captured set → a nested fn
  reading `length` read null.

Repro: `let length="outer"; function g(){return length;}` → `g()` returns
`null` (should be `"outer"`). Only `length`/`concat`/`equals`/`substring`/
`charCodeAt` are affected; every other name works.

**Fix:** discriminate by index — skip only when the funcMap entry is a *genuine
user function*, i.e. `ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)`.
A builtin-only collision falls through and the var is globalized/captured.
Sites: `declarations.ts:registerModuleGlobal`, `closures.ts` (×3 capture loops),
`nested-declarations.ts` (×2 capture loops). The function-name gates (keyed on
`funcName`) are left untouched.

### B — capturing function with a destructuring param reads the wrong param slot when it captures a TDZ-flagged (let/read) variable → malformed Wasm  (FIXED)

`nested-declarations.ts` lifts a capturing FunctionDeclaration with the param
layout `[valueCap_0..N-1, tdzFlagBox_0..K-1, userParam_0..]` (value captures,
then one i32-cell TDZ flag box per TDZ-flagged capture, then the user params).
The default-init / destructuring / arguments offset used `captures.length` (N)
only, **ignoring the K prepended TDZ-flag boxes**. So a capturing function with a
*destructuring* param destructured a TDZ i32-flag cell as the array argument →
invalid Wasm (`any.convert_extern[0] expected type externref, found … (ref null
N)`). `var` write-only captures have no TDZ flag (K=0) and were unaffected — why
`callCount`-style tests compiled while the `length`-read dstr family trapped once
bug A let `length` be captured.

Repro: `let c=5; function f([a]){ return c; }` → malformed Wasm; `var c=0;
function f([a]){ c++; }` → fine.

**Fix:** `const leadingParamCount = captures.length + tdzFlaggedCaptures.length;`
and use it for `emitDefaultParamInit`, the destructure-param loop, and
`emitArgumentsObject`. No-op when K=0 (strictly additive for TDZ-flag captures,
which previously always produced malformed Wasm).

### C — block-scoped `let` captured by a *hoisted function declaration* → duplicate local, capture reads the uninitialized slot  (NOT fixed — → architect)

A `let`/`const` declared inside a block (try/plain block) and captured by a
nested **function declaration** in the same block reads null. Arrow functions,
function expressions, `var` captures, and outer-(function-)scope captures all
work — it is specifically the hoisted-FunctionDeclaration path.

Mechanism (WAT-confirmed): the enclosing function ends up with **two** `$s`
locals. `saveBlockScopedShadows` removes the pre-hoisted `s` localMap entry on
block entry, so the block's `let s` allocates a *fresh* slot (e.g. idx 4) and
writes `"outer"` there, while the capture list for the hoisted `f` recorded the
pre-removal slot (idx 2). `emitFuncRefAsClosure`'s immutable-capture path pushes
`cap.outerLocalIdx` (idx 2, uninitialized → null). The obvious capture-side fix
(localMap-first resolution) was **already tried and reverted** for regressions
(`closures.ts:3509`, "Stage 1 localMap-first lookup reverted"), so this needs a
deliberate design over the block-scope-shadow / hoist / capture interaction
(#1205 / #1607 / #1177 territory), not an inline patch.

Repro: `{ let s="outer"; function f(){ return s; } f(); }` (returns null).
**This is broad** (every block-nested function declaration capturing a block let)
and is the keystone for the remaining 57 of the 73-cluster (class-method &
function-declaration contexts, which compile via the hoisted-decl path). It is a
scoping/hoisting bug, not destructuring-specific. → route to architect.

## Acceptance criteria (this PR — A+B)

- Module/outer variables named `length`/`concat`/`equals`/`substring`/
  `charCodeAt` globalize + capture correctly (return the stored value, not null).
- A capturing function with a destructuring param that captures a TDZ-flagged
  (let / read) variable compiles to valid Wasm and reads the correct param.
- `+16` on the `ary-ptrn-rest-obj-prop-id` cluster (generator/async-gen bodies,
  named function expressions, object-method contexts) + broader builtin-capture
  family. No regression in `.length`/`.concat`/… member access, var-write
  capture, fn-scope-let capture, simple/dstr bindings (11/11 controls green).
- No new malformed-Wasm in the cluster (0 traps across the 73).

## Test Results (fresh single-file, host/gc)

- `ary-ptrn-rest-obj-prop-id` 73-cluster: **0→16 PASS**, 57 FAIL (all bug C),
  **0 traps** (bug B's malformed Wasm eliminated).
- 11/11 regression controls green (member `.length`/`.concat`/`.substring`/
  `.charCodeAt`, bare-`length` local, var-write capture, fn-scope-let capture,
  simple param, array/object dstr bindings).
- `tests/issue-2811.test.ts` — A+B repros (currently-failing-on-main → pass).

## Follow-up

- **Bug C** → carve/route to **architect** (block-scoped let captured by hoisted
  function declaration; previously-reverted localMap-first approach). Unblocks
  the remaining 57 of this cluster + a broad block-let-capture class suite-wide.
