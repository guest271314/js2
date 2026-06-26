---
id: 2721
title: "Standalone JSON: JSON.parse accepts malformed number grammar (booleans/null typeof split to #2733)"
status: done
sprint: 67
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen
language_feature: standalone
goal: standalone-everything
parent: 2711
related: [2733]
---
# #2721 — Standalone JSON number-grammar tightening

**Parent:** #2711 (standalone↔host differential parity gate).

**Scope (narrowed after verify-first):** this issue delivers the **number-grammar
tightening** (Part 2). The booleans/null `typeof` half (Part 1) is a value-rep
substrate problem — split to **#2733** (under the #1917/#2580 umbrella). See the
Resolution for why.

## Root cause

The native JSON codec (`src/codegen/json-codec-native.ts`) hand-written number
parser was **too permissive**: it accepted malformed numbers that host
`JSON.parse` rejects with a `SyntaxError`.

## Acceptance criteria

- [x] Malformed JSON numbers (leading-zero `01`/`007`, trailing-dot `1.`,
      exponent-no-digit `1e`/`1e+`, lone `-`) throw `SyntaxError` in standalone,
      matching host.
- [~] Booleans/null correct `typeof` in standalone → **split to #2733**
      (value-rep substrate, #1917/#2580).
- (Note: the `\uXXXX` grammar already throws correctly on current main — verified
  `"\u12"` → SyntaxError; no change needed there.)

## Resolution (2026-06-26) — number-grammar guards

Verify-first on current main:
- **Part 2 (numbers)** — `JSON.parse("01")` and `"1."` were silently ACCEPTED
  (host throws); `"+1"` and a bad `\uXXXX` already threw. Fixed.
- **Part 1 (booleans/null `typeof`)** — the *values* already work
  (`JSON.parse("true") === true`, `=== null`, `false` is falsy); only `typeof`
  is wrong, and it matches NONE of boolean/number/object/undefined/string
  because the codec boxes booleans as a `$__box_number_struct` AND standalone
  `typeof` of a boxed struct is itself broken. The codec author already flagged
  this in-line as "the broader standalone boolean-boxing gap (overlaps #1917),
  out of scope." Substrate, not a codec fix → **#2733**.

Added three reusable grammar guards to the number parser
(`src/codegen/json-codec-native.ts`), each throwing a standalone `SyntaxError`
via the existing `throwSyntaxError` helper:
- `integerStartGuard` — after the optional `-`, requires a digit (rejects a lone
  `-`, and **keeps the parser bounds-safe** — the original integer loop bailed on
  EOF, but a guard reading `data[V_POS]` would otherwise trap out-of-bounds), and
  rejects a leading `0` followed by another digit (`01`/`00`/`007`).
- `digitRequiredGuard` — reused after the `.` (`frac = "." 1*DIGIT` → rejects
  `1.`/`1.e5`) and after the exponent `e`/`E`+sign (`exp = e [sign] 1*DIGIT` →
  rejects `1e`/`1e+`).

Validated against a host-parity battery (28 number forms + embedded-in-structure
cases): every malformed input throws SyntaxError matching host; every valid
number parses identically; object/array/string parsing and `\uXXXX` escapes are
unaffected (member values verified correct). `tests/issue-2721.test.ts` (30
cases). `tsc` + prettier clean. **Zero test262 movement** — test262 JSON runs
host mode, which already rejects these; this closes the standalone↔host parity
gap only.

The 2 pre-existing `issue-2166` / `json.test` stringify-space/host-import
failures are unrelated to this change (fail identically on clean main).
