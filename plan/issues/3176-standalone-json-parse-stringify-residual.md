---
id: 3176
title: "standalone: JSON.parse/stringify spec residual — reviver array walk illegal-cast, SyntaxError strictness, replacer/space edges (67 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: json
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 2671, 3046, 1353, 1636]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; slices the JSON area of tracking issue #2671"
---

# #3176 — standalone: JSON.parse/stringify spec residual

## Problem

**67 host-pass tests are not host-free-standalone passes** under
`built-ins/JSON/` (parse 30, stringify 29, rawJSON 5, isRawJSON 2,
Symbol.toStringTag 1; 58 fail + 9 compile_error; measured 2026-07-12
lane-baseline diff, method in #3169). Slices the JSON area of tracking issue
#2671 for the standalone lane.

Measured signatures:

- **`L80:3 illegal cast [in test()]`** (10 rows, the largest single bucket) —
  the parse **reviver** walking ARRAY holders:
  `reviver-array-non-configurable-prop-delete.js` and siblings. The
  InternalizeJSONProperty walk over array elements (delete-on-undefined,
  `[[Delete]]`/`[[DefineOwnProperty]]` fidelity, holder `this` — #3046 fixed
  the object-holder binding) mis-casts on the array arm.
- **SyntaxError strictness** (6 rows: `assert.throws(SyntaxError, …)` not
  thrown) — the native parser accepts invalid JSON (15.12.2-2-\* corpus:
  bare `+`, trailing garbage, control chars in strings, leading zeros).
- stringify edges: replacer-array key filtering with numeric keys,
  `space` coercion (`JSON.stringify(obj, null, boxedNumber)`), circular
  detection `TypeError`, `Symbol.toStringTag` descriptor row, holes
  (`arr.hasOwnProperty('1')` after roundtrip).
- rawJSON/isRawJSON (7 rows): new ES2025 statics — recognizer + carrier over
  the existing codec.

## ANTI-BLOAT directive

- The native codec EXISTS across `src/codegen/json-codec-native.ts`,
  `json-runtime.ts`, `json-standalone.ts`. Fix the reviver's ARRAY-holder arm
  inside the existing InternalizeJSONProperty walk (it already handles object
  holders per #3046) — do not fork a second walk.
- Grammar strictness: tighten the EXISTING scanner's token rules; add the
  rejected-input corpus as unit tests. No second parser.
- rawJSON: register via the existing builtin-static tables
  (`builtin-static-globals.ts` / `builtin-fn-meta.ts`, the #2933 namespace
  pattern) — table entries, not a new dispatch path.

## Acceptance criteria

- ≥48 of the 67 measured gap tests under `built-ins/JSON/` flip to host-free
  standalone passes (the 9 CE rows must at minimum stop CE-ing).
- Sample tests:
  - `test/built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js`
  - `test/built-ins/JSON/parse/15.12.2-2-9.js` (SyntaxError strictness)
  - `test/built-ins/JSON/Symbol.toStringTag.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, JSON only.
