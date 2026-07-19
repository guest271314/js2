---
id: 3443
title: "standalone: illegal-cast residual (92 gap tests) — general __module_init + __str_to_number/parseInt, no open tracker"
status: ready
created: 2026-07-19
priority: medium
task_type: bug
area: standalone
goal: standalone-mode
model: fable
sprint: current
horizon: s
related: [1781, 2038, 3075]
---

# #3443 — standalone illegal-cast residual (v8 harvest, 2026-07-19)

## Summary

The 2026-07-19 host↔standalone gap harvest surfaced **92 gap tests** with
`error_category: illegal_cast` — standalone modules that compile but trap
`illegal cast` at runtime, where the JS-host lane passes. Genuine
standalone-codegen bugs (a `ref.cast` to the wrong concrete type), not
host-import refusals.

The specific illegal-cast trackers — #2038 (`__iterator_next` / async-dstr) and
#3075 (for-of/for-await dstr iterator) — are `status: done`. No **open** tracker
covers the residual 92, whose dominant sub-signature is a **general
`__module_init` cast**, not the iterator paths those issues fixed.

## Sub-buckets (normalized signature within the 92 gap tests)

| signature | count |
| --- | ---: |
| `illegal cast [in __module_init()]` (general) | 79 |
| `illegal cast [in __str_to_number() ← __module_init]` (string→number coercion) | 8 |
| `illegal cast [in parseInt() / parseFloat() ← __module_init]` | 5 |

## Sample paths

- `test/built-ins/String/prototype/replace/replaceValue-evaluation-order.js` (general)
- `test/language/expressions/does-not-equals/S11.9.2_A7.4.js` (`__str_to_number`)
- `test/built-ins/parseInt/S15.1.2.2_A1_T6.js` (parseInt)

## Root cause (hypothesis)

Standalone codegen narrows an `anyref`/`externref` value to a concrete struct via
`ref.cast` on a path where the dynamic type doesn't match — most visibly in the
string→number coercion helper (`__str_to_number`) and `parseInt`/`parseFloat`,
where a boxed value reaches the numeric fast path without the host lane's
`__box`/`__extern` normalization. Likely the same value-representation mismatch
family as #2160 (standalone string↔number coercion residual).

## Suggested fix

1. Reproduce `does-not-equals/S11.9.2_A7.4.js` in `--target standalone`; capture
   the source type vs cast target in `__str_to_number`.
2. Add the missing type guard / normalization before the `ref.cast` in the
   standalone numeric-coercion path; cross-check #2160.
3. Triage the 79 general `__module_init` casts for a shared representation root.

## Regression note

Specific illegal-cast trackers (#2038/#3075) closed at earlier baselines; this 92
is the current v8-baseline standing surface with no open owner. Filed fresh from
the harvest.
