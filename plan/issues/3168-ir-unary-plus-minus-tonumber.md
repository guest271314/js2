---
id: 3168
title: "IR: lower unary +/- ToNumber on non-number operands — #3143 flip-track post-claim divergence class 3"
status: ready
sprint: current
created: 2026-07-12
updated: 2026-07-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
language_feature: operators, coercion
goal: ir-full-coverage
related: [3143, 3153, 3167, 2949, 2138]
origin: "2026-07-12 architect IR audit: #3153 census class 3; blocks the #3143 IR-first flip."
---

# #3168 — IR unary `+` / `-` ToNumber coercion

## Problem

`src/ir/from-ast.ts` throws when a unary `+`/`-` operand is not statically
number:

- :5409 — `ir/from-ast: unary '-' expects number in <func>`
- :5421 — `ir/from-ast: unary '+' expects number in <func>`

Post-claim, this is a hard error under the #3143 IR-first flip. #3153's
census ranks it class 3 on the equivalence corpus (`+str` / `+anyVal` is a
common idiom).

## Spec (§13.5.4 Unary Plus, §13.5.5 Unary Minus → §7.1.4 ToNumber)

`+x` is exactly `ToNumber(x)`; `-x` is `ToNumber(x)` negated. String →
StringToNumber (trimmed, "" → 0, non-numeric → NaN); boolean → 0/1;
null → 0; undefined → NaN; object → ToPrimitive(number) then ToNumber.

## Implementation Plan (architect, anchors @ upstream/main adc65cfc65)

### Scope of this slice

Operand IrType ∈ {string, boolean, any/dynamic-carrier}. Object operands
(ToPrimitive chain) stay rejected — **mirrored into the selector** as a
pre-claim reject (same select↔build parity requirement as #3167; the two
issues should share the mirror plumbing if worked together).

### Changes

**1. `src/ir/from-ast.ts` `lowerPrefixUnary` (:1813 entry; throw sites :5409/:5421):**

- **boolean operand:** lower to the existing bool→f64 conversion (i32 →
  `f64.convert_i32_u`) — no new node needed if a coercion node exists; check
  how the numeric-arithmetic arm coerces bool today.
- **string / any operand:** build a `to_number` plan node.

**2. `src/ir/lower.ts` — mode-split ToNumber:**

- **Dynamic carrier (`any`):** the S5.3 dynamic-relational arm already uses
  the `__unbox_number` primitive for exactly this — see the from-ast doc
  block at :6379–6450 ("each dynamic operand … `__unbox_number` host — D4,
  the same primitive S5.3's relational arm uses"). Reuse that D4 primitive
  for the any-operand case — it implements ToNumber's numeric-abstract
  semantics for the carrier.
- **Static string:** host lane → the same host ToNumber/`string_to_number`
  import legacy's unary lowering uses (grep the legacy unary `+` handling in
  `src/codegen/expressions.ts` for the exact import the string arm calls;
  reuse the name); native lane → the native string→f64 parser helper legacy
  uses in nativeStrings mode (grep `nativeStrHelpers` for the str-to-num
  helper; it exists — parseFloat/Number coverage in standalone depends on
  it). If the native helper turns out to be Number()-parsing-incomplete,
  restrict the native arm to the same coverage legacy has (parity, not
  improvement, is the bar).

**3. Selector mirror (`src/ir/select.ts`/`capability.ts`):** object-typed or
unresolvable operands reject pre-claim.

**4. `-x` negation:** after ToNumber, `f64.neg` — sign-correct for `-0`
(spec: `-"" === -0`); do NOT use `0 - x` (wrong for `-0`).

### Edge cases

- `+""` → 0, `+" 42 "` → 42, `+"abc"` → NaN, `+"0x10"` → 16 (hex per
  StringToNumber — verify the reused helper covers it; if legacy differs,
  match legacy).
- `+true` → 1, `+null` → 0, `+undefined` → NaN (null/undefined reach here
  only via `any` — the D4 primitive handles them).
- `-x` on `any` in i32 context — result type is f64; let existing IR
  coercion narrow.
- Postfix/prefix `++`/`--` are NOT this issue (separate lowering).

### Validation

- `tests/issue-3168-ir-unary-tonumber.test.ts`: legacy/IR parity across the
  edge-case table × both lanes; byte-diff anti-vacuity for positive claims;
  object-operand shape proves clean pre-claim demote.
- `pnpm run check:ir-fallbacks` — no unintended growth; post-claim empty.
- #3153 meter re-run — class 3 count 0.

### Classification

**fable-executable-now** — both ToNumber primitives exist (D4 `__unbox_number`,
legacy string→number helpers); this is wiring + parity tests.
