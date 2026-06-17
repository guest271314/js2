---
id: 2080
title: "standalone: any-boxed empty string is truthy — anyref truthiness checks ref non-null, never string length"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-15
completed: 2026-06-15
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [2072]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2080 — ToBoolean("") via anyref returns true

## Problem

```ts
const v: any = "";
v ? "T" : "F"
// standalone: "T"   node: "F"
```

Direct `const s = ""; s ? …` is correct — only the any-boxed path is
wrong (flips index 3 of the `[0,-0,NaN,"",null,undefined]` truthiness
table).

## Root cause

anyref truthiness in `src/codegen/type-coercion.ts` checks ref
non-nullness for boxed strings but never the string length (§7.1.2: empty
string → false). Exact line not pinned — locate the anyref ToBoolean
branch.

## Acceptance criteria

- Repro returns "F" standalone; full truthiness table matches Node for
  any-boxed values; direct paths unchanged

## Dupe check

#171 (old boolean edges, done); no standalone truthiness issue. New.

## Investigation (2026-06-11, dev-spec-b2)

The anyref ToBoolean lives in `ensureI32Condition`
(`src/codegen/index.ts:11696-11705`): for a `ref $AnyValue` it calls
`__any_unbox_bool` (`src/codegen/any-helpers.ts:384`). The bug is in that
helper: its final arm is `tag >= 5 → 1` (always truthy), so a string never
has its length checked.

Compounding it (and the reason this is NOT a clean isolated fix): in
standalone mode a native string (`ref $AnyString`, an eqref subtype) boxes via
`__any_box_ref` → **tag 6**, NOT tag 5 (`__any_box_string`/tag 5 is only for
externref/JS-host strings). So `__any_unbox_bool` would need to `ref.test` the
tag-6 `refval` against `$AnyString` and, if it is a string, flatten
(`__str_flatten`, registered in `ensureNativeStringHelpers`) and read the
length field — a cross-helper dependency between the AnyValue helpers and the
native-string helpers, with the usual late-import index-shift concerns.

This is the SAME type-unaware-boxing root cause as [[2072]] (native string →
tag 6, not a string tag). Fixing the boxing so strings carry a recoverable
string tag fixes both. **Recommend bundling with #2072 under senior-dev/
architect** rather than a tag-6 special-case here.

## Resolution (2026-06-15, sdev5) — bundled with #2072

The investigation's `__any_unbox_bool` lead was for the `$AnyValue`-box path;
the **actual** standalone ToBoolean for an `any`-held value is `__is_truthy`
(`src/codegen/index.ts`, `addUnionImportsAsNativeFuncs`). On the standalone /
nativeStrings path a string `any` is held as an externref wrapping a native
`$AnyString` (the supertype of `$NativeString` / `$ConsString`), NOT a tag-6
`$AnyValue` box. `__is_truthy` already handled the number / boolean / bigint
boxes but had **no `$AnyString` arm**, so a string fell through to the final
`i32.const 1` ("any non-null ref → truthy") default — the empty string was
wrongly truthy.

**Fix**: inserted a native-string arm before the truthy default —
`ref.test $AnyString` → `struct.get` field 0 (`$len`) → `len != 0`. Guarded on
`ctx.anyStrTypeIdx >= 0` so the GC / host-string path is untouched. No boxing
ABI change (avoids the #1888 −794 regression).

Verified standalone truthiness table now matches §7.1.2 for
`"" / "x" / "0" / 0 / -0 / NaN / 42 / false / true`. Regression test:
`tests/issue-2072.test.ts` (`#2080 — ToBoolean`). Host/gc mode unchanged.
