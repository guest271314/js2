---
id: 3541
title: "Standalone: String.fromCodePoint.apply(null, vec) returns null (__str_concat null-deref) — sole remaining gate on the RegExp property-escapes 311-row family"
status: ready
created: 2026-07-23
updated: 2026-07-23
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: standalone
sprint: current
horizon: m
umbrella: 2860
related: [2860, 3536, 3535, 2088, 3138, 3139]
files:
  - src/codegen/expressions/calls.ts
---

# Standalone: `String.fromCodePoint.apply(null, vec)` returns null

## Problem

With the #3536 call-boundary fix landed, every one of the **311
`built-ins/RegExp/property-escapes/generated/` baseline rows** now advances
into `regExpUtils.js`'s `buildString` — and hits this defect. All 311 run the
SAME harness function, so fixing this one path flips the family (measured
gate, not an extrapolation: 15/15 sampled tests die here and nowhere else,
via the real sharded worker).

Minimal repro — no functions, no params, plain top level, pre-existing
(unrelated to #3536; reproduces on main before it):

```js
var v = [0x41, 0x42, 0x43];
var s = String.fromCodePoint.apply(null, v); // s is null, not "ABC"
if (s !== "ABC") throw new Error("bad: " + s);
// → dereferencing a null pointer [in __str_concat ← __module_init]
```

Compiled shape (binaryen disasm): the call routes through the generic
`__call_m_apply_2(closureWrapper(__builtin_static_String_fromCodePoint),
null, extern.convert_any(vec))` — the apply runtime does not spread a native
`$vec_f64` into the builtin-static's variadic lowering; the result lands
null and the first consumer (`__str_concat` from `result += …`, or the
strict-compare against the expected string) null-derefs.

Second blocker in the SAME harness function (verify while here): the
grown-array variant

```js
const codePoints = [];
for (let length = 0, cp = start; cp <= end; cp++) codePoints[length++] = cp;
result += String.fromCodePoint.apply(null, codePoints);
```

fails with `illegal cast [in buildString]` — likely the empty-literal array's
vec type vs the apply path's expected carrier. 41 of the 198 re-measured
null-deref census rows now show exactly this signature.

## Direction

Options, in rough preference order (verify against the compiled shape
before choosing):

1. Special-case `<builtin fromCharCode/fromCodePoint>.apply(thisArg, arr)`
   at the call site (calls.ts already flattens STATIC array literals for
   `.apply`) — lower a dynamic array/vec argument through the same
   per-element loop `compileFromCharCodeFamily` uses, reading the vec at
   runtime (length + elem loop into the variadic concat primitive). Zero
   changes to the generic apply runtime.
2. Fix `__call_m_apply_2`'s native-vec argv handling for builtin-static
   closures generally (bigger blast radius — the fnctor/apply machinery
   borders #3138/#3139; coordinate before touching).

## Acceptance

- The minimal repro passes standalone (s === "ABC").
- The grown-`codePoints` variant passes (no illegal cast).
- ≥ measured-majority of a 15-test property-escapes sample flips to PASS
  through the real worker (the tests additionally exercise `\p{…}`
  unicode-property RegExp matching — measure, don't assume; if the RegExp
  engine lacks the property tables, record the residual honestly).
- Zero host-lane changes (standalone-scoped or verified byte-identical).
