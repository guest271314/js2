---
id: 2687
title: "acorn parse() — ExpressionStatement.expression is null (parsed Literal not attached to the statement node)"
status: done
assignee: ttraenkler/dev1
sprint: 67
created: 2026-06-26
updated: 2026-06-27
completed: 2026-06-27
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2681, 2674, 2664, 2659, 2660]
depends_on: [2660]
origin: "Surfaced re-verifying the acorn dogfood after #2085 fixed the 9th-wall hang (sd-2674c, #2674). The numeric/empty statements that DO parse return an ExpressionStatement whose `.expression` is null — the parsed Literal is not attached to the statement node. CONFIRMED a real codegen defect (not a host-marshalling artifact) by a direct struct-walk."
---

# #2687 — acorn `parse()`: ExpressionStatement.expression is `null`

## Context (the acorn dogfood chain → #1712)

After PR #2085 fixed the 9th-wall HANG (#2674), the simple statements that DO
parse on compiled acorn return a structurally INCOMPLETE AST vs node-acorn.

## Confirmed defect (direct struct-walk, NOT a marshalling artifact)

A direct live-object struct-walk (sd-2674c, `.tmp/structwalk.mjs`, one acorn
compile) — accessing `stmt.expression` DIRECTLY, not via `JSON.stringify`:

```
"1;"  → program.type=Program bodyLen=1
        stmt: { type:"ExpressionStatement", start:0, end:2,
                loc:undefined, sourceFile:undefined, range:undefined,
                expression: null }                       ← the Literal is MISSING
        stmt.expression (direct) = null
        stmt ownKeys = [type,start,end,loc,sourceFile,range,expression]
"1"     → same: expression = null
"true;" → same: expression = null
";"     → EmptyStatement (no expression field) — CORRECT
```

The `expression` own-key IS present and directly readable, but its value is
genuinely `null`, while sibling string fields (`type="ExpressionStatement"`) read
correctly. So this is a **real codegen defect**, not a host-marshalling-depth
artifact: acorn's `parseExpressionStatement` does
`node.expression = expr; return this.finishNode(node, "ExpressionStatement")`, and
the `expression` child (the parsed `Literal`) is not attached to the freshly-built
Node.

(`loc`/`range`/`sourceFile` being `undefined` is benign — acorn only populates
loc/range when `locations`/`ranges` options are set; `sourceFile` is an internal
Node field. The only real divergence vs node-acorn is `expression: null`.)

## Suspected locus (verify-first — do NOT assume)

`parseExpressionStatement(node, expr)` → `node.expression = expr; finishNode(...)`.
The write `node.expression = expr` is to a freshly-`new Node()` struct. Candidates:
- the WRITE `node.expression = <Literal>` is dropped (the #2664 write-dispatch /
  multi-shape struct-slot family — `node` is a `Node` struct, the write may miss
  the slot or hit a sidecar that the later READ doesn't see); OR
- `parseExpression()`/`parseLiteral()` returns the Literal correctly but the
  assignment target `node` is a different representation than the one returned by
  `finishNode` (read/write representation divergence — same family as #2674).

Verify with the banked `.tmp` probes (instrument `__set_member`/`__extern_set` for
key `expression` on a Node receiver, single acorn compile ~290s). Likely the same
struct-slot write/read family as #2664/#2655/#2659 — possibly already addressed
for other fields by the #2664 `__set_member_<name>` dispatcher; re-probe to see if
`expression` specifically diverges.

## Acceptance
- Localize (verify-first) why `node.expression` is null on the returned
  ExpressionStatement; fix it.
- Compiled-acorn `parse("1;")` returns `ExpressionStatement{ expression:
  Literal{ value: 1 } }` matching node-acorn (the #1712 differential passes for
  literal expression statements).
- Full merge_group / test262 (codegen-adjacent).

## ROOT CAUSE (pinned, dev1 2026-06-27) — higher-arity prototype-method host dispatch was un-emitted, NOT a dropped write

The suspected-locus hypotheses (dropped `node.expression = expr` write, or a
read/write representation divergence) were BOTH wrong. A chained per-level
diagnostic probe (instrument every return in
`parseExpression → parseMaybeAssign → … → parseExprAtom/parseSubscripts`, surface
the tags on the statement node, single ~26 s acorn compile) pinned it precisely:

- `parseLiteral` and `parseExprAtom` return a valid `Literal` (`__d_atom=2`), but
  **`parseExprSubscripts` returns null** (`__d_subs=-1`). So `expr` is already
  null when `parseExpressionStatement(node, expr)` runs — the write attaches a
  genuinely-null value (`exprWasNull=1`), it is NOT dropped.
- Inside `parseSubscripts`, the loop runs twice and **`this.parseSubscript(...)`
  returns null without its body ever executing** — even a first-line call-counter
  `this.__d_subCalls` stays `undefined`, while the sibling `this.__d_ps_*` writes
  (same `pp$5` `this`) DO surface. So `parseSubscript`'s body never ran; the
  method-call returned null.

`parseSubscript` is an **arity-7** prototype method
(`base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit`).
A `this.parseSubscript(...)` on an `any`/externref receiver wraps the lifted
closure and dispatches it through `__call_fn_method_<N>` (runtime.ts
`wasmClosureBridge` / `wasmClosureDynamicBridge`). The compiler emitted
`__call_fn_method_N` only for **N=0..5** (the highest being the #1712 fnctor
arity-5 bridge). Each dispatcher's membership filter is
`info.paramTypes.length <= arity`, so the arity-7 closure was **OMITTED** from the
highest-available `__call_fn_method_5` → the dynamic method call returned null →
`parseSubscript` returned null → null bubbled up the entire expression chain →
`ExpressionStatement.expression = null`.

This is the **symmetric companion to #2664**: #2664 fixed a method invoked with
FEWER args than its declared params (dispatched too LOW); #2687 is a method whose
DECLARED arity EXCEEDS the highest emitted dispatcher.

Confirmed against the compiled module: `__call_fn_method_N` exports were
`0..5` only. acorn's prototype-method arity histogram tops out at 8
(`parsePropertyValue`), with 7 (`parseSubscript`) and 6 present.

## FIX (src/codegen/index.ts, finalize)

After `emitClosureMethodCallExportN(ctx, 5)`, emit one dispatcher per arity up to
the module's actual max closure arity, capped at 8 (the dynamic bridge's existing
scan range — `_wrapWasmClosureUnknownArity` iterates `a = 8..0`):

```ts
let maxClosureArity = 5;
for (const info of ctx.closureInfoByTypeIdx.values())
  if (info.paramTypes.length > maxClosureArity) maxClosureArity = info.paramTypes.length;
for (let n = 6; n <= Math.min(maxClosureArity, 8); n++) emitClosureMethodCallExportN(ctx, n);
```

`emitClosureMethodCallExportN` no-ops when no closure of arity ≤ N exists, so
modules whose methods top out at ≤5 are byte-identical. Low-arity closures in a
module that DOES have arity-6/7/8 methods are unaffected: each closure is still
dispatched at its OWN arity at the wasm dispatch arm (extra padding args dropped).

## Test Results
- Compiled pinned acorn: `parse("1")` / `parse("1;")` / `parse("true;")` now
  return `ExpressionStatement{ expression: Literal{...} }` (was `expression: null`).
- New `tests/issue-2687.test.ts` (4 tests): arity-6/7/8 prototype methods invoked
  via `this.m(...)` now RUN (were null); arity-≤5 unaffected. Confirmed genuine
  regression guard — reverting the fix returns null/0.
- Method-dispatch family green: #2664, #2674, #1712 (dynamic-dispatch/tokenizer/
  capture), #1636 (json-stringify/tojson), #2015, #2731, #1382.
- `tsc --noEmit` clean; prettier clean.
- NOTE: `tests/issue-1712-capture-closure-dispatch.test.ts` has one PRE-EXISTING
  failure on clean origin/main (`__call_fn_1 dispatches an arity-0 capturing
  closure`) — fails identically WITHOUT this change; unrelated to #2687.
- OUT OF SCOPE (still substrate-blocked, separate read-side root): #2681
  (`parse("x")` identifier path THROWS) and #2686 (`parse("1 + 2 * 3;")` binary
  THROWS) — the parseExprAtom `switch (this.type)` host-proxy mis-comparison.
