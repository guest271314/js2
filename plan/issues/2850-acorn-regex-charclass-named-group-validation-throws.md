---
id: 2850
title: "compiled-acorn THROWS validating regex literals with character classes `[…]`/`\\d` or named capture groups `(?<n>…)`"
status: ready
sprint: current
priority: low
horizon: m
feasibility: hard
created: 2026-06-29
updated: 2026-06-30
task_type: bugfix
area: codegen, runtime
language_feature: regexp
goal: acorn-dogfood
related: [1712, 1690]
umbrella: 1712
---

# #2850 — compiled-acorn throws validating regex character classes / named groups

> **PARTLY SUPERSEDED by #2853 (see its repro B, verified 2026-07-03):** the
> **char-class half is FIXED** on current main (`/[a-z]/`, `/[a]/`, `/\d/` all
> parse — likely by #1690-family work); the surviving failure is **any regex
> group `(…)`** (capturing, non-capturing, AND named). PO: re-scope this issue
> to the group-throw or close it into #2853. In the interpreter sequencing
> (`docs/architecture/runtime-eval-interpreter.md` §15–§16) the surviving half
> is slice **P2**, a hard blocker for #2928's parser wiring.

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella). Compiled-acorn throws a
`WebAssembly.Exception` while **parsing/validating** certain regex-literal
patterns that node-acorn accepts. This is NOT the #2838 `return` wall —
`corpus/regex.js` contains no function/`return`/`new.target`.

## Localization (`.tmp/probe-regex.mjs`, current main)

```
/foo.*bar/        OK
/foo.*bar/gi      OK
/\p{Letter}/u     OK
/[a-z]+\d?/u      THREW    ← character class [a-z] and/or \d escape
/(?<year>\d{4})/  THREW    ← named capture group and/or \d escape
```

So compiled-acorn throws on regex patterns containing a **character class
`[…]`** and/or a **named capture group `(?<name>…)`** (both throwing cases also
contain a `\d` class escape; plain `.`/`*` and `\p{…}` unicode-property escapes
validate fine). node-acorn parses all of them to a `Literal` with a `regex:
{pattern, flags}` field.

The throw originates inside acorn's `RegExpValidationState` /
`validateRegExpPattern` machinery — the same charCode-loop-heavy code that
exposed #1690 (`isInAstralSet` global-array f64 mismatch). The exact thrown
payload is opaque (compiled `__exn` tag carries an externref, not exported).

## Minimal repro

```js
const r = /[a-z]+/; // THROWS — node-acorn: { type:"Literal", regex:{pattern:"[a-z]+",flags:""} }
const g = /(?<y>\d{4})/; // THROWS
```

## Acceptance

- `tests/dogfood/acorn-corpus.mjs`: `corpus/regex.js` no longer
  `compiled-parse-threw`; regex Literals diff `equal±quirks`.
- Focused regression checks for `/[a-z]/`, `/\d/`, and `/(?<n>…)/`.
- No test262 regression.
