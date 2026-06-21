---
id: 2581
title: "standalone: object-literal method generators ({ *m(){} }) still leak env.__gen_* — native lowering via closures.ts"
status: done
assignee: sd-2
completed: 2026-06-21
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: generators, object-literals
goal: standalone-mode
related: [2571, 2040, 2203, 1665, 2170, 2171]
origin: "Follow-up carved from #2571 (sd-2). #2571 landed native CLASS (instance+static) generator methods; object-literal method generators were intentionally deferred because their emit lives in a different (lifted-closure) path."
---

# #2581 — native object-literal method generators

## Problem

After #2571 (PR #1872), **class** generator methods lower natively in a
no-JS-host target. **Object-literal** method generators still leak the
eager-buffer host runtime:

```ts
// standalone: validates but cannot instantiate (imports env.__gen_*)
export function run(): number {
  const o = { *m() { yield 9; } };
  return o.m().next().value === 9 ? 1 : 0;
}
```

`{ *m(){ yield 9 } }` imports `__gen_create_buffer` / `__create_generator` /
`__gen_next` / … — `WebAssembly.instantiate` fails with `Import #0 "env":
module is not an object or function`.

## Why #2571 deferred it (current state)

#2571 made `isNativeGeneratorCandidate` (`generators-native.ts`) the single
source of truth and **bails an object-literal method generator to the host
path** with:

```ts
if (ts.isMethodDeclaration(decl) && !ts.isClassLike(decl.parent)) return false;
```

So object-literal method generators keep `__gen_*` registered and emit the
eager buffer — a **clean** bail (valid Wasm, no regression, just leaks in
standalone). This issue removes that bail and wires the native path.

## Root cause / why it's a separate slice

Class method generators emit from `class-bodies.ts`, whose collection pass
already builds a typed `this`-bearing method signature — #2571 threaded `this`
as a synthetic leading param (`param_this`) there. Object-literal method
generators are lowered through the **`closures.ts` lifted-closure path**
(`compileNativeGeneratorFunction` is NOT yet called there; the generator
emit at `closures.ts:~2317` builds the eager host buffer). The object-literal
receiver `this` is the object being constructed — its struct type may not be a
clean leading ref param the way a class instance's `this` is, so threading the
receiver needs its own treatment (or an explicit bail when the body reads
`this`, lowering only `this`-free object-literal method generators first).

## Suggested approach

1. In `closures.ts`, at the generator emit site (`isGenerator && ts.isBlock(body)`),
   add a guard: when `(ctx.standalone || ctx.wasi)` and the decl is an
   object-literal `MethodDeclaration` that `isNativeGeneratorCandidate` would
   accept (once the `!isClassLike(parent)` bail is lifted for the wired path),
   register via `registerNativeGenerator` + emit via
   `compileNativeGeneratorFunction`, mirroring `class-bodies.ts`.
2. Receiver handling: start with the `this`-free subset (no synthetic param —
   like a static method). A `this`-reading object-literal method generator can
   stay on the host bail until the receiver type is modelled.
3. Lift the `!ts.isClassLike(decl.parent)` bail in `isNativeGeneratorCandidate`
   ONLY once closures.ts routes the native emit — keep the candidate gate the
   single source of truth so `sourceNeedsGeneratorHostImports` agrees (a
   mismatch bakes an undefined funcidx → invalid wasm, the exact hazard #2571
   hit + fixed).

## Acceptance criteria

- `const o = { *m(){ yield 9 } }; o.m().next().value` compiles to a standalone
  module with **zero `env.__gen_*` imports**, instantiates + runs.
- `this`-reading object-literal method generators either lower natively OR keep
  a clean host bail (no invalid wasm).
- Class + free-function + static generators stay byte-identical (no regression).
- JS-host (gc) mode unchanged.

## Scope note

`feasibility: hard` — the lifted-closure receiver model is the genuinely new
piece. Pairs with #2571 (class methods, landed) and #2040 (generator runtime).
Validate via the full gen-method standalone cluster + merge_group (broad-impact,
NOT a scoped sweep).

## Investigation (2026-06-21, sd-2) — machinery mapped; harder than the class case

Confirmed the object-literal method-generator path is structurally distinct from
the class path (#2571) — it is NOT a `local.get`-the-this-struct-param emit. Map:

- **Result type + per-literal func**: `literals.ts:1852-1872` — for `isGen`, the
  method result type is set to `externref` (the eager-buffer Generator object),
  and a fresh per-literal func (`<name>__lit<idx>`) is allocated with signature
  `[(ref null objStruct), ...userParams] → externref`.
- **Closure wrapping**: `literals.ts:1961-1968` calls
  `emitObjectMethodAsClosure(ctx, fctx, methodFullName, methodFuncIdx,
  structTypeIdx)` (closures.ts:3708) — wraps the method body func as a CLOSURE
  value (`ref.func $trampoline` + `struct.new $closureStruct`), stored in the
  object's eqref/closure field.
- **`this` resolution**: the trampoline (`buildTrampolineThisSlot`,
  closures.ts:3753) resolves the receiver from `__current_this` (#2015), NOT a
  struct param — so the #2571 "thread `this` as synthetic leading param" trick
  does not transfer directly.
- **Body compile**: the generator emit for the body func lives in the
  `closures.ts` lifted-closure generator block (`isGenerator && ts.isBlock(body)`,
  ~closures.ts:2317) — the eager-buffer `__gen_create_buffer`/`__create_generator`
  path.
- **Finalize**: `finalizeMethodTrampolines` (closures.ts:3812) rebuilds every
  trampoline body against the method's FINAL signature before late-import shifts.

### Why it's a multi-layer change (the genuinely hard part)

To go native, the body func must return a `$GenState_*` ref (not externref), and
that ref must flow through: (1) the per-literal func result type
(literals.ts:1855), (2) the closure trampoline wrapper's result type +
`finalizeMethodTrampolines` rebuild, (3) the eqref-closure dispatch that reads the
method back off the struct and calls it, and (4) the `.next()/.return()/.throw()`
dispatch on the returned ref. The class path avoided all of this because the
method is a direct struct method, not a closure value.

### Suggested first slice (lower risk)

Start with the `this`-FREE object-literal generator method subset (no receiver to
thread — like a static method): register the body via `registerNativeGenerator`
with `synthesizedThis = false`, route the body emit through
`compileNativeGeneratorFunction`, and make the method-value/closure flow carry the
`$GenState` ref. A `this`-reading object-literal generator method stays on the
host bail until the receiver-through-closure model is built. Keep the candidate
gate the SINGLE source of truth (the `!ts.isClassLike(decl.parent)` bail in
`isNativeGeneratorCandidate`, generators-native.ts) so
`sourceNeedsGeneratorHostImports` agrees — a mismatch bakes an undefined funcidx →
invalid wasm (the exact hazard #2571 hit + fixed).

## Suspended Work (2026-06-21, sd-2)

- **Branch / worktree**: `issue-2581-objlit-method-generators` at
  `/workspace/.claude/worktrees/issue-2581-objlit-method-generators` (off main
  `5bfb4c3de`, post-#2571).
- **State**: no code changes yet — investigation only (machinery mapped above).
  Claimed `ttraenkler/sd-2`. Suspended at the end of a long session rather than
  rushing a deep multi-layer closure/trampoline change (over-broad-change risk).
- **Resume**: re-claim with `--force`, start from the `this`-free first slice
  above. Validate broad-impact via the full gen-method cluster + merge_group, NOT
  a scoped sweep.

## Resolution (2026-06-21, sd-2) — native, simpler than first feared

Object-literal method generators now lower natively in standalone/wasi. The
key enabler: the object-literal method **body func already leads with a `this`
struct param** (`methodFctxParams[0] = (ref structTypeIdx)`, literals.ts) —
structurally identical to a class method — so the #2571 synthetic-`this`
state-struct model transferred directly and the closure trampoline carries the
`$GenState` ref result through unchanged (the earlier `__current_this`-only
framing was about the trampoline; the underlying body func has the struct param).

### Changes

- **`generators-native.ts`** — the candidate-gate bail
  `!ts.isClassLike(decl.parent)` widened to also admit
  `ts.isObjectLiteralExpression(decl.parent)`. Other MethodDeclaration contexts
  still bail to host. The gate stays the single source of truth (registration +
  `sourceNeedsGeneratorHostImports` agree).
- **`literals.ts`** — at the object-literal method collection site: register the
  native generator when `(standalone||wasi) && !async && candidate`, keyed by the
  per-literal func identity (`${fullName}__lit${forkIdx}` when a
  `literalMethodFuncIdx` fork exists, else `fullName`, so forked sibling literals
  get distinct `$GenState`s), pass `methodParams` (already leads with `this`) +
  `synthesizedThis = true`, and set the method result type to the `$GenState_*`
  ref. The generator-method body emit routes through
  `compileNativeGeneratorFunction` (host eager-buffer is the `else`). The fctx
  returnType derives from `methodResults`, so it tracks automatically.

### Bail-outs (host path, valid Wasm, no regression)

Capturing / `arguments` / `super` method generators bail via the existing
`isNativeGeneratorCandidate` guards. Two **same-name same-shape** object literals
dedup to one method func (last body wins) — the PRE-EXISTING object-literal method
dedup, identical for non-generators (verified on clean main: `{m(){return 100}}`
+ `{m(){return 200}}` → both 200). Distinct-named generators each get their own
state machine (verified 100200).

### Verified

`tests/issue-2581-objlit-method-generators.test.ts` (12): simple/this/this+param/
multi-yield/done/lazy native (zero `__gen_*` imports); fresh-state per call;
for-of; distinct-named independence; gen+regular coexistence; capturing bail;
class+free-fn regression guard. Updated the #2571 objlit test (was asserting the
now-lifted deferral). tsc + prettier + hard-error + IR-fallback gates clean; 40
generator/class regression tests pass. JS-host (gc) byte-identical
(`(standalone||wasi)`-gated). Broad-impact → merge_group is the authoritative
full-standalone-shard validator.

## Merge-queue ejection + fix (2026-06-21, sd-2)

PR #1873 ejected from the merge_group on "test262 standalone shard 54" — a REAL
regression (branch was 0 commits behind origin/main; not stale-base drift).

Root cause: an object-literal generator method with a **default/optional param**
(`{ *m(d = 5){ yield d } }`) returned the WRONG value (`o.m()` → 0 instead of 5).
Object-literal methods are invoked through the closure trampoline
(`emitObjectMethodAsClosure`), which forwards args but does NOT set the
`__argc_default` global the param-default check reads — so the native factory read
the un-defaulted sentinel. The CLASS path is unaffected (class methods are called
directly, argc set), which is why #2571 didn't hit this.

Fix: `isNativeGeneratorCandidate` bails an object-literal generator method with any
`param.initializer || param.questionToken` to the host eager-buffer path (which
applies defaults correctly). A strictly-narrowing bail — it can only reduce what
goes native, never add a regression. The common no-default object-literal
generator stays native. Class/free generators with defaults stay native
(unchanged). Regression tests added (default bails to host; explicit-arg stays
native). Re-validated via chunk54 standalone diff + merge_group.
