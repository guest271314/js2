---
id: 6408
title: "standalone object-literal data/method property keys emit `global.get -1` sentinel → binary emit error (~17 tests; subcluster of a 155-test #51-family residual)"
status: in-progress
assignee: ttraenkler/sdev-harvest
sprint: 63
created: 2026-06-18
updated: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literal, standalone
goal: standalone-mode
related: [1888, 51, 2043, 2087]
test262_bucket: standalone-string-global-sentinel
test262_count: 155
origin: "2026-06-18 sprint-63 standalone harvest (sdev-harvest): re-bucketed the fresh standalone baseline JSONL. The `-1` string-global sentinel CE class (#51) has a 155-test residual on main, all in object-literal data/method property keys (the accessor-key arm was fixed in #1888 S5c but the sibling PropertyAssignment + MethodDeclaration arms were not)."
---

# #6408 — standalone object-literal data/method property keys bake the `-1` string-global sentinel into `global.get`

## Problem

In `--target standalone` (`nativeStrings` / `ctx.standalone`), there is **no
host string-constant global** — `addStringConstantGlobal(ctx, name)` records the
`-1` sentinel in `ctx.stringGlobalMap` rather than a real import-global index
(this is the #51 / #1888 class). A subsequent literal `{ op: "global.get",
index: keyGlobal }` therefore emits `global.get -1`, which serializes to a
`Codegen error: global index out of range — -1` binary-emit failure.

`#1888 S5c` fixed the **accessor** arm in
`compileObjectLiteralWithAccessors` (`src/codegen/literals.ts`) to materialize
the key via the dual-mode helper `stringConstantExternrefInstrs(ctx, propName)`.
The two sibling arms in the **same loop** were left on the raw
`global.get keyGlobal`:

- **PropertyAssignment** arm — **already fixed on upstream/main via #51** (an
  identical `stringConstantExternrefInstrs` conversion landed in the commits
  after this branch's fork base; resolved as a no-op merge here).
- **MethodDeclaration** arm (`literals.ts`, the `{ greet(){}, get v(){} }`
  shape) — **STILL on the raw `global.get keyGlobal` on upstream/main**; this is
  the genuine remaining defect this PR fixes.

So any object literal that takes the accessor path (i.e. contains ≥1
getter/setter) AND also has a data property or a regular method emits
`global.get -1` for the data/method key. This is why the failure shows up under
`__anon_0_<method>` / `__module_init` (the literal construction site), not in
the getter callback.

### Minimal repro (standalone)

```ts
const o = { index: 0, get val() { return this.index; } };
let x: any = (o as any).val;
// → Binary emit error: global index out of range — -1 at '__module_init'
```

```ts
const obj = { make() { return { index: 0, get val() { return this.index; } }; } };
let it: any = (obj as any).make();
// → ... at '__anon_0_make'
```

Removing the data property (`{ get val() { return 1; } }`) makes it pass —
the getter alone is fine (already-fixed accessor arm), but the sibling `index`
data key trips the unguarded `global.get`.

## Root cause

`literals.ts` PropertyAssignment + MethodDeclaration arms push a raw
`global.get <stringGlobalMap.get(name)>`, where in standalone that value is the
`-1` sentinel. The fix is identical to the accessor arm: emit the key via
`stringConstantExternrefInstrs(ctx, name)`, which lowers to the native-string
inline path under standalone and the host `global.get` under GC.

## Fix

Replace, in both arms, the pair
```ts
addStringConstantGlobal(ctx, name);
const keyGlobal = ctx.stringGlobalMap.get(name);
if (keyGlobal === undefined) continue;
fctx.body.push({ op: "local.get", index: objLocal });
fctx.body.push({ op: "global.get", index: keyGlobal });
```
with
```ts
addStringConstantGlobal(ctx, name);
fctx.body.push({ op: "local.get", index: objLocal });
for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
```

`stringConstantExternrefInstrs` (per `reference_string_global_sentinel_guard`)
emits the guarded dual-mode key under both backends and is byte-identical to the
old `global.get` in GC mode. No late-import-shift interaction (it does not
capture a funcIdx).

## Acceptance criteria

- The minimal repros above compile clean in `--target standalone`.
- The object-literal **method-key** subcluster of the `global index out of
  range — -1` residual clears. Measured against current upstream/main (which
  already carries #51's PropertyAssignment-arm fix): the MethodDeclaration-arm
  fix in this PR flips **18 / 155** standalone CE bucket files
  CE→compiles-clean, and upstream-without-this-PR flips **0 / 155** of them —
  i.e. this bucket is dominated by object literals with named/computed
  **methods** (iterators `[Symbol.iterator](){…}` / `next()`, set-like classes,
  async-from-sync) that contain a getter, so the method-arm is the load-bearing
  fix. The remaining 137 hit the same sentinel class in *other* emit sites —
  see Follow-up.
- No host/GC-mode regression (`stringConstantExternrefInstrs` is byte-identical
  to the old `global.get` in GC mode; verified — the object-literal /
  getter/setter / accessor suites that pass on baseline still pass, and the only
  pre-existing failures (`getters-setters.test.ts` `string_constants` harness
  issue, `issue-1888` 2-4-arg dispatch) fail identically with and without this
  change).
- HW floor not breached (no breach of 20,706/20,803 standalone pass HW).

## Follow-up (broader #51 / sentinel sweep — NOT in this PR)

The 155-test `global index out of range — -1` bucket is a multi-site #51-family
residual. This PR fixes only the **object-literal data/method-key** arm in
`literals.ts` (the accessor arm was already fixed in #1888 S5c). The remaining
~138 hit raw `global.get <stringGlobalMap.get(key)>` in other standalone-reachable
emit sites, each needing the same `stringConstantExternrefInstrs` conversion but
with per-site stack-type verification:

- `object-ops.ts` — `emitDefinePropertyFlagCheck` (flag-key + TypeError message
  globals) **and** the `Object.defineProperty` value-store key path
  (`emitExternDefinePropertyValue` / `markRuntimeDefinedProperty`); the
  `{ value: v }` descriptor still emits `global.get -1` after the flag-check fix,
  so the defineProperty path needs a complete audit, not a partial one.
- `string-ops.ts` (`global.get stringGlobalMap.get(word|"null"|"undefined")`),
- `class-bodies.ts` (`subNameGlobal` / `parentNameGlobal`),
- `binary-ops.ts:742`, `array-methods.ts:5112-5113`, `object-ops.ts:3650`.

Recommend a dedicated follow-up issue (a systematic `global.get`-of-string-global
audit across `src/codegen/*.ts` under `ctx.standalone`) rather than folding it
into this focused PR — each site is mechanically identical but the stack-type and
GC-mode verification per site is what makes it broad-blast-radius.
