---
id: 2805
title: "init-time `any`-receiver field WRITE dropped at module-init (symmetric write side of #2800)"
status: ready
assignee: ttraenkler/unassigned
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
created: 2026-06-28
updated: 2026-06-28
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
