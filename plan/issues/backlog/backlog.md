# Backlog index

Lightweight pointer index for unscheduled issues that need sprint candidacy. Authoritative status lives in each issue file's frontmatter.

## Spec-compliance easy wins (from #1563 gap analysis, 2026-05-21)

- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol argument must throw TypeError (§7.1.3 step 3) — ~12 fails, easy
- [#1565](1565-toBoolean-bigint-i64-eqz.md) — ToBoolean BigInt: must use i64.eqz, not f64.convert_i64_s (§7.1.2) — ~12 fails, easy
- [#1566](1566-toNumber-symbol-throws-typeError.md) — ToNumber: Symbol argument must throw TypeError (§7.1.4) — ~10 fails, easy

## Host-independence gaps (standalone/WASI)

- [#1591](1591-throw-reference-error-standalone-gate.md) — `__throw_reference_error` standalone gate: emit `unreachable` instead of host import — ~20 LOC, easy
- [#1592](1592-string-fromcharcode-standalone.md) — `String.fromCharCode` / `fromCodePoint` pure-Wasm path for standalone — ~60 LOC, easy
- [#1593](1593-json-standalone.md) — JSON.parse / JSON.stringify standalone: Phase 1 refuse-and-document, Phase 2 cJSON side module — Phase 1 easy, Phase 2 hard

