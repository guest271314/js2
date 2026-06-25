---
id: 2666
title: "base[prop] eval order in compound-assign + ++/--: ToPropertyKey ONCE, base-before-prop, left-before-right (ES3/ES5/ES6, ~100 fails)"
status: in-progress
assignee: ttraenkler/dev-2046
created: 2026-06-25
updated: 2026-06-25
priority: top
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: assignment, member-access, eval-order
goal: spec-completeness
sprint: 66
---

# #2666 — `base[prop]` evaluation order in compound-assign + `++`/`--`

## Problem

For `base[prop] op= rhs` and `base[prop]++` / `base[prop]--` on an **object**
receiver with a **computed, side-effecting key**, the compiler evaluates the
key's ToPropertyKey coercion **TWICE** (once for the read, once for the
write-back) instead of **once**, and the value result is wrong.

ECMAScript requires the property key to be evaluated exactly once for a
read-modify-write:

- **§13.15.2 (AssignmentExpression : LeftHandSideExpression AssignmentOperator
  AssignmentExpression)** — for a compound assignment, the LHS is evaluated to a
  *Reference* ONCE (step 1.a: `lref = Evaluation of LeftHandSideExpression`),
  then GetValue/operator/PutValue all reuse that one Reference. Evaluating a
  `MemberExpression : MemberExpression [ Expression ]` to a Reference
  (**§13.3.3**) runs `baseReference` then `propertyNameReference` then
  `ToPropertyKey(propertyNameValue)` (**§13.3.2 EvaluatePropertyAccessWithExpressionKey**)
  — so the key's ToPropertyKey happens **once**, with **base before prop**.
- **§13.4 (UpdateExpression)** — `++`/`--` likewise evaluate the LHS to a
  Reference once, then GetValue → +1/−1 → PutValue on that same Reference.
- **§7.1.19 (ToPropertyKey)** — `key = ToPrimitive(arg, string)`; if Symbol
  return it; else `ToString(key)`. A side-effecting `toString`/`valueOf` /
  `@@toPrimitive` must therefore fire **exactly once** per read-modify-write.

## Reproduction (current main)

```ts
// key.toString MUST run once; currently runs twice
var n = 0; var o:any = { x: 1 };
var key = { toString() { n++; return "x"; } };
o[key] += 10;          // n === 2 (WRONG, want 1); o.x also wrong (null)
o[key]++;              // key.toString never fires / value broken
```

- `obj[stringLiteralOrVar] += rhs` → **works** (string key needs no re-coercion).
- `arr[i] += rhs`, `arr[i]++` (array/vec index) → **works** (probe confirmed).
- `obj[computedNonStringKey] += rhs` / `obj[…]++` → **broken**: double
  ToPropertyKey + wrong value. This is the ~100-fail cluster (ES3/ES5/ES6
  property-eval-order tests).

## Root cause

`compileElementCompoundAssignment` (`src/codegen/expressions/assignment.ts`,
externref arm) compiles the key to externref ONCE and stores it in `keyLocal`,
then passes that SAME raw key externref to BOTH `__extern_get(obj, key)` AND
`__extern_set(obj, key, val)`. In **host mode the JS `__extern_*` imports run
ToPropertyKey *internally*** (`_toPropertyKey`, runtime.ts:2667, invoked at
runtime.ts:8319/8423) — so a non-string key object is coerced **twice**, once
per host call, firing `toString` twice. (Standalone mode coerces inside
`__to_property_key` per public entry — same double-coercion shape.) The element
inc/dec path (`unary-updates.ts`) has the same structure.

The READ-only and WRITE-only single accesses are correct (one host call → one
coercion); only the **read-modify-write** double-accesses the key.

## Fix

Apply **ToPropertyKey ONCE in codegen** before the read-modify-write: coerce the
key to a primitive property key, store the coerced result, and pass THAT to both
the get and the set. A coerced primitive (string, or a preserved Symbol) is
idempotent under the host's internal ToPropertyKey (ToPropertyKey of a string is
the string; of a Symbol is the Symbol) → no second `toString`.

- **Host import `__to_property_key(externref) -> externref`** wrapping the
  existing `_toPropertyKey` (runtime.ts:2667, full §7.1.19 incl. Symbol
  preservation). Register it like the other `__extern_*` imports (callbackState
  closure). Standalone already has the native `__to_property_key`
  (`object-runtime.ts:433`) — reuse it on that path.
- In `compileElementCompoundAssignment` (externref arm) and the element inc/dec
  paths (`unary-updates.ts`): after compiling the key to externref, `call
  __to_property_key`, store the coerced key in `keyLocal`, then use `keyLocal`
  for both `__extern_get` and `__extern_set`. Base is already compiled-once into
  `objLocal` before the key (base-before-prop preserved); RHS is compiled after
  the current-value read (left-before-right preserved).

## Acceptance

- `o[{toString}] += rhs` and `o[{toString}]++` fire ToPropertyKey **once**
  (`n === 1`) and produce the correct value.
- `arr[i] += / ++` and `obj[strKey] += / ++` unchanged (regression-safe).
- base-before-prop-before-rhs order preserved (probe: `B()[P()] += R()` → "BPR").
- Full merge_group / test262: the ES3/ES5/ES6 property-eval-order cluster flips
  toward pass; zero regression elsewhere (shared assignment path).

## Resolution (2026-06-25, dev-2046)

**COMPOUND ASSIGNMENT done; inc/dec carved as a follow-up.**

- **`__to_property_key(externref) -> externref` host import** (`src/runtime.ts`)
  wrapping `_toPropertyKey` (§7.1.19, Symbol-preserving). Standalone reuses the
  existing native `__to_property_key` (`object-runtime.ts`).
- **`compileElementCompoundAssignment`** (`src/codegen/expressions/assignment.ts`,
  both externref arms): new `emitToPropertyKeyOnce(ctx, fctx)` coerces the key
  ONCE right after it is compiled to externref; the stored `keyLocal` (now a
  primitive string / preserved Symbol) is reused by both `__extern_get` and
  `__extern_set`. A primitive is idempotent under the host's internal
  ToPropertyKey, so `toString` no longer fires twice.
- **Verified:** `o[{toString}] += 10` → ToPropertyKey once (`n === 1`), value
  correct (11); base-before-prop-before-rhs preserved (`B()[K()] += R()` →
  "BKR"); string-literal / string-var / array-index keys unchanged.
  `tests/issue-2666.test.ts` 7/7.

**`++`/`--` on a computed object key — FOLLOW-UP (not in this PR).** The element
inc/dec path (`unary-updates.ts`) for `o[keyExpr]++`/`--` is entangled with the
**#2659-family struct-slot-vs-sidecar asymmetry**: routing it through the host
`__extern_get`/`__extern_set` (the only place ToPropertyKey-once would apply)
writes the sidecar while `o.x` reads the typed-struct slot, so the value isn't
observable — AND the `obj[strKey]++` / `obj["x"]++` (`o:any`) cases are **already
broken on `main`** independent of ToPropertyKey (verified: return the old value,
no update). So inc/dec needs the struct-slot-aware write first; carved as a
follow-up rather than shipping a half-correct arm. The compound-assignment
cluster (the bulk of the ES3/ES5/ES6 eval-order fails) is fixed here.

**Broad-impact (shared element-compound-assign path) — validate via the full
merge_group floor.**

## Notes

- Array/vec index access already evaluates the index once (it lowers to a direct
  struct/vec read+write, no host re-coercion) — the fix is scoped to the
  externref/object key path.
- `+=`/`-=`/`*=` etc. and `++`/`--` all route through the same key-coercion fix.
- Logical-assign (`&&=`/`||=`/`??=`) element paths
  (`compileElementLogicalAssignmentExternref`) have the same shape — fold in if
  the corpus needs it (verify; may be a follow-up).
