---
id: 2838
title: "[SENIOR-DEV ONLY] dynamic prototype-accessor dispatch on statically-typed receivers — `Object.defineProperties(Proto, {get})` getters never fire on `this.field` (acorn `return` wall)"
status: done
completed: 2026-06-29
assignee: sendev-2838
sprint: 69
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2837, 2831, 2664, 2151, 1239]
depends_on: [2837]
blocks: [1712]
architect_spec: candidate
---

# #2838 — runtime-installed prototype accessors are never invoked via `this.field` on a typed receiver

**Layer 3 of the acorn `return` wall (round 5).** #2837 (object-literal growth →
externref `$Object`) is NECESSARY but NOT SUFFICIENT for compiled acorn to parse
a `return` statement. After #2837, acorn module-init succeeds (the
`prototypeAccessors` descriptors build and the getter closures install), but
`function f(){ return 1 }` STILL throws acorn's own `'return' outside of
function`. This issue is the remaining, ORTHOGONAL blocker.

## Root cause (WAT-grounded, NOT hand-waved)

acorn installs its parser-state predicates as **prototype getters at runtime**:

```js
var prototypeAccessors = { inFunction: { configurable: true }, /* +10 */ };
prototypeAccessors.inFunction.get = function () {
  return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0;
};
Object.defineProperties(Parser.prototype, prototypeAccessors);   // runtime install
```

`parseReturnStatement` (acorn.mjs:1191) then does `if (!this.allowReturn) raise(…)`,
where `allowReturn` → `this.inFunction` → the runtime-installed getter.

Instrumented compiled acorn (`.tmp/bb-instr.mjs` / `bb-instr2.mjs`):
- `this.inFunction` reads **0** (`typeof number`), `allowReturn` reads **0**, so
  every `return` raises `'return' outside of function`.
- BUT a direct `this.currentVarScope().flags & SCOPE_FUNCTION` computes **2**
  (correct) — the scope state is fine.
- The injected `console.log` inside the `inFunction` getter body **never fires**,
  while one in `parseReturnStatement` does. **The runtime-installed getter is
  NEVER invoked.**

**Mechanism:** the compiler lowers `this.inFunction` (a member access on a
statically-typed receiver) as a **STATIC struct-field read**, with no knowledge
that `inFunction` is an **accessor installed at runtime** via
`Object.defineProperties(Parser.prototype, …)`. So it reads the struct's default
slot value (0) instead of dispatching to the getter. (#2837 already made the
*storage* of the getter closure + its host-callable wrapping work — verified the
descriptors install and `definePropertiesHandler` wraps the wasm closures; the
gap is purely the **invocation** at the `this.field` read site.)

## Minimal repro (no acorn)

```ts
function C(this: any) {}
Object.defineProperties((C as any).prototype, {
  f: { get(this: any) { return 1; }, configurable: true },
});
export function probe(): number {
  return new (C as any)().f;   // must return 1; currently reads the struct default (0/undefined)
}
```

Acceptance: `new C().f` invokes the runtime-installed getter (returns 1), and the
acorn return repros parse:
`parse("function f(){ return 1; }")`, `parse("(a)=>{ return a; }")` →
correct AST, no `WebAssembly.Exception`.

## Scope / candidate approaches (architect to choose)

This is the **accessor-dispatch** substrate (member-get on a typed receiver vs the
host MOP), ORTHOGONAL to #2837's literal-growth representation. Candidates:

- **A — host-MOP fallthrough on member-get:** when a `this.field` / `o.field` read
  targets a field that is NOT a statically-known struct slot (or whose receiver's
  prototype had a runtime `Object.defineProperties` accessor install), route the
  read through `__extern_get` (the host MOP), which already consults
  runtime-installed prototype accessors. Risk: perf on the hot struct-field path;
  needs a precise "this field might be a runtime accessor" predicate.
- **B — static modelling of `Object.defineProperties(Proto, {…})`:** detect the
  acorn-shape install at compile time and register the prototype keys as
  accessor-backed members so `this.field` lowers to a getter call. Narrower; may
  not generalise beyond the statically-analysable install shape.
- **C — represent such prototype-accessor-bearing instances as `$Object`:** if a
  constructor's prototype receives runtime accessors, route its instances through
  the externref `$Object` path (reads go through `__extern_get` → host accessor).
  Broad; perf + identity considerations.

Recommend an architect spec choosing A/B/C. **Verify-first MUST exercise the
actual `Object.defineProperties(Proto, {get})` + `new C().field` install-and-invoke
chain** — NOT a direct `desc.get()` call (the #2837 architect's `:any` verify used
`po.inFn.get()`, a direct call, which masked this invocation gap). **Senior-dev,
`reasoning_effort: max`, `horizon: l`. Broad-impact ⇒ full `merge_group` +
standalone-floor.**

## Pointers

- acorn: `parseReturnStatement` 1191, `allowReturn`/`inFunction` getters 624/608,
  `Object.defineProperties(Parser.prototype, prototypeAccessors)` ~685.
- Compiler: member-get dispatch (`property-access.ts`), `__extern_get` host MOP,
  the struct-field-read fast path; runtime `definePropertiesHandler`
  (`src/runtime.ts`) where the accessors install (#2837 wraps the closures there).
- Repro infra (branch `issue-2837-objrep` `.tmp/`): `bb-instr.mjs`,
  `bb-instr2.mjs` (getter-never-invoked proof), `bb-probe2.mjs` (return trigger).
- Diagnosed after #2837 on compiled acorn@8.16.0, 2026-06-29 (sendev round 5).

---

## Implementation (sendev-2838, 2026-06-29) — 3-PR epic per architect round-7

Driving the full 6-layer stack to acorn-`return`-parses (and on to the edge.js
NM differential). Chunked into 3 PRs to isolate the broad L6 dispatch change.

### PR1 — L3: `wasmClosureBridge` method-`this` arity fallback (this branch)
`src/runtime.ts`, `_wrapWasmClosure` → `wasmClosureBridge` (~2009). When the
exact `__call_fn_method_${arity}` dispatcher is ABSENT, fall back to the highest
available `__call_fn_method_M` (M from 8 down to arity), padding args to M. The
wasm method-dispatch arm hands each closure exactly its own declared arity, so a
higher-M dispatch still threads `this` correctly. LAZY bridge ⇒ module-init-safe
(resolves exports at call time, after `Object.defineProperties` runs pre-`__setExports`).
This is the round-5/6 drafted-and-reverted fix, re-applied. **Verified
non-regressing**: closure/accessor + class-method/dispatch suites
(`illegal-cast-closures-585`, `issue-1712*`, `getters-setters`,
`accessor-side-effects`, `class-method-calls`, `class-methods`,
`computed-setter-class`, `issue-1364a`, `issue-1672`, `issue-2174`) produce
**identical** pass/fail counts with and without the change. L3 alone does not fix
acorn — it is the isolated prerequisite for L6.

### PR2 — L4+L5: member-read host-MOP routing + `this`-truth (this branch, stacked on PR1)
- **L5** (`property-access.ts`, `resolveStructNameForExpr` ~1070): for a `ThisKeyword`
  receiver, return `resolveThisStructName(ctx, fctx)` (the fctx `this` local's actual
  ref type) instead of the TS-contextual type. Inside a runtime-installed accessor
  getter TS types `this` as the descriptor literal (`__anon_N`), so the old path
  lowered `this.<x>` against the wrong struct and read a default slot. The fctx local
  is the runtime truth: a dynamic getter's local is externref → undefined → fully
  dynamic (host MOP); a genuine typed method's local is the correct struct (truth
  AGREES → no change).
- **L4** (`property-access.ts`, the `#856` sidecar/MOP block ~5512): relax its
  `!typeName` gate so a `__fnctor_*`/`__anon*` typed receiver also reaches the
  existing `extern.convert_any` + `__extern_get` path (which consults
  `_fnctorProtoLookup` for runtime-installed prototype accessors). Positioned as the
  LAST resort (after the static fast path + auto-register), so the hot struct-field
  read is untouched; only genuinely-absent fields take the MOP route. Gated on
  `!noJsHost` — standalone keeps its existing default.
- **Verified**: the `this-thread.mjs` var-descriptor accessor probe flips from
  `null`/`null` to the correct `2`/`55` (getter `return this.flags` now reads the real
  receiver). **Non-regressing**: identical failing sets vs L3-only baseline across
  closure/accessor, fnctor/this/proto, and class-method suites; additionally clears
  the flaky `#1742` this-receiver-vec read. L4+L5 do NOT yet parse acorn `return` —
  the runtime-installed METHOD-call dispatch (`new C().read()`, `this.currentVarScope()`)
  is the remaining L6 wall.

### PR3 — L6: dynamic-`this` method-call dispatch (this branch) — BREAKS THE ACORN RETURN WALL
- **Root cause (WAT-grounded)**: a method call whose receiver is `this`, where the
  runtime `this` is dynamic (acorn's getter body runs with `__current_this` set, the
  fctx `this` local is NOT a concrete struct ref) but TS contextually typed `this` as
  the descriptor literal `__anon_N`. The static dispatch arms in `compileCallExpression`
  resolve the receiver against that WRONG nominal type; none match the real method, so
  the call degraded to a member-get-then-DROP (`__extern_get(this,"m"); drop; ref.null`)
  — the method never ran and returned null. `this.currentVarScope()` inside acorn's
  `inFunction` getter hit exactly this, so `inFunction`/`allowReturn` read 0 and every
  `return` raised `'return' outside of function`.
- **Fix** (`calls.ts`, top of the property-access call branch ~3964): when the receiver
  is `this`, `resolveThisStructName(ctx,fctx)` is undefined (runtime `this` dynamic) yet
  `resolveStructName` of the TS type IS a struct (the lie), route the call through the
  existing `emitWrapperDynamicMethodCall` → `__extern_method_call(recv,name,args)`, which
  binds the receiver via `__current_this` and walks the runtime prototype chain
  (`_fnctorProtoLookup`). Precise predicate: a genuine typed method (truth AGREES →
  struct defined) is never intercepted; a truly-`any`/module-level `this` (no struct
  either way) is left to the existing fallback. `.call`/`.apply`/`.bind` excluded by
  name; JS-host only.
- **ACCEPTANCE — MET (real acorn, compiled, not synthetic)**: `setup-acorn` →
  `compile(acornSource,{skipSemanticDiagnostics:true})` → instantiate → `wrapExports` →
  `parse("function f(){return 1}")` now returns a `Program` AST (previously threw
  `[object WebAssembly.Exception]` = acorn's own `'return' outside of function`).
  `(a)=>{return a}` and `var x=1` also parse. **The acorn `return` wall is broken.**
- **Non-regressing**: identical failing sets vs the pre-L6 (L4+L5) baseline across
  closure/accessor, fnctor/this/proto, and class-method suites (per-test JSON diff).
  The predicate never fires for typed class/fnctor methods (concrete-struct `this`).

### edge.js NM differential verdict (round-8)
Ran the real-world differential (`nm-diff.mjs`: compiled-acorn `parse()` vs node-acorn
oracle, `ignorePositions`) at three source states — all WAT/runtime-grounded:

| target | pure-main (L3) | L4+L5 | L4+L5+**L6** |
|---|---|---|---|
| sanity `foo(bar,baz)` | nonQuirk 0 | 0 | **0** |
| **background.js** | **nonQuirk 2** | 2 | **2** (identical — NO regression) |
| **edge.js** | THREW (`return` wall) | THREW | **PARSES**, nonQuirk-class 76 |

- **edge.js advanced from THROW → parses** to a structurally-equivalent AST. All 76
  residual divergences are **pre-existing `wrapExports` marshalling quirks**, NOT parse
  defects: 62 are the function-parameter field-marshalling quirk (the param Identifier
  node is present but its `type`/`name` sub-fields aren't read back — the same quirk that
  produces background.js's pre-existing 2, and the node-count deficit 1190→1160 ≈ the 30
  unread param `type` fields), and 14 are the boolean→number representation quirk
  (`Literal.value` `true`→`1`, ForOf `.await` `false`→`0`) — the same family as the
  already-tolerated `optional/computed/generator/async` boolean quirks.
- **background.js stays equal — proven**: nonQuirk count is IDENTICAL (2) at pure-main,
  L4+L5, and L4+L5+L6. The 2 are pre-existing marshalling quirks caused by NONE of this
  epic's changes. No regression.
- **Round-8 follow-up (separate from this parse epic)**: the residual is a `wrapExports`
  marshalling representation gap — (a) function-parameter Identifier `type`/`name` not
  marshalled back across the host boundary, (b) booleans marshalled as i32 `0/1`. These
  are AST-marshalling concerns, orthogonal to parse correctness (the compiled parser
  builds the right tree). Recommend a dedicated `wrapExports` marshalling issue.

### Predicate narrowing (post-park hardening of L5/L6)
PR2's first merge_group run auto-parked on `check for test262 regressions` (net -8:
cluster of `static private-accessor-name/static-private-*` + 3 flaky `top-level-await`).
Diagnosis: the original L5 **unconditionally** returned `resolveThisStructName` for a
`this` receiver, which forced a static method's `this.#priv` (TS `typeof C`, a genuine
struct, but the class object is externref so `resolveThisStructName` is undefined) onto
the dynamic path and broke brand-checked private dispatch. The exact failing test
(`static-private-name-common`) could NOT be reproduced locally on pure L4+L5 (passes),
and the cluster carried flaky TLA + the report's own drift-signature flag — so the park
was most likely baseline-drift/flake. Regardless, L5/L6 were **narrowed** to the precise
descriptor-lie case the architect identified:
- **L5**: for a `this` receiver, (1) concrete fctx struct → use it; (2) dynamic fctx +
  genuine non-`__anon` TS struct → KEEP the TS struct (static-method/private dispatch
  preserved); (3) dynamic fctx + `__anon` descriptor TS type → undefined → dynamic.
- **L6**: only fires when the fctx `this` is dynamic AND TS typed it as an `__anon`
  descriptor. Genuine-struct and static `this` method calls are never intercepted.
Re-verified after narrowing: acorn `return` still parses; var-descriptor accessor probe
still 2/55; `static-private-accessor` repro returns `"get string"`. Blast radius is now
minimal (only the runtime-getter `__anon`-`this` case).
