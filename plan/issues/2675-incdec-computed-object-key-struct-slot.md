---
id: 2675
title: "++/-- on a computed object key (obj[keyExpr]++) is broken: NaN/no-update + double ToPropertyKey — #2659-family struct-slot vs sidecar"
status: done
completed: 2026-06-26
assignee: ttraenkler/dev-conformance
created: 2026-06-25
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: increment-decrement, member-access, evaluation-order
goal: spec-completeness
sprint: 66
related: [2666, 2659, 2674]
---

# #2675 — `obj[keyExpr]++` / `--obj[keyExpr]` on an object is broken

Carved from #2666. #2666 fixed the **compound-assignment** half
(`obj[key] op= rhs` ToPropertyKey-once); the **prefix/postfix `++`/`--`** half on
a computed/dynamic **object** key is a DISTINCT, partly **pre-existing** bug and
is tracked here.

## Problem

For `obj[keyExpr]++` / `++obj[keyExpr]` (and `--`) where `obj` is an object
(typed struct or `any`/externref) and the key is computed (variable / call /
side-effecting `{toString}`):

- the value is **not updated** (returns the old value; `obj.x` unchanged), and
- a side-effecting key's `toString` is mis-counted (eval-order, §13.4 / §7.1.19).

Verified on `main` (independent of #2666's ToPropertyKey fix):

```ts
var o:any = { x: 5 }; var k = "x"; o[k]++;        return o.x; // 5 (WRONG, want 6)
var o:any = { x: 5 };               o["x"]++;      return o.x; // 5 (WRONG, want 6)
var o:any = { x: 5 }; var key = { toString(){ return "x"; } }; o[key]++; return o.x; // wrong
```

(Array/vec index `arr[i]++` works; member `o.prop++` on a typed class works. The
gap is the **object element** `obj[key]++` path.)

## Root cause

The element inc/dec lowering (`src/codegen/expressions/unary-updates.ts`,
`compileMemberIncDec` element arm + `compilePrefix/PostfixIncrementElement`):

- the **literal-key** struct arm resolves a static field (works);
- a **computed key** on a struct falls through to a **NaN fallback** (no field);
- an **`any`/externref** base hits the "incrementing a dynamic property → NaN"
  arm (only evaluates the key for side-effects, then NaN).

Routing it through the host `__extern_get`/`__extern_set` (the only place
ToPropertyKey-once applies) writes the **sidecar** while `obj.x` reads the typed
**struct slot** — the **#2659-family struct-slot-vs-sidecar asymmetry**. So a
naive externref-routed inc/dec returns the right delta but the write isn't
observable through the slot-reading `obj.x`.

## Fix direction

This is gated on a **struct-slot-aware** element write for an externref/any
receiver — the same symmetric `struct.set` dispatch #2659 added for member
writes (`emitAlternateStructSetDispatch`), applied to the element inc/dec write.
Once the #2659 read/write asymmetry is fully resolved (connects to the acorn
#2674 read-side `__current_this`/ref.test work), the inc/dec arm can:

1. base → externref receiver (once), key → externref + `__to_property_key` ONCE
   (reuse #2666's `emitToPropertyKeyOnce`);
2. read current via the struct-slot-aware get, unbox → f64, ±1;
3. write back via the struct-slot-aware set (NOT plain `__extern_set` → sidecar);
4. prefix → new, postfix → old.

## Acceptance

- `obj[strKey]++`, `obj["x"]++`, `obj[{toString}]++` update the value and read
  back correctly; ToPropertyKey fires once for a side-effecting key.
- `arr[i]++` and `o.prop++` unchanged (regression-safe).
- The `prefix/postfix-(in|de)crement/*_A6_T2.js` test262 cluster (the inc/dec
  half of #2666's acceptance) flips toward pass.

## Notes

- #2666 reuses `emitToPropertyKeyOnce` (`assignment.ts`) — re-export it (it is
  currently file-private) when implementing here.
- Depends on / overlaps #2659 (member write struct.set dispatch) and #2674
  (acorn read-side struct dispatch).


## Resolution (2026-06-26)

Fixed in `src/codegen/expressions/unary-updates.ts`: the externref (any-typed)
element arm of `compileMemberIncDec` no longer NaN-drops the write. New helper
`emitExternrefElementIncDec` does a real read-modify-write mirroring the working
compound path `o[k] += 1` (`compileElementCompoundAssignment`): `__extern_get` →
`__unbox_number` → f64, ±1, `__box_number`, write-back via the #2659 symmetric
`struct.set` dispatch for a STATIC string-literal key (slot-consistent, with
`__extern_set` terminal fallback) or `__extern_set` for a DYNAMIC key. The key's
ToPropertyKey fires ONCE (§7.1.19) via the now-exported `emitToPropertyKeyOnce`
(re-exported from `assignment.ts`), and §13.4 prefix(new)/postfix(old) return
semantics are honoured. The wasm-null base RequireObjectCoercible TypeError is
preserved (shift-safe, #1720).

Guarded by `tests/issue-2675.test.ts` (15 cases): variable/literal/`{toString}`
keys update the slot, postfix returns old + prefix returns new, decrement,
ToPropertyKey-once, ToNumber coercion, nested `o[a][b]++`, and regression guards
for `o[k] += 1` / `arr[i]++` / `o.prop++`.
