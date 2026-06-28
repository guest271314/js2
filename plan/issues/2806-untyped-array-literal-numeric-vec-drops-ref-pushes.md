---
id: 2806
title: "[SENIOR-DEV ONLY] untyped `[]` array literal lowers to a NUMERIC (f64) vec — ref pushes coerce to 0 (drops AST node refs)"
status: ready
assignee: ttraenkler/unassigned
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-28
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2801, 2794, 2784]
depends_on: []
blocks: [2801]
architect_spec: candidate
---

# #2806 — untyped `[]` lowers to a numeric vec, dropping reference-typed pushes

**Carved out of #2801 (layer 2 of 2).** Distinct substrate class from the host
vec→array *marshaling* fix that landed for #2801 layer-1. This is the **real
blocker** for correct compiled-acorn call arguments — and it is **general**, not
acorn-specific: it equally breaks `ArrayExpression.elements` and surfaces in
`CallExpression.optional` reading `0` instead of `false`.

## Symptom

After the #2801 layer-1 host-marshaling fix (`_wrapVecForHost`), compiled-acorn
`parse("foo(bar, baz)").arguments` is a **real JS array of length 2**, but its
elements are `[0, 0]` — numeric zeros — instead of the two `Identifier` nodes.

## Decisive root-cause probe

Instrumenting the host read (`DBG2801` in `_wrapVecForHost.elemAt`,
`src/runtime.ts`):

```
[DBG elem] i=0 rawTypeof=number rawIsWasm=false raw=0 mutSup=1 vecLen=2
```

So `__vec_get(argsVec, i)` returns a **`number 0`** (`rawIsWasm=false`), with
`__vec_mut_supported=1`, `__vec_len=2`. The `arguments` vec is a genuine,
growable vec whose **backing-array element kind is numeric (f64)**. When acorn
pushes AST node references into it, each ref is coerced to f64 `0`; `__vec_get`
faithfully reads back `0`. `call.optional` reading `0` (not `false`) is the same
class of raw-scalar representation leak.

`__vec_get` (`src/codegen/index.ts` ~4726-4900) is innocent: it does a
`ref.test` chain over registered vec types and reads the matched backing array.
The args vec genuinely **is** a numeric vec, so the read is correct for the
(wrong) representation.

## Origin — empty-array element-kind resolution

`compileArrayLiteral` empty-array path, `src/codegen/literals.ts` ~3087-3162:

```ts
let emptyElemKind = "externref";
const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
if (ctxType) {
  const sym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
  if (sym?.name === "Array") {
    const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
    if (typeArgs[0]) {
      const elemWasmType = resolveWasmType(ctx, typeArgs[0]);
      emptyElemKind = elemWasmType.kind === "ref" || elemWasmType.kind === "ref_null"
        ? `ref_${(elemWasmType as { typeIdx: number }).typeIdx}`
        : elemWasmType.kind;
    }
  }
}
const vecTypeIdx = getOrRegisterVecType(ctx, emptyElemKind);
```

acorn is **plain JS** (compiled with `skipSemanticDiagnostics: true`, no type
annotations). For acorn's `arguments`/`elements` `[]` literals the contextual /
`getTypeAtLocation` element type resolves to a **numeric** wasm kind, so the vec
is created with an f64 backing array — and every subsequent reference push is
coerced to f64.

## The `body`-vs-`arguments` representation split (the tell)

`Program.body` reaches the host as a **host-backed JS array** (externref,
`isWasm=false`) of node proxies and works, while `CallExpression.arguments` /
`ArrayExpression.elements` are **f64 vecs** that drop their node refs. Same
"untyped `[]` + `.push(node)`" source pattern, different representation — so the
element-kind decision is **inference-context dependent** (evolving-array flow
analysis / contextual type), not uniform. Pinning *why* the two diverge is the
first investigation step.

## Fix direction (needs an architect representation-policy decision)

An empty / untyped `[]` that subsequently receives **reference-typed** pushes
must lower to an **externref/any-element vec** (boxed refs preserved), never an
f64 vec. Candidate policies (DESIGN DECISION — architect-spec):

1. **Default-to-any**: an untyped/`any[]`/`never[]` empty literal whose element
   kind can't be proven numeric lowers to externref, not f64. Simple, but may
   widen genuinely-numeric untyped arrays (perf/repr cost) — measure.
2. **Flow-analyze pushes**: inspect the `.push(...)` / index-write sites feeding
   the array binding; if any pushes a ref/`any`, choose externref. More precise,
   more complex, must handle the evolving-array binding across the function.

Either way: validate the `body`-style host-array path is unaffected, and run the
**full `merge_group` + standalone-floor** (broad blast radius — touches every
untyped/evolving array literal). Watch for regressions in numeric-array-heavy
test262 buckets.

## Acceptance

- An empty/untyped `[]` that receives reference-typed pushes round-trips those
  references (host reads them back as the pushed objects, not `0`).
- Compiled-acorn `parse("foo(bar, baz)").arguments` structurally equals
  node-acorn (two `Identifier` nodes) via the dogfood differential oracle —
  closing **#2801**. Spot-check `f(1, 2+3)`, `f()`, `g(a)(b)`, `[1, 2]`.
- `CallExpression.optional` reads `false` not `0` (same representation class).
- Full `merge_group` + standalone-floor green; no numeric-array regressions.

## Banked probes / method

- `.tmp/callargs3.mjs` — parse + diffAst vs node-acorn oracle for arguments.
- `.tmp/elemdbg.mjs` + `DBG2801` instrumentation in `_wrapVecForHost.elemAt` —
  the decisive `__vec_get → number 0` classification.
- Acorn compiles in ~40s (longer under load); reuse ONE compile per probe.
- Depends on the #2801 layer-1 fix (`_wrapVecForHost`) being present so the
  array surfaces at all — branch fresh from `origin/main` after that lands, or
  cherry-pick it.

## Build-on

- **Blocks #2801** (its acceptance can't be met until node arrays preserve refs).
- Sibling representation work: #2784 (vec-identity), #2794 (vec read-methods).
