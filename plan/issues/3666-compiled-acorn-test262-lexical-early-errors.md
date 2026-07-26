---
id: 3666
title: "compiled Acorn Test262 differential: lexical early errors are accepted instead of rejected"
status: done
assignee: ttraenkler/codex-acorn
created: 2026-07-26
updated: 2026-07-26
completed: 2026-07-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: parser, regexp, string
goal: acorn-dogfood
umbrella: 1712
related: [1474, 1539, 1712, 1769, 2802, 3026]
---

# #3666 — compiled Acorn loses lexical early errors

## Problem

The full pinned-Acorn/Test262 differential found inputs that node-acorn 8.16.0
rejects with `SyntaxError`, while the compiled copy of the exact same Acorn
source accepts and returns an ESTree. The first three completed disjoint shards
initially established a lower bound; the completed four-shard baseline contains
**36 affected files / 72 sloppy+strict variants**.

Unlike compiler issue #3026, these are not missing js2wasm early-error checks.
The oracle is Acorn itself on both sides. A branch, primitive, RegExp validation,
or throw path inside compiled Acorn is semantically diverging.

## Provisional breakdown

The 36 measured files fall into four lexical families:

| Family                                   | Example oracle diagnostic                          |
| ---------------------------------------- | -------------------------------------------------- |
| invalid untagged template escapes        | `Bad escape sequence in untagged template literal` |
| truncated binary/octal/hex numerics      | `Expected number in radix ...`                     |
| dangling named RegExp backreferences     | `Invalid named capture referenced`                 |
| invalid string character/unicode escapes | `Bad character escape sequence`                    |

Representative files:

- `language/expressions/template-literal/invalid-unicode-escape-sequence-2.js`
- `language/literals/numeric/binary-invalid-truncated.js`
- `language/literals/regexp/named-groups/invalid-dangling-groupname-3-u.js`
- `language/literals/string/unicode-escape-nls-err-single.js`

## Work plan

1. Reduce one file per family to the shortest source that differs.
2. Record which Acorn validation/`raise` branch node-acorn takes and whether the
   compiled parser skips the condition or loses the thrown exception.
3. Keep RegExp-constructor validation separate from character-reader/radix
   branches if their mechanisms differ; split this issue only after the
   reductions prove independent compiler defects.
4. Add focused exact rejection parity cases to the Acorn acceptance suite.

## Implementation progress 2026-07-26

Two substrate defects explain all four provisional families:

1. **#1769 return-carrier tail:** `number | null` function results collapsed to
   f64 even though nullable locals used externref. Acorn's `readInt` and
   `readHexChar` null sentinels became zero, skipping radix/string/template
   rejection branches. General nullable primitive type resolution now keeps the
   sentinel carrier at call boundaries.
2. **#2802 nested vec mirror mutation:** named RegExp backreferences were
   pushed into a materialized host Array facade rather than the underlying
   WasmGC vec, leaving `backReferenceNames.length === 0`. Raw-vec push/pop is now
   positively intercepted before generic host method lookup.

The real pinned-Acorn representative gate is **4/4 files, 8/8 matching syntax
rejections, 0 mismatches**. The exhaustive recorded-mismatch replay then
covered all 223 baseline mismatch files / 446 variants: all 72 lexical-error
variants became matching Acorn syntax rejections, with **zero**
`compiled-accepted-oracle-rejected` residuals. Only the separately owned
host-depth (#3668) and arbitrary-width BigInt (#2846) families remain.

## Acceptance

- Compiled Acorn rejects every recorded input with a Wasm exception that the
  differential classifies as a matching Acorn syntax rejection.
- Valid neighbouring template, numeric, RegExp, and string literals still
  produce ESTree output exactly equal to node-acorn, including positions.
- The full pinned-Acorn/Test262 differential reports zero
  `compiled-accepted-oracle-rejected` variants.
- Standalone Acorn remains zero-import and the parser/interpreter ABI stays
  unchanged.
