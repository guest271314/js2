---
id: 3348
title: "compiled-acorn parse() throws in-Wasm on current main — 'parse is not a function' dynamic method-dispatch failure (regressed since 2026-06-30 corpus baseline)"
status: ready
created: 2026-07-17
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime, dogfood
language_feature: dynamic-dispatch
goal: runtime-eval
related: [3308, 2927, 1584, 1710, 1712]
origin: "#3308 E0 probe attempt (2026-07-17, opus-4) — the in-Wasm AST-consumer measurement is blocked because compiled-acorn's own parse() throws in-Wasm."
---

# #3348 — compiled-acorn `parse()` throws in-Wasm on current main

## Problem

While attempting the #3308 (E0) in-Wasm AST-consumer probe, the **control**
measurement — compiled-acorn **alone**, calling the exported `parse` through
`wrapExports` exactly as the `tests/dogfood/acorn-corpus.mjs` harness does —
throws from **inside the compiled module**:

```
parse is not a function
  at runtime.ts:10656  (throw new TypeError(method + " is not a function"))
  at fn (runtime.ts:14534)
  at parse (wasm://…:wasm-function[105])
```

This is a **dynamic method-dispatch failure** raised by the host runtime's
`method-not-a-function` guard, reached from *within* acorn's compiled `parse`
(so `exp.parse` IS callable at the JS level; acorn's internal dispatch — e.g.
`Parser.parse(...)` / a prototype-method call — resolves to a non-function
in-Wasm and throws).

The `CORPUS-GAP-MAP.md` baseline (dated **2026-06-30**) records
`compiled-threw=1` (only `regex.js`), i.e. `parse` worked for the vast majority
of inputs at that time. Current `origin/main` is **~343 commits** past that
baseline, and now even a trivial script (`const a = 1; let b = 2; function
f(){}`) throws. So this is a **regression** in compiled-acorn's `parse`
somewhere in that window — a class of failure that is a hard blocker for the
runtime-eval interpreter ladder (#2927/#2928), which depends on compiled-acorn
producing a walkable AST.

## Repro (2026-07-17, opus-4)

Combined-module and control experiments (host/gc mode, `skipSemanticDiagnostics:
true`, the corpus's exact compile options):

1. **Control — acorn ALONE**: `compile(acornSrc, { fileName: "acorn.mjs",
   skipSemanticDiagnostics: true })` compiles successfully; then
   `wrapExports(instance.exports, { signatures }).parse("const a=1; let b=2;
   function f(){}", { ecmaVersion: 2025, sourceType: "script" })` **throws
   "parse is not a function"**.
2. **Combined acorn + in-Wasm walker** (append `export function
   probeBodyLen(src){ const ast = parse(src, { ecmaVersion: 2025, sourceType:
   "script" }); return ast.body.length; }` to the acorn source before compile):
   compiles (**703 KB** binary), but
   - the exported `parse` still throws "parse is not a function" (with options)
     / "type incompatibility when transforming from/to JS",
   - the internal `probeBodyLen` throws "parse is not a function" (with options)
     / "dereferencing a null pointer" (no options).

The combined module compiling cleanly (703 KB) rules out a co-compilation /
func-index-shift authoring problem in the walker — the failure is in acorn's
own `parse` dynamic dispatch.

## Investigation leads

1. **Confirm + bisect.** Check whether `tests/dogfood/acorn.test.ts`'s
   `compiled-threw` count regressed since 2026-06-30 (the corpus test is
   non-failing tooling, so a `parse` regression may be silently absorbed into
   the "compiled-threw" bucket rather than failing CI — verify against the
   committed `tests/dogfood/report/acorn-corpus.json` trend). Bisect the ~343
   commits to the PR that flipped `parse` to throwing.
2. **Localize the dispatch.** `runtime.ts:10656` is the host
   `method-not-a-function` guard; identify which acorn internal call
   (`Parser.parse`, a prototype method on the parser instance, or a
   dynamically-resolved token-context method) resolves to a non-function
   in-Wasm. Likely a prototype-chain / static-method / dynamic-dispatch
   codegen regression rather than an acorn-source issue (acorn is unchanged —
   pinned 8.16.0).

## Acceptance criteria

- [ ] Root-cause identified (the specific in-Wasm dynamic call that resolves to
      a non-function, and the PR that regressed it).
- [ ] compiled-acorn `parse` no longer throws for the trivial script control
      (returns a `Program` node with `body.length === 3`).
- [ ] `tests/dogfood/acorn.test.ts` `compiled-threw` count back to its
      2026-06-30 level (≤1); a regression guard if feasible.
- [ ] Unblocks #3308 (E0 in-Wasm AST-consumer probe).

## Related

- Blocks **#3308** (E0 in-Wasm AST-consumer probe — mis-sized S; depends on this).
- Ladder: **#2927 → #2928** (runtime-eval interpreter) → **#1584**.
- Corpus harness: `tests/dogfood/` (#1710/#1712).
