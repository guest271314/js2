---
id: 3633
title: "__extern_eval evaluates in a scope containing none of the compiled module's bindings (184 test262 tests die on `assert is not defined`)"
status: ready
sprint: current
goal: es5-complete
priority: high
horizon: l
feasibility: hard
---

# The dynamic eval path cannot see the enclosing module's bindings

## Problem

When `tryStaticEvalInline` declines a constant eval body — most often on the
deliberate `funcDeclNeedsDynamicEvalPath` guard (a nested `FunctionDeclaration`,
i.e. AnnexB B.3.3 territory, see the #2923 park note in
`src/codegen/expressions/eval-inline.ts`) — the call routes to the
`__extern_eval` host import.

`__extern_eval` (`src/runtime.ts` ~L8040) **compiles the eval string as a fresh,
standalone js2wasm module** and instantiates it, with a `(0, eval)` host
fallback. Neither route can see the _calling_ module's bindings: the fresh
module is compiled from the string alone, and the host fallback runs in the JS
global scope, where functions compiled into the Wasm module simply do not exist.

Any identifier the eval body inherits from its enclosing program is therefore
unresolvable. In test262 that identifier is almost always the harness itself.

## Probe (current HEAD, host mode, `tests/probe-eval-mvp.test.ts` — gitignored)

```ts
function helper(): number {
  return 5;
}
// direct:   eval("if (true) { function f() { return 1; } } helper();")
// indirect: (0, eval)("if (true) { function f() { return 1; } } helper();")
```

| probe                            | got               | spec      | verdict  |
| -------------------------------- | ----------------- | --------- | -------- |
| direct eval, non-foldable body   | `value=undefined` | `value=5` | **FAIL** |
| indirect eval, non-foldable body | `value=undefined` | `value=5` | **FAIL** |

Mechanism confirmed (the body does not see `helper`). **Symptom differs from
test262**: locally the call yields `undefined` without throwing; in test262 the
body does `assert.sameValue(...)`, so the property read on the unresolved
`assert` throws and is reported as `assert is not defined`. Both are the same
root cause — the binding is not in scope — but the local repro does _not_
reproduce the throw, and that discrepancy is itself worth understanding before
implementing.

## Measured denominator — and why the flip count is NOT 184

Baseline: `test262-current.jsonl` fetched 2026-07-25 18:21. Population =
ES5-classified (post-#3626 classifier), `eval`-dependent, host lane: 775 tests,
**484 not passing**.

- **184** of the 484 report literally `assert is not defined`.
- All 184 are `annexB/language/eval-code/*` — procedurally generated AnnexB
  B.3.3 tests. That family comes in two shapes: the `assert` call is either
  **inside** the eval string or **outside** it.

| shape (ES5, `annexB/language/eval-code`, host lane) | pass    | rate       |
| --------------------------------------------------- | ------- | ---------- |
| `assert` **inside** the eval string (masked)        | 0 / 144 | **0 %**    |
| `assert` **outside** the eval string (unmasked)     | 89 /325 | **27.4 %** |

So fixing scope visibility **unmasks** ~184 tests; the remainder then fail on
AnnexB B.3.3 semantics, which is #2200 / #2552's work, not this issue's.

**27.4 % is an UPPER BOUND on the post-unmasking flip rate, not a point
estimate.** The two shapes are not equivalent populations: the masked variants
put the `assert` call _inside_ the eval body, so after unmasking they exercise
strictly more machinery inside the splice (harness property access, call
dispatch, and the B.3.3 binding under test, all within the eval Script) than the
unmasked variants do, where the assert runs in ordinary compiled code. The true
rate is lower than 27.4 %; how much lower is only knowable from a post-fix
re-run.

**Do not quote 184 as a flip count** — it is a gate count. Do not quote 27.4 %
as a flip count either; quote it as a ceiling.

## Why this is `hard`

Making module bindings visible to `__extern_eval` means exporting a live
binding view (read _and_ write — B.3.3 requires the eval body to create bindings
the caller then observes) across the Wasm/host boundary. #1073 (`done`) injects
_caller locals_; this is the module/global-scope half, and it has to work for
the fresh-module compile route as well as the host-eval fallback. The
alternative framing — teach the folded path to handle nested function
declarations correctly so these bodies never reach `__extern_eval` — is
tracked by #2200 / #2552 and would resolve the same 184 from the other side.

## Acceptance criteria

- The probe above returns `value=5` for both direct and indirect eval.
- The `assert is not defined` signature disappears from the `annexB/language/eval-code`
  bucket (the tests then pass or fail on B.3.3 assertions, which is the correct next gate).
- Standalone lane behaviour is unchanged or improved — `__extern_eval` is absent
  there, so this must not introduce a host import into a standalone module.

## Not covered here

AnnexB B.3.3 hoisting semantics (#2200 / #2552), eval in standalone mode
(#1066), direct eval with a runtime string (#3630).
