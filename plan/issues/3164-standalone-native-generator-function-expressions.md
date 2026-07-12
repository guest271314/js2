---
id: 3164
title: "Standalone: native lowering for generator FUNCTION EXPRESSIONS (anonymous/IIFE/var-assigned) — retires ~1,700 sync __create_generator leaky passes"
status: ready
sprint: current
created: 2026-07-12
updated: 2026-07-12
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: generators
goal: standalone-mode
related: [1665, 680, 2203, 2571, 2581, 2920, 2940, 3132, 1781]
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
