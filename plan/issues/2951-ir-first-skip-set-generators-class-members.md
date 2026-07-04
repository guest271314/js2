---
id: 2951
title: "IR-first skip set: include generators and class members (retire the two #2138 standing exclusions)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, ir
language_feature: generators, classes
goal: ir-full-coverage
depends_on: [2138]
related: [2950, 1370, 2864]
origin: "2026-07-02 July Fable audit §1 (#2138 impl-note deviations 3 and 4 had no tracking issue)"
---

# #2951 — generators and class members always compile twice, even under IR-first

## Problem

#2138's landed skip-set computation (`computeIrFirstSkipSet`,
`src/codegen/index.ts:1139`) permanently excludes two families:

1. **Generators** — legacy generator compilation creates auxiliary
   machinery beyond the slot body; IR generator lowering registers its own
   imports (`addGeneratorImports`) but standalone-ness of the IR-only path
   without legacy's side effects is unproven (#2138 impl note, deviation 3).
2. **Class members** — the typeIdx parity contract with legacy callers
   (class-bodies.ts pre-allocated signatures, `integration.ts` parity
   guard) keeps them on the always-legacy-then-overwrite path (deviation 4).

Both exclusions are correct-but-untracked; #2950 (default flip) either
needs them retired or explicitly carved out.

## Approach

- **Generators:** enumerate the aux side effects of legacy generator
  compilation (imports, globals, helper funcs) vs what IR generator claim
  registers; either prove the IR path self-sufficient (then include
  IR-claimed generators in the skip set) or make the IR path register the
  missing pieces first. Probe: compile a claimed generator with the skip
  forced on and diff the module sections.
- **Class members:** carry the typeIdx-parity check into the skip decision
  — a member is skippable iff its IR signature byte-matches the
  class-bodies.ts pre-allocation (the parity guard already computes this;
  reuse, don't re-derive).

## Acceptance criteria

- `CompileResult.irFirstSkipped` lists generator and class-member bodies on
  a claim-dense probe.
- Flag-off byte-identity preserved; index-layout invariance test extended
  to a class+generator corpus.
- Full merge_group net-zero with the flag on (feeds the #2950 gate).

## Predecessor slice contract: IR `gen.setReturn` (fable-gencarrier, 2026-07-04, Opus-executable)

The generator half of this issue has a hard prerequisite the audit missed:
**IR generators throw-defer any `return <expr>` to legacy**
(`src/ir/from-ast.ts lowerTail`, the #2035 arm, ~L763) — so a generator with a
value-carrying return can never be IR-claimed, and no skip-set widening can
cover it. Retire the deferral with a `gen.setReturn` IR instruction that
mirrors the legacy routing (`compileReturnStatement`,
`src/codegen/statements/control-flow.ts:140-170`: coerce to externref →
`__gen_set_return(buffer, value)` → `br` out of the body block).

Mechanical contract (mirror `gen.push` at every layer — `grep -rn
'"gen.push"' src/ir/` enumerates the exact switch arms; there are ~12 across
`nodes.ts` (type + 3 switches), `builder.ts` (emit method), `from-ast.ts`,
`lower.ts` (2), `effects.ts` (2), `verify.ts`, `verify-alloc.ts`,
`select.ts`, `integration.ts`, `passes/inline-small.ts`,
`passes/monomorphize.ts`):

1. **`nodes.ts`**: `IrGenSetReturn { kind: "gen.setReturn"; value: IrValueId;
result: null }` — same shape as `gen.push`; add to the same unions/switches.
2. **`builder.ts`**: `emitGenSetReturn(value)` guarded on
   `funcKind === "generator"` + `generatorBufferSlot` set (copy the
   `emitGenPush` guards).
3. **`from-ast.ts lowerTail`** generator arm: replace the `#2035` throw with:
   lower `stmt.expression` via the SAME dispatch `lowerYield` uses (f64 / i32 /
   ref-coerced-to-externref), `emitGenSetReturn(v)`, then the existing
   `emitGenEpilogue()` + return-terminator. Bare `return;` unchanged.
4. **`lower.ts`** `case "gen.setReturn"`: `__gen_set_return` has signature
   `(externref, externref) -> void` (registered in `addGeneratorImports`,
   `src/codegen/index.ts`). The value must be BOXED:
   - f64 → resolve `__box_number` exactly the way the `__unbox_number`
     resolution does at lower.ts:940 (`resolveHostImport`-style; if the
     resolver doesn't know it, THROW to defer — never emit a raw f64 arg);
   - i32 → `f64.convert_i32_s` first, then box;
   - ref/ref_null → `extern.convert_any`; externref → pass through.
     Then push buffer slot + boxed value, `call __gen_set_return`.
5. **Effects/verify/select/passes**: copy `gen.push`'s classification
   verbatim (side-effecting, non-reorderable past buffer reads, not
   inlinable-across… whatever `gen.push` declares — do not re-derive).

Validation gate: `tests/issue-2035.test.ts` (9 cases) must pass with the IR
path now CLAIMING the for-of program (assert via `trackFallbacks` that the
generator no longer defers); `pnpm run check:ir-fallbacks` must not grow;
js-host lane A/B on the dstr/generator corpus net-zero-or-positive. NOTE the
#3032 W6 horizon: this invests in the eager-buffer model that W6 eventually
retires — it is still worth landing because the IR-first flip (#2950) is
gated on IR parity NOW, and the instr becomes dead code W6 can delete
wholesale.
