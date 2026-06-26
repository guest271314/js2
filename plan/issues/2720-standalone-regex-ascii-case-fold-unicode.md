---
id: 2720
title: "Standalone regex: /i is ASCII-only case-fold; /u and /v match per-code-unit not per-code-point"
status: done
sprint: 67
created: 2026-06-26
updated: 2026-06-27
completed: 2026-06-27
assignee: ttraenkler/dev1
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

- [x] Non-ASCII `/i` and astral `/u`/`/v` matches agree with host in standalone
      (cross-backend / standalone corpus), OR fail loud with a tracked gap.

## Resolution (2026-06-27, dev1)

**Verify-first finding:** the `/u`/`/v` per-code-point half of this issue was
**already correct** on current `main` — #1911's compile-time "host as spec
oracle" (`src/codegen/regex/unicode.ts`) desugars all `u`/`v` class atoms and
single chars (including `i`-folded ones via `enumerateClassRanges`) into the
unit-level AST, decoding surrogate pairs. Astral `\u{…}` matching, `[…]` astral
ranges, and `iu`/`iv` case folding all agreed with the host in the probe.

The genuine remaining gap was the **non-Unicode `/i`** path: `compile.ts`'s
`asciiFold` / `foldClassRangesAscii` only folded `A–Z`, so `/Ä/i`, `/Σ/i`,
Cyrillic, etc. silently produced no match.

**Fix:** new `src/codegen/regex/casefold.ts` implements §22.2.2.9.3 Canonicalize
(non-Unicode, IgnoreCase) using the host's `String.prototype.toUpperCase` at
**compile time** (same oracle pattern as #1911/#1912), building the BMP code-unit
equivalence classes once per process. `compile.ts`'s `char`/`class` emitters,
when `i` is set WITHOUT `u`/`v`, now desugar to plain `CHAR`/`CLASS` ops over the
full equivalence set — the VM and emitted module stay pure Wasm with zero runtime
Unicode tables. The §22.2.2.9.3 ASCII-guard is honored (Kelvin sign `K` U+212A,
long-s `ſ` U+017F, and `ß`→"SS" correctly do NOT fold). u/v mode is untouched
(keeps the already-correct parse-time host-oracle fold).

**Validation:** 67,887 single-char `/i` BMP checks + 6,576 multi-script class
checks vs native, 0 diffs; `tests/issue-2720.test.ts` (58 end-to-end standalone
Wasm dual-run cases + inline-modifier case); all 427 existing
parse→compile→vm + 1911/1912 standalone Wasm regex tests still pass.

**Tracked residual (narrow, out of scope):** case-insensitive **backreferences**
to non-ASCII captured text under non-Unicode `/i` still compare with the VM's
runtime ASCII fold (`vm.ts` `BACKREF`/`asciiFold`) — a backref can't be desugared
to a static class, and a runtime Unicode fold table would violate the
pure-Wasm/no-runtime-tables principle. This is a strictly smaller surface than
the literal/class gap fixed here.
