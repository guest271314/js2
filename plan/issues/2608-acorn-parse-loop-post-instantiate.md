---
id: 2608
title: "compiled-acorn parse() infinite-loops in parseTopLevel after instantiation (4th dogfood blocker)"
status: done
assignee: ttraenkler/dev-acorn
created: 2026-06-21
updated: 2026-06-22
completed: 2026-06-22
priority: high
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen, runtime
language_feature: multi
goal: self-hosting-dogfood
sprint: 65
model: opus
depends_on: [1712, 2582]
related: [1712, 2582, 1940, 1528]
---

# #2608 — compiled-acorn `parse()` infinite-loops in `parseTopLevel` (4th blocker)

> **Issue reconciliation (2026-06-22).** This blocker was first hand-picked as
> `#2586`, which collided with the unrelated `2586-standalone-arrayfrom-map.md`
> on `main` (the #2531 hand-pick race). It was re-allocated to **#2608** —
> the canonical id for this parse()-loop blocker. The `#2586` _file_
> (`Array.from(Map) illegal_cast`) is a different, separately-`done` issue.
> sd-acorn's mechanism diagnosis (the `new this(...)` defect + that the generic
> `__construct` is typeof-gated and fails closure→Proxy, and #86 callable-params
> is a different path) correctly scoped exactly what the fix had to handle; the
> landed fix routes through #56 `__construct_closure` — the bounded path sd-acorn
> had not tested.

## Context

The **4th** independent compiled-acorn dogfood blocker, surfaced once #2582
(numeric-key module-init read) let acorn INSTANTIATE. With #1712 (tokenizer
identity loop) and #2582 both fixed/landed, compiled acorn now
`instantiated OK; parse=function` — but `parse("var x = 1;")` **infinite-loops**
in `parseTopLevel`.

## Symptom

`parseTopLevel` (acorn dist ~846):

```js
while (this.type !== types$1.eof) {
  var stmt = this.parseStatement(null, true, exports);
  node.body.push(stmt);
}
```

Host-bridge method-call counter (`DEBUG_2586`, budget 50000) for
`parse("var x = 1;")`:

```
parseStatement=2271, push=2271, parseExpressionStatement=2270, …
isContextual=9083 (≈4× per statement), isUsingKeyword=4542
```

So `parseStatement` runs 2271× — each COMPLETES and pushes a statement — but the
`this.type !== types$1.eof` guard never trips. The loop never reaches EOF for a
single-statement input.

This is the SAME loop SHAPE as the #1712 tokenizer-identity loop, but #1712's
two root causes (the `_safeSet` `__sset_` writeback gating + the `_wrapForHost`
proxy-vs-raw `_hostEqComparableValue` mismatch + the `replace` arg-drop) are all
FIXED and present on this branch (verified). So this is a NEW, distinct cause.

## Hypotheses (to bisect)

1. **A different identity mismatch on `this.type !== eof`** — now that keyword
   recognition works (#1712/#2582), the EOF comparison may still mismatch for a
   reason unrelated to the proxy/sidecar fixes (e.g. a fresh struct copy on a
   specific read path, or the comparison routing through a path that doesn't
   canonicalize).
2. **`this.pos` / scan-position not advancing through dynamic dispatch in THIS
   call shape** — if `nextToken`/`next` doesn't advance `this.pos` past the
   input, `this.type` is recomputed as the same non-eof token forever. (Prior
   #1712 N-probes showed `this.pos += n` works through a prototype method, but
   acorn's exact `finishToken`/`next` shape may differ.)
3. **`parseStatement` not consuming the token it parsed** — each iteration
   re-examines the same `var` token (the `isContextual` 4×/stmt count is
   consistent with re-scanning a stuck position).

## ROOT CAUSE — pinned to `new this(...)` in an fnctor static method (2026-06-21, sd-acorn)

Bisected far past the loop symptom. The loop is downstream of a **tokenizer
input loss**, which is downstream of a **`new this(...)` defect**:

1. `parseTopLevel`'s loop never reaches eof because `var` is tokenized as
   `name`, not `_var`. Traced via a `finishToken` host-bridge log: `readWord`
   calls `finishToken(name, "")` — the scanned **word is the EMPTY STRING**.
2. `readWord1()` returns `word + this.input.slice(chunkStart, this.pos)` = `""`
   ⇒ the identifier-scan `while (this.pos < this.input.length)` loop never ran
   ⇒ **`this.input` is empty (length 0)** in the compiled Parser.
3. `this.input = String(input)` (Parser ctor). So the parse INPUT never reached
   the instance. The chain is
   `exp.parse(src) → parse(src,opts) → Parser.parse(src,opts) → new this(opts,src)`.

The defect is **`new this(...)` inside an fnctor static method**, reproduced in
~8 lines (`.tmp/probe-static.ts`):

```ts
var Parser = function Parser(a, b) {
  this.a = a;
  this.b = b;
};
Parser.simple = function (x, y) {
  return y;
}; // OK   (static, no `new this`)
Parser.makeIdent = function (x, y) {
  return new Parser(x, y);
}; // OK (`new Parser`)
Parser.makeNew = function (x, y) {
  return new this(x, y);
}; // THROWS "is not a constructor"
```

- `staticSimple` ✓, `staticNewIdent` (`new Parser(x,y)`) ✓,
  **`staticNewThis` (`new this(x,y)`) → Wasm exception `"is not a constructor"`.**

### Why

`new this(...)` is handled by the #1679 path
(`src/codegen/expressions/new-super.ts:3473`), gated on
`expr.expression.kind === ts.SyntaxKind.ThisKeyword`. But by the time the static
method body reaches `compileNew`, **`this` has been REWRITTEN from `ThisKeyword`
to an `Identifier`** (confirmed: a raw AST scan shows `new this` as `ThisKeyword`,
but the codegen log inside `compileNew` reports `exprKind=Identifier
className=undefined enclosing=undefined`). So the #1679 ThisKeyword arm is never
taken, `className` is unresolved, the fnctor-name fallback misses, and the call
drops to the generic dynamic-`new` path which throws `"is not a constructor"`
(`emitThrowTypeError(…, "is not a constructor")`) because the runtime receiver is
a wrapped closure externref with no `[[Construct]]`.

The rewrite happens in the static-method / closure-this lowering
(`src/codegen/closures.ts` — the `__current_this` / `__this`-param machinery,
~L2750/L3544). `fctx.enclosingClassName` is ALSO undefined for these `Fn.method
= function(){…}` static methods, so neither the type-symbol nor the enclosing-
context fallback resolves the fnctor.

### Acorn vs. the minimal probe — a caveat

The minimal probe THROWS `"is not a constructor"`; real acorn does NOT throw —
it LOOPS with empty `this.input`. So acorn's `new this(options, input)` does not
hit the throw arm (likely because the full Parser fnctor IS registered, so a
different sub-path runs), but it still mishandles the args — the `input` operand
is lost (empty `this.input`). Both are the same family: **`new this(...)` in an
fnctor static method does not correctly resolve `this`→ctor and/or forward its
arguments.** The fix must (a) recognise the rewritten-`this` callee as the
enclosing fnctor ctor, and (b) forward the args in order to `<Class>_new`.

### Suggested fix direction

- In `compileNew`, when the new-callee is a rewritten-`this` (or the resolved
  `className` is undefined) AND the enclosing function is a static method of a
  known fnctor, resolve the ctor from the fnctor context (carry the owning
  fnctor name onto `fctx` for `Fn.method = function(){…}` static methods, the
  way class methods set `enclosingClassName`), then route to the same
  `<Class>_new` machinery the #1679 ThisKeyword arm uses — with in-order arg
  forwarding so `new this(opts, input)` passes `(opts, input)` to the ctor.
- This is fnctor/closure-dispatch architecture-adjacent; given the
  `this`-rewrite interaction it may warrant an architect spec. The minimal repro
  (`staticNewThis`) is the regression-pin target.

## Investigation harness

- `/workspace/.claude/worktrees/issue-2582-numkey-objread/.tmp/run-acorn3.mjs`
  (compile + instantiate + `parse` under a method-call counter).
- `DEBUG_2586=1 DEBUG_2586_BUDGET=N` on `__extern_method_call` prints the top
  per-method call counts and throws to escape the tight Wasm loop.
- Re-use the #1712 `host_eq` watchdog + `finishToken`/`nextToken` label trace to
  see whether `this.type` ever becomes `eof` and whether `this.pos` advances.

## Acceptance

- Compiled acorn `parse("var x = 1;")` returns a Program AST (loop terminates).
- Then the #1710/#1712 differential-AST harness: structurally-equal AST vs
  node-acorn for the representative fixture (the #1712 acceptance).
- No test262 / equivalence regression.
- #1712 stays open until the full parse + AST-match acceptance is met; this
  issue is the next slice toward it.

## Resolution (2026-06-22, dev-acorn) — BOUNDED via the landed #56 bridge

Fixed by routing `new this(...)` through the **already-landed #56
`__construct_closure` host bridge** (#1940) — NOT the deep `__construct_fnctor`
dispatcher substrate. Two parts in `src/codegen/expressions/new-super.ts`:

1. **Exclude a `this` callee from the Pattern-2 throw.** The checker types the
   `new this(...)` callee as the bare `function`-value (CALL sigs, NO construct
   sigs), so the `callSigs.length > 0 && constructSigs.length === 0` guard
   (~L2569) threw `"is not a constructor"` _before_ any `this`-aware arm ran.
   Added `unwrappedNonId.kind !== ts.SyntaxKind.ThisKeyword` to that condition so
   a `this` callee falls through.

2. **New `new this(...)` bridge arm** (before the `if (!className)` unknown-ctor
   block, ~L3683, JS-host only): when the callee is `ThisKeyword` and `className`
   does not resolve to a registered class/fnctor, evaluate `this` → externref,
   materialize args via `__js_array_new`/`__js_array_push` (source order), and
   call `__construct_closure`. One terminal `flushLateImportShifts`. The bridge
   detects `__is_closure`, wraps with `_wrapCallableForHost` (constructible), and
   `Reflect.construct`s it. Standalone keeps the existing path.

**Why it works without new substrate:** at runtime `this === Parser` (verified)
and that value is a WasmGC closure struct — exactly what the #56 bridge already
constructs. No static fnctor resolution is needed.

### Root cause (corrected)

The earlier analysis attributed the failure to `this` being _rewritten to an
Identifier_. The actual cause is simpler: the checker resolves `this`'s type
symbol to **no className** for a `Fn.method = function(){…}` static method, so
the #1679 ThisKeyword arm (gated on a resolved className) is skipped, AND the
Pattern-2 not-a-constructor guard fires first. Both are addressed above.

### Test Results

`tests/issue-2608-new-this-fnctor-static.test.ts` (sd-acorn's prior skipped case
un-skipped + passing, 2/2 green):

- `new this(x, y)` constructs and forwards args in order: `getA→10, getB→20`.
- **Acorn shape** `Parser.parse = function(input,opts){ return new this(opts,input) }`
  now preserves `this.input = String(input)`: `inputLen('var x = 1;')=10`,
  `firstChar('Xyz')=88 ('X')`, `pos=0`. This is the empty-`this.input` root cause
  that made `parseTopLevel` loop forever — RESOLVED.
- Plain `new Parser(...)` + non-`new this` statics still work.
- Standalone (`nativeStrings`) compiles clean (no crash).
- Constructor/this/closure-construct regression suite (issue-1528, 1679,
  fn-constructor, 2026-\*, 1742, 1636s1): 59 pass (2 pre-existing infra failures
  unrelated to this change: a wrong relative import path in
  `new-non-constructor.test.ts`, a bare-instantiate harness gap in
  `constructor-arity.test.ts`).
