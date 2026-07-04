---
id: 2845
title: "Assignment-expression destructuring default initializers don't fire on absent element/property (`[a=d]=src`, `{k:x=d}=src`)"
status: done
assignee: ttraenkler/dstr4
created: 2026-06-29
updated: 2026-07-03
completed: 2026-06-29
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
parent: 2669
related: [2669, 2758, 2808, 2811, 2769]
sprint: 69
---

# #2845 — assignment-expression destructuring default-init firing

Carved from the #2669 destructuring umbrella (dstr4, 2026-06-29). The largest
clean single-root-cause cluster in `language/expressions/assignment/dstr/` that
is NOT iterator-protocol (#1642), generator-over-consumption (#2566), or
rest-element (restobj's lane).

## Problem

Assignment-EXPRESSION destructuring (`[a = d] = src`, `{ k: x = d } = src` —
where the LHS is an assignment target, not a `let`/`const` binding) failed to
fire the default Initializer when the source element/property was **absent**.
Per ECMA-262 §13.15.5.5 (AssignmentElement / IteratorDestructuringAssignment)
and §13.15.5.3 (ObjectAssignmentPattern), the default fires **iff** the read
value is `undefined` — which for an array means out-of-bounds, and for an object
means a missing-or-`undefined` property. The binding-pattern path (`let [...] =`)
already does this correctly; the **assignment** path (added piecemeal) did not.

```js
// all WRONG before the fix:
var a, b; [a = 1, b = 2] = [];            // a,b => NaN     (want 1, 2)
var a, x=0; [a = (x += 1)] = [];          // a=NaN, x=0     (want a=1, x=1)
var x; ({ y: x = 1 } = { y: undefined }); // x => undefined (want 1)
var x; ({ y: x = 1 } = {});               // x untouched    (want 1)
```

## Root cause — three sibling defects, one conceptual bug

All in `src/codegen/expressions/assignment.ts`. Each is a place where "fire the
default iff the value is `undefined`" was mis-implemented:

**A. Array, numeric element (`compileArrayDestructuringAssignment`).** The
default branch only handled `ref`/`externref` element types; for `f64`/`i32`
elements it fell into an `else` that **dropped the default entirely** and just
`local.set` the read value. And the read itself (`emitBoundsCheckedArrayGet`)
returns a *value sentinel* on OOB (NaN/0 for numerics; `ref.null` =
JS `null`, not `undefined`, for externref), so OOB never looked like
`undefined`. Net: numeric defaults vanished, and externref OOB read `null` so the
undefined-check missed it.

**B. Object `{ k: x = d }` typed-struct property target.** Two bugs: (1) used
`ref.is_null` instead of `__extern_is_undefined`, so an `undefined`-valued
externref field (`{ y: undefined }`) did not fire the default (and a `null`
field wrongly *would* have, had the value differed); (2) a **missing field**
(`fieldIdx === -1`) was `reportSilentFallback` + `continue`, so the default
never ran for `{ y: x = 1 } = {…no y…}`. The shorthand path (`{ x = d }`) already
did both correctly — the property path was simply never brought to parity.

**C. Object no-struct (externref RHS) path.** The `{} = vals` fallback loop
(`__extern_get(rhs, key)` per property) skipped every non-shorthand prop
(`if (!isShorthandPropertyAssignment) continue`), so `{ y: x = 1 } = {}` (empty
object ⇒ externref RHS, property form) dropped the binding.

## Fix

`src/codegen/expressions/assignment.ts` (172 +/72 −, single file):

- **A.** Rewrote the array identifier-target default branch to compute an
  explicit `absent` flag: for a vec, `i < length` gates an in-bounds read
  (so a non-null `ref` element never traps on an OOB `ref.as_non_null`); for a
  tuple it's compile-time. In bounds, externref reads map array holes →
  `undefined` (`emitHoleToUndefined`) and set `absent` from
  `__extern_is_undefined`; `ref` uses `ref.is_null`; numerics set `absent = 0`.
  Default fires iff `absent`, uniformly across numeric/externref/ref elements.
- **B.** Object property path: hoist the target/default extraction above the
  field lookup; on `fieldIdx === -1` with an identifier target + default, fire
  the default (mirror of the shorthand arm). For a present externref field, use
  `__extern_is_undefined` (not `ref.is_null`); keep `ref.is_null` for plain
  wasm `ref`/`ref_null` (no JS-undefined sentinel there).
- **C.** No-struct loop now derives `(keyName, targetName, propDefault)` for
  both shorthand and `{ k: x = d }` property forms and runs the existing
  `__extern_get` + `__extern_is_undefined` default logic for both.

### Why it needed care (downstream effects considered)

- **OOB trap avoidance:** a non-null `ref` element vec read past `length` would
  trap on `ref.as_non_null` inside `emitBoundsCheckedArrayGet`. The fix only
  emits the element read inside the in-bounds arm, so the OOB path never touches
  it.
- **Stack balance / late-import shifts:** the `__extern_is_undefined` ensure +
  `flushLateImportShifts` is sequenced before the branch-instruction arrays are
  detached via the saved-body swap, matching the existing shorthand pattern, so
  funcIdx shifts land in the authoritative body.
- **null vs undefined:** kept strictly distinct — `{ y: x = 1 } = { y: null }`
  must leave `x = null` (default does NOT fire); regression-controlled.
- **Heterogeneous elements (#2769 trap):** correctness is keyed on TS-type /
  spec semantics (absent ⇒ default), not Wasm kind. Verified with
  `[v=10, vN=11, vH=12, vU=13, vO=14] = [2, null, , undefined]` on an explicit
  `any[]` source → `2, null, 12, 13, 14` (present / null-kept / hole→default /
  undefined→default / OOB→default).

## Out of scope (residual, separate root causes)

- `array-elem-init-assignment.js` (untyped `[2, null, , undefined]`): the
  *untyped* array infers a numeric-lowered element type, so `null` reads back as
  `0` and `=== null` fails. This is a value-representation issue (#2769 family),
  NOT default-firing — fails identically before the fix.
- `*-simple-no-strict` (`arguments` / sloppy-mode), `*-init-let` (let TDZ
  ReferenceError), `*-put-obj-literal-prop-ref-init*` (member-expression target
  with a setter + default) — distinct clusters, deliberately untouched.

## Result

`language/expressions/assignment/dstr/` (368 files): **137 → 128 fail (+9 pass,
0 regressions)**. Newly passing: `array-elem-init-evaluation`,
`array-elem-init-order`, `array-elem-init-yield-ident-valid`,
`obj-prop-elem-init-assignment-{missing,null,undef}`,
`obj-prop-elem-init-evaluation`, `obj-prop-elem-init-in`,
`obj-prop-elem-init-yield-ident-valid`.

Guard test: `tests/issue-2845.test.ts` (13/13). Pre-existing `issue-43`
assignment-dstr-default suite stays green; `tsc` clean; 0 regressions across the
full assignment/dstr scan.
