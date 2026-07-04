---
id: 2836
title: "[SENIOR-DEV ONLY] typed nominal-struct vec ($__vec_ref_*) loses its elements when passed as an `any` argument through an indirect/dynamic call — compiled acorn cannot parse arrow functions with ≥1 param"
status: done
completed: 2026-06-29
assignee: ttraenkler/sendev-arrowparam
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
related: [2831, 2806, 2809, 2379, 2151, 2186, 1917]
depends_on: []
blocks: [1712]
architect_spec: done
---

> **DONE (sendev-arrowparam, 2026-06-29).** Implemented the architect's verified
> host-shim `__is_vec` gate at BOTH sites in `src/runtime.ts` (`__make_iterable`'s
> `convertToJS` and `_convertIterableForHost`). VERIFY-FIRST confirmed: all arrow
> repros (`x=>x`, `(x)=>x`, `(a,b)=>a`, `f((x)=>x)`) parse AST-equal to node-acorn;
> the minimal `repro-dyn2.mjs` dynamic cases return `"Identifier"`. **Milestone:
> the `background.js` NM differential is now structurally equal to node-acorn
> modulo only the documented quirks (null `sourceFile`, boolean-as-i32
> `computed`/`optional`)** — `diffAst` reports zero non-quirk divergences. Bonus:
> default-param (`f(a=1)`) and rest-param (`f(...a)`) arrows/functions also parse
> now (same host-shim path). Dual-mode: `__make_iterable` is host-only
> (`!ctx.standalone && !ctx.wasi`), standalone keeps the native WasmGC vec readers
> — no standalone parallel bug, floor cannot regress. Regression test:
> `tests/issue-2836-typed-vec-dynamic-dispatch-arg.test.ts` (6 tests). Remaining
> `edge.js` walls (block-body arrow `(a)=>{…}`) carved to **#2837** (round 4).

# #2836 — typed-struct vec (`$__vec_ref_*`) elements are lost across an indirect/dynamic-dispatch `any` argument

> NOTE (architect, 2026-06-29): the diagnosis below ("generic reader can't read
> a typed-struct vec") was the prior senior-dev's WAT-grounded hypothesis. The
> architect verify-first pass **superseded it** — the real root cause is the
> host shim `__make_iterable`, and the fix is a 2-site host-runtime guard, NOT a
> coercion-engine change. See `## Implementation Plan` at the bottom. The
> original diagnosis is retained for history.

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

## Implementation Plan (architect, 2026-06-29 — VERIFY-FIRST supersedes Candidate A/B)

### TL;DR — neither Candidate A nor B; the root cause is a host-shim bug

I reproduced on the issue branch, dumped the WAT for the static (works) vs
dynamic (fails) call, and traced the actual data loss. **The diagnosis above
("the generic index-reader can't `array.get` a typed-struct vec") is a red
herring.** The generic readers (`__vec_get`, `__is_vec`, the inline `__nve_*`
guard) are all SWITCHES that already enumerate every registered vec type
(`getOrRegisterVecType` registers EVERY vec — incl. nominal-struct vecs keyed
`ref_<typeIdx>` — into `ctx.vecTypeMap`; `__vec_get` emits a per-type
`ref.cast`+`array.get` arm for each). The element is **not** lost in the reader.

The element is destroyed in the **JS host import `__make_iterable`**. Decisive
evidence (`.tmp/cmp-{static,dynamic}.wat`):

- **Static `consume({}, [mkId()], false)`** → **0** `__make_iterable` refs in the
  emitted WAT. The wasm vec passes straight through; the callee reads it natively
  → returns `"Identifier"` (works).
- **Dynamic `o.c({}, [mkId()], false)`** (call_ref, generic `(externref,…)`
  signature) → the arg is coerced `(ref $vec) → externref` at the any-coercion
  boundary, which attaches `__make_iterable` (`src/codegen/type-coercion.ts:1793–1804`,
  host-mode only). At runtime `__make_iterable`'s `convertToJS`
  (`src/runtime.ts:12203`) **recursively converts the wasm vec into a real JS
  array** and, per element, recurses into `convertToJS(__vec_get(vec, i))`.
- For an **object element** (a `$obj` nominal struct), `convertToJS` mistakes it
  for a vec: it gates the vec branch on `__vec_len(obj) >= 0`, but **`__vec_len`
  returns its not-a-vec default `0` for ANY non-vec struct**
  (`src/codegen/index.ts:4786`). So a plain object → `len = 0` → `new Array(0)` →
  **empty array**. That is exactly the observed "`params[0]` became an empty
  `Array`, `Object.keys === []`".
- **Scalars survive** because `__vec_get` returns a JS number/string for
  `f64`/`externref` element vecs, and `convertToJS(number|string)` returns it
  unchanged — matching the element-type sensitivity table above.

`__vec_len` cannot distinguish "empty vec" from "not a vec"; the codebase already
ships the correct positive discriminator **`__is_vec`** (`src/codegen/index.ts:5025`,
a `ref.test $__vec_base` over all registered vec types).

### Root cause

`convertToJS` (and its sibling `_convertIterableForHost`) treat every WasmGC
struct as a vec because the `__vec_len(obj) >= 0` gate is always true. A non-vec
object element is therefore flattened to an empty JS array, erasing its fields.

### The fix — one host-side guard (NOT a coercion-engine change)

Gate the vec-conversion branch on the existing `__is_vec` export so only genuine
vecs are converted; non-vec structs (plain objects, acorn `Node`s) pass through
opaque.

**File: `src/runtime.ts`**

1. `convertToJS` inside the `__make_iterable` import handler — **line ~12234–12246**
   (the `// Try vec struct (homogeneous arrays)` block). Operative site for #2836.
2. `_convertIterableForHost` (the `extern_class` constructor path) — **line ~2654–2666**
   — identical bug pattern; fix for consistency so the same corruption can't
   surface via the constructor/host-spread path.

Both: resolve `const isVec = exports.__is_vec as Function | undefined;` and add
`&& (typeof isVec !== "function" || isVec(obj))` to the existing
`typeof vecLen === "function" && typeof vecGet === "function"` condition. The
`typeof isVec !== "function"` fallback keeps old behavior if a module somehow
lacks the export (it never does when `__vec_len`/`__vec_get` exist — all three
are emitted together in the same finalize block gated on `vecEntries.length>0`).

The **tuple branch above** (numeric `_0,_1` via `__struct_field_names`) is
unchanged and still runs first, so `[k,v]` Map/Set entries keep converting.

Verified patch (proven against the repros below):

```ts
const vecLen = exports.__vec_len as Function | undefined;
const vecGet = exports.__vec_get as Function | undefined;
const isVec = exports.__is_vec as Function | undefined;
if (
  typeof vecLen === "function" &&
  typeof vecGet === "function" &&
  (typeof isVec !== "function" || isVec(obj))
) {
  const len = vecLen(obj) as number;
  …
}
```

### Container-identity / mutation question — MOOT under this fix

The header asks the architect to resolve box-always vs box-when-not-mutated vs
alias, because Candidate A *copies* the vec into a new `$__vec_externref`. **This
fix introduces no copy and no new container.** The vec still crosses the boundary
as the same value `__make_iterable` returns; we only stop the host shim from
mangling object *elements*. Element identity AND container identity are exactly
as before the fix (no behavioral change for any value already correct). There is
therefore no mutation-divergence to document. **Decision: do nothing — the
identity concern does not arise.** (Avoiding the vec→JS-array materialization for
wasm-bound dynamic callees is a future perf optimization, tracked separately,
not a correctness fix.)

Candidates A and B are both **rejected**: each adds representation-scale
machinery (a reserved per-vec boxing helper + funcIdx-shift discipline, or
flow-sensitive construction inference) to solve a problem that does not exist
(the reader is fine). They would also *introduce* the very container-identity
hazard the header worries about. The host-shim guard is strictly smaller, lower
risk, and read/write-consistent.

### Edge cases (all covered by the guard)

- **Empty vs non-empty vec**: a genuine empty vec still has `__is_vec === 1` →
  still converts to `[]` (correct). A non-vec object → `__is_vec === 0` → stays
  opaque (the fix).
- **Scalar element** (`[7]`, `["h"]`): unchanged — element is a JS number/string,
  not a wasm struct, returned as-is.
- **Object element** (`[{…}]`): now stays opaque → host `__extern_get`/native
  read returns the struct → field reads work.
- **Nested vec / vec-of-vec** (`[[1,2]]`): inner element IS a vec → `__is_vec`
  true → still recursively converts (preserved).
- **Tuple element** (`[[k,v]]` for Map): handled by the numeric-fields tuple
  branch ABOVE the vec branch → unaffected.
- **null / non-object**: early `obj == null || typeof obj !== "object"` return →
  unaffected.
- **Standalone / WASI**: `__make_iterable` is host-only (not attached under
  `ctx.standalone`/`ctx.wasi`, type-coercion.ts:1793) → no standalone behavior
  change; the standalone floor cannot regress from this edit.

### Test plan (bar = #1712)

VERIFIED by the architect on the issue branch with the patch applied:

- **Minimal repros** (`.tmp/repro-dyn2.mjs`): `static-arr-arg`, `anyfn-arr-arg`,
  `objlit-method-arr` all return `"Identifier"` (were undefined for the two
  dynamic cases). ✔
- **Compiled acorn arrows** (`.tmp/arrow-probe.mjs`): `() => 1`, `x => x`,
  `(x) => x`, `(a,b) => a`, `f((x)=>x)` ALL `OK` and AST-equal to node-acorn
  (were `THREW WebAssembly.Exception`). ✔
- **Destructured params** (`({a,b}) => a`): now `OK` (was THREW). ✔ (bonus — same
  root cause).
- **NM differential** (`.tmp/nm-diff.mjs`): `background.js` (script) reduces to
  only the **documented known quirks** — `sourceFile: null/undefined` and
  boolean-as-i32 (`computed`/`optional` `false` vs `0`). Per the #1712 bar these
  are accepted. ✔
- **0 regressions**: host-boundary change touching the vec→JS-array conversion.
  Run **full `merge_group` + standalone-floor** (broad-impact, never scoped).
  Watch buckets: `built-ins/Array/**`, spread/iterator, Map/Set-from-iterable,
  any-receiver dispatch, array-identity/`===`. Risk is low: previously any
  non-vec struct reaching `convertToJS` became `[]` (a latent corruption); the
  only behavior that changes is that such structs now stay opaque (the correct
  ES result).

Add a regression test under `tests/` (equivalence-style): the `objlit-method-arr`
/ `anyfn-arr-arg` shapes asserting `params[0].type === "Identifier"` through a
dynamic dispatch.

### Blast radius / classification

- **Surface**: 2 host-runtime call sites; no codegen/IR/type changes. Far smaller
  than the representation-scale change the header anticipated.
- **Impact axis**: every typed-struct (object-element) array marshalled to the JS
  host through `__make_iterable` for a dynamic/`any` consumer — i.e. the
  reference_2379 "typed-elem vs boxed-any" family, but the fix is at the host
  boundary, so it is uniform across all such vecs without per-type machinery.
- **Classification**: still **senior-dev, `reasoning_effort: max`** for the
  broad-impact CI/regression judgment, though the diff itself is small.

### NOT in scope — round-4 walls (file as follow-on, do not block this PR)

With the fix applied, `edge.js` (module, 1190 nodes) parses much further but
STILL throws, and the bisect (`.tmp/edge-bisect.mjs`) shows **independent
pre-existing walls** this fix does NOT address (they also throw WITHOUT the fix,
so they are not regressions):

- **block-body arrow** `(a) => { return a; }`  (expression-body arrows work)
- **default param** `function f(a = 1) {}`
- **rest param** `function f(...a) {}`

Separate marshalling paths (`parseMaybeDefault` / `parseBindingList` / arrow
block-body) — a "round 4" issue. #2836's stated acceptance repros (`x=>x`,
`(x)=>x`, `(a,b)=>a`, `f((x)=>x)`, background.js) are fully met by this fix; full
`edge.js` equality requires the round-4 walls and should be tracked in a NEW
issue, not gated on this PR.

### Repro infra (architect, this session)

`.tmp/repro-dyn2.mjs` (minimal), `.tmp/arrow-probe.mjs` (compiled-acorn arrows),
`.tmp/nm-diff.mjs` (NM differential), `.tmp/edge-bisect.mjs` (round-4 wall
bisect), `.tmp/cmp-{static,dynamic}.wat` (the 0-vs-2 `__make_iterable` evidence).
