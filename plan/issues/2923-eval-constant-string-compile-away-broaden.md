---
id: 2923
title: "Broaden constant-string eval compile-away to functions/classes/for-of"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
sprint: current
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
