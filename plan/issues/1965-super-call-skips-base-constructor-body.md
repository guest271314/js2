---
id: 1965
title: "derived-class construction never executes the base constructor body; super(args) writes args positionally into parent struct fields"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: classes
goal: class-system
related: [1551, 1833, 1366]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main"
---

# #1965 — `super(args)` is a positional field copy, not a constructor call

## Problem

Constructing a derived class never runs the base constructor's **body**:
`super(5)` maps arguments positionally onto parent struct fields with
`struct.set`. Any parent ctor logic beyond `this.f = <param>` assignments —
computation, side effects, conditionals, method calls — is silently dropped.
Core OO semantics, silent wrong results.

## Repro (verified on main)

```ts
export function test(): string {
  class A { x: number; constructor(x: number){ this.x = x*2; } }
  class B extends A { constructor(){ super(5); } }
  return String(new B().x);
}
```

| case | wasm | node |
|------|------|------|
| above | `5` | `10` |
| log probe (`A` ctor appends `"Ac;"`, `B` appends `"Bc;"`) | `Bc;` | `Ac;Bc;` |
| implicit ctor (`class B extends A {}`) | `` | `Ac;` |
| base ctor calls overridable method | `` | `B` |

Passes only by accident when the parent ctor consists solely of
`this.f = <expr>` assignments (mined as pseudo-field-initializers).

## Root cause

- `src/codegen/class-bodies.ts:1992` (`compileSuperCall`) — for a user-class
  parent it re-runs ancestor *field initializers* (~2090-2110) then maps
  `super(...)` arguments **positionally onto `assignableParentFields`** with
  `struct.set` (~2105-2200). The parent constructor's parameter binding and
  body statements are never compiled/invoked.
- `src/codegen/class-bodies.ts:1256-1320` (implicit-ctor path) — replays only
  field initializers plus top-level `this.<name> = <expr>` ExpressionStatements
  from the ancestor ctor body; everything else silently dropped.

## Fix direction

Compile each class constructor as a real callable (init function taking
`(self, ...ctorParams)`); `super(args)` evaluates args and `call`s the
parent's init function. The implicit path forwards args to the same parent
init. Architect-level change to class lowering; coordinate with #1551 (super
arg evaluation order, in-progress) and #1833 (builtin-parent forwarder,
in-review).

## Acceptance criteria

- All four repro cases match Node
- 3-level hierarchies: each ctor body runs exactly once, base-first
- Field-initializer-vs-ctor-body ordering per spec (base fields → base ctor
  body → derived fields → derived ctor body)
- Builtin-parent (`extends Error` etc.) path unregressed

## Dupe check

#1551 (in-progress) = super *argument evaluation order* only; #1833
(in-review) = builtin-parent forwarder arg truncation; #1366 (done) documents
the positional mechanism for builtin parents. The user-base-ctor-body gap is
unfiled.

---

## Implementation notes (2026-06-12, senior-fable)

**Design: split allocation from initialization.** For every WasmGC-struct
user class, the collection phase now registers a second function
`${Class}_init(...ctorParams, self: ref $Class) -> (ref $Class)` alongside
`${Class}_new`. The init carries everything that used to live in `_new`'s
body — parameter defaults, own field initializers, and the full constructor
body — operating on a caller-allocated instance bound as `this`. `_new`
reduces to `struct.new` (defaults + class tag) + `return_call _init`.
`super(args)` in a derived ctor (and the implicit-ctor forward) is a real
`call ${Parent}_init(args..., self)` — direct WasmGC subsumption, since
class structs already declare `superTypeIdx`.

Why the pieces fall out:

- **Repro 4 (virtual dispatch from base ctor) needed no dispatch work**: the
  derived-most `_new` allocates with the DERIVED `__tag`, so when the base
  ctor body runs `this.m()` through the existing #1299 tag-cascade, it
  dispatches to the override.
- **Self is the LAST init param** so ctor param indices are identical in
  `_new` and `_init` — the param-index-based defaults/`__argc` machinery
  (`emitClassParamDefaultCheck`, `cacheParamDefaultArgc`) works unchanged.
  `__argc` set by the `new` call site flows untouched through `_new` into
  `_init`; explicit `super(k)` sites set it via `maybeSetArgcForKnownCall`
  against the init name (optional/rest metadata is mirrored from
  `${Class}_new` to `${Class}_init` at registration).
- **Implicit derived ctors forward params 1:1** (they were already cloned
  from the nearest explicit ancestor ctor — #2082) and skip their own
  default emission: the parent's init applies defaults, so default
  expressions with side effects run exactly once.
- **`_init` returns the instance** (not void) so the entire existing
  ctor-return logic (#2018 bare-return-this, return-override for base
  ctors, derived return-primitive TypeError) applies verbatim to the moved
  body. `super()` drops the parent init's result — parent return-override
  through super() remains unsupported (it was equally unsupported by the
  positional copy).
- **Deleted machinery**: the ancestor field-initializer/`this.x=...` AST
  replay in both `compileSuperCall` (#2078) and the implicit-ctor path, and
  the positional args→parent-fields copy (incl. its spread variant). The
  real call subsumes all of it. A defensive legacy replay remains only for
  the cannot-happen case of a user parent without a registered `_init`.
- **Externref-backed classes (`extends Error` etc.) are untouched** — they
  keep the single-function host-forwarder shape (#1366a/#1833).

Super arg handling per §13.3.7.1 (#1551 parity): args evaluate
left-to-right with parent param types; extras evaluate and drop; missing
args pad with sentinel defaults + argc; rest-param parents get the standard
vec packing; statically-known spreads flatten; runtime spreads evaluate for
side effects and call with argc 0 (pre-existing limitation).

**Validation**: 4/4 issue repros fixed; `tests/issue-1965-super-ctor-body.test.ts`
(13 cases: 3-level interleaving, defaults through both super forms, rest /
static spread / extra args, derived overwrite ordering, base-throw
propagation, #2018 bare return). 25+ class/inheritance/equivalence test
files diffed against main: identical pass/fail sets (the failures are the
pre-existing minimal-ENV/`string_constants` local breakage). IR fallback
gate unchanged; biome clean.
