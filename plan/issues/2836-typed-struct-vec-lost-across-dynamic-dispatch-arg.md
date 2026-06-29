---
id: 2836
title: "[SENIOR-DEV ONLY] typed nominal-struct vec ($__vec_ref_*) loses its elements when passed as an `any` argument through an indirect/dynamic call — compiled acorn cannot parse arrow functions with ≥1 param"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2831, 2806, 2809, 2379, 2151, 2186, 1917]
depends_on: []
blocks: [1712]
architect_spec: needed
---

# #2836 — typed-struct vec (`$__vec_ref_*`) elements are lost across an indirect/dynamic-dispatch `any` argument

**The next acorn-dogfood wall after #2831 (ROUND 3).** Surfaced by the
real-world NM differential (compiled acorn.wasm vs node-acorn) on
`examples/native-messaging/{edge.js,background.js}`: after #2831 cleared the
function-body `illegal cast` wall, both files now throw acorn's **own**
`SyntaxError: "Assigning to rvalue (1:NaN)"` — but only for **arrow functions
with ≥1 parameter**.

## Repro isolation (WAT-grounded, not hand-waved)

On freshly-compiled pinned acorn@8.16.0 (`skipSemanticDiagnostics:true`),
`instance.exports.parse(src, {ecmaVersion:2022,sourceType:"script"})`:

```
() => 1        -> OK         (ZERO params)
x => x         -> THROW WebAssembly.Exception   (acorn SyntaxError "Assigning to rvalue")
(x) => x       -> THROW
(a,b) => a     -> THROW
f((x)=>x)      -> THROW
(1) / (x)      -> OK         (parenthesized, NO arrow)
```

The thrown object is a `WebAssembly.Exception` (acorn's `throw new SyntaxError`
lowered to a wasm `throw`), i.e. **compiled code reaches acorn's own raise** at
`toAssignable`'s `default` case (acorn.mjs:2167, `this.raise(node.start,
"Assigning to rvalue")`). `(1:NaN)` = column NaN because `node.start` is
`undefined` (→ `getLineInfo` arithmetic → NaN). It reaches `default` because
`node.type` reads `undefined`. **The NaN is a downstream symptom, not the root.**

## Root cause — VERDICT (a) VALUE-REP (vec representation, NOT a numeric-field NaN)

Instrumented acorn (logging injected into `toAssignable`/`toAssignableList`/the
`[id]` call site / `parseArrowExpression` entry) pinned the divergence exactly:

- acorn's arrow path: `case types$1.name` → `id = parseIdent()` →
  `return this.parseArrowExpression(this.startNodeAt(...), [id], false, forInit)`
  (acorn.mjs:3025). `parseArrowExpression` does
  `node.params = this.toAssignableList(params, true)` (3535) →
  `toAssignableList` does `this.toAssignable(exprList[i], …)` (2179).
- **At the call site** (just before the call), `[id][0].type === "Identifier"`,
  `.name === "x"` — the array element is the **correct** Identifier node.
- **At the FIRST line of `parseArrowExpression`** (callee entry),
  `params.length === 1` (survives) but `params[0].type === undefined`,
  `Object.keys(params[0]) === []`, `params[0].constructor.name === "Array"` —
  the element has become an **empty Array object**. The container survived; the
  **element was lost in argument marshalling**.

`this.parseArrowExpression(...)` is a **dynamic method dispatch** (call_ref via
the prototype-method closure). The element loss is specific to passing an
array-of-object as an `any` argument through an **indirect/dynamic** call.

### Minimal repro WITHOUT acorn (`.tmp/repro-dyn2.mjs` / `repro-dyn3.mjs`)

```ts
function mkId(){ var n = {}; n.type = "Identifier"; return n; }
function consume(node, params, flag){ return params[0].type; }
export function run(){ var o = { c: consume }; return o.c({}, [mkId()], false); }
//  -> "undefined"   (BUG; static `consume({}, [mkId()], false)` returns "Identifier")
```

Element-type sensitivity (decisive):

| array element  | vec type built | indirect `params[0]` | result |
|----------------|----------------|----------------------|--------|
| number `[7]`   | `$__vec_f64`        | recognized | **works** (7) |
| string `["h"]` | `$__vec_externref`  | recognized | **works** ("h") |
| object `[{…}]` | `$__vec_ref_5` (typed nominal-struct vec) | **NOT recognized** | **empty Array** |

### Exact mechanism (WAT, `.tmp/mini.wat`)

The indirectly-called callee gets a generic signature `(param externref externref
externref)`. Its dynamic index-read for `params[0]` is:

```wat
local.get 1            ;; params (externref)
any.convert_extern
local.tee 7
ref.test (ref 2)       ;; $__vec_externref ?
local.get 7
ref.test (ref 4)       ;; $__vec_f64 ?
i32.or
(if (result externref)
  (then  … array.get on the recognized vec …)        ;; call 12 — correct element read
  (else  … host/scalar fallback (__extern_get / box) …))  ;; WRONG for a typed struct vec
```

The reader recognizes **only** `$__vec_externref` (type 2) and `$__vec_f64`
(type 4). The caller built `[mkId()]` as **`$__vec_ref_5`** (`(struct (length)
(data (ref null $__arr_ref_5))))`, `$__arr_ref_5 = (array (mut (ref null
$obj))))`) and passed it with a raw `extern.convert_any` (the typed vec stays a
typed GC struct, just typed externref). On the callee side neither `ref.test`
matches → the **else** (host/scalar) branch runs → returns an empty Array →
`.type` is `undefined`.

`.length` works because `$__vec_base` (the common supertype) carries `length`
and is read generically; element read needs the backing array type, which the
generic reader does not have for an arbitrary `$__vec_*` subtype.

**This is pre-existing and independent of #2831** — `vec_from_extern` count is 0
in the minimal repro; #2831's materializer is not on this path. It is the same
representation family as #2379 (boxed-any vs typed-elem rep), #2806/#2809
(array-rep unification), #2151/#2186 (any-receiver dynamic dispatch).

## Why this is architecture-scope (escalated for an architect spec)

A Wasm-GC generic reader **cannot** `array.get` an arbitrary `$__vec_base`
subtype (the backing array type is unknown at the read site), so "teach the
reader to recognize all typed vecs" is not expressible. The fix must **normalize
representation at the boundary**, and that raises design questions a blind patch
must not decide:

- **Candidate A — coercion-engine normalization.** When coercing a
  `$__vec_<typedref>` to `externref`/`any` for a generic/dynamic argument or
  param, materialize a `$__vec_externref` (box each element, `extern.convert_any`
  per element) instead of a raw `extern.convert_any` on the container. The
  callee's universal reader then recognizes it. (Symmetric inverse of #2831's
  `buildVecFromExternref` materializer.) **Open design issues:** (1) **container
  identity** — a boxed copy is a *new* object, so `arr === sameArrPassedDynamically`
  and callee-mutates-container-visible-to-caller both change; element identity is
  preserved (same refs re-stored). For acorn this is safe (it mutates *elements*
  in place and uses the *returned* list), but it is a general semantic change.
  (2) Which source vecs to normalize (nominal-struct only? vec-of-vec? tuple
  vecs?). (3) Every dynamic-boundary coercion site + funcIdx-shift / late-import
  hazards (the #2831/#1461/#2193 pain). (4) standalone floor + full `merge_group`.
- **Candidate B — construction-site inference.** Build an array-of-objects as
  `$__vec_externref` when its value may escape to an `any`/dynamic context.
  Inference-scale; risks over-boxing arrays that never escape.

Both are representation-scale (reference_2379 hazard). Recommend an architect
spec choosing A vs B and resolving the identity/mutation-semantics question
before any code. **Senior-dev / architect, `reasoning_effort: max`, `horizon: l`.**

## Acceptance (bar = #1712)

- `parse("x=>x")`, `parse("(x)=>x")`, `parse("(a,b)=>a")`, `parse("f((x)=>x)")`
  on compiled acorn return the correct AST (no `WebAssembly.Exception`),
  structurally equal to node-acorn.
- The minimal `.tmp/repro-dyn2.mjs` `objlit-method-arr` / `anyfn-arr-arg` cases
  return `"Identifier"`.
- The real-world NM differential (`edge.js` module + `background.js` script)
  compiled-acorn vs node-acorn is **structurally equal** (modulo known quirks:
  always-null `sourceFile`, boolean-as-i32) — THE #1712 bar.
- 0-regression `merge_group` + standalone-floor (watch `built-ins/Array/**`,
  any-receiver dispatch, and array-identity/`===` buckets). Broad-impact ⇒ full
  CI, never scoped.

## Pointers

- acorn raise: `toAssignable` default `acorn.mjs:2167`; arrow param path
  `acorn.mjs:3025` (`[id]`), `3535` (`toAssignableList`), `2179` (element read).
- Compiler: the dynamic any-receiver **index-read** helper (locals `$__nve_recv`,
  `$__nve_idx`, `$__nve_any` in `consume`'s WAT) — only `ref.test`s
  `$__vec_externref` / `$__vec_f64`; `src/codegen/type-coercion.ts` coercion of
  `(ref $__vec_*)` → externref (currently raw `extern.convert_any`); contrast
  #2831's `buildVecFromExternref` / `buildVecFromExternMaterializer` (the inverse).
- Repro infra (this branch `.tmp/`, gitignored): `arrow-probe.mjs`,
  `arrow-instr{,2,3,4,5}.mjs` (acorn instrumentation), `repro-dyn{,2,3}.mjs`
  (minimal no-acorn repros), `dump-mini.mjs` + `mini.wat` (the WAT evidence),
  `nm-diff.mjs` (full-file differential).
- Verified on freshly-compiled pinned acorn@8.16.0, 2026-06-29 (sendev round 3,
  branch `issue-arrowparam-toassignable`, stacked on #2831/PR #2311).
