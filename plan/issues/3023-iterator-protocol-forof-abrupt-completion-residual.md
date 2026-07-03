---
id: 3023
title: "iterator protocol: synthesized-iterator .next callability + for-of/for-await abrupt-completion residual (~508 default-lane fails)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators, for-of, for-await-of
es_edition: 2015
goal: spec-completeness
test262_category: language/statements/for-of, language/statements/for-await-of, language/expressions/async-generator
test262_fail: 508
related: [2669]
---

# #3023 — iterator protocol: `.next` callability + for-of/for-await abrupt completion

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). Two related
sub-buckets:

- `TypeError: it.next is not a function` in destructuring contexts
  (`class/dstr`, `assignment/dstr`, `async-generator/dstr`) — **113**. A
  synthesized/custom iterator object's `.next` isn't recognized as callable
  by the destructuring iterator-consumption path.
- `for-of` (**275**) / `for-await-of` (**120**, with async-generator
  combined **261**) abrupt-completion and iterator-close gaps — the runtime
  doesn't correctly call `IteratorClose` / propagate abrupt completions
  (`break`/`throw`/`return` mid-loop) through custom and async iterators.

This is narrower than — but overlaps — the #2669 destructuring-correctness
residual umbrella (which already tracks `for-of/dstr` at 247 as one of its
sub-buckets). This issue scopes specifically to the iterator-protocol
mechanics (`.next` callability, `IteratorClose`, abrupt completion through
for-of/for-await), as distinct from #2669's broader destructuring-pattern
correctness (defaults, holes, rest). Coordinate with #2669 before
implementing to avoid duplicate fixes on the shared `for-of/dstr` surface.

## Sample failing files

- `language/expressions/assignment/dstr/array-elem-trlg-iter-elision-iter-nrml-close-skip.js`
- `language/expressions/async-generator/dstr/ary-init-iter-close.js`
- (for-of/for-await abrupt completion — pull fresh samples from
  `language/statements/for-of/` and `language/statements/for-await-of/`
  `error_category` groupings at implementation time)

## Suggested approach

1. Confirm whether `.next` callability failures share a root cause with the
   iterator-close call path — a custom `{ next() {...} }` object literal
   used as an iterator may not be recognized as callable if the codegen
   checks a closed/nominal shape instead of doing a generic property lookup
   + call.
2. Audit `IteratorClose` invocation sites for for-of/for-await: is it called
   on every abrupt completion (`break`, labeled `continue`, `throw`,
   `return`) inside the loop body, for both sync and async iterators?

## Acceptance criteria

- `.next is not a function` fails in destructuring iterator contexts drop
  materially below 113.
- for-of / for-await-of abrupt-completion test262 fails drop materially
  below the combined 395 recorded here.

## Investigation (2026-07-03, dev-3023) — corrects an earlier banked note

An earlier same-day note characterised this as `var [a,b] = obj` (obj an
`any`-typed custom iterable) yielding **NaN** because the var-decl
array-destructuring path "index-extracts instead of running the iterator
protocol". **That characterisation does not hold on current main** — do not
build a fix around it. Verified findings:

1. **The common iterator-consumption paths already PASS.** With the iterator
   protocol wired correctly (host `__iterator` / `__iterator_next` bridge, or
   the source-defined `emitDrainCustomIterableToVec` drain), all of the
   following return the correct value on current main:
   - `for (const x of obj)` over a custom iterable (host-provided **and**
     source-defined object-literal `{ [Symbol.iterator]() {…} }` and
     class-with-`[Symbol.iterator]`);
   - `var [a,b] = obj` **and** `const [a,b] = obj` over the same iterables;
   - trailing-elision assignment-destructuring `[x, ,] = vals` calls `.next()`
     exactly twice and does **not** call `return()` when the iterator is
     already done (verified `nextCount=2, returnCount=0`, matching
     `array-elem-trlg-iter-elision-iter-nrml-close-skip`'s spec expectation).
   The var-decl externref path (`compileExternrefArrayDestructuringDecl` →
   `destructureParamArray` in `src/codegen/destructuring-params.ts`) already
   materialises the source via `__array_from_iter_n` (GetIterator + `.next()`),
   and the statically-typed custom-iterable path is handled by the
   `isCustomIterable` branch in `src/codegen/statements/destructuring.ts`
   (~L1129) draining through `emitDrainCustomIterableToVec`. **A "NaN" repro
   requires the test harness to omit `setExports`** — without it the host
   `__iterator` bridge can't call back into the WasmGC struct's exported
   `@@iterator`, so the value looks non-iterable; that is a harness artifact,
   not a compiler bug. The CI worker and equivalence harness both call
   `setExports`.

2. **The two cited sample files are NOT a codegen index-extraction bug.** Both
   `assignment/dstr/array-elem-trlg-iter-elision-iter-nrml-close-skip.js` and
   `async-generator/dstr/ary-init-iter-close.js` build their iterable via a
   **late-bound property assignment** — `var it = {}; it[Symbol.iterator] =
   function () {…}`. Running them through `src/cli.ts` hard-crashes inside the
   TypeScript **checker** (`getLateBoundSymbol` →
   `Cannot read properties of undefined (reading 'flags')`, at
   `contextuallyCheckFunctionExpressionOrObjectLiteralMethod`) during
   `getSemanticDiagnostics`. **This crash is NOT what CI/test262 sees** — the
   test262 worker (`scripts/test262-worker.mjs`) and the `compile()` API both
   pass `skipSemanticDiagnostics: true`, which bypasses the crashing full-file
   semantic pass. A 150-file in-process sample across `assignment/dstr` +
   `async-generator/dstr` produced **0** such crashes and **122/150 compiled
   OK** — so the residual failures are **runtime spec-conformance**, not
   compile errors.

3. **Where the real 508 failures live**: subtle spec mechanics on files that
   *do* compile — `IteratorClose` (`return()`) invocation on **abrupt**
   completion (`break` / `throw` / labeled `continue` mid-loop) and on
   over-consumed / early-terminated destructuring; `.next` callability for
   dynamically-shaped iterators; and for-await ordering / async-iterator close.
   These are per-edge-case conformance gaps, not one shared index-extraction
   root cause. This makes #3023 **broader and deeper** than a bounded bugfix —
   it should be split into targeted sub-slices (each a specific
   IteratorClose-site or abrupt-completion path with its own test262 group),
   ideally after coordinating with #2669 on the shared `for-of/dstr` surface,
   rather than attempted as a single fix.

**Revised guidance for the next dev:**
- Do **not** target `compileExternrefArrayDestructuringDecl` /
  `emitDrainCustomIterableToVec` for a "NaN" fix — the common path is correct.
- Reproduce against the **actual test262 runtime** (via
  `scripts/test262-worker.mjs`, or `compile(..., {skipSemanticDiagnostics:true})`
  with `setExports` wired), **not** `src/cli.ts` (its unguarded
  `getSemanticDiagnostics` crashes on late-bound `[Symbol.iterator]=`).
- Pick ONE narrow sub-bucket (e.g. for-of `break` → `IteratorClose`) with a
  concrete failing-file list, verify the `return()`-call gap with an
  inject-throw / call-count proof, and land it as a scoped slice.
- Separately, the `src/cli.ts` late-bound-symbol crash is worth a small
  robustness follow-up (wrap the `getSemanticDiagnostics` call so a TS-internal
  throw degrades to "no semantic diagnostics" instead of a hard process crash)
  — it does not move the test262 number and is out of scope for this issue.
