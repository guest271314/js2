---
id: 3667
title: "compiled Acorn Test262 differential: yield followed by RegExp loses generator lexical context"
status: in-progress
assignee: ttraenkler/codex-acorn
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
language_feature: parser, generators, regexp
goal: acorn-dogfood
umbrella: 1712
related: [1712, 2800, 2805, 2853, 3668]
---

# #3667 — compiled Acorn loses the RegExp lexical goal after `yield`

## Problem

The pinned Acorn/Test262 differential reports both sloppy and strict variants
of:

```text
language/expressions/yield/rhs-regexp.js
```

as compiled-parser rejections while node-acorn 8.16.0 accepts them. The compiled
parser reports `Unexpected token` at `yield/abc/i`; `/` is tokenized as division
instead of as the RegExp literal required by the generator lexical context.

## Root cause

Acorn creates `TokenType` instances inside its module-level `types` table, then
installs context callbacks with nested writes:

```js
types.star.updateContext = function (prevType) { ... };
types.name.updateContext = function (prevType) { ... };
```

The `types.star.updateContext` callback is installed and invoked correctly.
When it sees `*` after `function`, Acorn performs:

```js
var index = this.context.length - 1;
this.context[index] = types.f_gen;
```

`Parser` instances are dynamically dispatched in JS-host mode, so
`this.context` reaches the indexed assignment as an externref. The receiver is
the raw WasmGC vec, but `__extern_set_strict` previously fell through to the
opaque-struct sidecar path. The host accepted the numeric write without
mutating the vec backing array; later in-Wasm reads still observed `f_stat`.
Consequently `inGeneratorContext()` returned false for `yield` and the slash
was scanned as division.

The module already exposes vec mutation dispatch for growable arrays. The fix
routes canonical numeric writes through the same live vec mutation surface,
including reference-keyed vecs whose physical backing element is externref.

## Measured acceptance

- The focused dynamic-index regression updates the live vec element and passes.
- `language/expressions/yield/rhs-regexp.js` is exact against pinned node-acorn
  in **2/2 sloppy+strict variants**.
- The final recorded two-file mismatch replay is exact in **4/4 variants**.
- The required 22-input Acorn corpus remains **22/22 exact** with zero throws.
- The full 53,259-file post-fix differential is the final running gate.

## Acceptance

- A dynamic numeric write to a WasmGC vec updates the live element observed by
  subsequent compiled reads.
- Compiled Acorn parses `yield/abc/i` with exact ESTree parity to pinned
  node-acorn in both sloppy and strict Test262 variants.
- The full recorded mismatch replay has no residual lexical-context mismatch.
- No parser, callable, rec-group, or interpreter ABI changes are introduced.
