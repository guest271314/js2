---
id: 3144
title: "IR: instanceof + static method calls + accessor get/set on local classes (claims classes.ts main)"
status: done
assignee: ttraenkler/fable-irfb
completed: 2026-07-11
sprint: 71
created: 2026-07-11
updated: 2026-07-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: classes
goal: ir-full-coverage
parent: 2856
related: [2855, 3000, 2857, 3143]
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/lower.ts
  - src/codegen/index.ts
  - src/ir/nodes.ts
  - src/ir/builder.ts
  - src/ir/select.ts
  - src/ir/integration.ts
---

# #3144 — IR: `instanceof` + static calls + accessors on local classes

Child slice of #2856 (`body-shape-rejected` → 0). Claims the last
`js/classes.ts` rejector (`main`), ratcheting the unintended
`body-shape-rejected` bucket **15 → 14**.

## Ground-check (2026-07-11, main @ 0957fcdd41)

`JS2WASM_IR_SHAPE_DIAG=1 check-ir-fallbacks --shape-diag` attributed
`js/classes.ts main` to `expr-binary-op-instanceof`. A selector probe showed
the first-wins recorder was masking THREE further blockers behind it — the
full claim chain for `main` was:

1. `rex instanceof Dog` / `rex instanceof Animal` — `instanceof` table-deferred.
2. `Animal.kingdom()` / `Dog.kingdom()` — static method calls (bare class
   identifier receiver rejected; `buildIrClassShapes` skipped statics).
3. `rex.name` / `rex.age` / `rex.breed` reads + `rex.name = "Rex Jr."` write —
   accessor-backed properties (shape carried FIELDS only; build demoted at
   `class Dog has no field "name"`).
4. `cond ? "true" : "false"` — `lowerConditional` required scalar `val` arms
   (string arms threw "ternary branches have different types (string vs
   string)").

## What landed (one PR — the four sub-capabilities are all on `main`'s claim path)

- **`class.instanceof` IR instr** — `value instanceof C` for a LOCAL class C
  (identifier RHS, unshadowed; mirrored selector arm + `lowerInstanceOf`).
  Lowering reads the receiver struct's hidden `__tag` (slot 0) and compares
  against the TARGET class's tag + transitive-descendant tags
  (`IrClassLowering.instanceOfTags`, the same walk as legacy
  `collectInstanceOfTags`) — byte-shape parity with legacy
  `compileInstanceOf`'s non-null-ref path (multi-tag via a lazy
  `$instanceof_tag_scratch` i32 local). Never-class LHS representations
  (f64/i32 scalars, string, object structs, closures) fold to constant
  false; dynamic/extern/union/boxed LHS demotes cleanly (claim-partial, like
  `new C(...)`). The IR class carrier is non-null, so no null arm exists.
- **`class.static_call` IR instr** — `C.m(args)`: legacy statics take NO
  `self` param (`class-bodies.ts`), so lowering emits args +
  `call $<C>_<m>` via the collision-relocated `methodFuncName` key.
  Statics are projected into `IrClassShape.methods` with
  `memberKind: "static"` (best-effort — an unprojectable static is skipped,
  never rejecting the class). A same-name instance member wins (legacy
  registers ONE key for both — the ambiguous call demotes).
- **Accessor get/set through instances** — `IrClassShape.methods` now also
  carries `memberKind: "getter"/"setter"` projections (property name;
  getter `[] -> T`, setter `[T] -> null`). `recv.prop` falls back from the
  field lookup to the getter descriptor → `class.call recv get_<prop>`;
  `recv.prop = v` → `class.call recv set_<prop>(v)` (void, statement
  position). Resolution keys off the RECEIVER's className — sound for
  inherited accessors because legacy's inherited-member key propagation
  registers `Dog_get_name` → Animal's funcIdx (`collectClassDeclaration`).
  All member lookups (`findClassMember`) filter on `memberKind` (default
  "method"), so accessor/static descriptors never leak into instance
  `class.call` resolution; instance-method lookup now also walks
  `shape.parent` (inherited non-overridden methods resolve).
- **Same-type non-scalar ternary arms** — `lowerConditional` accepts arms
  whose IrTypes are equal but non-`val` (string/class/extern/object): the
  `if` lowering already derives the result carrier via
  `lowerIrTypeToValType`. Mismatched arms still demote.

## Verification

- **Runtime parity**: `js/classes.ts` IR-vs-legacy console output identical
  (9/9 lines — getters, setter write, virtual dispatch via override, BOTH
  instanceof lines, both static kingdom() calls); bytes differ (claim proven
  non-vacuous); post-claim demotions ZERO.
- **Gate**: `body-shape-rejected 15 → 14`; all other buckets unchanged;
  post-claim table empty. Banked via `--update-on-decrease`.
- `tests/issue-3144-ir-class-claims.test.ts` (new): per-capability
  legacy/IR parity incl. subclass/parent/unrelated instanceof, runtime
  tag check through an `Animal`-typed binding holding a `Dog`, primitive
  fold-false, static inherited/overridden dispatch, accessor read/write,
  string-arm ternary, shadowed-class-name negative (demote), and byte-diff
  claim proofs.
- `tests/ir-scaffold.test.ts` failure count identical to pristine main
  (2 pre-existing container-env failures, verified side-by-side);
  algorithms-cluster 18/18; ternary + vec-push suites green.

## Remaining in the #2856 bucket after this slice (14)

benchmark-harness 8 `main`s + `addBenchCard` (first-class function values +
arrow-closure args — the Step-2 multi-capability program), calendar 4
(module-scope MUTABLE bindings + DOM chains + if-shapes), async `delay`
(Promise executor). Epic #2856 stays `blocked` on those.
