---
id: 2713
title: "IR↔legacy parity: IR path re-introduces correctness bugs fixed only on the legacy side"
status: done
sprint: 66
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
assignee: ttraenkler/dev-2713b
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1821, 1981, 1375, 1530, 1927]
---
# #2713 — IR↔legacy parity correctness twins

**Source:** 2026-06-26 audit. Recurring "bug factory" #3: the IR front-end
re-introduces correctness bugs that were fixed **only on the legacy AST→Wasm
path**, because the IR lowering was never given the fix and there is no test
forcing parity. The IR verifier checks structure, not semantics, so these are
*committed* miscompiles, not clean demotes.

## Confirmed instances (current main)

- **`delete o.x` returns constant `true`, performs no deletion** —
  `ir/from-ast.ts:1393-1405` lowers the operand for side effects then
  `emitConst({kind:"bool", value:true})`. Legacy twin #1821 is **done**; the IR
  path is the un-fixed twin. `const o={a:1}; delete o.a; return o.a;` → `1`.
- **`string === null` folded to a constant** — `ir/from-ast.ts:4148-4196`
  (`tryFoldNullCompare`) bails for boxed/extern/class/object/closure/ref_null
  (the #1981 fix) but **not** for a `val{string}` operand, which lowers to a
  nullable ref. An exported/host-facing fn receiving `null` for a string param
  sees `s===null` folded to `false`. Same bug class as #1981, left open for the
  string arm.
- **`a?.[i]` drops the optional short-circuit** — `ir/from-ast.ts:1908`
  (`lowerElementAccess`) never reads `questionDotToken`; selector accepts it
  (`select.ts:1744`). On a null receiver it **traps** instead of yielding
  `undefined`. (Legacy/property twins handled under #1375/#1981.)
- **`void <expr>` always materializes `f64 NaN`** — `ir/from-ast.ts:1415-1418`,
  contradicting its own guard comment; wrong representation of `undefined` in a
  non-f64 carrier.
- **rest/default/optional params slip the identifier-only param gate** —
  `ir/from-ast.ts:300` gates only `!ts.isIdentifier(p.name)`; `...args`, `x=5`,
  `x?` keep an Identifier name, so their semantics are dropped on closure /
  nested-func / method param paths (a regression against #1372's intent, which
  was to reject them to legacy).

## Recommendation

1. **Fix the five instances** — bail the string arm in `tryFoldNullCompare`;
   route IR `delete` through the real property-delete helper (or refuse to legacy);
   honour `questionDotToken` in `lowerElementAccess` (short-circuit or clean
   fallback); make `void` respect its carrier; tighten the param gate to reject
   rest/default/optional to legacy.
2. **Add the structural guard** — a parity rule that **every legacy-path
   correctness fix ships an IR-path test** (or an explicit "IR demotes here"
   assertion). The #2711 differential harness is the natural home: run the same
   corpus through IR-on and IR-off and assert identical output. This converts the
   "fixed on one path only" failure mode into a red test.

## Acceptance criteria

- [x] All five instances fixed (each a committed correct answer or a clean
      legacy demote, never a trap or wrong constant).
- [x] A differential IR-on vs IR-off check exists over the correctness corpus and
      is green; the five repros are in it.
- [x] test262 non-regressing; the IR-claimed subset of each repro produces the
      spec result.

## Resolution (dev-2713b, 2026-06-26)

**Verify-first audit against current main.** Each of the five audited instances
was reproduced through the real `compile()` path (IR-on vs IR-off) with
`JS2WASM_LOG_IR_FALLBACKS=1` to confirm claim status. Result: **only B2 (string
null-compare) is a reachable committed miscompile on current main**; the other
four are already either a spec-correct committed answer or a clean legacy
demote (the audit over-stated their severity). Fixes were scoped to what is
actually reachable plus cheap, provably-safe defensive guards; behaviour was
never changed where it was already correct (that would only lose IR coverage or
break a locked-in test).

| # | Instance | Status on main (verified) | Action |
|---|----------|---------------------------|--------|
| B2 | `string === null` / `!== null` folded to a constant | **REACHABLE miscompile** — selector claims the fn, IR folds `s===null`→`false` (host can pass `null`). legacy=1 vs IR=0. | **Fixed:** `tryFoldNullCompare` now bails the `string` IrType to legacy (mirrors the #1981 class/object/closure arm). IR now returns the spec result. |
| B3 | `a?.[i]` drops the optional short-circuit | `questionDotToken` verifiably ignored (claimed=1); the divergent null-receiver case is masked at the host boundary but the token is genuinely dropped. | **Fixed:** `lowerElementAccess` now throws (demotes to legacy) when `questionDotToken` is present — matches the documented "optional chaining → legacy" scope (#1169n). |
| B5 | rest/default/optional params slip the closure param gate | **Unreachable** — every outer fn containing such a nested closure / function is `body-shape-rejected` by the selector first (proven for untyped *and* type-annotated closures), so the param sites never run. Already a clean legacy demote. | **Defensive guard (no-op on all current inputs):** mirrored `select.ts`'s param-shape gate into `lowerFunctionAstToIr` and `lowerClosureExpression` so a future selector widening can't silently drop the semantics. |
| B1 | `delete o.x` returns constant `true` | **Intentional + locked by #1169n** — `delete obj.x` of a configurable property *is* `true` (spec); the effect-observed case (`delete o.a; return o.a`) demotes to legacy already. Already correct. | No behaviour change (changing it would break the #1169n slice-11 assertion). Covered by a parity twin. |
| B4 | `void <expr>` always materializes `f64 NaN` | Produces the spec result in the reachable cases (statement-position void; void in an externref/any carrier → `undefined`). Locked by #1169n. | No behaviour change (would lose coverage for a working case). Covered by parity twins. |

**Structural guard:** `tests/issue-2713-ir-legacy-parity.test.ts` — a focused,
deterministic **differential IR-on vs IR-off** corpus (15 cases) covering all
five patterns. Each case compiles the same source under `experimentalIR:false`
and `experimentalIR:true`, instantiates both via `buildImports`, and asserts the
two runtimes agree **and** match the spec value. Cases use only host-marshalling-
clean shapes (number/`null` args; strings/arrays built inside the wasm) and
assert no known-divergent (broken-in-both) behaviour. Before the B2 fix, the
four string-null twins go red; after, green.

**Files:** `src/ir/from-ast.ts` (B2 string bail, B3 optional-element guard, B5
×2 param guards), `tests/issue-2713-ir-legacy-parity.test.ts` (new).
Gates verified green: `tsc --noEmit`, prettier, biome, `check:ir-fallbacks` (no
bucket deltas), `gen:ir-adoption --check`.
