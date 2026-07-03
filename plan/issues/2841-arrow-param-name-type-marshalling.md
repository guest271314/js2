---
id: 2841
title: "arrow / function-expression param Identifier nodes lose name+type on HOST readback (compiled-acorn AST != node-acorn)"
status: done
completed: 2026-06-29
assignee: ttraenkler/agent-senior-2841
sprint: 69
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: runtime-marshalling
language_feature: ast-readback
goal: acorn-dogfood
related: [2836, 2837, 2838, 2801, 2186, 2151, 1712]
depends_on: []
blocks: [1712]
umbrella: 1712
---

> **DONE (agent-senior-2841, 2026-06-29).** Root cause is HOST MARSHALLING, not
> value-rep and not codegen — the arrow param Identifier node's `name`/`type`
> ARE present in-wasm (reachable via `__extern_get`). The bug: a wasm vec that
> crosses a dynamic-dispatch `any` boundary is materialised by the host shim
> `__make_iterable` into a REAL host JS array of OPAQUE wasm structs (#2836). When
> that array is then read back as a struct field through the `_wrapForHost` proxy
> (acorn `node.params`), the proxy returned the JS array RAW, leaving its
> Identifier elements unwrapped → `param.type`/`param.name` read `undefined`.
> Declaration / function-expression params take the `parseBindingList` path and
> stay a genuine wasm vec (routed to `_wrapVecForHost`, which wraps elements), so
> ONLY arrow params (and any field arriving as a host JS array of structs) were
> affected. Fix: wrap host-array struct elements on read in the `_wrapForHost`
> proxy `get` (load-bearing), plus the symmetric `_wasmToPlain` host-array
> recursion for the marshal:"copy"/JSON consumers. **Verified: the uncapped NM
> differential `background.js` went from 2 non-quirk divergences
> (`params[0].type`, `params[0].name`) to ZERO.** A SEPARATE gap surfaced (the
> spurious `attributes: []` on import/export nodes) — it is NOT marshalling but a
> distinct dynamic-property type-inference codegen bug (ecmaVersion 2022 is not
> normalised to 13, so `2022 >= 16` wrongly enables import-attributes). Carved to
> **#2849** and escalated (separate root cause; also blocked behind #2325 for
> edge.js).

# #2841 — arrow / fn-expression param Identifier nodes lose `name`+`type` on host readback

The genuine remaining gap (after #2836 broke the `Assigning to rvalue` arrow
wall) for compiled acorn to parse real Native-Messaging files LITERALLY equal to
node-acorn. Surfaced by the UNCAPPED NM differential (the default
`maxDivergences:8` truncated before reaching function bodies, hiding it — #2836's
"zero non-quirk" claim was a capped-diff artifact).

## Symptom (uncapped differential, ecmaVersion 2022)

- `background.js`: 2 non-quirk divergences, both on the arrow passed to
  `chrome.runtime.onMessage.addListener((reason) => …)`:
  `…arguments[0].params[0].type` (`"Identifier"` → `undefined`) and
  `.params[0].name` (`"reason"` → `undefined`).
- `edge.js`: 62 such arrow/fn-expr params — but edge.js cannot be parsed on
  current `main` (it hits the #2838 `return` wall, fixed only by the in-flight
  PR #2325). Verified separately by stacking #2325.

## Control (proves it is marshalling, not value-rep)

- Function **declaration** params marshal correctly:
  `parse("function f(reason){g(reason)}").body[0].params[0]` →
  `{type:"Identifier", name:"reason"}`. ✓
- Function **expression** params also marshal correctly (same `parseBindingList`
  path). ✓
- Only **arrow** params come back `{}` (empty). The data IS in-wasm: hooking the
  host `__extern_get` import shows `get(arrowParamsContainer, 0)` →
  `{type:"Identifier", name:"reason"}` for BOTH decl and arrow.

## Root cause (host marshalling)

`compiled.parse(...)` returns a `_wrapForHost` proxy tree. Reading a struct
field whose value is a wasm vec routes through `_wrapVecForHost` (line ~5519:
`__is_vec(val)===1`), which wraps each element on index read — so decl/fn-expr
params (genuine wasm vecs) navigate fine.

Arrow params are different: acorn parses `(reason)` as a paren `exprList`, then
calls `this.parseArrowExpression(node, exprList, …)` — a **dynamic method
dispatch**. The vec arg is coerced `(ref $vec) → externref` at the any-boundary,
which attaches the host shim `__make_iterable`. `__make_iterable` materialises
the vec into a **real host JS array** of the (opaque, post-#2836) Identifier
structs, and that JS array becomes `node.params`. On readback the `_wrapForHost`
proxy `get` reached its fall-through `return val;` for a non-wasm-struct value —
a host JS array is NOT a wasm struct (`__is_vec` is 0, `Array.isArray` is true),
so it was returned RAW. Its element `params[0]` was therefore an UNWRAPPED wasm
struct; plain JS access (`.type`/`.name`) on a raw struct yields `undefined`.

`__sget_type` returns "Identifier" on the raw struct, but `name` lives in the
node's dynamic-property store (no `__sget_name` of its own shape) — both are only
reachable through the `_wrapForHost` proxy / `__extern_get`, which the raw
element bypassed.

## Fix (contained, host-only)

`src/runtime.ts`:

1. **`_wrapForHost` proxy `get` (load-bearing)** — before the final
   `return val`, when the resolved field value is a real host JS array, return a
   cached view (`_wrapHostArrayElems`) that `_wrapForHost`-wraps each STRUCT
   element on index read (mirrors `_wrapVecForHost`). Primitives / plain objects
   pass through; genuine wasm vecs were already handled above and are not
   `Array.isArray`. This alone takes `background.js` to 0 non-quirk.
2. **`_wasmToPlain` host-array recursion (symmetric robustness)** — the
   marshal:"copy" / `JSON.stringify` flatten path returned host JS arrays as-is
   (`!_isWasmStruct` early-out), so a copy/JSON consumer would also see opaque
   elements. Recurse element-wise (with cycle guard) so the deep copy reaches the
   structs.

Both are host-mode marshalling only; standalone keeps the native WasmGC vec
readers (no parallel bug, floor cannot regress).

## Why NOT value-rep / NOT escalated for the arrow fix

The architect-escalation trigger ("needs a broad value-rep change") did not fire:
the in-wasm AST is already correct (data present and reachable). #2836's earlier
Candidate-A/B value-rep normalisation is unnecessary; the smallest correct fix is
two host-marshalling sites. Container + element identity are preserved (the view
is a cached lazy wrapper, no copy).

## Verification

- Uncapped NM differential (`maxDivergences: 100000`): `background.js`
  **2 → 0** non-quirk divergences; `sanity` 0; the only remaining divergences
  across the suite are the two accepted quirks (`sourceFile`, boolean-as-i32).
- `parse("x=>x" | "(x)=>x" | "(a,b)=>a" | "(reason)=>g(reason)")` →
  `params[*]` carry `{type:"Identifier", name:…}`.
- `function f(reason)` declaration params stay correct (control).
- Regression test `tests/issue-2841-arrow-param-name-type-marshalling.test.ts`
  (4 cases; the host-array element wrapping + scalar no-regression). Guards the
  `_wasmToPlain` twin directly; the proxy twin is guarded by the NM differential
  + the #1712 dogfood gate.
- `#2836` regression suite + dogfood `acorn.test.ts` still green; full typecheck
  clean.

## Acceptance

- [x] `background.js` uncapped differential: ZERO non-quirk divergences.
- [x] arrow/expr params carry correct `name`+`type`; decl params stay correct.
- [x] `edge.js` arrow/expr params: ALL cleared. With #2325 now merged to `main`,
  edge.js parses and the uncapped differential shows **4** non-quirk
  divergences, ALL the spurious `attributes: []` (every one of the 62 arrow/expr
  params + all other prior divergences are gone; the 276 boolean mismatches are
  the accepted bool-as-i32 quirk). The remaining 4 `attributes` are carved to
  **#2849** (distinct dynamic-property type-inference codegen bug). edge.js will
  reach 0 non-quirk once #2849 lands.
- [x] 0 test262 regressions expected (host-marshalling, additive); full
  merge_group + standalone-floor on CI.

## Pointers

- `src/runtime.ts`: `_wrapHostArrayElems` (new), `_wrapForHost` proxy `get`
  fall-through, `_wasmToPlain` array branch; contrast `_wrapVecForHost`
  (the wasm-vec analog) and the #2836 `__is_vec` gate in `__make_iterable`.
- acorn arrow path: `parseArrowExpression(node, exprList)` (entry module
  ~3535 `toAssignableList`); the paren `exprList` is the dynamic-dispatch vec arg.
- Follow-up: **#2849** (spurious import/export `attributes: []` from failed
  ecmaVersion normalisation — dynamic-property type-inference codegen bug).
