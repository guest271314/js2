---
id: 2713
title: "IR↔legacy parity: IR path re-introduces correctness bugs fixed only on the legacy side"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
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

- [ ] All five instances fixed (each a committed correct answer or a clean
      legacy demote, never a trap or wrong constant).
- [ ] A differential IR-on vs IR-off check exists over the correctness corpus and
      is green; the five repros are in it.
- [ ] test262 non-regressing; the IR-claimed subset of each repro produces the
      spec result.
