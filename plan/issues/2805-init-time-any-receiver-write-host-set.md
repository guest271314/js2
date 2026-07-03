---
id: 2805
title: "init-time `any`-receiver field WRITE dropped at module-init (symmetric write side of #2800)"
status: done
assignee: ttraenkler/senior-developer
sprint: 69
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
created: 2026-06-28
updated: 2026-07-03
completed: 2026-07-02
task_type: bugfix
area: codegen
language_feature: object-literals
goal: acorn-dogfood
related: [2800, 2179, 2731, 2664]
depends_on: []
blocks: []
---

# #2805 — init-time `any`-receiver field WRITE dropped at module-init (symmetric write side of #2800)

The symmetric WRITE counterpart of #2800. Same host-init-timing root cause; carved
out as a follow-up because acorn does **not** hit it (so it was not needed to
unblock #2686), and a prototype write-side fix was reverted in #2800 (a funcIdx
desync surfaced — see below — that needs more care than the read-side gate).

## The bug

A top-level `new X(objLiteral)` whose constructor writes `this.<field> = …` on an
**`any`-typed `this`** drops the write at MODULE-INIT in gc/host mode — the struct
keeps its default (0 / null). The identical construction at RUNTIME works.

```ts
function VI(this: any, label: any, conf: any) {
  this.label = label;
  this.zz = conf.zz || 0;     // both the READ (fixed by #2800) and the WRITE...
}
function useDelete(o: any) { delete o.x; }   // forces ctx.moduleUsesDelete
const x: any = new (VI as any)("a", { zz: 9 });
// x.zz === 0  at top-level (BUG)   ;   mk().zz === 9 at runtime (OK)
```

`runtimeZz()` reads 9; `topLevelZz()` reads 0 (write dropped). With ONLY #2800's
read-side fix, `conf.zz` reads 9 correctly at init, but `this.zz = 9` is then
silently dropped, so `x.zz` is 0.

## Root cause (same as #2800, write side)

A delete-using module (`ctx.moduleUsesDelete`) routes an `any`-receiver property
WRITE through `tryEmitDeleteAwareDynamicSet` (`src/codegen/property-access.ts`) —
the strict host setter `__extern_set_strict` → `_safeSet` → `__sset_<field>`
(#2731, the symmetric mirror of #2179's read routing). gc/host runs
`__module_init` via the Wasm `start` section, **inside `WebAssembly.instantiate`,
BEFORE the host wires the struct setters via `__setExports`** — so at init
`__sset_<field>` is unreachable and the field write is dropped.

acorn does NOT hit this: its `TokenType` ctor writes `this` via host-free
`struct.set` (`this` resolves to a concrete fnctor struct, not `any`), so only the
conf READ was on the host path. This bug needs a delete-using module that does a
top-level `new X(objLiteral)` whose ctor writes an `any`-typed `this` through the
host setter.

## Suggested fix (symmetric `__in_module_init` gate)

Mirror #2800's read-side gate in `tryEmitDeleteAwareDynamicSet`: branch on the
`__in_module_init` flag global (already defined by #2800 —
`finalizeInModuleInitFlag` / `recordInModuleInitFlagRead` in
`src/codegen/{index,registry/imports}.ts`):

- **init (flag=1):** write the slot host-free via the `__set_member_<name>`
  dispatcher (`reserveMemberSetDispatch`, #2664) — `struct.set` over the candidate
  set, no exports needed; nothing has been `delete`d yet so the for-in re-add
  ordering the sidecar tracks is moot for a freshly-built object;
- **runtime (flag=0):** keep the tombstone/order-aware host `__extern_set_strict`
  (#2731 preserved).

gc/host only (`!ctx.wasi`; the function already returns early for
`ctx.standalone`).

### Why the #2800 prototype was reverted

A first attempt routed the init arm through `__set_member_<name>` but the dumped
ctor showed BOTH `this.label` and `this.zz` writes baking the SAME `call funcIdx`
(a funcIdx desync — the late-import funcIdx-shift hazard, #2043/#2664 class). The
read-side `__get_member_<name>` reserve-then-fill handles this correctly; the
write-side reserve needs the same flush discipline verified end-to-end (confirm
`reserveMemberSetDispatch(ctx, propName, true, fctx)` returns distinct, post-shift
funcIdx per property, and that the gated `call` isn't baked before the shift
settles). Dump the ctor body and resolve `funcIdx` → name against the FINAL
(post-DCE) index space before trusting the gate.

## Acceptance

- A top-level `new X(objLiteral)` in a delete-using module whose ctor writes an
  `any`-typed `this.<f> = conf.<f>` reads the written value back (`x.f === 9`).
- #2179 / #2731 / #2664 / for-in-order delete suites stay green (the runtime arm
  must keep the host `__extern_set_strict` ordering/tombstone semantics).
- The init-time WRITE must not regress the read-side #2800 gate.

## Reproduce

`tests/issue-2800-toplevel-new-objlit-init-read.test.ts` (the read-side guard) +
the `new VI(...)` write variant dropped from it (see #2800's git history) which
reads `topLevelZz() === 0` pre-fix.

## Resolution (2026-07-02)

Implemented the symmetric `__in_module_init` gate in
`tryEmitDeleteAwareDynamicSet` (`src/codegen/property-access.ts`).

### Measure-first (the exact repro shape matters)

The bug reproduces ONLY with a **clean** function constructor — implicit-`any`
`this`, NO `this: any` annotation, NO `(VI as any)` cast:

```ts
function VI(label, conf) { this.label = label; this.zz = conf.zz || 0; }
function useDelete(o: any): void { delete o.x; }
const x: any = new VI("a", { zz: 9 });          // top-level (init)
function mk(): any { return new VI("b", { zz: 9 }); }
// pre-fix: topLevelZz()===0, topLevelLabel()===null; runtimeZz()===9
```

An explicit `this: any` annotation OR an `(VI as any)` cast routes `new` through
the **dynamic-new** path, which independently fails to marshal the object-literal
argument (`conf` reads `undefined` at BOTH init and runtime — a *separate*,
pre-existing `new (fn as any)(objLiteral)` arg-passing gap, NOT this bug). Using
the clean ctor form (the shape acorn actually emits for `new TokenType(...)`)
isolates the init-timing write drop cleanly. The delete-free variant already
works at init (native `struct.set`, no host setter), confirming the root cause is
the host-setter timing, not the write itself.

### funcIdx desync — root-caused and avoided (not just "verified")

The #2800 write-side prototype baked the SAME `call funcIdx` for `this.label` and
`this.zz` because it reserved `__set_member_<name>` **before** evaluating the
`value` expression. The value (`conf.zz || 0`) itself reserves a
`__get_member_zz` dispatcher and pulls late imports, shifting the defined-function
index space; the already-captured `setMemberIdx` local went stale-low. Fix:
reserve the dispatcher **after** both operands are lowered into locals, with
nothing emitted between its reserve+flush and the bake — so its funcIdx is
post-shift. `setIdx` (`__extern_set_strict`) is an IMPORT (stable index once
added) so baking it late is safe. Verified by dumping the compiled `$VI` ctor and
resolving funcIdx→name against the final index space:

- `this.label` init arm → `call 11` = `$__set_member_label`
- `this.zz`    init arm → `call 13` = `$__set_member_zz`  (distinct ✓)
- both writes + the `conf.zz` read gate on the SAME flag global (`__in_module_init`)
- runtime arms → `__extern_set_strict` (import) / `__extern_get` (import) preserved

### Files

- `src/codegen/property-access.ts` — `tryEmitDeleteAwareDynamicSet` init gate.
  Reuses the #2800 flag machinery (`recordInModuleInitFlagRead` /
  `finalizeInModuleInitFlag` — the write reads are patched by the same finalize
  pass, sharing `ctx.inModuleInitFlagReads`), and the #2664
  `reserveMemberSetDispatch`.
- Guard: `tests/issue-2805-init-time-any-receiver-write.test.ts`.

### Verified

- new guard (3 cases): init write lands (`x.zz===9`, `x.label==="a"`), runtime
  write still `9`, delete-free module unaffected.
- `#2800` read guard, `#2179`/`#2731`/`#2664` dispatch, `issue-forin`,
  `#2130` delete-in-presence all green.
- Byte-inert for untouched lanes: a delete-free module emits NO
  `__in_module_init`; standalone early-returns (no flag). The change is reachable
  only in a delete-using gc/host module — the target lane.
- (`tests/delete-operator.test.ts`, `tests/constructor-arity.test.ts` #593, and
  the `./helpers.js` importers fail identically on base main — pre-existing
  worktree test-infra breakage, unrelated.)

### Known follow-up (out of scope)

`new (fn as any)(objLiteral)` / `new fn(objLiteral)` with an explicit `this: any`
param drops the object-literal ARGUMENT (`conf` reads `undefined`) at both init
and runtime — a dynamic-new arg-marshaling gap, distinct from this init-timing
write drop. Worth a dedicated issue if a real program hits it.
