---
id: 2721
title: "Standalone JSON: booleans/null box as numbers; JSON.parse accepts malformed number/\\uXXXX grammar"
status: ready
sprint: 67
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
language_feature: standalone
goal: standalone-everything
parent: 2711
---
# #2721 — Standalone JSON codec correctness gaps

**Parent:** #2711 (standalone↔host differential parity gate).

## Root cause

The native JSON codec (`src/.../json-codec-native.ts:1361`) diverges from host
`JSON`:

- `JSON.parse` returns `true` / `false` / `null` **boxed as numbers** rather
  than as the proper boolean / null values, so `typeof JSON.parse("true")` and
  equality checks disagree with host.
- `JSON.parse` is **too permissive**: it accepts malformed numbers and
  malformed `\uXXXX` escape grammar that host `JSON.parse` rejects with a
  `SyntaxError`.

## Fix sketch

- Decode JSON `true`/`false`/`null` to the correct runtime value
  representation, not a boxed number.
- Tighten the number and `\uXXXX` grammar in the parser to match the JSON spec;
  throw `SyntaxError` on malformed input as host does.

## Acceptance criteria

- [ ] `JSON.parse` of booleans/null yields correct typed values in standalone.
- [ ] Malformed JSON (bad number / bad `\uXXXX`) throws in standalone, matching
      host.
