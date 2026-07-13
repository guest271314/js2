---
id: 3164
title: "Standalone: native lowering for generator FUNCTION EXPRESSIONS (anonymous/IIFE/var-assigned) — retires ~1,700 sync __create_generator leaky passes"
status: done
sprint: 71
created: 2026-07-12
updated: 2026-07-13
completed: 2026-07-12
assignee: sendev-3164
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: generators
goal: standalone-mode
related: [1665, 680, 2203, 2571, 2581, 2920, 2940, 3132, 1781]
# (#3131) LOC allowance for this change-set: the three parts land as new arms
# in the existing generator/iterator/closure subsystems — admission gate +
# host-mix dispatch (generators-native), GENSTATE runtime arms
# (iterator-native), fn-expr emit-site wiring (closures), NativeGeneratorInfo
# decl widening (context/types). No barrel/driver growth.
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/codegen/generators-native.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
origin: "2026-07-12 architect standalone audit (plan/log/standalone-gap-map.md): 1,741 official-scope tests pass ONLY via the eager-buffer __create_generator/__gen_* host shims; the dominant shape is the dstr-harness IIFE `var iter = function*() { iterCount += 1; }();`"
---

# #3164 — Native lowering for generator function expressions

## Problem

The native generator state machine (#1665/#680) covers **declarations**
(`function* g() {}`), **class methods** (#2571), and **object-literal
methods** (#2581) — but NOT **function expressions**:

```ts
// src/codegen/generators-native.ts:1881 (isNativeGeneratorCandidate)
if (!decl.name || !decl.body || !decl.asteriskToken) return false;
```

An anonymous `ts.FunctionExpression` has no `decl.name`, so every

```js
var iter = function*() { iterCount += 1; }();   // the test262 dstr harness idiom
var g = function*() { yield 1; };
callSomething(function*() { ... });
```

bails to the eager-buffer host path (`src/codegen/closures.ts:2861–2940`,
`__create_generator` / `__gen_create_buffer` / `__gen_next` / … +
`__get_caught_exception`). In the standalone lane the runner shims those
imports, so the test **passes but is a leaky pass** — excluded from
`host_free_pass`.

**Measured impact (baseline 2026-07-12):** 1,741 official-scope leaky passes
carry `env::__create_generator`; filename classification shows ~1,400 are
dstr-family tests whose ONLY generator is the harness IIFE above. Retiring
this leak is worth **~+3 to +4 pts** on the standalone (host-free) number and
is a precondition for the #2040 dstr fixes to count as host-free wins.

## Implementation Plan (architect, verified against upstream/main @ adc65cfc65)

### Root cause

`isNativeGeneratorCandidate` (generators-native.ts:1850) and the collection
pass only consider named declarations/methods; `FunctionExpression` generators
have no funcMap-stable name and no registration path, so `closures.ts`
compiles them via the eager-buffer host lowering unconditionally.

### Changes

**1. Synthetic naming + registration (collection pass)**

- The closure lowering already synthesizes stable names for lifted function
  expressions (see the `__closure_<n>` family in `src/codegen/closures.ts` and
  the nested-generator registration in `src/codegen/nested-declarations.ts`,
  which gates on `captures.length === 0` per #2203).
- Add a source-walk arm that finds `ts.FunctionExpression` nodes with
  `asteriskToken` and, when eligible (below), registers them through
  `registerNativeGenerator` (generators-native.ts:2159 →
  `ctx.nativeGenerators.set(functionName, info)` at :2351) under a synthetic
  name (`__genexpr_<n>`), keyed by the AST node (add a
  `ctx.generatorExprNames: Map<ts.Node, string>` so the emit site finds it).

**2. Eligibility — extend, do not fork, the single gate**

Extend `isNativeGeneratorCandidate` to accept `ts.FunctionExpression`:

- Replace the `!decl.name` bail with: name optional for FunctionExpression
  (synthetic name supplied by caller); keep it required for declarations.
- Keep ALL existing bails, applied to the expression body identically:
  rest params (#2920 note), `bodyUsesArguments`, captures via
  `generatorCapturesOuterScope` (generators-native.ts:1985 — module-global
  reads like the harness's `iterCount += 1` are already classified NOT a
  capture, which is exactly what makes the harness IIFE eligible),
  `buildNativeGeneratorPlan !== null`.
- NEW bail: a **named** function expression whose body references its own
  name (`var g = function* gen() { yield gen; }`) — the self-binding scope is
  not modeled; bail to host.
- NEW bail: `this` used in the body (a bare function expression's `this` is
  call-site dependent; the state-struct model has no receiver slot for the
  non-method case).

**3. Emit site (closures.ts)**

In the generator arm of the closure/function-expression lowering
(closures.ts:2861–2940, the block that ends with
`const createGenName = isAsync ? "__create_async_generator" : "__create_generator"`):

- If `ctx.generatorExprNames.has(node)` and `ctx.nativeGenerators.get(name)`
  exists → emit the native factory exactly the way
  `compileNativeGeneratorFunction` consumers do (see the class-method wiring
  in `src/codegen/class-bodies.ts` around :2310 and function-body.ts:1041–1051
  for the declaration form). The result value is the native generator state
  struct — downstream `.next()`/for-of/spread already dispatch on it via
  `tryCompileNativeGeneratorMethodCall` (generators-native.ts:4051) and
  `tryCompileNativeGeneratorForOf` (:4413).
- Else → existing eager-buffer path unchanged.

**4. Keep `sourceNeedsGeneratorHostImports` in lockstep (CRITICAL)**

`sourceNeedsGeneratorHostImports` (generators-native.ts:2066) decides whether
the `__gen_*` host imports get registered at all. It MUST consult the same
extended candidate logic for FunctionExpressions: if ANY generator in the
file still bails, the imports stay registered (otherwise emit bakes
`funcIdx: undefined` → invalid module; this is the exact hazard documented in
the #2203 comment block at generators-native.ts:1975).

**5. IR seam**

`src/ir/from-ast.ts` / `effects.ts` reference `__create_generator` — no change
needed (generators stay compile-twice under IR-first in standalone, see
`computeIrFirstSkipSet` gate 2, codegen/index.ts:2167). Do not touch.

### Bounded slicing

- **Slice 1 (the payoff slice):** top-level `var x = function*(){...}` and
  IIFE `(function*(){...})()` with zero captures, no `this`, no `arguments`,
  identifier or no params. This alone covers the dstr harness (~1,400 tests).
- **Slice 2:** function expressions passed as call arguments / stored in
  object properties — apply the host-lane escape-analysis walk
  (`hostLaneGeneratorUsesAreSafe`) ONLY in the JS-host lane, as today; in
  standalone/wasi route natively whenever eligible (there is no host consumer
  to protect).
- **Out of scope:** async function expressions (ride #3132), captures
  (#2203 follow-up), rest params (#2920).

### Edge cases

- Harness IIFE where the generator body never yields (`function*(){ iterCount += 1; }`)
  — zero-suspend generators are native candidates since #2938; verify
  `.next()` → `{value: undefined, done: true}` and that the body runs lazily
  (first `next()`), not eagerly (#928 semantics differ between paths: the
  eager path defers thrown exceptions to first next(); the native path must
  match — it already does for declarations).
- `var g = function*(){}; g.prop = 1` — property assignment on the function
  value: bail (escape) in slice 1.
- Generator expression flowing into `yield*` of an EAGER host-path outer
  generator in host lane — already covered by `hostLaneGeneratorUsesAreSafe`;
  in standalone the outer is native or refused, no mixed case.

### Validation

- Scoped: `npx tsx` probe compiling the harness shape
  `var iter = function*() { c += 1; }();` at `--target standalone` and
  asserting the module's import section contains NO `env::__gen_*` /
  `env::__create_generator` entries.
- `tests/equivalence.test.ts` (host-lane parity must be byte-inert for
  ineligible shapes).
- CI: standalone lane `host_free_pass` must jump by ~1,000+; merge_group
  standalone floor is the hard gate. Verify with the jsonl `imports` field:
  count of pass-records containing `env::__create_generator` should drop from
  1,741 to <300.

### Classification

**fable-executable-now** — the native factory, plan builder, and both method
wirings (#2571/#2581) are established patterns to follow; no new substrate
design.

## Implementation Notes (2026-07-12, sendev-3164)

Implemented as slice 1 (zero/identifier params) in three parts — the plan's
"consumers already dispatch" claim held only for `.next()`; the dynamic
iteration consumers needed real work:

1. **Admission** (`generators-native.ts`, `closures.ts`, `context/types.ts`):
   `GeneratorDecl` widened with `ts.FunctionExpression`;
   `isNativeGeneratorCandidate` gained a fn-expr shape gate
   (`isNativeGeneratorExpressionShape`: identifier-only params without
   default/optional/rest, no `arguments`, no `this`/`super` outside nested
   non-arrow scopes, no self-name reference for NAMED fn-exprs, no outer
   capture). `sourceNeedsGeneratorHostImports` consults the same gate, so the
   `__gen_*` bundle is skipped exactly when every fn-expr is admitted. The
   closures.ts emit site registers the fn-expr under its lifted
   `__closure_<n>` name with `paramTypes = [selfType, ...arrowParams]` and
   `leadingCaptures = [{name: "__self"}]` — the factory's `local.get 0..n`
   then aligns 1:1 with the lifted wasm params, and the resume prelude
   rehydrates user params by name. The closure ABI is UNCHANGED (externref
   return, `extern.convert_any` on the state struct), so function VALUES
   (`g.prop = 1`, passing `g` around) need no escape analysis; only the
   returned generator object changed representation. A candidate/pre-scan
   desync in the eager arm late-registers the import bundle
   (`addGeneratorImports({allowNoJsHost:true})`, the IR-path idiom) instead of
   baking an undefined funcIdx.
   - WHY defaults/patterns bail (slice 1): per §27.5 EvaluateGeneratorBody,
     FunctionDeclarationInstantiation (param destructure side effects/throws)
     is a CALL-time observable; the #2920 resume prelude defers it to state 0.
     The `-err`/`-throws` dstr families would flip leaky-pass→fail if admitted.
2. **Dynamic consumers** (`iterator-native.ts`): new `ITER_KIND_GENSTATE`
   (=7) arm across the whole generic runtime — GetIterator identity arm in
   `__iterator`, per-producer resume drive + per-elem boxing (UNDEF_F64
   sentinel-aware) in `__iterator_next` (an f64 scratch local is appended at
   fill time), `__iterator_rest` stepKinds, `__array_from_iter_n` drainability
   admission (without which externref destructure silently answered length 0 →
   all bindings undefined), and an IteratorClose arm in `__iterator_return`
   that writes `state := doneState` (a closed generator's later `.next()` is
   `{undefined, true}`; finally-on-close stays out of scope — the #2903
   iter-hof boundary). Producers = `ctx.nativeGenerators` values with
   `resumeFuncIdx` emitted, deduped by state type, at finalize fill time.
3. **Host-mix dispatch** (`generators-native.ts`): the open
   `.next()/.return()/.throw()` dispatch's #1344 miss arm assumed every
   generator in the module is native — false once fn-exprs go native while a
   sibling shape bails (the `gen-meth-dflt-*-fn-name-gen` class regressed
   pass→fail with `Generator.prototype.next requires that 'this' be a
   Generator`). When the host `__gen_*` machinery is registered (funcMap
   presence — never adds imports), the miss arm now classifies the receiver:
   an internalized HOST external (neither struct/array/i31 — the #3075
   HOSTGEN trick) routes to `__gen_next/return/throw` and wraps the result
   into `__NativeGeneratorResult_externref` (dispatch block type forced to
   eqref); internal non-generators keep the #1344 TypeError. The open result
   reader includes the externref result struct whenever it exists.

**Also fixed en passant**: `tests/issue-3032-lazy-generator-expressions.test.ts`
"buffered semantics" expectation updated — the native path suspends at each
yield (spec-correct), the old host thunk ran the whole body on first resume.

**Validation** (local): 130-file test262 sample (100 leaky + 30 host-free
controls): 0 regressions, +6 status fixes, host-free 15→25; 40-file zero-param
sample: 0 regressions, +10 fixes, host-free 7→16. All direct consumers probed
host-free: `.next()`, for-of (any), destructure, rest, spread, `Array.from`,
throw-at-step propagation, close-marks-done. tests/issue-1344.test.ts green
(receiver validation preserved). Full standalone delta validated by CI
shards + merge_group floor.

**Follow-ups (out of slice)**: pattern/default params for fn-exprs (needs a
call-time destructure model, see WHY above); `arguments` (needs an args-vec
slot in the state struct); async fn-exprs ride #3132; the `gen-meth-*dflt*`
method families still bail (their own admission slice).
