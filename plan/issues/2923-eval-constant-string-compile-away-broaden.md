---
id: 2923
title: "Broaden constant-string eval compile-away to functions/classes/for-of"
status: done
assignee: ttraenkler/dev-2863
completed: 2026-07-02
created: 2026-07-02
updated: 2026-07-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
sprint: 69
parent: 1584
related: [1163, 1261, 2924]
---

# #2923 — Broaden constant-string `eval` compile-away (functions/classes/for-of)

Slice **A** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-A).
First landable slice — pure AOT, **standalone-safe**, no interpreter, no host.

## Problem

`tryStaticEvalInline` (#1163, `src/codegen/expressions/eval-inline.ts`) already
compiles `eval("<compile-time-constant>")` by parsing the string as a Script and
splicing its statements inline at the call site. But `allNodesInlineSupported`
(same file, ~line 185) **bails** the moment the constant body contains a
function declaration, function/arrow/class expression, `for-of`, `for-in`,
`yield`, `await`, or an import/export — falling through to the dynamic
`__extern_eval` host import, which **traps at instantiation in standalone mode**.

Many test262 constant-string eval bodies are of the form
`eval("function f(){return 1} f()")` or `eval("class C {} new C")` — exactly the
bailed kinds — so they get no standalone coverage despite being fully static.

## Goal

Extend the inliner to compile the currently-bailed node kinds when they appear in
a constant eval body, reusing the machinery the AOT path already has:

- **Function declarations** — already hoisted via
  `hoistFunctionDeclarations` (`statements/nested-declarations.ts`); the bail in
  `allNodesInlineSupported` for `FunctionDeclaration` is over-conservative now
  that the hoist path is wired. Remove it and verify.
- **Class declarations / expressions** — route through the existing class
  codegen. The blocker is that foreign `ts.createSourceFile` nodes have **no
  checker bindings** (see the `EVAL_SOURCE_FILENAME` note); classes that rely on
  type info must still bail. Gate: allow classes whose members need no checker
  type resolution (fields/methods with inferable shapes); keep bailing otherwise.
- **`for-of` / `for-in`** — allow when the iterable is an array/string literal or
  a plain object literal (iterator type resolvable without the checker); keep
  bailing on general iterables.

## Constraints

- **Correctness first.** Any construct whose correct lowering needs checker
  bindings the foreign SourceFile lacks MUST keep bailing to the dynamic path —
  the inliner is a best-effort fast path (per #1163). Do NOT loosen a bail if it
  risks silent mis-compilation.
- **No new host imports.** This slice must not introduce any `env::__*` import;
  it is pure AOT splice.

## Acceptance criteria

- [ ] `eval("function add(a,b){return a+b} add(2,3)")` returns `5` in
      **standalone** mode (no host).
- [ ] `eval("class P{get x(){return 7}} new P().x")` returns `7` in standalone
      mode, OR provably bails to the dynamic path with a documented reason.
- [ ] `eval("var s=0; for (const x of [1,2,3]) s+=x; s")` returns `6` standalone.
- [ ] No regression in the existing #1163 inliner tests.
- [ ] Emit a constant-vs-dynamic split count over the eval buckets (a
      `--dry-run` classifier reusing #1261's `StaticLiteral` classification) as a
      logged artifact, sizing the Tier-0 win (roadmap §5.4).

## Notes

Sibling slice #2924 (`new Function` compile-away) depends on this one's broadened
splice machinery. Umbrella: #1584. Goal: `runtime-eval`.

## Done (dev-2863, 2026-07-02)

Lifted in `allNodesInlineSupported` / `tryStaticEvalInline`
(`src/codegen/expressions/eval-inline.ts`):

- **Function declarations** (incl. params, recursion, mutual reference). The
  foreign eval `SourceFile` has no checker bindings, so
  `getSignatureFromDeclaration` THROWS (`symbol.escapedName` on `undefined`) —
  fixed at BOTH sites in `src/codegen/statements/nested-declarations.ts`
  (`compileNestedFunctionDeclaration` and the multi-fn pre-reserve pass in
  `hoistFunctionDeclarations`): params degrade to externref
  (`getTypeAtLocation → any`) and the return type defaults to externref, both
  paths identically so the reserved funcType matches the compiled body.
- **`for-of` over an array/string literal**, **`for-in` over an object/array
  literal** (iteration needs no checker-resolved iterator type). A non-literal
  iterable keeps bailing.

Still bailing to the dynamic path (their codegen dereferences a checker
signature/heritage the foreign SourceFile lacks and would THROW an internal
error — worse than a clean fall-through): **function/arrow expressions**,
**classes**, yield/await/import/export. Acceptance criterion 2 (class) is met by
the "provably bails with a documented reason" branch — standalone class-in-eval
awaits the Tier-2 interpreter (#2928).

**Sizing artifact (criterion 5)** — `scripts/eval-const-classifier.mjs`
(`npx tsx`, reuses `resolveConstantString`). Over `test262/test`: **1460 files**
with an eval site, **2611 call-sites**, of which **2394 (91.7%) are
constant-string (Tier-0 liftable)**, 210 dynamic (need the interpreter #2928),
7 no-arg.

Tests: `tests/issue-2923-eval-const-broaden.test.ts` (13). No regression in the
existing #1163 / eval-tiering tests. The #2861 namespace-reads follow-up (#2933)
rides this PR.

## Merge-group park fix (dev-eval design, landed by dev-evalf, 2026-07-02)

PR #2442 was auto-parked (`auto-park-bot:merge-group-failure`, 00:50Z): the
merge_group test262 run showed **123 regressions / net −73** vs baseline —
all eval-related, 100% PR-caused (PR-level shards had been SKIPPED by the
path filter, so the merge_group was the first test262 exposure):

- **102× `annexB/language/eval-code/{direct,indirect}`** — the splice hoisted
  function declarations nested in a script-scope block/if/switch/for
  unconditionally; AnnexB §B.3.3 web-legacy semantics require a *conditional*
  hoist (skipped entirely when it would conflict with a lexical binding —
  the `skip-early-err-*` variants assert `f` stays undeclared). Includes 6
  `for-in` variants that crashed compile (`reading 'flags'`) — the bail now
  precedes the crashing splice.
- **~21× strict-mode** (`13.*-s`, `*-eval-stricteval`, `*strict*` eval-code) —
  strict early-errors (`function f(eval){}` → SyntaxError) and strict
  block-scoping of decls are not enforced by the splice.

Fix (`eval-inline.ts`, FunctionDeclaration case in `allNodesInlineSupported`):
bail to the dynamic `__extern_eval` path when (A) the eval body has a
`"use strict"` directive prologue, or (B) the decl is nested in script-scope
lexical statements without an intervening function boundary
(`funcDeclNeedsDynamicEvalPath`). Top-level sloppy decls — the headline win —
still lift; probe re-ran 12 regressed files (all 3 clusters) → all PASS, and
the surviving improvements (`language/statementList/eval-fn-*`) still pass.
~45 annexB `*-block-scoping`/`func-*` improvements that had come from the
same (unsound) unconditional hoist revert to baseline-fail; implementing real
AnnexB conditional hoisting in the splice is future work (Tier-2 #2928 era).
Guard tests added (17 total in the test file).
