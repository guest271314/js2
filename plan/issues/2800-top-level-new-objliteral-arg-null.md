---
id: 2800
title: "[SENIOR-DEV ONLY] top-level `new X(objLiteral)` reads the literal arg's fields as null at module-init (type-index remap)"
status: done
assignee: ttraenkler/senior-developer
sprint: 69
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
task_type: bugfix
area: codegen
language_feature: object-literals
goal: acorn-dogfood
related: [2794, 2686, 2784]
depends_on: []
blocks: [2686]
---

# #2800 — top-level `new X(objLiteral)` reads the literal arg's fields as null at module-init

**General core-codegen bug, carved out of #2794 (3).** It is NOT acorn-specific
marshaling — it is a general defect in how a constructor invoked at **module-init
(top-level) time** receives an **object-literal argument**: the constructor body
reads the literal's fields as `undefined`/`null`, even though the identical
constructor called at runtime reads them correctly. Fixing this unblocks #2686
(compiled-acorn binary expressions) and helps any program that builds typed
objects via constructors at module scope.

## Minimal repro (the failure)

```js
function VI(label, conf) {
  this.label = label;
  this.zz = conf.zz || null;
}
var x = new VI("a", { zz: 9 });          // MODULE TOP-LEVEL → x.zz === null   ✗ BUG
function mk() { return new VI("b", { zz: 9 }); }
//  mk().zz === 9                          // RUNTIME (inside a fn) → correct    ✓
```

In acorn this is the root cause of every binary expression throwing: acorn builds
its whole `types$1` TokenType table at module-init
(`plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, … })`), so every
`TokenType`'s `conf`-derived fields (`binop`, `beforeExpr`, `prefix`,
`startsExpr`, …) are stored as `null`/`false`. `parseExprOp`
(`acorn.mjs:2776`) then reads `prec = this.type.binop === undefined` → `prec ==
null` → the operator is never consumed → `unexpected()` → `Unexpected token (1:1)`.

## Confirmed evidence (all empirical; probes banked under the #2794 branch `.tmp/`)

- `plusMin.binop` reads `null` **WASM-INTERNALLY** (`types$1.plusMin.binop` as a
  runtime function read), not merely via the host proxy — so the struct slot
  genuinely holds null. (NOT a host-proxy / `__sget` issue — both faithfully
  return the stored null.)
- The value was never stored: `this.binop = conf.binop || null` read
  `conf.binop === void 0` at construction. Proof: stashing
  `(conf.binop === void 0) ? -2 : (conf.binop || -1)` into a spare field reads
  back **-2**.
- In-acorn bisection (`.tmp/variants{,2,3}.mjs`):
  - `new VI(...)` at top-level → `null`; SAME ctor at runtime → `9`.
  - plain (non-`new`) function `f({zz:9})` reading `conf.zz` → `9`.
  - the literal read at its own call site (`litG.zz`) → `9`.
  - inside an object-literal initializer (`var t = { k: new VI("b",{zz:9}) }`,
    the exact `types$1` shape) → `null`.
- A **unique** field name (`zzPrecedence`) fails identically → NOT a field-name
  collision.
- **Scale-dependent**: a *standalone* module with the same pattern — even with
  acorn's full token table, the `binop()`/`kw()` helpers, ~33 init-time
  `new TokenType` calls, AND ~10 extra distinct object-literal struct shapes —
  reads `binop=9` correctly (`.tmp/scale-repro.ts`, `.tmp/objlit-repro.ts`). The
  bug manifests ONLY inside the full acorn module.

## Hypothesis (type-index remap / DCE divergence)

The same object literal `{zz:9}` is given DIFFERENT struct types depending on
context: at init the `struct.new` emits type `T_init`; the constructor's
`conf.<field>` read was compiled as `struct.get` against the type `T_ctor` it
casts the param to. If `T_init ≠ T_ctor` (because DCE / same-shape dedup remapped
one but not the other in the giant top-level init function), then inside the ctor
the `ref.test`/`ref.cast` to `T_ctor` fails → the param is treated as the wrong
type → the field read yields the default (`null`). At runtime the literal gets
`T_ctor` (matches) so it works. cf. memory
`project_type_index_shift_and_deadelim` ("DCE remaps types; register shared types
late+once") and `reference_subview_type_idx_stability`.

**Suggested first step:** dump the type index of the init-time literal's
`struct.new` vs the type the ctor's `conf.<field>` `struct.get`/`ref.cast` uses,
in the full acorn module (codegen-side instrumentation, or WAT diff). Confirm the
divergence, then trace where init-context object-literal type assignment diverges
from the constructor param's expected type.

## Ruled OUT (do not re-investigate)

- host proxy / `_wrapForHost` (wasm-internal read is also null);
- `__sget_<field>` per-shape dispatcher (`_emitStructFieldGettersInner`,
  `src/codegen/index.ts:2240`) — the slot genuinely holds null, `__sget`
  faithfully returns it;
- `emitNullGuardedStructGet` / `findAlternateStructsForField`
  (`src/codegen/property-access.ts`) — `conf.<field>` never routes through it
  (0 instrumentation hits);
- `__extern_get` — never called for the field, even at init;
- field-name collision (a unique field name fails identically);
- the empty `{}` void-0 default (giving it a field-bearing shape doesn't help);
- prototype-method / fnctor-ness (fails with and without a prototype method);
- simple object-literal struct-table scale (10+ extra shapes standalone still
  works).

## Acceptance

- The minimal repro above: `x.zz === 9` for a top-level
  `new VI("a", { zz: 9 })`.
- Compiled-acorn `parse("1 + 2 * 3;")` → an `ExpressionStatement` whose
  `expression` is a `BinaryExpression` with correct precedence (`1 + (2 * 3)`),
  no throw — unblocking #2686.
- A regression test pinning the top-level-`new`-with-object-literal-arg case.
- Full `merge_group` + standalone-floor (broad-impact codegen).

## Probes (banked under the #2794 branch `.tmp/`)

`variants{,2,3}.mjs` (init-vs-runtime bisection), `binop-ctor.mjs` (the `-2`
void-0 proof), `tt2.mjs`/`tt3.mjs` (in-acorn clone, unique-field variant),
`scale-repro.ts` + `objlit-repro.ts` (standalone scale controls),
`acorn-run.mjs` (watchdog parse driver).

## Resolution (2026-06-28)

**The hypothesis (type-index remap / DCE divergence) was WRONG.** Empirically
disproven: `__sget_binop(conf)` returns the correct value for all 15 acorn
`binop()` confs POST-instantiation, but `__extern_get(conf, "binop")` returns
`undefined` AT CONSTRUCTION — same object, same slot. The struct slot is read
correctly; the divergence is purely temporal.

### Real root cause — host-init timing, not type indices

`conf.binop` (an `any`-typed-receiver read) in acorn's `TokenType` ctor compiles
to a **bare host `__extern_get`**, because acorn uses `delete` somewhere, which
sets `ctx.moduleUsesDelete`, routing every `any`-receiver read through
`tryEmitDeleteAwareDynamicGet` (`src/codegen/property-access.ts`) — the
tombstone-aware host read (#2179). That host helper reads a WasmGC struct field
via `callbackState.getExports()?.[`__sget_<field>`]`.

In **gc/host** mode, `__module_init` runs via the Wasm **`start` section**
(`src/codegen/declarations.ts` — `ctx.mod.startFuncIdx = initFuncIdx`), which
executes **inside `WebAssembly.instantiate`**, BEFORE the host wires the exports
via `__setExports`. So during init `getExports()` is `undefined` → `__extern_get`
returns `undefined` for every struct field → `this.binop = conf.binop || null`
stores `null` for every `types$1` TokenType → `parseExprOp` reads `prec == null`
→ `unexpected()` → "Unexpected token" on the first binary expression. The
IDENTICAL `new TokenType(...)` at RUNTIME (after `__setExports`) works.

Scale-dependence was a red herring: standalone repros either don't trigger
`moduleUsesDelete` or don't read the field at init through the host helper.

### Fix — `__in_module_init` flag gate (read side)

A mutable i32 global `__in_module_init`, set to 1 for the duration of
`__module_init` and 0 otherwise. `tryEmitDeleteAwareDynamicGet` branches on it:

- **init (flag=1):** read the slot via the HOST-FREE `__get_member_<name>`
  dispatcher (`ref.test`+`struct.get` over the complete finalize-time candidate
  set; #2674) — no exports needed, and nothing has been `delete`d yet so the
  tombstone is moot for a freshly-built object;
- **runtime (flag=0):** keep the tombstone-aware host `__extern_get` (#2179
  preserved).

gc/host only (`!ctx.wasi`). The flag global is allocated at FINALIZE — after all
import globals settle — and the recorded read `global.get` placeholders are
patched to its final index, sidestepping the live-baked-index shift hazard
(string-constant imports shift the module-global range through closure bodies the
per-add fixup can miss). The flag is allocated + reads patched **even when there
is no `__module_init`** (a module whose only delete-aware reads live inside
functions): the flag stays 0 → every gated read takes the runtime arm
(pre-#2800 behaviour), and the placeholder index never survives to trip
`if[0] expected i32` validation.

Files: `src/codegen/property-access.ts` (`tryEmitDeleteAwareDynamicGet` gate),
`src/codegen/registry/imports.ts` (`recordInModuleInitFlagRead`),
`src/codegen/index.ts` (`finalizeInModuleInitFlag`),
`src/codegen/context/types.ts` + `create-context.ts` (ctx fields).
Guard: `tests/issue-2800-toplevel-new-objlit-init-read.test.ts`.

### Verified

- compiled-acorn `parse("1 + 2 * 3;")` → `ExpressionStatement` whose `expression`
  is a `BinaryExpression` with the CORRECT precedence (`+` at the top, `*` as the
  right child) — **unblocks #2686**. `a + b * c - d;`, `f(x) + g(y);` likewise.
- the issue's minimal repro (no `delete`) reads `9` (always did standalone — that
  path never hit the host helper);
- #2179 delete-tombstone read still returns `undefined`; #2731/#2674/#2130
  delete-dispatch suites green.

### Known follow-up (out of scope here)

The symmetric WRITE side has the same root cause: a ctor's `this.<f> = …` on an
`any`-typed `this` routes through `tryEmitDeleteAwareDynamicSet` → host
`__extern_set_strict` → `__sset_<f>`, which is also unreachable at init, so the
field write is silently dropped (the struct keeps its default). acorn does NOT
hit this — its `TokenType` ctor writes `this` via host-free `struct.set` (`this`
resolves to a concrete fnctor struct) — so it is not needed to unblock #2686. A
symmetric `__set_member_<name>` flag-gate was prototyped and reverted (a funcIdx
desync needs more care); track as a dedicated follow-up issue. Affects only a
delete-using module that does a top-level `new X(objLiteral)` whose ctor writes an
`any`-typed `this` via the host setter.
