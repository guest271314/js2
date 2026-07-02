---
id: 2856
title: "IR: drive body-shape-rejected fallback bucket to zero (dominant unintended bucket)"
status: in-progress
assignee: ttraenkler/dev-2856f
sprint: current
created: 2026-06-30
updated: 2026-07-02
priority: low
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [1376, 1131]
---

# #2856 — IR: `body-shape-rejected` → 0

Child of the IR front-end migration epic **#2855**. This is the **single
largest** unintended IR fallback bucket and the highest-value migration slice.

## Problem

`body-shape-rejected` is the `IrFallbackReason` raised when `from-ast.ts` cannot
lower _some statement or expression_ in a `FunctionDeclaration`'s body, so the
whole function demotes to the legacy direct-AST→Wasm path. Per
`plan/log/ir-adoption.md`, the bucket clears for a function only when
"`from-ast.ts` handles every statement in the body."

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`body-shape-rejected: 31`**
(matches `scripts/ir-fallback-baseline.json`). Per-file worklist:

| File                                                | count |
| --------------------------------------------------- | ----- |
| `website/playground/examples/dom/calendar.ts`       | 6     |
| `website/playground/examples/js/algorithms.ts`      | 5     |
| `website/playground/examples/benchmarks.ts`         | 4     |
| `website/playground/examples/js/classes.ts`         | 3     |
| `website/playground/examples/benchmarks/array.ts`   | 2     |
| `website/playground/examples/benchmarks/dom.ts`     | 2     |
| `website/playground/examples/benchmarks/style.ts`   | 2     |
| `website/playground/examples/js/builtins.ts`        | 2     |
| `website/playground/examples/benchmarks/fib.ts`     | 1     |
| `website/playground/examples/benchmarks/helpers.ts` | 1     |
| `website/playground/examples/benchmarks/loop.ts`    | 1     |
| `website/playground/examples/benchmarks/string.ts`  | 1     |
| `website/playground/examples/js/async.ts`           | 1     |

## Likely covered kinds (confirm during the diagnostic pass)

The bucket is heterogeneous. From the `mixed` / `direct-only` rows in
`plan/log/ir-adoption.md`, the statement/expression kinds that throw inside
`from-ast.ts` and most plausibly drive these 31 rejections:

- **Statements (direct-only — no IR handler):** `SwitchStatement`,
  `BreakStatement` / `ContinueStatement` (labeled + unlabeled), `DoStatement`,
  `LabeledStatement`, `ForInStatement`.
- **Expression shapes that throw (`mixed` rows):** `%`, `**`, `in`,
  `instanceof` in `BinaryExpression`; `~` / `typeof` partials in
  `PrefixUnaryExpression`; complex `TemplateExpression` interpolation; computed
  / empty `ObjectLiteralExpression`; spread / sparse / mixed-type
  `ArrayLiteralExpression`; non-reference (f64/i32) `null` context; optional
  `?.()` call forms.

## Approach (recommended decomposition)

This is too large for one PR. **Step 1 is a diagnostic pass**, then slice by
kind:

1. **Diagnostic pass (do first).** Run the example corpus with per-function
   reason logging (`JS2WASM_LOG_IR_FALLBACKS=1`, or extend
   `scripts/check-ir-fallbacks.ts` to print the _offending node kind_ per
   rejected function, not just the file count). Produce an exact kind→count
   histogram. **Append the histogram to this issue** so follow-up slices are
   precisely scoped. If the histogram shows several independent kinds, split
   this issue into per-kind child issues (one PR each) rather than a single
   mega-PR.
2. **Land the highest-count kind first** (likely `SwitchStatement` or a
   loop-control kind — confirm from the histogram). Add the `from-ast.ts`
   handler + selector acceptance + IR lowering, with legacy-parity equivalence
   coverage.
3. **Re-run the gate after each slice** and bank the decrease:
   `pnpm run check:ir-fallbacks -- --update-on-decrease`, commit the lowered
   `scripts/ir-fallback-baseline.json`.
4. When the bucket reaches **0**, add `"body-shape-rejected"` to
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1013`) and promote the affected
   rows in `plan/log/ir-adoption.md` (`pnpm run gen:ir-adoption`).

## Step-1 diagnostic pass (2026-07-01, dev-b) — hypothesis CORRECTED

Ran a non-invasive diagnostic (reuses the real `planIrCompilation` selector to
identify the 31 `body-shape-rejected` functions, then classifies each body):

**Key correction — the "Likely covered kinds" hypothesis above is WRONG.** All
31 rejected functions have **only Phase-1-ACCEPTED top-level statement kinds**.
**Zero** of them contain a `SwitchStatement`, `BreakStatement`,
`ContinueStatement`, `DoStatement`, `LabeledStatement`, or `ForInStatement` — at
top level OR nested. So this bucket is **not** driven by unhandled statement
_kinds_; it is driven by inner **expression/statement SHAPE** rejections inside
otherwise-accepted statements.

Approximate cause histogram (heuristic — a function can carry >1 tag; derived
directly from the `isPhase1Expr` / `isPhase1StatementList` reject arms):

| cause                                                         | ~fns   | reject arm                                                                                                                                            |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stmt: local reassignment` `x = e;` (LHS not property-access) | ~10    | `isPhase1StatementList` accepts `=` only when LHS is a PropertyAccess (line ~824)                                                                     |
| `guard: C-style loop + array literal` (#1804)                 | 5      | `isPhase1Expr` array-literal arm withholds when `currentFnHasCStyleLoop` (line ~1761)                                                                 |
| `expr: closure value` (arrow / function expression)           | 3      | no `isPhase1Expr` arm for ArrowFunction/FunctionExpression                                                                                            |
| `op: %` (remainder)                                           | 2      | `isPhase1BinaryOp` rejects `%`                                                                                                                        |
| `stmt: if/else @ non-tail`                                    | 2      | non-tail loop accepts only `if` WITHOUT else (line ~842)                                                                                              |
| `stmt: ++/--`                                                 | 1      | no ExpressionStatement arm for postfix/prefix inc-dec                                                                                                 |
| `stmt: element assignment` `arr[i] = e;`                      | 1      | same `=` arm — ElementAccess LHS not accepted                                                                                                         |
| `op: instanceof`                                              | 1      | `isPhase1BinaryOp` rejects `instanceof`                                                                                                               |
| **unclassified by the heuristic**                             | **17** | needs the selector's own verdict (bare/multiple non-tail returns, var-decl with non-Phase-1 / non-resolvable initializer, unsupported tail shapes, …) |

**The heuristic explains ~14/31; 17 remain unclassified.** An EXACT per-cause
histogram requires **opt-in selector instrumentation** — thread an
"offending-node" recorder through the `return false` sites of
`isPhase1StatementList` / `isPhase1Expr` (behaviour unchanged when the recorder
is off) and surface it via `planIrCompilation`'s fallbacks, then have
`scripts/check-ir-fallbacks.ts` print the node-kind. That instrumentation is the
concrete Step-1 implementation (was mis-scoped as "just print the kind"; the
kinds are all accepted — it must print the _reject-arm/shape_).

**Recommended first kind-slice** (highest lever, once instrumentation confirms):
statement-level **mutable assignment** — `x = e;` and `arr[i] = e;` — which the
heuristic attributes to ~11 functions. NB this is a substantial IR change
(mutable-local versioning / element-store lowering in `from-ast.ts`), not a
quick win; size it as its own PR with legacy/IR equivalence parity.

Diagnostic script kept at `.tmp/diagnose-body-shape.mjs` (heuristic; not
committed — the exact instrumentation supersedes it). Routing: this epic needs
`senior-developer` for the selector instrumentation + the mutable-assignment IR
lowering.

## EXACT reject-leaf histogram (2026-07-02, dev-2856f — instrumentation landed)

The opt-in reject-leaf instrumentation is now in `src/ir/select.ts` (a `rej(tag,
node)` recorder threaded through the `return false` sites of the Phase-1 shape
predicates, active only under `trackFallbacks`; zero behaviour change when off)
and surfaced via `IrFallback.rejectDetail` →
`pnpm run check:ir-fallbacks -- --why` (histogram + per-function detail;
`--verbose` prints the histogram only). This is the EXACT verdict from the
selector's own reject sites — it supersedes the 2026-07-01 heuristic above,
which was materially wrong (the dominant cause is host-global identifier
references, not local reassignment).

| reject leaf (first failing, per function)   | count | what it actually is                                                                     |
| ------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `expr:ident-not-in-scope`                    | 21    | `document` ×16, `console` ×2 (host globals → **#2939**); `fibCache`/`gridEl`/`selStart` ×3 (module-scope bindings → **#2940**) |
| `body:stmt-IfStatement`                      | 3     | plain `if` inside a loop body — `isPhase1BodyStatement` has no `if` arm (→ **#2941**)     |
| `vardecl:local-type-annotation-ArrayType`    | 2     | `const arr: number[] = []` — explicit array-type annotation rejected                      |
| `tail:ExpressionStatement-nonvoid`           | 1     | `yr = yr - 1;` as final stmt of a value-returning branch (calendar `fdow`)                |
| `stmtlist:nontail-IfStatement`               | 1     | `if/else if/else` chain at non-tail position (calendar `onDay`)                           |
| `new:type-args`                              | 1     | `new Promise<number>(…)` — generic type args deferred (async `delay`)                     |
| `body:assign-prop-name-not-ident`            | 1     | `this.#name = …` — private-field write (classes `Animal_new`)                             |
| `prop:name-not-ident`                        | 1     | `this.#name` read — private-field access (classes `Animal_speak`)                         |

Total 31/31 reconciled — every function in the bucket is leaf-classified.

### Root cause: host globals are the keystone, and demotion is CONTAGIOUS

`isPhase1Expr` rejects any identifier not in the function-local scope set
(`expr:ident-not-in-scope`). Host globals (`document`, `console`) are never in
scope, so every `main`/`bench_*` driver function demotes. **Fixing any other
leaf first is a trap**: the selector's fixpoint loop (`src/ir/select.ts` ~415)
demotes a claimed function whenever ANY local caller or callee is unclaimed,
re-bucketing it as `call-graph-closure`. Since the host-global references sit
in the `main` drivers — the roots of each example's call graph — a leaf-level
fix just MOVES the count from `body-shape-rejected` into `call-graph-closure`,
and the gate fails on that bucket's growth (proved by the predecessor's
`fibIter` experiment: shape-fixing the leaf grew `call-graph-closure`). The
host-global slice (#2939) must therefore land FIRST — it clears the
`body-shape-rejected` rows AND the `call-graph-closure` contagion in the same
PR, letting the ratchet (`--update-on-decrease`) bank both drops together.

## Decomposition — child issues (one PR each)

| child     | slice                                                            | fns freed | order                                        |
| --------- | ----------------------------------------------------------------- | --------- | --------------------------------------------- |
| **#2939** | host-global refs (`console`, `document`) via legacy host-import path | 18 (+ call-graph-closure contagion) | FIRST — keystone |
| **#2940** | module-scope bindings (`fibCache`, `gridEl`, `selStart`)           | 3         | after #2939                                    |
| **#2941** | `if` statement inside loop bodies                                  | 3         | independent, after #2939 (contagion)           |
| (parent)  | misc leftovers: private fields ×2, array-type annotation ×2, non-void tail expr ×1, non-tail if/else ×1, `new` type-args ×1 | 7 | slice later, from this issue |

## Acceptance criteria

1. `body-shape-rejected` count in `scripts/ir-fallback-baseline.json` is `0`
   (verify `pnpm run check:ir-fallbacks` reports the bucket gone).
2. The kind histogram from the diagnostic pass is recorded in this issue.
3. Equivalence tests for each newly-IR-claimed kind pass (legacy/IR parity).
4. `"body-shape-rejected"` is added to `STRICT_IR_REASONS` once the bucket is
   zero, so a regression hard-errors.
5. No regression in the existing IR test suite (`tests/ir-*.test.ts`) or
   test262 conformance.

## Files

- `src/ir/from-ast.ts` — add statement/expression handlers for the rejected kinds.
- `src/ir/select.ts` — relax the body-shape check as each kind is supported.
- `src/ir/lower.ts` / `src/ir/nodes.ts` — IR node types + Wasm lowering as needed.
- `scripts/check-ir-fallbacks.ts` — (diagnostic) per-node-kind reporting.
- `scripts/ir-fallback-baseline.json` — ratchet down as slices land.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.
- `plan/log/ir-adoption.md` — promote rows (regenerated).
