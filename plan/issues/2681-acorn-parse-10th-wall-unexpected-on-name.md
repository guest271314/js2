---
id: 2681
title: "[ARCH] acorn parse() 10th wall — identifier expression-statement throws (unexpected() on a `name` token); root cause = Parser not reconstructed (new this() in static methods), substrate-scoped"
status: done
completed: 2026-06-29
assignee: ttraenkler/sendev-substrate
sprint: 69
created: 2026-06-26
updated: 2026-07-03
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

> **Resolution (2026-06-29).** Resolved by the acorn Parser-reconstruction
> substrate chain (#2264/#2272/#2275/#2301). Verified on freshly-compiled pinned
> acorn@8.16.0 (`skipSemanticDiagnostics: true`): `parse("x")` → `ExpressionStatement`
> and `parse("var x = 1;")` → `VariableDeclaration` (both previously threw a
> `WebAssembly.Exception`). The identifier `name`-token wall is gone. (The next,
> separate wall — function/arrow bodies throw `illegal cast` at
> `__set_member_labels` — is tracked under the still-open #1712.)

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

## Architect verdict — NOT unblocked by #2731 (esch, 2026-06-27)

**Verdict: #2731 does NOT unblock #2681. Still requires the ranked-#1/#2 substrate
work — NOT a clean dev fix as-is.**

#2731 (PR #2170) added ONLY the symmetric WRITE routing
(`tryEmitDeleteAwareDynamicSet`, property-access.ts:2223). The GET path this issue
pinned — `tryEmitDeleteAwareDynamicGet` (property-access.ts:2148) → plain
`__extern_get` — is **byte-unchanged**, and #2731 touched neither `__host_eq` /
`_unwrapForHost` nor the lifted-method `this`-binding.

Verified on current `origin/main` HEAD (f51590644910a, post-#2731) with a minimal
faithful repro of the mechanism (a fnctor whose `this.<field>` is written in the
ctor and read in a `pp = F.prototype; pp.m = function(this:any){…}` lifted method,
`skipSemanticDiagnostics: true` to match the runner):
- `this.type` written in the ctor reads back as **`undefined`/null** inside the
  lifted method (`var t = this.type` → null), and `this.type === TT.name` is **`0`**
  → a `switch(this.type){ case TT.name: … }` falls to `default` (acorn's
  `unexpected()`). This is the exact host-proxy-vs-struct divergence #2681 names.
- It reproduces **even without `delete`** in the module, confirming the defect is the
  lifted-method `this`→struct binding (ranked #1), broader than the delete-aware GET
  path. #2731's write-symmetry cannot bridge it: the ctor write is `struct.set` on a
  concretely-typed `this` (NOT rerouted by `tryEmitDeleteAwareDynamicSet`, which gates
  on an `any`/`unknown` receiver), while the lifted-method read is `__extern_get` on a
  host proxy that never saw that struct field.

The scale-dependent `name-token === empty-proxy → 1` collision (the full-acorn smoking
gun) is a *symptom* of the same divergence; minimally it surfaces as a null read. The
fix set is unchanged from the pinned analysis: **ranked #1** (whole-program
prototype-alias `pp$N = F.prototype` tracking + lifted-method `this`→`$__fnctor_F`
binding — the substrate fix), or **ranked #2** (route `tryEmitDeleteAwareDynamicGet`
through the struct-candidate dispatch first, `__extern_get` terminal). Both are
architect/senior-dev-scoped; #2731 changes none of the inputs.

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

## ROOT CAUSE SHARPENED + SUPERSEDED on current `origin/main` (2026-06-28, dev-acorn)

Re-verified against current `origin/main` (HEAD #2201, post-#2731). `parse("x")`,
`parse("var x = 1;")`, `parse("foo(bar);")` still THROW. The prior analysis (and
the architect verdict) assumed acorn's `Parser` is a reconstructed
`$__fnctor_Parser` struct (the "type 90" framing). **That is NO LONGER TRUE on
current main** — and this changes the fix.

### The decisive structural finding
Dumped the full acorn WAT (emitWat) on current main and grepped the type section:
- **There is NO `__fnctor_Parser` struct at all.** The fnctors that ARE
  reconstructed: `__fnctor_Node`, `__fnctor_Token`, `__fnctor_TokenType`,
  `__fnctor_Scope`, `__fnctor_Position`, `__fnctor_SourceLocation`,
  `__fnctor_TokContext`, `__fnctor_RegExpValidationState`,
  `__fnctor_DestructuringErrors`, `__fnctor_BranchID`. **Parser is the one that is
  not.**
- **Why:** acorn instantiates the parser ONLY via `new this(options, input)`
  inside the STATIC methods `Parser.parse` / `parseExpressionAt` / `tokenizer`
  (acorn.mjs:672/676/682) — there is **no `new Parser(...)` anywhere**. The fnctor
  escape-gate (`analyzeFnctorEscapeGate`) classifies a fnctor for reconstruction
  only at a `new <identifier>()` site; `new this()` has callee `this` →
  `resolveFnctorSymbol(this)` is `undefined` → Parser is never seen as a
  reconstruct site → it stays a **dynamic `$Object`**.
- **Consequence (the actual #2681/#2686 mechanism):** `this.<field>` reads on the
  parser instance go through the `$Object` / `__extern_get` host path, which
  returns a value whose identity DIVERGES from the stored `__fnctor_TokenType`
  struct. So `switch (this.type) { case types$1.<name>: … }` (the case labels
  `types$1.name` read the raw `__fnctor_TokenType` structs) never matches its
  discriminant → falls to `default → unexpected()` → THROW (#2681); the operator
  path throws the same way (#2686).

### Two candidate substrate fixes — both architect-scoped (NOT a dev slice)
- **(A) escape-gate reconstruct of `new this()` in a static/prototype method.**
  Teach `analyzeFnctorEscapeGate` to recognize `new this(...)` inside a function
  assigned to `F.method = function(){…}` (resolve the enclosing method's owner `F`
  — the same prototype/static-holder analysis used by the alias resolver) as an
  `F` reconstruct site, so Parser gets a `__fnctor_Parser` struct. Then the read
  path (below) + the existing write-mirror (`_safeSet`/`__sset_<key>`/#2664) close
  the loop. **Broad escape-gate change** — reconstruction approval is the #2660
  substrate, regression risk that needs full `merge_group` CI; it also must handle
  the 35+ Parser fields and the `Object.defineProperties(Parser.prototype, …)`
  accessors.
- **(B) `$Object` dynamic reader preserves native struct-value identity.** Make
  `__extern_get` / the `$Object` reader return the SAME `__fnctor_*` struct
  externref that was stored, so `this.type` round-trips the TokenType identity even
  while Parser stays a `$Object`. This is the foundational value-rep substrate item
  (cf. `project_s64_value_rep_substrate_next`, "$Object dynamic reader drops native
  values") and overlaps the value-rep / IR-migration scope — **A-vs-B is an
  architect call.**

### Banked: #2660 PART-2 read-dispatch wiring (correct, but INERT for Parser here)
Prototyped (then reverted — NOT shipped) the designed #2660 PART-2 wiring:
1. `resolveLiftedMethodThisStruct(ctx, arrow)` (in `expressions/fnctor-prototype.ts`)
   — resolves a function-expression's `this` to `__fnctor_<F>` when it is a
   `F.prototype.m = fn` / `var pp = F.prototype; pp.m = fn` method (handles the
   aliased acorn `pp$N` form).
2. `compileArrowAsClosure` (closures.ts) sets `liftedFctx.thisStructName` from it.
3. A consumer in `compilePropertyAccess` (property-access.ts, BEFORE
   `tryEmitDeleteAwareDynamicGet`) routes a resolved-`this` / flow-mapped read
   through the deferred `__get_member_<name>` dispatcher (#2075) — finalize-time
   struct-candidate resolution, `__extern_get` fallback.

Verified it ENGAGES at acorn scale (the consumer fired 1704× with
`thisStruct=__fnctor_Parser`, e.g. `prop=type`), and `__get_member_type` was
emitted with a ref.test chain over `__fnctor_Node`/`__fnctor_Token`/`__anon_33`.
But it is **INERT for the parser** precisely because `__fnctor_Parser` is never
registered (finding above), so the Parser receiver matches none of the dispatcher's
candidate `ref.test`s and falls back to the broken `__extern_get`. This wiring
becomes load-bearing the moment fix (A) gives Parser a struct — keep it for the
implementer of (A). It does NOT close #2681/#2686 on its own.

Reusable probes banked: `.tmp/verify-driver.mjs` + `.tmp/verify-worker.mjs`
(single-compile multi-input acorn `parse()` driver, worker-thread watchdog — acorn
compiles in ~40s on this box now). `compile(..., { skipSemanticDiagnostics: true })`
is required to get past acorn's semantic diagnostics.

**Status: re-tagged `[ARCH]` / substrate-scoped — routed to architect for the
A-vs-B decision. Not a quick dev slice.**

## Implementation attempt + findings (sendev-acorn, 2026-06-28) — A1–A3 LAND THE SWITCH, BUT acorn HANGS: Fix (A) is INCOMPLETE (the banked ranked-#2 value-rep substrate IS required)

Branch `issue-2681-acorn-new-this` (worktree
`/workspace/.claude/worktrees/agent-ae75b7409d6e143f8`). Implemented A1–A3 per the
architect's plan, verified the mechanism on minimal repros, then discovered the
fix cascades into the broad value-rep substrate the architect explicitly **banked
as "not landed this budget."**

### What was implemented (all typecheck-clean)
- **A1** `src/codegen/expressions/new-super.ts` — `new this()` className/symbol
  fallback via `resolveEnclosingFnctorOwner`, gated on `approvedNames`; the #1679
  build path uses the owner symbol (`symbol ?? thisFnctorSym`).
- **A2** `src/codegen/fnctor-escape-gate.ts` — `collect` classifies `new this()`
  sites (`newThisSites`) as ALWAYS `reconstruct` (clause-B bypass), + owner
  resolvers `resolveEnclosingFnctorOwner` / `resolveLiftedMethodThisStruct`
  (the latter approvedNames-gated, NOT structMap-gated, so it is compile-order
  robust), + `inferReturnStruct`/`buildReceiverStructMap` follow `new this()`.
- **A3** `closures.ts` sets `liftedFctx.thisStructName`; `property-access.ts`
  routes pinned-`this`/flow-mapped reads through `__get_member_<name>`
  (`tryEmitPinnedStructMemberGet`); `assignment.ts` routes the symmetric write
  (`tryEmitPinnedStructMemberSet`).
- **Beyond A3 (required, found by tracing the hang):**
  - compound `this.x += v` (`assignment.ts` Path B) and increment `this.x++`
    (`unary-updates.ts`) had a READ via bare `__extern_get` (sidecar) but a WRITE
    via the `__set_member` struct dispatcher → divergence. Routed BOTH reads
    through `__get_member_<name>` (symmetric with their writes).
  - **The architect's deferred "ranked #2":** `tryEmitDeleteAwareDynamicGet` /
    `tryEmitDeleteAwareDynamicSet` (the `any`-receiver path acorn's `delete`
    triggers) emitted BARE `__extern_get`/`__extern_set_strict`. A bare host read
    **cannot read a WasmGC struct slot** — it returns the empty JS sidecar. Routed
    both through the `__get_member_<name>` / `__set_member_<name>` dispatchers
    (struct arms + tombstone-aware sidecar terminal).

### Verified WORKING (minimal repros, `.tmp/identity*.mjs`)
- `new Parser(); p.getType()` → 7 (struct identity survives the host method `this`).
- `p.bump(); p.bump()` (read+write `this.pos` in lifted method) → 45.
- nested `this.advance(); this.inner()` → 207.
- Trampoline probe confirms `__current_this` arrives as the native struct
  (`isStruct=true`), `__fnctor_Parser` is built with ALL 35 fields and registered
  (`__register_fnctor_instance` ×6), and reads route to the dispatchers (A3 read
  consumer fires: type 278×, pos 250×, input 226×, …).

### THE WALL — acorn `parse("x")` THROW → HANG (not fixed)
On real acorn (`tests/dogfood/.acorn`, host/gc mode), `parse("")/";"/"1"/"1;"`
return a Program, but `parse("x")` / `"var x = 1;"` / `"1 + 2 * 3;"` now **HANG**
(were a fast `unexpected()` throw). The A1–A3 fix lands the `parseExprAtom` switch
(no longer throws), but execution proceeds into a non-terminating loop. Host-call
signature of the hang: `__extern_get` ~1.2M, `__box_number`/`__unbox_number`
~0.6M each; **`__extern_set` is ABSENT** (writes hit the struct, reads hit the
sidecar — divergence). Dominant `__extern_get` key: **`flags`** (~150k) on
`Scope` objects — acorn's `currentVarScope()` backward-walks `this.scopeStack`
checking `scope.flags & SCOPE_VAR` (acorn.mjs ~3852); `scope.flags` reads as
`undefined` (sidecar) so the loop never finds the scope and decrements forever.

### Root verdict (sendev-acorn): substrate-scoped, matches the architect's banked ranked-#2/value-rep
The defect is NOT one read site — it is that **every** field read of **every**
reconstructed fnctor struct (Parser → TokenType → `Scope` → Node → …) reached via
an `any`/typed receiver must route through native struct dispatch consistently
with its write, AND the dispatch's struct candidate set / `ref.test` typeIdx must
survive the late-registration + DCE type-remap (`project_type_index_shift_and_deadelim`).
Each fix peels one layer and the next struct's read/write split surfaces. `Scope`
is typed `Scope` (concrete), so it takes the TYPED read path (frozen-candidate
`#2674` inline dispatch), whose `ref.test __fnctor_Scope` misses at acorn scale
even though the struct is built — strongly suggesting a compile-order/DCE typeIdx
desync of the late `__fnctor_Scope` in the typed read dispatch. This is exactly
the broad value-rep substrate work the architect wrote was **"banked, not landed
this budget."**

**Recommendation:** keep the branch (the A1–A3 + symmetric read/write routing are
correct, directional, and pass minimal repros), but treat the completion as a
value-rep substrate epic (consistent native dispatch for ALL reconstructed-struct
field access + finalize-/DCE-stable typeIdx), NOT a bounded #2681/#2686 dev slice.
The broad `tryEmitDeleteAware*` re-routing also needs full `merge_group` validation
(delete-module regression surface) before landing. Reusable probes:
`.tmp/acorn-run.mjs` (single-compile worker watchdog + host-call signature),
`.tmp/dbg-keys.mjs` (extern_get key histogram), `.tmp/identity*.mjs` (minimal
struct-identity repros).

## S2/S2b landed on a MERGED S1 (sendev-substrate, 2026-06-28) — typeIdx desync RULED OUT; remaining hang is S3 (host/array-boundary identity)

Rebased sr-acorn's `issue-2681-acorn-new-this` (commit `ebc464375`) onto a
**merged S1** (#2234 — pass-invariant up-front fnctor struct-type reservation) on
branch `issue-2681-s2-acorn`. The merge reconciled cleanly: S1 refactored
`fnctor-escape-gate.ts`/`new-super.ts` but sr-acorn's `new this()` additions
coexist; **S2b** now POPULATES S1's `newThisOwnerNames` from the reconstruct-
classified `new this()` owners (was the empty S1 placeholder), feeding S1's
`reserveFnctorStructTypes` union so `Parser` gets a reserved, pass-invariant
`$__fnctor_Parser` slot.

**Validated (all green locally):**
- typecheck clean (exit 0); identity repros pass 7 / 45 / 207 (no S1 regression of
  the working `new Parser()` reconstruct path).
- **S2b works** — `$__fnctor_Parser` is now REGISTERED in the acorn WAT (it was
  entirely ABSENT on main, per the sharpened analysis above). All 11 fnctor
  structs present (Parser, Node, Scope, Token, TokenType, …).
- **S2 works** — the `__get_member_<name>` read-dispatchers are emitted (incl.
  `__get_member_flags`, `__get_member_scopeStack`).
- **#2687 literal gap closed for literals** — `parse("1")` / `parse("1;")` now
  return `ExpressionStatement` with `expr=Literal` (was `expression: null` on
  main).

**STILL HANGS — and the cause is now isolated to S3, not the typeIdx desync
sr-acorn suspected.** `parse("x")` / `"1 + 2 * 3;"` / `"var x = 1;"` still hang
(`__extern_get` ~850k, infinite `currentVarScope()` loop). Crucially, **S1 already
made `$__fnctor_Scope`'s typeIdx pass-invariant and DCE-stable** (reserved up-front
+ verified the unit repro), so sr-acorn's "compile-order/DCE typeIdx desync of the
late `__fnctor_Scope`" hypothesis is **RULED OUT** — the `ref.test` typeIdx is now
correct, yet the read still misses. The remaining defect is the **value-rep /
host-boundary identity loss (epic S3)**: `this.<field>` and `scope.flags` are
stored as **`externref`** struct fields (`resolveWasmType` resolves a fnctor
instance to `externref`, the #1712 guard — see the `$__fnctor_Parser` field dump,
`$type`/`$scopeStack` are `externref`/array), and when a native `$__fnctor_Scope`
ref is pushed into the host-backed `this.scopeStack` array and read back, it is
**re-proxied to a host externref** whose `ref.test $__fnctor_Scope` fails → the
read falls to `__extern_get` → `scope.flags` reads `undefined` → the
`currentVarScope()` backward-walk never terminates. This is **exactly the epic's S3
row** ("native struct ref stored into a host-backed array … must not be re-proxied
… so a parser that `this.scopeStack.push(scope)` then re-reads `scope.flags` sees
the native slot"). **S2/S2b cannot bridge it; S3 is the next required slice.**

**Status: S2/S2b substrate landed (Parser struct + read/write/compound/delete-aware
dispatch symmetry on stable typeIdx); #2681/#2686 remain OPEN pending S3.**
