---
id: 2128
title: "object-literal setter not invoked on property assignment — the write silently no-ops"
status: done
sprint: 61
created: 2026-06-12
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [1239, 2017]
renumbered_from: "residual of #1239 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2128 — assignment to an object-literal `set` accessor does not call the setter

## Problem

A `set` accessor defined inline on an object literal is not invoked when the
property is assigned; the write silently does nothing.

```ts
let captured = 0;
const o: any = { set v(x: number) { captured = x; } };
o.v = 9;
captured                  // wasm: 0    node: 9
```

## Scope / relationship to neighbours

- **Getter/setter pair on a module-level const with compound assign**
  (`o.x += 3`) now works — verified FIXED on main (`#1971` item 3b), so this
  issue is narrowed to the **setter-invocation-on-write** path.
- The **getter-only** write case (`o.x = 99` where `x` has only a getter)
  trapping `illegal cast` instead of a strict-mode TypeError is already
  tracked by **#2017** — distinct from this issue (here the setter *exists*
  and just isn't called).

## Root cause (pointer)

The assignment-codegen path for `o.prop = v` treats `prop` as a plain struct
field write and does not consult the accessor registry for an inline-literal
`set` accessor (`classAccessorSet`). It needs the same setter-dispatch that
class instance setters use. See member-assignment lowering in
`src/codegen/expressions.ts` / `src/codegen/statements.ts` and accessor
registration in `src/codegen/object-ops.ts`.

## Acceptance criteria

- `let c=0; const o:any={set v(x){c=x}}; o.v=9; c` → `9`
- Getter+setter pair: `set` fires on write, `get` fires on read
- No regression on plain data-property writes
- An equivalence test under `tests/`

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` (branch `po-1971-triage`).
JS-host mode, default options.

## Resolution (2026-06-12)

The "setter not invoked" symptom decomposed into THREE sub-bugs:

1. **Init-time bridge no-op** (`src/runtime.ts`): top-level statements run in
   the wasm START function, before `setExports` wires the instance — the
   accessor `__cb_<id>` host bridge's `getExports()` was undefined and the
   optional chain silently returned undefined. Setter dispatches (args
   present) are now PARKED via the existing #1712 `deferToExports` mechanism
   and replayed at wiring. (Getters need their value synchronously and keep
   the pre-wiring undefined behaviour.)
2. **Writeback gap on property reads/writes** (`src/codegen/expressions.ts`):
   persistent ref-cell writebacks were re-emitted only after
   `ts.CallExpression`s — but `o.v = x` / `o.v` lower to internal
   `__extern_set`/`__extern_get` calls, so a setter/getter's captured-local
   mutations were never synced back. Writebacks now also re-emit after
   assignments with property/element LHS and after property/element reads.
   Identifier-LHS assignments are deliberately excluded (re-syncing after a
   direct local write would clobber it). Writebacks themselves are now
   null-guarded (`src/codegen/closures.ts`) since the cell local may be
   unset when the creation site sits in an untaken branch.
3. **Per-callback cell snapshots** (`src/codegen/closures.ts` +
   `src/codegen/literals.ts`): a get/set pair capturing the same
   function-local each created its OWN ref cell (and a read-only getter
   captured by VALUE), so the getter never saw the setter's writes. The
   object-literal accessor path now pre-scans all accessor bodies
   (`collectMutatedCaptureNames`), forces mutable capture for locals any
   sibling writes (`forceMutableCaptures`), and shares ONE cell per local
   across the literal's accessors (`sharedRefCells`, scoped per literal so
   loop-iteration `let` semantics keep fresh cells).

Also fixed `tests/accessor-side-effects.test.ts`'s stale harness (bare
`{env:{}}`, no `setExports` wiring) — 0/16 → 13/16.

## Test Results

- `tests/issue-2128.test.ts` — 7/7: top-level repro (→ 9), function-local
  setter capture, get/set pair sharing (→ 11), getter side effect on read,
  module-backing pair, data writes unregressed, forEach mutable-capture
  callbacks unregressed.
- `tests/accessor-side-effects.test.ts`: 13/16 (was 0/16 on main). The 3
  remaining failures are MODULE-LEVEL object literals with accessors — a
  distinct pre-existing divergence (the module-global initializer pipeline
  registers a struct shape, emits `__sget_v`/`__sset_v`, and reads route
  via the struct path instead of the host accessor object). Needs its own
  issue.
- Closure/callback suites (issue-859, issue-929, issue-1695×2, issue-1712,
  array-callback-three-params, flatmap-closure, illegal-cast-closures-585,
  issue-329, optional-direct-closure-call, issue-1896, issue-1718):
  59 passed, 8 failed — the 8 are identical on main (pre-existing).

## Residuals (verified identical on main, out of scope)

- Module-level accessor literals (struct-shape divergence above) — 3
  remaining accessor-side-effects failures + "getter reads module-level
  variable" → NaN.
- `const o: any = { v: 1 }; o.v = 9; o.v` → 1 (stale): any-typed DATA
  literal writes go to the sidecar while reads hit the struct field —
  #2130 presence-predicate territory.
