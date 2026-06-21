---
id: 2187
title: "standalone: string methods on an any-typed local with a native-string ValType take the generic externref path (v.length → 0)"
status: done
assignee: ttraenkler/sd-3
sprint: 64
created: 2026-06-17
updated: 2026-06-21
completed: 2026-06-21
priority: low
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: strings
goal: standalone-mode
related: [2171, 2072, 2157]
origin: "2026-06-17 — residual found while closing #2171 SF-4 (string-yield generators)"
---

# #2187 — string method on `any`-typed local with a string-ref ValType

## Problem

When a local's **TS static type is `any`** but its **Wasm ValType is the native
`$AnyString` ref**, a string method/property on it takes the generic
externref/`any` property path instead of the native-string fast-path, returning
wrong results. Surfaced via #2171 string-yield generators in standalone (no lib
types → the for-of loop var infers `any`):

```ts
function* g(){ yield "a"; yield "b"; }
export function test(): number {
  let n = 0; for (const v of g()) n += v.length; return n;  // standalone: 0   expected: 2
}
```

Counts and concatenation are correct (`s += v` → `"ab"`); only a per-element
string method/property (`v.length`, `v.charCodeAt(0)`, …) on the `any`-typed
loop var is wrong. `String(o.a)`-style concat works because the concat path keys
off the operand ValType, not the TS type.

## Root cause

`compilePropertyAccess` (`src/codegen/property-access.ts`) gates the native
`.length` fast-path on `isStringType(tsObjType)` (the **TS static type**, ~line
1418). For an `any`-typed receiver whose *local ValType* is `(ref null
$AnyString)`, this is false, so the read falls to the generic
`extern.convert_any` + null-check + `__extern_get` path (which the WAT shows
throwing/returning 0). The single-yield case happens to hit a different
`.length` arm that consults the local ValType, so it returns the right value —
the divergence is exactly "TS type vs local ValType" disagreement.

## Fix direction

When the receiver is an identifier whose local/param **ValType is a native
string ref** (or, more generally, a concrete non-`any` Wasm representation),
route string property/method access by the **local ValType**, not the TS static
type — so `any`-typed-but-string-ref locals use the native `$AnyString` path.
Coordinate with the #2072 value-rep family (the general "compiled value has a
concrete representation even though TS says `any`" problem). Likely a shared
helper `receiverNativeStringValType(ctx, fctx, expr)` consulted before the
`isStringType(tsObjType)` gate, applied to `.length` and the string-method
dispatch sites.

## Acceptance criteria

- `for (const v of g()) n += v.length` (string generator, standalone) → correct
  sum; `v.charCodeAt(0)` correct.
- No regression on TS-typed `string` receivers or on numeric generators.
- JS-host mode unaffected.

## Notes

Split from #2171 (string-yield generators, SF-4 of #2157 — landed in
`c3eb18936`). #2171's own acceptance (iterate + concat) is met; this is the
per-element string-method residual.

## Implementation (sd-3, 2026-06-21)

Added `receiverIsNativeStringValType(ctx, fctx, recv)` in `property-access.ts`
(mirrors the #2192 `receiverIsCaughtErrorStringRead` TS-type-vs-ValType pattern):
true when the receiver is a bare identifier whose TS type is `any`/`unknown` but
whose compiled local/param **ValType is the native string ref**
(`anyStrTypeIdx`/`nativeStrTypeIdx`), standalone/WASI only. Wired it into the
two dispatch gates the static `isStringType` check missed:
1. `compilePropertyAccess` — an EARLY `.length` arm (before the Function/vec
   `.length` arms, which else fall through to `__extern_length`→0) reads `len`
   (field 0 of `$AnyString`) natively.
2. `expressions/calls.ts` string-method gate (`||` next to the existing
   `isStringType` / caught-error checks) → routes `v.charCodeAt(0)` etc. to
   `compileNativeStringMethodCall`.

Validated: the headline `for (const v of g()) n += v.length` + `v.charCodeAt(0)`
(single-yield string generator, the #2171 origin) now pass; 9 scoped tests
(`tests/issue-2187.test.ts`) green; no regression on typed `string`/literal
receivers, numeric generators, or arrays (the 144-test string suite passes; the
one `string-methods.test.ts` collection error is a pre-existing missing-`helpers.js`
worktree artifact, identical on origin/main). Hard-error + any-box gates clean.

**Out of scope (deferred, #2072 value-rep family):** an `any` local assigned
from a string METHOD (`const v: any = s.slice(1)`) gets an **externref** ValType
(the method returns externref), not `$AnyString`, so the ValType is opaque and
`v.length` still routes generically — this needs the broader externref-carries-a-
string tracking, not the bare ValType check. The multi-yield generator
(`yield "a"; yield "b"`) value-binding residual is a separate generator-state bug
(#2040 territory), NOT the `.length`/method DISPATCH this issue fixes (the WAT
shows the native `len` read fires correctly; the yielded value reaches `v` wrong).
