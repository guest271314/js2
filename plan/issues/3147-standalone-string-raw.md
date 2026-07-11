---
id: 3147
title: "standalone: String.raw (22 __get_builtin CEs)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984, 2160]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3147 — standalone String.raw

## Problem

`String.raw(template, ...substitutions)` used standalone hard-CEs through the
`__get_builtin` dynamic-shape refusal (#1472 Phase B). Measured **22** non-pass
standalone entries under `built-ins/String/raw/`. Note: this is the FUNCTION
`String.raw(obj)` reflective/error-path form (a `cooked`/`raw` ToObject +
length-coercion + string-concat loop); the tagged-template lowering
`String.raw\`...\`` is a separate path (#2510) and already handled — these
tests call `String.raw` as an ordinary function with hand-built objects.

## Sample paths

- `test/built-ins/String/raw/template-length-throws.js`
- `test/built-ins/String/raw/template-raw-not-object-throws.js`
- `test/built-ins/String/raw/return-empty-string-if-length-is-zero-NaN.js`
- `test/built-ins/String/raw/returns-abrupt-from-next-key.js`

## Shared-infra deps

- Needs `String.raw` as a resolvable standalone builtin function with the spec
  §22.1.2.16 algorithm: `ToObject(template.raw)`, `ToLength(len)`, per-index
  `Get` + `ToString` on both raw segments and substitutions, string
  concatenation. Reuses the open-object dynamic `__extern_get` + native string
  concat already present; the error-path tests mostly assert TypeError on a
  non-object `.raw` / abrupt getters.

## Acceptance

- `built-ins/String/raw/*` standalone tests compile + pass with 0 regressions.
