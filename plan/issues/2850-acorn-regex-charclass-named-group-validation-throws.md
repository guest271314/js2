---
id: 2850
title: "compiled-acorn THROWS validating regex literals with character classes `[…]`/`\\d` or named capture groups `(?<n>…)`"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-3051c
sprint: 71
priority: low
horizon: m
feasibility: hard
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
created: 2026-06-29
updated: 2026-07-13
task_type: bugfix
area: codegen, runtime
language_feature: regexp
goal: acorn-dogfood
related: [1712, 1690, 2853]
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

## Landed (dev-3051c, 2026-07-12) — re-grounded root cause: dynamic `+=` was numeric-only

**#2853's shape-brand + sidecar-shadow fixes cleared the MINIMAL group repros
(`/(a)/`, `/(?:a)/`, single `(?<n>…)`), but `corpus/regex.js` still threw.**
Re-bisection isolated TWO surviving families, and instrumentation (patched
`RegExpValidationState.raise` + group/property logging) unified them into ONE
root cause that is neither char-classes nor groups:

- `/(?<a>x)(?<b>y)/` (ANY two named groups) → "Duplicate capture group name"
- `/\p{L}/u`, `/\P{…}/u`, `/\p{Script=Greek}/u` (ANY property escape under `u`)
  → "Invalid property name"

Both because **`state.lastStringValue` accumulated `NaN`**: acorn builds the
group/property name via `state.lastStringValue += codePointToString(ch)`, and
`compilePropertyCompoundAssignmentExternref`'s externref path (assignment.ts)
lowered `obj.prop += rhs` on a dynamic receiver UNCONDITIONALLY as
`__unbox_number → f64.add → __box_number`. `"" += "y"` → `0 + NaN` → NaN; both
group names keyed `"NaN"` (spurious duplicate), the unicode property name
arrived as `NaN` (invalid). 3-line no-acorn repro:
`function f(s: any) { s.v += "a"; return s.v; } f({v: ""})` → NaN.

**Fix** (`src/codegen/expressions/assignment.ts`): for `+=` on the dynamic
extern-property path, route the current-value/RHS pair through the
runtime-dispatched JS `+` (`__host_add` — the #2058 `emitAnyAdd` bridge used
for identifier targets), preserving §13.15.3 string-concat semantics; write
back through the same pinned-dispatch/bare-`__extern_set` split; result is
externref. Host-lane only — standalone keeps its numeric lowering (different
native extern surface). All other compound ops (`-=`, `*=`, …) keep the
numeric path byte-identical.

**Verification:**

- All repro shapes parse: two named groups, `(?<year>\d{4})-(?<month>\d{2})`,
  `\p{Letter}/u`, `\p{L}/u`, `\P{Letter}/u`, `\p{Script=Greek}/u`; the genuine
  SyntaxError case `/(?<a>x)(?<a>y)/` (duplicate name) still throws ✓.
- **`corpus/regex.js`: compiled-parse-threw → `equal±quirks`** (full corpus:
  23 inputs, 0 REAL divergences; only `real/acorn.mjs` self-parse still throws
  — the next-deeper gap, tracked by the #1712 umbrella).
- `tests/issue-2850.test.ts` (8 tests) + issue-2853 suite green; equivalence
  compound-assignment suites (7 files, 47 tests) green.

**Residuals (out of scope, pre-existing):** storing a string via `+=` into a
receiver whose struct slot is NUMERIC coerces on write (NaN on read-back) —
the #2853-documented typed-slot residual family; `new (fn as any)()` on an
any-cast plain function throws (unrelated, reproduced without any `+=`).
