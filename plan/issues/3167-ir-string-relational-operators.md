---
id: 3167
title: "IR: lower string relational operators (< > <= >=) — #3143 flip-track post-claim divergence class 2"
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
language_feature: strings, operators
goal: ir-full-coverage
related: [3143, 3153, 3156, 2949, 2138]
origin: "2026-07-12 architect IR audit: #3153 census class 2; blocks the #3143 IR-first flip (post-claim throw = hard error under IR-first)."
---

# #3167 — IR string relational operators

## Problem

`src/ir/from-ast.ts:5821` throws for string operands of `<`/`>`/`<=`/`>=`:

```
ir/from-ast: string operator '<' not in slice 1
```

Under today's overlay this demotes to legacy (warning). Under the #3143
IR-first flip, a post-claim throw on a skipped function is a **hard compile
error** (codegen/index.ts:2147–2172). #3153's census ranks this the #2
remaining divergence class on the equivalence corpus (class 1,
substring/charCodeAt, landed as #3156).

## Spec (§13.10 / §7.2.13 IsLessThan)

Both operands string → lexicographic code-unit comparison (NOT locale, NOT
numeric). Mixed string/number → ToNumber both, f64 compare with NaN → false.

## Implementation Plan (architect, anchors @ upstream/main adc65cfc65)

### Scope of this slice

**Both operands statically `IrType` string** (the common equivalence-corpus
shape: `if (a < b)` on string locals/params). Mixed/dynamic operands stay
rejected — but move the reject **into the selector** (select.ts) so it
becomes a pre-claim `body-shape` reject (safe legacy demote under IR-first)
instead of a post-claim throw. That selector mirror is part of THIS issue's
acceptance criteria (select↔build parity, the #2138 lockstep rule).

### Changes

**1. `src/ir/from-ast.ts` (~:5772–5821, the relational/binary lowering):**
in the arm that currently throws at :5821, when BOTH operand IrTypes are
string, build a `string_compare`-plan node instead. Follow the pattern the
just-landed #3156 used for the string METHOD family (from-ast.ts:3778–3830,
the `StringMethodPlan` with resolver-plan variants): a compare plan that
lowers to a `-1/0/1` i32 sign, then the operator folds to the boolean:
`<` → `sign < 0`, `<=` → `sign <= 0`, etc.

**2. `src/ir/lower.ts` — mode-split lowering (mirror legacy exactly):**

- **Host lane:** env import `string_compare (externref, externref) -> f64`
  — grep `string_compare` in `src/codegen/declarations.ts` (:1412 context)
  for the exact existing import signature legacy uses; reuse the SAME import
  name so no new host surface is added.
- **Native-strings/standalone lane:** the `__str_compare` helper
  (`ctx.nativeStrHelpers.get("__str_compare")` — see legacy usage at
  `src/codegen/binary-ops.ts:3800–3820`: flatten both via `__str_flatten`,
  then call `__str_compare` → i32 sign). The IR backend resolves helper
  funcIdx symbolically post-`compileDeclarations`, so no funcIdx-shift hazard
  (same reason the #3156 family was safe).

**3. `src/ir/select.ts` / `capability.ts` — selector mirror:** extend the
capability predicate so a relational with ONE string-typed operand and one
non-string (or unresolvable) operand **rejects at selection** (reason:
`body-shape-rejected` or a dedicated reason string). Both-string becomes
claimable. This exactly mirrors the from-ast condition — cite the #2138
select↔build parity rule in the code comment.

**4. `src/ir/verify.ts` / `effects.ts`:** the compare plan node is pure
(no effects); add to the node-kind switch(es) — the `never`-exhaustiveness
pattern will flag every site that needs an arm.

### Edge cases

- `""` empty-string operands; equal strings for `<=`/`>=` (sign 0 arm).
- Rope/unflattened native strings: `__str_flatten` before compare (as legacy).
- Surrogate code units compare by code unit (UTF-16 order) — `__str_compare`
  already implements legacy semantics; do not re-implement.
- `===`/`!==` are NOT this issue (already handled).

### Validation

- New `tests/issue-3167-ir-string-relational.test.ts`: legacy/IR parity for
  each operator × (lt/eq/gt operand pairs) × both lanes; positive claims
  proven via byte-diff (anti-vacuity, follow
  `tests/issue-2856-vec-push.test.ts`'s pattern); mixed-operand shape proves
  a CLEAN pre-claim demote (no post-claim record).
- `pnpm run check:ir-fallbacks` — no unintended bucket growth; post-claim
  buckets stay empty.
- Re-run the #3153 meter (`STRIDE=300 npx tsx scripts/ir-postclaim-meter.mts .`)
  — class 2 count must be 0.

### Classification

**fable-executable-now** — follows the landed #3156 pattern; both lowering
targets exist in legacy and are reused, not rebuilt.
