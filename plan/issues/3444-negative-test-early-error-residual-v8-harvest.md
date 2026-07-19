---
id: 3444
title: "negative_test_fail residual (v8 harvest): early-error not detected + negative test mis-passes — 89 default / 45 standalone"
status: ready
created: 2026-07-19
priority: medium
task_type: bug
area: test262-conformance
goal: test262-conformance
model: fable
sprint: current
related: [3417, 3026, 721, 418, 2920]
---

# #3444 — negative_test_fail residual (v8 harvest, 2026-07-19)

## Summary

Per the harvest protocol (inspect `negative_test_fail` — real conformance bugs,
not noise), the 2026-07-19 baselines show a standing negative-test residual that
has **no open tracker** — the prior trackers (#3026, #721, #418, #2920) are all
`status: done`. #3417 explicitly flagged `fail::negative_test_fail` (88) as
"REAL conformance bugs — needs sub-bucket triage". This issue is that tracker.

Negative tests either (a) should raise an **early/parse SyntaxError** but the
compiler accepts the code with no diagnostic, or (b) should throw at **runtime**
but execution succeeds.

## Sub-buckets (both lanes, official)

| signature | default | standalone |
| --- | ---: | ---: |
| `expected SyntaxError but compiled with no diagnostic (early error not detected)` | 44 | — |
| `expected resolution SyntaxError but compiled with no diagnostic` (module instantiation) | 22 | 22 |
| `expected runtime ReferenceError but succeeded` | 12 | 12 |
| `expected runtime Test262Error but succeeded` | 6 | 6 |
| `expected runtime SyntaxError but succeeded` | 3 | 3 |
| `expected runtime TypeError but succeeded` | 2 | 2 |
| **total** | **89** | **45** |

## Sample paths

- `test/language/statements/labeled/value-await-module.js` (early SyntaxError not detected)
- `test/language/module-code/import-attributes/import-attribute-newlines.js` (resolution SyntaxError)
- `test/language/statements/switch/scope-lex-class.js` (runtime ReferenceError not thrown — lexical scope / TDZ)

## Root cause (hypothesis)

The compiler's early-error / static-semantics pass under-enforces several
grammar-level restrictions (labeled `await` in module context, duplicate
import-attribute keys, lexical-declaration scope collisions), and some runtime
TDZ / ReferenceError paths resolve the binding instead of throwing. The v8
harness runs the real negative-test verdict, exposing these.

## Suggested fix

Sub-triage by the specific early-error rule (each is a small static-semantics
check). Start with the `early error not detected` cluster (44) since it is the
largest and purely a parse-time validation gap. Cross-check the done #418 /
#3026 fixes for which rules regressed vs newly-surfaced under v8.

## Regression note

Prior negative-test trackers closed at earlier baselines; this residual is the
current v8-baseline standing surface with no open owner. Low-to-medium count but
genuine conformance bugs.
