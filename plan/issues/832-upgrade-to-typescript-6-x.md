---
id: 832
title: "Upgrade to TypeScript 6.x to support Unicode 16.0.0 identifiers"
status: ready
created: 2026-03-28
updated: 2026-06-02
priority: medium
feasibility: medium
reasoning_effort: high
goal: spec-completeness
sprint: Backlog
test262_skip: 82
---
# #832 -- Upgrade to TypeScript 6.x for Unicode 16.0.0 support

## Problem

82 test262 tests use Unicode 16.0.0 identifier characters (released September 2024) that TypeScript 5.x's parser rejects as "Invalid character". These are valid ES identifiers per spec.

Example: `test/language/identifiers/start-unicode-16.0.0-class-escaped.js` uses `\u1C89`, `\u1C8A` etc. as private field names.

Currently skipped with reason "TypeScript 5.x: Unicode 16.0.0 identifiers not supported".

## Fix

1. Upgrade `typescript` dependency from `^5.7` to `^6.0`
2. Test that all compiler APIs still work (`createProgram`, `TypeChecker`, AST node kinds)
3. Run equivalence tests to verify no regressions
4. Remove the skip filter for `unicode-16.0.0` in test262-runner.ts

## Risk

TypeScript 6.0 is a major version — internal APIs we use may have breaking changes. Needs thorough testing of:
- `ts.createProgram` signature
- `ts.SyntaxKind` enum values
- `ts.TypeChecker` methods
- AST node type guards (`ts.isIdentifier`, `ts.isFunctionDeclaration`, etc.)

## Acceptance criteria

- TypeScript 6.x installed and all equivalence tests pass
- 82 Unicode 16.0.0 tests unskipped and running

## Refreshed standalone evidence - 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The standalone root-cause classifier assigns **43** rows to Unicode /
reserved-word identifier handling and another **18** rows to lexical grammar,
hashbang, whitespace, and line-terminator parsing. The Unicode 16.0.0 slice is
still the core #832 owner, while the reserved-word/directive-prologue cases
share ownership with the older lexical/strict-mode issues (#270/#990/#1435).
