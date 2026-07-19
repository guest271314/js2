---
id: 3445
title: "compiler internal-error / stack-overflow crash residual (v8 harvest): 'Cannot read properties of undefined' + 'Maximum call stack' — ~28 both lanes"
status: ready
created: 2026-07-19
priority: low
task_type: bug
area: compiler-correctness
goal: test262-conformance
model: fable
sprint: current
related: [3417, 438, 523, 1606, 2587, 1607]
---

# #3445 — compiler internal-crash residual (v8 harvest, 2026-07-19)

## Summary

Low-count but **genuine compiler crashes** (the compiler throws a JS
`TypeError`/`RangeError` while compiling, rather than emitting a diagnostic).
The prior internal-error trackers (#438, #523, #1606, #2587, #1607) are all
`status: done`; no open tracker covers the current residual. Crashes warrant a
tracker even at low count.

## Sub-buckets (both lanes, official)

| signature | default | standalone |
| --- | ---: | ---: |
| `Internal error compiling expression: Cannot read properties of undefined (reading '…')` | ~5 | ~7 |
| `Internal error compiling statement: Cannot read properties of undefined (reading '…')` | ~4 | ~4 |
| `Cannot read properties of undefined (reading a class field)` | ~5 | — |
| `Internal error compiling expression: Maximum call stack size exceeded` | ~1 | ~2 |
| **total** | **~15** | **~13** |

## Sample paths

- `test/language/expressions/object/11.1.5-0-1.js` (object-literal — undefined `declarations`, cf. done #1606, re-exposed)
- `test/language/statements/for-in/cptn-expr-abrupt-empty.js` (statement compile — undefined property)
- `test/language/expressions/optional-chaining/optional-call-preserves-this.js` (Maximum call stack — recursive walker on optional-call TCO)

## Root cause (hypothesis)

An AST node reaches a codegen path expecting a resolved symbol/type that is
`undefined` (object-literal `declarations`, class-field metadata), and a deep /
mutually-recursive expression walker (optional-chaining call, tagged-template
TCO) overflows the JS stack — the same families as the done #1606 (object-literal
undefined declarations) and #2587/#1607 (recursive-walker stack overflow),
re-surfaced under the v8 workload. Likely an incremental guard / iterative-walker
extension of those fixes.

## Suggested fix

1. Reproduce `object/11.1.5-0-1.js` and add the missing null guard where
   `declarations` is read (extend #1606's fix to this node position).
2. Convert the optional-call / tagged-template recursive walker to the iterative
   form used by #1087 for the max-call-stack cases.

## Regression note

Prior internal-crash trackers closed at earlier baselines; this residual is the
current v8-baseline standing surface with no open owner.
