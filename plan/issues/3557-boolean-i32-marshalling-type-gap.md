---
id: 3557
title: "booleans cross the host boundary as i32 0/1 — systemic wrong-TYPE marshalling (boolean brand lost in struct-field type inference)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
model: opus
created: 2026-07-23
updated: 2026-07-23
task_type: bugfix
area: runtime, codegen
language_feature: host-marshalling, value-rep
goal: acorn-dogfood
related: [2773, 1712, 2847, 1788]
umbrella: 1712
origin: "Split out of #2847 (2026-07-23, sendev-acorn) — mis-filed there as a cosmetic quirk. The tech lead's 2026-07-23 review flagged it as a real fidelity gap; this issue reframes it as the wrong-TYPE-crossing-the-boundary defect it is."
---

# #3557 — booleans marshal as the number 0/1: a real type-fidelity gap, not a cosmetic quirk

Split from #2847 (which now keeps only the genuinely-cosmetic `sourceFile`
quirk). Surfaced by the acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella), but the defect is
**systemic**, not acorn-specific.

## Problem — this is wrong TYPE, not wrong truthiness

Boolean-valued struct fields (`computed`, `optional`, `static`, `generator`,
`async`, `prefix`, `delegate`, `tail`, `method`, `shorthand`, …) marshal across
the host boundary as the **number** `0`/`1` instead of JS `false`/`true`:

```
primitive-mismatch  $...computed   expected false   actual 0
```

Why "cosmetic" was the wrong frame (the original #2847 rationale said "a
consumer that reads `node.computed` still gets a truthy/falsy value"):

- `node.computed === false` → **false** (it's `0`); strict-equality consumers
  break silently.
- `typeof node.computed` → `"number"`, not `"boolean"`.
- `JSON.stringify` emits `0`/`1`, so serialized output differs from every
  spec-conformant producer.
- Any downstream tool with a type check (validators, TS consumers of the AST,
  structural differs) sees a different VALUE TYPE, which is exactly the class
  of divergence the dogfood program exists to catch.

Measured 467 occurrences across the 2026-07-03 corpus run (fields: `async`
`await` `computed` `delegate` `generator` `optional`).

## Root cause (verified 2026-07-03, dev-team-a — carried over from #2847)

**This is a CODEGEN brand-preservation gap, NOT a marshalling gap.** The
`__box_boolean` path (#1788) already boxes a boolean-branded i32 struct field
(`{kind:"i32", boolean:true}`) as a JS boolean on host read — verified for
both TS-typed `boolean` fields and untyped-JS `this.computed = false`
constructor assignments. The runtime marshaller does the right thing when the
brand survives.

The brand is **lost during struct-field-type computation** when a field is
assigned via boolean-returning method calls in untyped JS
(`node.generator = this.eat(types.star)`) whose inferred return type is plain
number-i32, not boolean-branded. When a field's assignment mix includes
unbranded method-call results, the merged field type drops `boolean: true`,
and getter emission (`src/codegen/index.ts` `_emitStructFieldGettersInner`,
the `hasBool` fork) emits raw-i32/`__box_number` instead of `__box_boolean`.

- **Real fix location**: struct-field-type inference / brand-preservation in
  `src/codegen` (brand boolean-returning method returns, or preserve the brand
  through the field-type merge), NOT `src/runtime.ts`. A field-name allowlist
  in the generic marshaller would regress real user programs and violates the
  no-bespoke-builtins principle.
- **Blast radius**: branding changes flow into `typeof`/boxing across the
  whole test262 surface (exactly what #1788 had to guard) — must validate IN
  BATCH via the full merge_group, not locally. This is value-rep territory —
  hence `related: [2773]` (value-rep epic); coordinate with any in-flight
  brand/rep work before implementing.

## Fix-vs-accept is a REAL decision — record it, don't default it

This issue must end in one of two explicit outcomes, decided with the value-rep
epic (#2773) owner / tech lead — NOT silently parked as an allowance:

1. **Fix**: preserve the boolean brand through field-type merging (per the
   root cause above), validated in batch. This is the type-fidelity-correct
   outcome and the default recommendation.
2. **Accept**: a recorded decision that i32-boolean marshalling is a permitted
   representation divergence, with the differ's quirk bucket as the permanent
   normalization layer. This weakens every strict-equality/typeof consumer of
   compiled output and should require explicit sign-off.

## Acceptance

- Marshalled boolean struct fields are JS booleans (`typeof === "boolean"`,
  `=== false` works), OR a recorded accept-decision with sign-off in this file.
- `tests/dogfood/acorn-corpus.mjs` reports `quirk-bool-as-i32` ≈ 0 (fix path).
- Full merge_group validation (batch blast-radius check) — no test262
  regression, no standalone-floor regression.
