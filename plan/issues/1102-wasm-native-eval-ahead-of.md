---
id: 1102
title: "Wasm-native eval: ahead-of-time compilation strategy for eval() and Function()"
status: done
completed: 2026-07-16
pr: 3113
assignee: ttraenkler/sendev-1102
created: 2026-04-12
updated: 2026-07-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: eval
goal: spec-completeness
model: fable
sprint: 72
required_by: [1584]
es_edition: ES5
# oracle-ratchet-allow: resolveConstStringBinding needs BINDING resolution
# (checker.getSymbolAtLocation: identifier → declaring const) — a symbol/
# declaration query, not a type fact; the TypeOracle surface (#1930) has no
# binding-resolution facility. Same category as the file's pre-existing
# isGlobalEvalIdentifier / isGlobalFunctionIdentifier checker sites.
oracle-ratchet-allow:
  - src/codegen/expressions/eval-inline.ts
---

# #1102 — Wasm-native eval: ahead-of-time compilation strategy

## Resolution (2026-07-16, sendev-1102)

**Option B (AOT specialization) is the strategy that landed — most of it via
the tier-ladder work that superseded this issue's original plan, plus one
remaining slice implemented here.** The authoritative architecture is
`docs/architecture/runtime-eval-interpreter.md` (Part II §12 routing table);
this issue is the Tier-0 (compile-away) leg. Do NOT re-derive strategy from
this file's "Approach options" — they predate the ladder.

### Acceptance criteria → where each landed (verified against main 2026-07-16)

- [x] `eval("1 + 2")` === 3 standalone — **#1163** (constant-string splice),
      broadened by **#2923**. Verified passing.
- [x] `eval("var x = 42")` introduces `x` into caller scope — **#1163**
      (`hoistVarDeclarations` into the enclosing function scope, per
      §19.2.1.1 direct-eval VariableEnvironment). Verified passing.
- [x] Dynamic eval → clear compile-time diagnostic — **#2960**:
      source-located warning + catchable call-time throw, no unsatisfiable
      `__extern_eval` import leak (ladder invariant L1). Verified passing.
- [x] `new Function("a", "b", "return a + b")` with constant args — **#2924**
      (`synthesizeStaticNewFunction`, global-scope §20.2.1.1 no-capture
      invariant). Verified passing.

### The slice implemented in THIS PR: const-binding constant-frontier widening

The issue's step 2.1 ("concatenate const-foldable string operands") was only
half-landed: `resolveConstantString` saw literals / literal-concat /
no-substitution templates, so `const s = "1 + 2"; eval(s)` — the plan's
category-2 "template eval" — was classified dynamic and THREW standalone.
Now `resolveConstantString(expr, checker?)` additionally resolves:

- identifiers bound by **`const` declarations** with recursively-constant
  string initializers (incl. chains: `const a = "1 + "; const b = a + "2"`),
- **template literals with all-constant substitutions**,
- TS assertion wrappers (`as` / `satisfies` / `<T>` / `!`).

**Where widening applies (and why):**

- **Direct eval: YES.** The splice's caller-scope semantics ARE §19.2.1.1
  direct-eval semantics — the fold is strictly more correct than the host
  shim (which lacks scope capture, the #2925 gap) and replaces the
  standalone Tier-3 throw with correct execution (routing rule 3's allowed
  direction).
- **`Function` ctor: YES.** The synthesized function is global-scoped
  regardless of the string's origin (§20.2.1.1).
- **Indirect eval: NO.** The splice runs in caller scope; indirect eval is
  global-scope, which the dynamic host shim implements correctly for
  scope-sensitive bodies. Widening would trade correct shim behavior for
  wrong-scope splices (routing rule 2: bails must stay sound). Its constant
  surface stays literal-only.

**TDZ soundness (why the guards exist):** folding a `const` read must not
erase a would-be `ReferenceError`. Three static guards in
`resolveConstStringBinding` (`src/codegen/expressions/eval-inline.ts`):

1. **Textual precedence** — declaration statement ends before the use begins
   (also kills self-references/cycles: any cycle needs a backward ref).
2. **Same execution container** — nearest function-like body (or SourceFile /
   class static block) of use and decl must match; otherwise a hoisted inner
   function can run the use before the initializer
   (`inner(); const s = "…"; function inner() { eval(s) }`).
   **Module-top-level relaxation:** when the decl is a top-level statement,
   exports aren't callable until the start function completes, so the only
   early-call hazard is a top-level statement BEFORE the const that can
   invoke user code — `topLevelPrefixIsInert` requires the prefix to contain
   no call/new/tagged-template/property-read/element-read/await/yield
   (property reads can fire user getters). This admits the dominant
   real-world shape (`const S = "…"` near the top, eval'd inside functions).
3. **Declaration block is an ancestor of the use** — control cannot enter the
   middle of a block, so a use nested under a later statement of the decl's
   own block implies the decl executed. Rejects switch sibling-clause
   fall-ins (`case 1: const s = "…"; case 2: eval(s)` — shared lexical
   scope, skippable initialization).

**Widened-shape stricter bar (regex):** widening exposed a PRE-EXISTING
splice defect — an eval-inlined regex literal's dynamic `.flags` read
returns `undefined` (even `eval("/abc/i").flags` on main; the value is
otherwise a working RegExp). Shapes that were dynamic pre-#1102 must not
flip onto a known-broken path, so a _widened_ fold bails when the parsed
body contains a `RegularExpressionLiteral` (`containsRegexLiteral` guard);
literal shapes keep their status quo. The defect itself is filed as
**#3301** (fix removes the guard).

**Test migrations:** #2960's dynamic-tier exemplars used
`const op = "+"; …"a"+op+"b"` shapes — constant under the new resolver —
so they were migrated to `let op = "+"; op = op + "";` to keep exercising
the dynamic tier they exist to test. #1164's compile-path tests flip to
Tier-0 where the value assertions still hold; direct `createEvalShim` API
tests keep the shim covered.

### Still open on the eval track (NOT this issue)

- Indirect-eval global-scope splice semantics + host-shim gaps → #2925/#3017.
- Standalone dynamic eval/Function execution → Tier-2 interpreter
  (#2927/#2928/#2929, roadmap §16).
- Remaining sound Tier-0 bails (strict prologues, AnnexB shapes, classes,
  function/arrow expressions) — broaden only with a PerformEval semantics
  proof (routing rule 2; the #2923 merge-group park is the standing lesson).
- Pre-existing: dynamic eval inside a NESTED function declaration returns 0
  instead of propagating the catchable throw (standalone; reproduces with
  `let`-bound strings on main — unrelated to this slice, noted for triage).
- #3301 (regex-literal splice `.flags` dynamic read).

## Problem

`eval()` and `new Function()` are currently skipped in test262 and require a JS host runtime to execute. In standalone mode, there is no JS engine available to parse and execute arbitrary code strings at runtime.

## Approach options

### Option A: Embed a lightweight JS parser/interpreter in Wasm

Compile a small JS interpreter (or a subset interpreter) to Wasm and include it in the output binary. eval() calls dispatch to this interpreter at runtime.

- Pro: semantically correct for arbitrary eval
- Con: large binary size increase, performance overhead, essentially embedding a JS engine in a Wasm binary

### Option B: Ahead-of-time eval specialization

At compile time, analyze eval() call sites:

1. **Constant string eval**: `eval("var x = 1")` — inline the parsed result at compile time
2. **Template eval**: `eval("return " + expr)` — if the template is statically analyzable, compile all possible expansions
3. **Dynamic eval**: fully dynamic strings — emit a compile-time error or runtime trap in standalone mode

This is the "compile away" approach: handle the common cases statically, reject the truly dynamic cases.

### Option C: Wasm-embedded compiler (self-hosting)

Include the js2wasm compiler itself (compiled to Wasm) in the output. eval() calls invoke the embedded compiler to produce new Wasm modules at runtime, then instantiate them.

- Pro: fully correct, uses the same compiler
- Con: massive binary size, complex linking, recursive instantiation

## Recommended path

Start with **Option B** (ahead-of-time specialization). Most real-world eval() usage falls into categories 1-2. Category 3 (truly dynamic eval) is rare in production code and can throw a clear error in standalone mode.

## Acceptance criteria

- [ ] `eval("1 + 2")` compiles and returns `3` in standalone mode (constant string)
- [ ] `eval("var x = 42")` compiles and introduces `x` into scope
- [ ] Dynamic eval (non-constant string) produces a clear compile-time diagnostic
- [ ] `new Function("a", "b", "return a + b")` compiles when args are constant strings

## Related

- #1006 eval host import (JS-host mode)
- #1073 eval scope injection
- #1089 indirect eval

## Implementation Plan

(Author: architect, 2026-05-21. Implement Option B — AOT
specialization — with a clean runtime trap fallback for dynamic
eval.)

### Entry point

`compileCallExpression` branch in `src/codegen/expressions/calls.ts`:
detect `eval(arg)` / `new Function(...)` and route to
`src/codegen/builtins/eval.ts` (new).

### Algorithm

1. **Detect eval call site** — identifier name === "eval" (direct
   eval); or `Function` constructor in `new Function(...)`.

2. **Argument analysis**:
   1. Concatenate const-foldable string operands at compile time.
   2. If the result is a fully-known string → specialize.
   3. Otherwise → emit `__eval_dynamic_trap(arg)` import: - JS-host mode: import maps to `(s) => eval(s)`. - Standalone mode: throws `EvalError: dynamic eval not
supported`.

3. **Specialization for direct eval**:
   1. Parse the string with the existing TS parser
      (`ts.createSourceFile`).
   2. Lower the resulting AST nodes _into the caller's scope_:
      `var` declarations become caller locals (or aliased), function
      decls become hoisted locals, expression statements compile in
      place.
   3. Hoisting must honour the direct-eval rule: `var`s leak into
      the surrounding function scope, `let`/`const` create a new
      block scope per spec §18.2.1.
   4. Emit the lowered code at the call site.

4. **Specialization for `new Function(...args, body)`**:
   1. Compile the body as a standalone function with parameter
      names from `...args`.
   2. Return a funcref/closure value.

### Edge cases

- **Indirect eval** (`(0, eval)("x")`) — caller's scope is NOT in
  effect; lower into global scope per spec §18.2.1.
- **Strict mode eval** — separate variable scope per spec.
- **eval changing `this`** — direct eval inherits caller's `this`;
  indirect eval uses global object.
- **`with`** — out of scope (project does not support `with`).
- **eval that introduces a function declaration** — must be
  hoisted at the syntactic location of the eval call, not at the
  function's top.
- **Cycle: eval calls eval** — Option B handles nested const-foldable
  cases; dynamic nested eval throws.
- **`new Function` with non-string body** — `Function(undefined)`
  per spec creates an empty function. Specialize this.

### Test262 paths

- `test/language/eval-code/direct/*` — direct eval with const
  strings.
- `test/language/eval-code/indirect/*` — indirect eval.
- `test/built-ins/Function/instance/*` — Function constructor.

Acceptance: const-string eval cases pass; dynamic-string cases get
a clear EvalError or compile-time diagnostic.

### Dependencies

- **#1073** — eval scope injection; this issue subsumes it.
- **#1089** — indirect eval; covered by step 1's branch on
  identifier-vs-expression callee.
- **#1066** standalone-mode eval — covered by step 2's trap.
- **#1264/#1265** — eval strict/sloppy scoping; coordinate to share
  the scope-lowering helper.

### Risks

- **Hoisting correctness**: var-leak semantics from a nested eval
  back into the caller are tricky; ship a strict mode-only subset
  first.
- **Compile-time work explosion**: large eval strings parse at
  compile time, slowing builds. Cap with a 64KB literal-eval limit;
  anything larger → dynamic trap.
