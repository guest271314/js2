---
id: 3304
title: "standalone: primitive-string bracket indexing (s[i]) returns garbage — falls to __extern_get, no native-string arm"
status: done
assignee: ttraenkler/sendev-date-3174
created: 2026-07-16
updated: 2026-07-19
completed: 2026-07-16
priority: high
feasibility: medium
model: fable
task_type: bug
area: codegen
es_edition: multi
language_feature: string
goal: standalone
umbrella: 2860
sprint: 72
horizon: s
related: [3174, 1910, 3027, 2891]
loc-budget-allow:
  - src/codegen/property-access.ts
origin: "root-caused during #3174 (Date brand/coercion) — blocks toISOString/15.9.5.43-0-5/11/12 and likely many non-Date rows"
---

# #3304 — standalone: primitive-string bracket indexing is broken

## Problem

Under `--target standalone`, integer-indexed element access on a PRIMITIVE
string (§10.4.3.5 StringGetOwnProperty) produces a garbage/null value while
`charAt` works:

```ts
var s = "XYZ";
s[2] === "Z"        // → false  (should be true)
s[2].length          // → traps: dereferencing a null pointer
s[2].charCodeAt(0)   // → traps: illegal cast
s.charAt(2) === "Z" // → true   (works)
```

WAT-level root cause (verified 2026-07-16): `compileElementAccess`
(property-access.ts) has NO arm for a statically-string-typed receiver with a
numeric index, so the access falls through to the generic dynamic read:

```
extern.convert_any(s)  f64.const 2  call $__box_number  call $__extern_get
```

`__extern_get` has no `$NativeString` receiver arm → null result → every
downstream use misbehaves (`===` false, member access traps).

The two ADJACENT arms both miss this case:

- **#1910 R4** (property-access.ts ~3505): String-WRAPPER indexed read
  (`new String("ab")[0]`) — gates on `isStringWrapperType` only, so a
  primitive `string` receiver never fires. Its emission (recv →
  `__to_primitive(recv,"string")` → flatten → `__str_charAt(flat, i)`) is
  exactly what the primitive case needs (ToPrimitive of a primitive string is
  identity).
- **#3027** (~3539): computed NON-numeric key on a string receiver
  (`"str"["length"]`) — explicitly excludes numeric indices.

## Impact (measured)

- Blocks `built-ins/Date/prototype/toISOString/15.9.5.43-0-5/11/12.js`
  (`dateStr[dateStr.length - 1] === "Z"`) — the residual toISOString rows
  from #3174.
- The `s[i]` idiom is pervasive in test262 (`String/prototype/*`, parsing
  helpers, `propertyHelper`-adjacent code), so non-Date collateral wins are
  likely.

## Fix

Widen the #1910 R4 gate to ALSO fire for a primitive-string receiver:
`ctx.oracle.staticJsTypeOf(expr.expression) === "string"` (the same
oracle-side predicate #3027 uses), keeping the identical emission
(`__to_primitive` → `__str_flatten` → `__str_charAt`). Result type stays
`(ref $NativeString)`.

Known, documented divergence (inherited from the sanctioned #1910 R4 arm):
out-of-range yields `""` (charAt §22.1.3.1 semantics) instead of the spec's
`undefined`. Acceptable approximation for this slice; a bounds-check →
undefined refinement can ratchet later if a measured row needs it.

## Out of scope (follow-ups)

- **`any`-typed receivers** (`var s: any = "XYZ"; s[2]`): needs a runtime
  `$NativeString`/`$AnyString` arm inside `__extern_get` (dyn-read substrate —
  overlaps the in-flight carrier/substrate lane; do not double-fix).
- **toString-only-object ToNumber gap** (from #3174 residuals, keep visible):
  `+{toString(){return "7"}}` → NaN standalone; the #2891 valueOf→toString
  fallthrough doesn't cover closed anon structs. Good next-next candidate.

## Acceptance criteria

- `"XYZ"[2] === "Z"`, `s[s.length-1]` idioms work host-free standalone.
- `built-ins/Date/prototype/toISOString/15.9.5.43-0-5.js` (and -11/-12 if
  their big-value constructor arithmetic permits) flip to host-free passes.
- Zero host-mode regressions; zero standalone high-water regressions.
- Scoped local sweep of `built-ins/String/prototype` + `built-ins/Date` shows
  net-positive, no regressions.
