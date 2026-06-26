---
id: 2720
title: "Standalone regex: /i is ASCII-only case-fold; /u and /v match per-code-unit not per-code-point"
status: ready
sprint: 67
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen
language_feature: regexp
goal: standalone-everything
parent: 2711
---
# #2720 — Standalone regex case-fold + unicode gaps

**Parent:** #2711 (standalone↔host differential parity gate).

## Root cause

The standalone (native) RegExp backend diverges from host semantics:

- `/i` performs **ASCII-only** case folding, so non-ASCII case-insensitive
  matches (e.g. `/Ä/i`, Greek, Cyrillic) disagree with host.
- `/u` and `/v` match **per UTF-16 code unit** rather than per Unicode code
  point, so astral characters (surrogate pairs) and `\u{…}` classes match
  incorrectly.

Host mode delegates to the JS RegExp engine and is correct; the standalone arm
silently produces different match results.

## Fix sketch

- Implement full Unicode simple case folding for `/i` (case-fold table), or
  fail loud for non-ASCII case-insensitive patterns under standalone.
- Make `/u` / `/v` iterate code points (decode surrogate pairs) so character
  classes and quantifiers operate on code points.

## Acceptance criteria

- [ ] Non-ASCII `/i` and astral `/u`/`/v` matches agree with host in standalone
      (cross-backend / standalone corpus), OR fail loud with a tracked gap.
