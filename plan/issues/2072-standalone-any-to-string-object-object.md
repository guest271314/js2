---
id: 2072
title: "standalone: String(any-boxed primitive) returns '[object Object]' — $__any_to_string doesn't recognize the boxed shape from String()/pop/catch paths"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-15
completed: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [1836, 1470]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2072 — anyref unboxing missing in standalone String()

## Problem

```ts
const v: any = 42;  String(v)   // standalone: "[object Object]"   node: "42"
const u: any = undefined; String(u)  // "[object Object]" vs "undefined"
String(a.pop())                      // "[object Object]" vs "3"
```

Also `e.name` after catch and `String()` of property-read results. Direct
concat `"n:" + v` works — only the String()/read-result paths fail.

## Root cause

`src/codegen/native-strings.ts:5417-5582` — `$__any_to_string`
tag-dispatches on `$AnyValue`, but the boxed shape produced for
String(anyref) / pop-return / catch-binding values isn't recognized and
falls to the "[object Object]" else-arm (:5470/:5582).

## Fix direction

Normalize all any-producing paths to the `$AnyValue` shape
`$__any_to_string` expects, or teach it the second shape (ref.test chain).

## Acceptance criteria

- All repros match Node in standalone mode; host mode unchanged
- Concat paths unaffected

## Dupe check

#1759 (done, WASI bridge), #1836 (number↔string formatting only), #1470 —
none cover anyref unboxing in String(). New.

## Investigation (2026-06-11, dev-spec-b2) — deeper root cause than originally scoped

The `$__any_to_string` dispatcher is NOT the bug — the **boxing tags are
wrong**. `coerceType(from → AnyValue)` (`src/codegen/type-coercion.ts:1178+`)
picks the box helper by **Wasm ValType kind, not the JS type**:

| `const v: any = …` | lowers to | boxed via | tag | wrong? |
|---|---|---|---|---|
| `42` | f64/i32 | `__any_box_f64`/`i32` | 2/3 number | ok |
| `true` | i32 | `__any_box_i32` | 2 (number!) | yes → "1", typeof traps |
| `undefined` | externref | `__any_box_string` | 5 (string!) | yes → "[object Object]" |
| `null` | externref | `__any_box_string` | 5 (string!) | yes |
| native string (standalone) | `ref $AnyString` (eqref) | `__any_box_ref` | 6 (object!) | yes (see #2080) |

So `$__any_to_string` (and `__any_unbox_bool`, `__any_typeof`, `__any_*_eq`)
all receive the WRONG tag and dispatch incorrectly. Confirmed: the **concat**
path (`compileNativeConcatOperand` → `$__any_to_string`) ALSO returns
`"[object Object]"` for `undefined`/`null` any and `"1"` for `true` any — the
"concat works" claim only held for the number case. `typeof (true as any)`
**traps** in standalone.

Fix requires **type-aware boxing**: the `coerceType(→AnyValue)` site must
consult the source expression's static TS type to pick `__any_box_bool`
(tag 4) for booleans and emit tag-0/tag-1 boxes for null/undefined, instead of
boxing by Wasm kind. `coerceType` is called from many sites without the TS
type, so this means threading a TS-type hint through the boxing path — a
cross-cutting change to the coercion API. **Recommend senior-dev/architect**:
this is the standalone-AnyValue-representation core, same family as the
#2009/#1989 struct-shape work, not a localized two-helper fix.

## Resolution (2026-06-15, sdev5) — corrected root cause, no boxing-ABI change

The "wrong tag" framing above was a half-truth that pointed at a dangerous
fix. Tracing the WAT (`const v: any = 42; String(v)`) on main shows `any`-held
primitives in standalone are **not** stored as `$AnyValue` boxes at all — they
take the **externref** path: `__box_number(f64)` → `$__box_number_struct`
wrapped via `extern.convert_any`; `__box_boolean(i32)` → `$__box_boolean_struct`;
a string stays a native `$AnyString` (eqref). `String()` routes through
`__extern_toString` → `__any_to_string`. The bug: `$__any_to_string`
(`native-strings.ts`, `ensureAnyToStringHelper`) only recognized `$AnyString`
and `$AnyValue`, so a `$__box_number_struct` / `$__box_boolean_struct` fell to
the `"[object Object]"` else-arm.

Threading a static-TS hint to flip the boxing to `$AnyValue` (the "type-aware
boxing" above) would change the externref ABI — exactly what #1888's NOTE in
`type-coercion.ts:1208` warns cost **−794 baseline standalone passes**. So
instead the fix **recovers the boxed shape at the read site**:
`$__any_to_string` now `ref.test`s `ctx.nativeBoxNumberTypeIdx` /
`nativeBoxBooleanTypeIdx` before "[object Object]" and formats the value
(number via the same `number_toString` arm it uses for `$AnyValue` tag 2/3;
boolean → "true"/"false"). Type indices (not func indices) are baked in, so no
late-import shift hazard. Guarded on the box types existing (`>= 0`).

**Fixed**: `String(v)` for `v: any =` number / float / boolean, `String(a.pop())`,
property-read results, catch bindings — all match Node in standalone + wasi.
Host/gc mode unchanged (host path uses the JS-host `__extern_toString` import).

**Deliberately deferred** (NOT this issue's shape-blindness root cause):
`String(v)` for `v: any = null / undefined`. On the current standalone path
BOTH lower to a bare `ref.null extern` — the null-vs-undefined distinction is
**lost at the value level**, so there is no boxed shape to recover. Restoring
it is the undefined-representation work owned by **#2142** (spec, done) →
**#2051 / #2106** (impl). Tracked there; out of scope for this P0 read-site fix.

Regression test: `tests/issue-2072.test.ts`. Companion #2080 (empty-string
truthiness) fixed in the same PR via the `__is_truthy` native-string arm.
