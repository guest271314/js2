# #3090 Phase 0 — legacy front-end delete-list (reachability audit)

**Date:** 2026-07-10 · **Author:** fable-6th · **Baseline:** `origin/main` @ `8d86b2c4fd`
**Tool:** `node scripts/audit-legacy-reachability.mjs` (re-run any time; writes
per-function detail to `.tmp/legacy-reachability.json`, prints the tables below)

## What was measured

Call-graph reachability over every top-level function in `src/` (function
declarations + `const x = fn/arrow`, plus a `<module>` pseudo-node per file
for top-level tables). Two reachability passes:

- **Survivor pass** — roots = every function in `src/` **outside**
  `src/codegen/` (IR front-end/backend, runtime, cli, linear backend,
  orchestration entry), with the legacy body-dispatch pair
  **`compileStatement`/`compileExpression` removed from the graph**. What
  this pass reaches survives legacy front-end retirement ("shared").
- **Full pass** — same roots + the dispatch pair. Reachable here but not in
  the survivor pass = **dies with the legacy front-end** ("legacy-only").
  Reachable in neither = **unreferenced** (dead today).

Edges are identifier references (call, callback, table entry) resolved via
same-file definitions and import/re-export chains — conservative: any
reference marks a function shared, so "legacy-only" is an under- not
over-estimate, and "unreferenced" excludes anything a live table mentions.
Known blind spot: consumers outside `src/` (tests import some codegen
internals) — Phase 2 must confirm each "unreferenced" entry with `knip`
before deleting.

## Hard numbers (fn-lines, 2026-07-10)

| Bucket                                               | files | legacy-only | shared | unreferenced |
| ---------------------------------------------------- | ----: | ----------: | -----: | -----------: |
| **frontend** (delete candidates)                     |    35 |  **59,976** |  7,413 |          288 |
| **deferred** (`eval`/`with`/async-CPS — never touch) |     3 |       1,473 |  1,408 |           12 |
| **runtime** (stdlib behavior emission — keep)        |    58 |  **46,979** | 29,032 |          280 |
| **stays** (substrate/orchestrator — keep)            |    57 |       4,136 | 45,802 |        1,573 |

The FRONTEND delete-set is a hard **~60.0K fn-lines** (the issue's ±10K band
was 70–80K file-lines; per-function attribution excludes the shared slices
that live inside FRONTEND files, e.g. 3.2K of `closures.ts` the class/decl
machinery reuses).

## Ground-truth gates — what "dormant" actually means (premise corrections)

The issue's Phase 1 assumed handlers for `ir-owned` kinds are "unreachable
when `experimentalIR: true`". The pipeline disproves this; deletion is gated
on four structural facts:

- **G1 — legacy compiles EVERYTHING first.** ~~By default the IR is an
  _overlay_~~ **CLEARED 2026-07-11 by #3143**: IR-first is now the default
  (`JS2WASM_IR_FIRST=0` is a one-release escape hatch) — legacy emission is
  skipped for claimed functions that pass `computeIrFirstSkipSet`'s gates
  (2 generators-standalone, 4 host-nodes, 5 string-element, 6
  dynamic-signature, 7 `??` residual). NOTE this clears G1 only for the
  *skipped* population: functions excluded by gates 2/4/5/6/7, selector-
  rejected functions (G2), top-level statements (G3), and class members
  still compile via legacy — per-kind handler deletion still requires
  G2/G3/G4 plus emptying the relevant skip-gate.
- **G2 — whole-function claim unit keeps every handler live.** The selector
  claims `FunctionDeclaration`s; any rejection (every non-zero bucket in
  `plan/log/ir-adoption.md`, every `mixed`/`direct-only`/`deferred` kind in
  the body, class-method gaps) demotes the _whole function_ to legacy — which
  then needs the legacy handler for every kind it contains, including
  `ir-owned` ones. An `IfStatement` inside a function with a `switch` is
  compiled by the legacy `IfStatement` handler. **A kind being `ir-owned`
  does NOT make its legacy handler dead.**
- **G3 — top-level statements are always legacy.** Module-level code is not
  claimable (the claim unit is function declarations / class members), so
  `compileStatement` and the statement handlers stay reachable for top-level
  code until the IR adopts module-level lowering.
- **G4 — runtime emission enters through legacy dispatch.** ~47K fn-lines of
  stdlib behavior emission (`array-methods`, `property-access`, `object-ops`,
  `native-regex`, `string-ops`, `json-*`, `dataview`, `map-runtime`…) are
  reachable **only** via `compileExpression`/`compileStatement` today; the IR
  path shares just 29K (coercion, strings, async/generator machinery,
  `object-runtime`). Retiring the front-end requires the IR to grow its own
  call-paths into this emission (per-kind adoption), not deletion.

**Consequence:** "deletable today with zero capability change" =
the **unreferenced set (~2.1K fn-lines)** — everything else is conditional.
The ~60K FRONTEND number is the size of the eventual win, banked per-kind as
gates clear (revised phases below).

## Ranked FRONTEND delete-list (dies with the legacy front-end)

Ranked by legacy-only fn-lines; "shared" fn-lines inside these files must
be kept (or relocated) when the file is deleted.

| File                              | file lines | legacy-only fn-lines | shared fn-lines | unreferenced |
| --------------------------------- | ---------: | -------------------: | --------------: | -----------: |
| expressions/calls.ts              |      17573 |                16210 |               0 |            0 |
| expressions/assignment.ts         |       7330 |                 6853 |               0 |            0 |
| statements/loops.ts               |       6221 |                 5645 |             105 |            0 |
| expressions/new-super.ts          |       5603 |                 5153 |               0 |            0 |
| binary-ops.ts                     |       4475 |                 4187 |               0 |            0 |
| expressions/builtins.ts           |       3710 |                 3494 |               0 |            0 |
| literals.ts                       |       4233 |                 3364 |             434 |            0 |
| expressions/unary-updates.ts      |       2088 |                 1700 |               0 |          204 |
| expressions/identifiers.ts        |       1926 |                 1507 |             167 |            0 |
| typeof-delete.ts                  |       1590 |                 1417 |               0 |            0 |
| statements/control-flow.ts        |       1530 |                 1305 |              49 |            0 |
| expressions.ts                    |       1568 |                 1217 |               3 |           59 |
| closures.ts                       |       5023 |                 1147 |            3229 |            0 |
| statements/variables.ts           |       1529 |                 1142 |             198 |            0 |
| expressions/calls-closures.ts     |       1102 |                 1012 |               0 |            0 |
| statements/destructuring.ts       |       1424 |                  639 |             532 |            0 |
| statements/exceptions.ts          |        638 |                  550 |               0 |            0 |
| expressions/misc.ts               |        563 |                  490 |               0 |            0 |
| expressions/extern.ts             |        578 |                  481 |               0 |            0 |
| statements/nested-declarations.ts |       2729 |                  443 |            1909 |           20 |
| expressions/logical-ops.ts        |        451 |                  403 |               0 |            0 |
| expressions/helpers.ts            |        533 |                  272 |              27 |            0 |
| statements.ts                     |        311 |                  230 |               0 |            0 |
| expressions/calls-guards.ts       |        300 |                  223 |               0 |            0 |
| expressions/calls-optional.ts     |        240 |                  209 |               0 |            0 |
| expressions/unary.ts              |        179 |                  146 |               0 |            0 |
| statements/shared.ts              |        174 |                  111 |              13 |            0 |
| expressions/late-imports.ts       |        856 |                  102 |             571 |            0 |
| expressions/promise-subclass.ts   |        200 |                   98 |               0 |            0 |
| expressions/fnctor-prototype.ts   |        222 |                   83 |              43 |            0 |
| expressions/proto-override.ts     |        288 |                   71 |             100 |            0 |
| statements/tdz.ts                 |        125 |                   49 |              14 |            5 |
| new-target.ts                     |         98 |                   23 |              19 |            0 |

Per-function names/spans: `.tmp/legacy-reachability.json` (regenerate with
the script).

### Kind → file mapping (cross-check vs `ir-adoption.md` `ir-owned` rows)

| ir-owned kind(s)                                                                                                    | Legacy handler home                               | Gate     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| `IfStatement`, `Block`, `ThrowStatement`, `ReturnStatement`                                                         | statements/control-flow.ts, statements.ts         | G1+G2+G3 |
| `WhileStatement` (+ mixed for/for-of/do)                                                                            | statements/loops.ts                               | G1+G2+G3 |
| `Identifier`                                                                                                        | expressions/identifiers.ts                        | G1+G2    |
| `NumericLiteral`, `StringLiteral`, `NoSubstitutionTemplateLiteral`, `True/FalseKeyword`, `RegularExpressionLiteral` | literals.ts, string-ops.ts (runtime)              | G1+G2    |
| `PostfixUnaryExpression`                                                                                            | expressions/unary-updates.ts                      | G1+G2    |
| `ConditionalExpression`, `ParenthesizedExpression`                                                                  | expressions.ts                                    | G1+G2    |
| `TypeOfExpression`, `DeleteExpression`, `VoidExpression`                                                            | typeof-delete.ts, expressions/unary.ts            | G1+G2    |
| `FunctionDeclaration` (claim unit)                                                                                  | declarations.ts (stays), function-body.ts (stays) | —        |

No `ir-owned` kind's handler is deletable in isolation today (G2); the
per-kind coupling lands in Phase 3 as buckets zero out.

## Deletable NOW — unreferenced functions (Phase 2, knip-confirmed)

~2.1K fn-lines dead today (top items; full list in the script output):

- `src/codegen/index.ts` — the superseded host-import scan family
  (`collectConsoleImports`, `collectMathImports`, `collectPrimitiveMethodImports`,
  `collectStringMethodImports`, `collectString*`/`collectPromise*`/
  `collectJson*`/`collectGenerator*`/`collectIterator*`/`collectUnion*`/… —
  ~1,400 lines): re-implemented as fused scans in `declarations.ts` (see the
  `// -- collectXImports --` section markers there); the originals in
  index.ts are referenced by nothing.
- `regex/vm.ts` — 245 lines unreferenced (regex VM superseded by
  `regex/bytecode.ts` + `native-regex.ts` paths; verify with knip).
- `expressions/unary-updates.ts` — `compilePrefixIncrementProperty` (:1650, 65 ln),
  `compilePrefixIncrementElement` (:1719, 139 ln).
- `expressions.ts` — `emitCoercedLocalSet`/`updateLocalType`/`widenLocalToNullable` (~59 ln).
- Assorted ≤20-line strays (see report).

Caveat: the audit graph does not include `tests/` — confirm zero test-side
imports (or move the helper) before each deletion; wiring `knip` into
`quality` (issue Phase 2) automates exactly this.

## Revised phase plan

1. **Phase 2 first (reordered):** knip wiring + delete the unreferenced set
   (~2.1K, immediate, zero-risk after knip confirmation).
2. **Gate-clearing prerequisites for any handler deletion** (each its own
   issue/slice):
   a. Make IR-first (`JS2WASM_IR_FIRST=1`, #2138) the default — clears G1.
   b. Module-level (top-level statement) IR adoption — clears G3.
   c. Per-kind fallback closure (#2855/#2856-family, STRICT_IR_REASONS) —
   clears G2 kind by kind.
   d. IR-side entry points into RUNTIME emission (per builtin family) —
   clears G4 file by file.
3. **Phase 1/3 (merged):** delete each FRONTEND file's legacy-only set in
   the same PR that closes its last gate, largest first per the ranked list
   (calls.ts 16.2K → assignment.ts 6.9K → loops.ts 5.6K → …). Validate every
   slice on full CI / `merge_group` (standalone floor only runs there).

## Regenerate

```bash
node scripts/audit-legacy-reachability.mjs            # tables + JSON
node scripts/audit-legacy-reachability.mjs --why 'calls.ts#compileCallExpression'  # survivor-path trace
```
