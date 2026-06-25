---
id: 2681
title: "acorn parse() 10th wall — identifier expression-statement throws (unexpected() on a `name` token) after the #2664 arity-dispatch fix"
status: ready
assignee: ttraenkler/unassigned
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2664, 2674, 2659, 2656]
depends_on: [2664]
origin: "Surfaced by dev-acorn fixing #2664 (under-applied dynamic method dispatch). With parseExpression() now actually running, parse(\"1;\")/parse(\"1\") return a Program AST, but parse(\"x\")/parse(\"var x = 1;\") (any IDENTIFIER expression statement) now THROW a WebAssembly.Exception instead of hanging — acorn's unexpected() fires on the `name` token. Distinct mechanism from the #2664 hang."
---

# #2681 — acorn `parse()` 10th wall: identifier path throws `unexpected()` on a `name` token

## Context (the acorn dogfood chain)

Prior dogfood blockers cleared: #1712 b1-3, #2582, #2608, #2655/#2659, #2656,
#2664 (the 8th wall — type-write asymmetry), #2674 Fix1/Fix2 (#2072 chained-this,
#2075 read dispatcher), and the **#2664 arity-dispatch fix** (this PR): the host
method-call bridge under-dispatched a method invoked with FEWER args than its
declared param count (`this.parseExpression()` — 0 args, 2 params) →
`__call_fn_method_0` omitted the arity-2 closure → returned null → the method body
never ran → `parseTopLevel` spun forever.

## What we know (verify-first, dev-acorn)

After the arity-dispatch fix, on the compiled acorn (gc/host mode):

| input | result |
|---|---|
| `parse("")` | OK — `Program` bodyLen 0 |
| `parse(";")` | OK — `Program` bodyLen 1 (EmptyStatement) |
| `parse("1")` | **OK — `Program` bodyLen 1** (numeric expression statement) |
| `parse("1;")` | **OK — `Program` bodyLen 1** |
| `parse("x")` | **THROWS `WebAssembly.Exception`** (no message) |
| `parse("var x = 1;")` | THROWS `WebAssembly.Exception` |
| `parse("1 + 2 * 3;")` | THROWS `WebAssembly.Exception` |
| `parse("foo(bar, baz);")` | THROWS `WebAssembly.Exception` |

So **numeric/empty statements parse to a real AST** (the #1712 differential gate is
now runnable for those), but any statement that reaches the **identifier path**
throws.

## Localized (raise-site probe)

Instrumenting acorn's `raise` / `raiseRecoverable` / `unexpected` to log before
the `throw` on `parse("x")`:

```
UNEXPECTED @undefined type=name
THREW Exception
```

So acorn's `unexpected()` is called with `this.type === name` (pos `undefined`,
i.e. `unexpected()` called with no `pos` arg → uses `this.start`). `unexpected()`
→ `raise()` → `throw new SyntaxError(...)`, which propagates out as a
`WebAssembly.Exception`. For valid input `"x"` acorn must NOT throw — the parser
is reaching an error path it shouldn't on the `name` token.

## Candidate loci (do NOT assume — verify-first, same method as #2664)

With `parseExpression()` now running, the identifier path is
`parseExpression → parseMaybeAssign → parseMaybeConditional → parseExprOps →
parseMaybeUnary → parseExprSubscripts → parseExprAtom (case types$1.name →
parseIdent) → parseSubscripts`. The `unexpected()`-on-`name` throw is somewhere in
that chain or a guard it consults. Suspects (verify):
- `parseIdent` / `parseIdentNode` mis-handling the `name` token (e.g. a
  reserved-word / keyword check that mis-fires, or `this.next(!!liberal)` arity —
  `next` was the one anchor that did NOT match in the #2664 probes, worth a look);
- a token-type identity guard in `parseExprAtom`'s switch tail or
  `parseSubscripts`' `while (true)` that mis-classifies `name`;
- `parseExpressionStatement` / the `expr.type === "Identifier"` check at
  `parseStatement` line 1045 reading a wrong node type.

## Method (reuse the #2664 toolchain — all committed under `.tmp/` patterns)

- `tests/dogfood/probe-driver.mjs` / the single-compile multi-input bisect
  (`["", ";", "x", "1", "1;", "var x = 1;"]`) to confirm the wall on merged main.
- Numeric-coded source instrumentation (`__n(code, val)` logging
  `code*1e6 + val`, avoid mixed-type `+` concat which garbles) to trace the
  identifier-path chain and pin which function calls `unexpected()` on a `name`.
- A raise-site log (`pp$9.raise`/`raiseRecoverable`/`unexpected`) to name the
  exact error + pos.

## Acceptance

- Localize (verify-first) why `unexpected()` fires on a valid `name` token in the
  now-reachable identifier path; fix it (or carve further).
- Compiled-acorn `parse("x")` returns an ExpressionStatement / Identifier AST;
  `parse("var x = 1;")` returns a VariableDeclaration Program.
- Full merge_group / test262 (codegen-adjacent).

## ROOT CAUSE (pinned, sd-2674c 2026-06-26) — `this.<field>` read returns a host proxy that mis-compares in the parseExprAtom switch

The `unexpected()` on `name` is because `parseExprAtom`'s
`switch (this.type) { case types$1.name: … }` NEVER matches the `name` case, so it
falls to `default → unexpected()`. Full end-to-end root-cause (8 instrumented
full-acorn compiles) is banked in the #2674 issue file ("## DECISIVE
ROOT-CAUSE" + "## RESOLVED BY #2085"). Summary:

- Acorn uses `delete` ⇒ `moduleUsesDelete=true`. `this.<field>` reads on the
  lifted parser methods (whose `this` the checker types `any`/externref) route
  through `tryEmitDeleteAwareDynamicGet` (property-access.ts ~2137-2197) →
  **plain `__extern_get`** (host sidecar/proxy), bypassing `struct.get` AND the
  #2075 `__get_member` dispatcher (none exist in the acorn WAT). `this.type` ≈48.6k
  reads via `__extern_get`.
- The proxy representation diverges from the `struct.set`-written raw struct; the
  JS-host `__host_eq` (`emitSwitchStrictEq` JS-host arm) canonicalizes both
  operands via `_unwrapForHost`, which MIS-resolves at full acorn scale (smoking
  gun: `name-token === empty-proxy -> 1` ~4k×). The switch matches the wrong case.
- The `===` OPERATOR and the standalone path avoid this via Wasm-side `ref.eq`;
  only the JS-host strict-switch + the dynamic-read path are affected.

### Fix tractability (assessed, sd-2674c) — BROAD, banked per budget
- **Ranked #1 (resolve lifted-method `this` → `$__fnctor_Parser`)**: acorn assigns
  methods as `pp$N.method = function(){}` with NINE prototype-alias vars
  (`var pp$2..pp$9 = Parser.prototype`). Binding the function-expression `this` to
  the class struct requires **whole-program prototype-alias tracking** (`pp$N =
  X.prototype`) + this-type binding across lifted function expressions. This is the
  substrate fix (helps ALL delete-using class-method code) but is broad
  escape-analysis work — **banked, not landed this budget** per lead guidance.
- **Ranked #2 (route `tryEmitDeleteAwareDynamicGet` through the struct-candidate
  dispatch first, `__extern_get` terminal)**: more localized BUT interacts with the
  delete-tombstone semantics that path exists for (#2179) — a struct-field read that
  IS a delete target would read stale via `struct.get`. Needs careful design to
  keep tombstone-awareness only for genuinely-dynamic props. Medium risk.
- **Ranked #3 (collision-free `_unwrapForHost`/`_hostProxyReverse` at scale)**:
  narrowest blast radius but symptom-level (fixes host_eq mis-match, not the
  representation divergence).
- A speculative `ref.eq` fast-path in `emitSwitchStrictEq`'s JS-host arm was tried
  + reverted (correct alignment, 13 #2063 tests pass, but BYPASSED here because the
  operands are host proxies — not eqrefs).

Reusable `.tmp` probes (worker-thread + SAB, single-compile) banked under #2674.
Each full-acorn compile is ~290s on this box — reuse one compile per probe.

### Carved sibling walls (now their own issues — do NOT bundle into #2681)
- **#2686 — Binary-expression throw**: `parse("1 + 2 * 3;")` THROWS (separate from
  the identifier path; likely the same token-type-comparison root via parseExprOp).
- **#2687 — ExpressionStatement.expression is null**: CONFIRMED a REAL codegen
  defect by a direct struct-walk (`.tmp/structwalk.mjs`), NOT a marshalling
  artifact. For `"1"`/`"1;"`/`"true;"` the ExpressionStatement node has its
  `expression` own-key present and directly readable but its value is genuinely
  `null` (sibling `type` field reads correctly), so the parsed Literal is not
  attached by `parseExpressionStatement`'s `node.expression = expr`. The extra
  `$.sourceFile`/`loc`/`range` undefined fields are benign (acorn only sets
  loc/range with options). So even the inputs that "parse" produce an incomplete
  AST — the #1712 differential needs #2687 fixed too. **TRUE #1712 GAP is larger
  than "just identifiers throw": even literal expression statements return
  `expression: null`.**
