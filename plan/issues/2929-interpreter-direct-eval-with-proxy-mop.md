---
id: 2929
title: "Interpreter direct eval + with + Proxy-MOP convergence"
status: in-progress
created: 2026-07-02
updated: 2026-08-11
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: current
parent: 1584
depends_on: [2928, 2925, 2864]
related: [1355, 2865]
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/direct-eval-environment.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/generators-native.ts
  - src/codegen/helpers/body-uses-arguments.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/statements/nested-declarations.ts
  - src/interp/eval-environment.ts
  - tests/issue-1102.test.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/generators-native.ts::isNativeGeneratorCandidate
  - src/codegen/generators-native.ts::isNativeGeneratorExpressionShape
  - src/codegen/helpers/body-uses-arguments.ts::bodyNeedsArgumentsObject
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
---

# #2929 — Interpreter direct eval + `with` + Proxy-MOP convergence

Slice **F** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-F, §7).
#1584 Phase 2. Adds standalone **direct-eval scope capture** to the interpreter,
and — deliberately — builds the shared substrate (`with`, Proxy MOP) so those
tracks converge on it instead of re-deriving it.

## Scope

### 1. Standalone direct-eval scope capture
Add `LdName` / `StName` opcodes that resolve identifiers against a **reified
environment-record chain** (§4.1). Reuse the `$EnvRecord`/name-map carrier
introduced in the JS-host reification slice **#2925** (which extends #2864's
`$Frame` with a name map) — do NOT define a second environment type. This makes
`function f(){ var x=1; eval("x=2"); return x }` return `2` **standalone**,
mirroring the JS-host behavior #2925 delivers.

### 2. `with` (shared substrate, roadmap §7)
`with (obj) { … }` prepends an **object environment record** to the lexical
environment chain and resolves names against the object's properties — the same
chain the interpreter walks for direct eval, with one link being an arbitrary
object. Implement `with` as an object-environment-record variant of the §1
chain. (`with` is currently in the IR "deferred-feature" bucket alongside eval;
this is where it exits that bucket.)

### 3. Dynamic meta-object protocol (Proxy trap surface, roadmap §7)
The interpreter's generic property opcodes —
`Get`/`Set`/`GetByValue`/`HasProperty`/`OwnKeys`/`Delete` — must implement the
full ordinary-object internal methods (prototype chain + descriptor semantics)
on `any`-typed receivers. Build these as **reusable `$Object`-level MOP
primitives** so #1355's Proxy handler dispatch plugs into the *same* surface.
**This issue does not implement Proxy traps or edit #1355's files** — it exposes
the MOP primitives #1355 consumes, and coordinates their signatures with the
#1355 owner (roadmap §7).

### 4. Generator / async opcodes
`SuspendGenerator`/`ResumeGenerator`/`YieldValue`, aligned with the #2864/#2865
`$Frame` suspend/resume encoding (the interpreter's frame IS the #2864 carrier).

## Coordination (must-not-diverge)

Per roadmap §7, the `$EnvRecord` type (with #2925/#2864) and the MOP-primitive
signatures (with #1355) are reviewed **jointly with those owners before
implementation**, so one carrier and one MOP surface serve direct-eval, `with`,
and Proxy.

## Acceptance criteria

- [x] `function f(){ var x=1; eval("x=2"); return x }()` returns `2`
      **standalone** (interpreter direct-eval capture).
- [ ] `with ({a:1}) { a }` evaluates to `1` via the object-environment-record
      chain (standalone).
- [ ] The MOP primitives are consumed by at least one #1355 Proxy trap in a
      joint integration test (coordinated, not implemented here).
- [ ] A generator run through the interpreter suspends/resumes correctly using
      the #2864 `$Frame` carrier.
- [ ] Direct-eval scope tests pass identically via JS-host (#2925) and the
      standalone interpreter (differential check).

## Notes

Depends on #2928 (VM core), #2925 (env-record carrier), #2864 (`$Frame`).
Converges with #1355 (Proxy) and `with`. Umbrella: #1584. Goal: `runtime-eval`.

## 2026-08-02 implementation handoff

Branch `codex/2929-direct-eval-capture` implements a resumable direct-eval
interpreter checkpoint:

- an AOT function whose lexical descendants can reach direct `eval` promotes
  eval-visible locals to the compiler's existing canonical mutable capture
  cells;
- direct eval passes current-activation state, lexical captures, outer captures,
  strictness, and mapped-parameter metadata through the standalone provider
  boundary
  `__runtime_direct_eval(source, globalObject, thisArg, activationState, activationSeedNames, activationSeedSlots, lexicalNames, lexicalSlots, outerNames, outerSlots, callerStrict, mappedParamNames)`;
- the provider creates a declarative `$EnvRecord` above the global record, and
  interpreter name lookup, assignment, and `typeof` dereference those live
  cells; and
- writes therefore flow both ways without a copy-back pass. The standalone
  probes cover an ordinary function, a nested function declaration, a function
  expression, an arrow, non-string passthrough, the refusal provider, and the
  real zero-import Acorn provider.

The MVP mutation gate is green: a caller cell initialized to `40` is changed by
dynamic direct eval to `42`, and the probe observes both the eval result and the
subsequent AOT read (`42 + 42 = 84`). Existing indirect-eval and `new Function`
provider routes remain green.

The follow-on declaration/strictness slice is also present on the same branch:

- `EvalDeclarationInstantiation` now separates top-level `var`/function names,
  top-level lexical names, and nested block functions;
- strict direct eval inherits caller strictness across the provider ABI, while a
  source-level `"use strict"` directive is detected inside the runtime AST;
- strict eval receives a private declarative var environment, and top-level
  `let`/`const` bindings receive a private TDZ environment;
- `InitName` initializes those predeclared lexical cells without weakening
  ordinary assignment's TDZ and strict-unresolvable checks; and
- nested block functions use real block lexical environments, so their closures
  retain the correct environment without leaking after the block exits.

Three further MVP slices are included:

- **Activation persistence.** Each AOT activation owns a persistent eval overlay
  with capacity for 64 eval-created names. Sloppy top-level eval `var` and
  eligible Annex B block-function bindings survive later direct-eval calls in
  the same activation, while strict eval and lexical declarations remain
  isolated. Current-activation names, lexical captures, and outer captures are
  represented separately, so a new current-function `var` cannot overwrite an
  outer capture.
- **Mapped arguments.** Sloppy simple parameters and `arguments[index]` share
  the same backing cells across direct eval. The dispatcher preserves the raw
  source-level argument count while widening to declared arity, and the local
  snapshot restores the exact boxed capture map. Parameter-to-arguments and
  arguments-to-parameter canaries return `202` and `303`, respectively.
- **Block, Annex B, and class MVP.** Nested blocks create lexical environment
  records with TDZ, closure capture, and cleanup on normal exit, `break`,
  `continue`, and exceptions. Sloppy block functions implement bounded B.3.3
  outer-binding behavior, including lexical-conflict and skipped-block cases.
  Classes support declarations and expressions, default/explicit constructors,
  and ordinary noncomputed instance/static methods. Class bodies are strict and
  calling a class without `new` throws `TypeError`. Inheritance, fields, private
  names, accessors, computed names, and `super` fail loudly.

Class construction and method calls are green while the class remains inside
the interpreter. Returning an interpreted class through the provider and then
constructing it in a separately compiled AOT module still loses constructor
arguments/prototype state. That is the deferred generic external-callable /
cross-module rec-group ABI seam, not an interpreter class-semantics success;
this checkpoint does not claim it.

The real Acorn provider remains a zero-import standalone artifact. Its runtime
canaries cover sloppy caller mutation, strict-source and strict-caller var
isolation, lexical isolation and TDZ, strict early errors, indirect strict var
isolation, declaration-plan/environment construction, activation persistence,
mapped arguments, block shadowing/TDZ/closure capture, abrupt-completion
cleanup, Annex B block functions, and the bounded class surface above. The
focused Node environment suite is 18/18.

### Test262 eval-code measurement

The full standalone runtime-eval lane was measured with:

```sh
TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 \
TEST262_PATH_FILTER=language/eval-code \
TEST262_REPORTER=dot \
pnpm run test:262
```

Result: **207 / 816 pass (25.4%)**, all 207 host-free.

| Scope | Pass | Total | Direct | Indirect |
| --- | ---: | ---: | ---: | ---: |
| Current standard | 130 | 347 | 97 / 286 | 33 / 61 |
| Annex B | 77 | 469 | 52 / 309 | 25 / 160 |
| Combined | 207 | 816 | 149 / 595 | 58 / 221 |

The 207-file passing surface is concentrated in these concrete families:

- direct and indirect non-string passthrough, `parse-failure-1..6`, and normal
  completion-value cases (`cptn-nrml-*`);
- strictness/isolation cases including direct `strict-caller-*`,
  `strictness-override`, both `block-decl-eval-source-is-strict-*` variants,
  indirect `always-non-strict` / `block-decl-strict`, and the passing strict
  `var-env-func-*`, `var-env-global-lex-*`, and `var-env-lower-lex-*` cases;
- the supported arrow/async arguments-declaration matrix where `arguments` is
  absent, a parameter, a `var`, or a function declaration (lexical-binding and
  several method/default-parameter shapes remain failures);
- direct global-environment/catch/eval/function cases, selected `this` and
  `super-call` cases, and direct/indirect import/export syntax checks; and
- 77 Annex B cases, primarily `*-block-scoping`, existing function/var
  no-initializer behavior, and the selected `*-skip-early-err-{block,for}`
  variants listed by the lane result.

Non-pass outcomes were 565 runtime failures, 16 compile errors, and 28 compile
timeouts. The leading runtime buckets were 349 assertion failures, 173 other
errors, 24 syntax errors, 14 illegal casts, 3 type errors, 1 negative-test
failure, and 1 null dereference; the 16 compile errors were reported as host
import leaks.

A maintained 56-test `var-env-*` / `lex-env-*` declaration cohort was measured
before and after this follow-on and remained **16 / 56** with no per-file status
changes. These Test262 inputs use literal eval sources and are currently handled
by the compiler's separate AOT `tryStaticEvalInline` path, so that cohort does
not exercise the runtime interpreter. The dynamic Acorn-provider canaries above
are the acceptance gate for this slice. A future interpreter-only Test262 score
needs an explicit maintained compile mode that prefers runtime eval; it must not
silently disable constant folding, because existing acceptance tests require
literal eval to remain provider-free.

The final post-merge full-lane A/B run (`20260802-075946`) remained **207 / 816** with the
exact same 207 passing files as the pre-slice baseline: zero pass-to-fail and
zero fail-to-pass transitions. Candidate non-pass outcomes were 569 runtime
failures, 16 compile errors, and 24 compile timeouts. The only four status
changes were Annex B files that moved from compile timeout to a known runtime
`ReferenceError`; they do not change the passing denominator. Current-standard
coverage remains 130/347 and Annex B remains 77/469.

### Remaining work, in recommended order

1. Complete dynamic mapped-arguments descriptor semantics: deleting or
   redefining an indexed property must sever the parameter alias exactly when
   required. The current MVP covers ordinary indexed reads/writes and direct
   parameter mutation, not every descriptor transition.
2. Extend lexical lowering to per-iteration loop environments, catch-parameter
   lexical bindings, and `switch`; extend classes with inheritance, fields,
   private names, accessors, computed names, and `super`.
3. Cover methods, async/generator functions, `new.target`, `super`, and strict-
   caller `this` behavior in the interpreter emitter/runtime. Freeze the
   external callable/constructor and rec-group ABI with the packaging owner
   before claiming classes returned across a module boundary.
4. Implement the object environment record for `with`, then coordinate the
   shared ordinary-object MOP surface with #1355 before adding Proxy traps.
5. Add generator suspend/resume opcodes on the shared #2864 frame carrier, then
   run the JS-host/standalone differential acceptance gate.

This branch is a resumable MVP slice, not closure of #2929. Only the first
acceptance checkbox is satisfied.

## 2026-08-03 verified handoff

The current checkpoint closes the runtime-routing and direct-capture MVP while
leaving the broader `with`/Proxy/generator scope open. In addition to the
previous caller-mutation gate, it now covers persistent sloppy-eval bindings,
strict/private declaration environments, mapped arguments, nested block and
loop lexical environments, bounded Annex-B block functions, classes, direct
eval caller-`this`, and the cross-module interpreted-callable boundary. The
deterministic linked-runtime probe now mirrors production by unwrapping
arguments and receivers before `applyRuntimeEvalCallable` and exposing returned
interpreted environments.

The authoritative local interpreter-tier measurement is:

| Scope / route | Pass | Total |
| --- | ---: | ---: |
| Standard direct eval | 108 | 286 |
| Standard indirect eval | 60 | 61 |
| Annex-B direct eval | 185 | 309 |
| Annex-B indirect eval | 120 | 160 |
| **Combined** | **473** | **816** |

The same worktree with the refusal provider passes 158/816. Comparing the two
JSONL result sets yields **315 interpreter-attributable fail→pass transitions**
and **zero pass→fail regressions**. The full arm has no timeouts or skips; its
44 compile errors are unchanged from the refusal arm. Run IDs are
`20260803-015311` (full) and `20260803-020039` (refusal), both with
`COMPILER_POOL_SIZE=2`, `TEST262_WORKERS=2`, and a 600-second per-test queue
budget. Generated benchmark reports are intentionally not part of the source
commit.

Focused verification is 128/128 plus typecheck. The final regression repair in
this checkpoint makes sloppy direct eval inherit the already-established
caller `this` (including global substitution for a bare sloppy AOT call), and
prevents Annex-B synthetic outer vars from crossing `for (let …)` lexical
bindings. The affected Test262 files moved 18/18 from fail to pass over the
immediately preceding 455-pass run, with no regressions.

### EvalDeclarationInstantiation collision slice

The next slice now implements the non-strict
`LexicalEnvironment`→`VariableEnvironment` preflight before creating any eval
binding. It checks the complete ordinary `var`/function name set atomically,
skips object environment records, applies Annex-B cancellation to eligible
block functions, and fails closed if the supplied environment chain is
malformed. The AOT capture boundary now classifies
function-body `let`/`const`/class bindings as lexical rather than as var
activation entries, so the production Acorn route sees the same intervening
record as the interpreter unit seam. Cancelled B.3.3 assignments are omitted
from emitted bytecode, preserving both the caller lexical cell and the Script's
empty-completion behavior; the assignment builtin also refuses to fall through
to an unrelated same-named lexical binding.

The literal direct-eval fast path normally remains provider-free, so
`tryStaticEvalInline` separately
reconstructs the caller-dependent collision rules. It recognizes lower lexical
bindings and parameter-initializer environments, including ordinary functions'
implicit `arguments` binding, while preserving the permitted arrow case with no
pre-existing `arguments` binding. Explicit strict eval declarations route to
the provider because the foreign-AST splice cannot supply their private
environment.

The maintained honest standalone cohort selected by
`declare-arguments|var-env-lower-lex` contains exactly 198 official Test262
files. Restricting the pre-slice full-interpreter run `20260803-015311` to those
same paths gives 52 pass / 102 fail / 44 compile errors. Candidate run
`20260803-042954`, measured after reconciling the branch with current main,
gives **154 pass / 0 fail / 44 compile errors**: exactly **102 fail→pass**,
52 pass→pass, 44 compile-error→compile-error, zero
pass→fail, and no missing rows. The full zero-import Acorn package canary and
the focused interpreter/environment/static-eval/Annex-B/provider tests also
pass; the directly affected unit suites are 49/49 and the real Acorn package gate
is 1/1.

The former sole runtime residual is now green:
`arrow-fn-body-cntns-arguments-func-decl-arrow-func-declare-arguments-assign-incl-def-param-arrow-arguments.js`.
Closure capture analysis recognizes a closure created directly
inside a parameter initializer and prefers its live parameter-environment
local over an eagerly registered same-named body function. Eval's
parameter-environment `arguments = "param"` cell therefore remains visible to
the default-parameter arrow while the later function-body
`function arguments(){}` binding remains the body binding.

The compile-error follow-on closes the remaining 44 files. Run
`20260803-044922` first moved the cohort to **182 / 198**: method values read
from direct-eval-reified object bindings now recover their concrete WasmGC
struct from `externref` before reading the closure field. This eliminated all
36 invalid-Wasm modules; 28 became passes and 8 exposed generator host imports
that the earlier validation error had masked, leaving 16 generator-family
compile errors and no runtime failures.

Run `20260803-045435` is the final measured gate: **198 / 198 (100%)**, with
zero runtime failures, compile errors, host-import leaks, timeouts, skips, or
missing rows. Generator admission now distinguishes a bare body binding named
`arguments` (`let arguments;` / `var arguments;`) from an executable use that
requires the implicit arguments object. The 12 synchronous generator
function-expression/method cases and 4 async-generator method cases therefore
use the existing native standalone generator paths; their default-parameter
direct eval still throws the required catchable `SyntaxError` at call time.

Across the fixed path set, the pre-slice `20260803-015311` baseline's 52 passes
remain passes, all 102 runtime failures and all 44 compile errors become passes,
and there are zero pass-to-fail transitions. Focused direct-eval coverage is
29/29 and the relevant native generator suites are 60/60 after excluding one
unrelated mixed async-generator warning assertion that reproduces unchanged on
the exact stacked baseline; typecheck passes. Generated Test262 reports remain
outside the source commit.

### Next-agent order

1. Finish Annex-B block-function initialization and update semantics. The
   largest residual clusters are missing function-valued outer updates,
   skipped-declaration initialization, and existing-global descriptor cases.
2. Close mapped-arguments descriptor severing and `new.target`/`super`/method
   context before attempting the full differential checkbox.
3. Continue the original issue scope with the object environment record for
   `with`, the jointly-owned #1355 MOP seam, and #2864 generator suspend/resume.

Do not reinterpret the 473/816 figure as the default CI baseline: it requires
`TEST262_FULL_RUNTIME_EVAL=1`. The default refusal tier remains intentionally
capability-free until the full provider is published as a reusable build
artifact.

## 2026-08-03 Annex-B eval binding lifecycle checkpoint

Branch `codex/2929-annexb-init-update` is a suspended, resumable follow-on to
the direct-eval collision slice. It does not close #2929.

The checkpoint fixes four lifecycle boundaries exposed by the Test262
`eval-code` Annex-B collision family:

- A `BlockStatement` directly under a Script `SourceFile` is now classified as
  a real block-nested Annex-B declaration site, rather than being mistaken for
  a function body's declaration list.
- Constant direct eval remains on the import-free AOT path for simple late-read
  block functions, but routes to the interpreter when B.3.3 initialization or
  update order depends on an eval `var`, a caller/global binding, an early
  reference, or a source-level `if`/`switch` declaration.
- Sloppy direct eval at Script global scope enters the provider through the
  global-environment route. This avoids an empty synthetic activation record
  hiding B.3.3 global object properties.
- B.3.3's synthetic outer assignment first updates an eval-created variable,
  then the exact pre-existing caller activation cell recorded by declaration
  instantiation. It never walks into an unrelated outer capture or lexical
  record.

The frozen focused gate is green:

- `pnpm run typecheck`
- 57/57 tests across `tests/issue-2929-annexb-eval-lifecycle.test.ts` and
  `tests/interp/eval-environment.test.ts`
- 2/2 selected import-free `block-nested` / `if-nested` fast-path canaries in
  `tests/issue-2923-eval-const-broaden.test.ts` (17 unrelated cases skipped)

The new coverage proves fresh and existing global descriptors, later
same-name block-function wins, exact caller activation updates, provider
routing for pre-declaration/collision cases, and preservation of the simple
zero-import `eval("{ function f() {} } ...")` fast path.

During PR #4077's 2026-08-04 main sync, its proposed 16-line classifier was
found already present on `main` with the required `ctx.standalone` boundary.
The stale unqualified duplicate made host literal indirect Annex-B eval import
`__extern_eval`, so it was removed. No unique interpreter source delta remains
in #4077; the corrected lifecycle checkpoint is already on `main`.

### Publication and remaining gate

PR #4013's merge-group Test262 gate rejected the preceding direct-eval
checkpoint. On the content-current merge candidate it measured 48,346/48,346
rows with 184 stable non-timeout regressions versus 105 improvements, a net
-79 fine-gate delta, a 217-pass standalone-floor breach, and five new null
dereferences in Annex-B existing-var-update files. CI, differential, and CLA
were green; the Test262 result is a real landing blocker and must not be
bypassed.

This follow-on targets the common B.3.3 lifecycle cause, but the user-requested
suspension happened before a fresh complete 101-file collision replay or full
816-file eval-code A/B measurement. The next agent should therefore:

1. Rebase or merge the current `origin/main`, build the full interpreter
   provider, and run the exact 101-file collision slice before attempting to
   land #4013 or this stacked PR. Require zero pass-to-fail transitions and no
   standalone-floor breach.
2. Re-run all five `existing-var-update` null-dereference files first. If any
   remain, trace materialization of the explicit eight-slot interpreted
   callable carrier; do not alter the shared closure/rec-group ABI merely to
   fit this path.
3. Finish same-name AOT/global block-function synchronization, especially the
   direct and indirect `existing-block-fn-update` cases, and preserve existing
   global property descriptors through block execution.
4. Isolate the cross-module `verifyProperty` open-object-to-closed-struct
   illegal cast at `__call_fn_method_4`; keep it separate from interpreter
   declaration semantics and from the deferred E6 packaging/rec-group ABI.
5. Only after the collision slice is clean, repeat the full interpreter-tier
   `language/eval-code/` measurement and update the 473/816 handoff table with
   an explicit provider tier and run IDs.

Generated Test262 reports and `benchmarks/results/runs/index.json` are not part
of this checkpoint.

### Merge-group repair checkpoint (2026-08-03)

The suspended collision handoff above has now been executed against merge-group
predecessor `ff5041e3` and repaired on PR #4013. The exact 38 locally
reproducible predecessor-pass/candidate-fail Test262 paths are 38/38 passing.
Across the complete 184-path stable non-timeout failure artifact, the repaired
branch is 145 pass / 39 fail; all 39 remaining failures reproduce on the exact
predecessor, leaving zero predecessor-pass/current-nonpass transitions.

The repair keeps provider-only routing in standalone mode while restoring the
established host literal compile-away boundary. It also closes the merge-group
gaps in direct-eval activation shadowing, Annex-B existing-var updates, native
async exception rejection, host callback argument-count isolation, and
recursive tagged-template capture forwarding. The focused unit matrix is
65/65 and typecheck passes. Generated Test262 reports and benchmark indexes
remain excluded from the checkpoint.

### Standalone merge-group follow-up (2026-08-03)

The next merge-group candidate exposed a separate standalone boundary defect.
Its 25,075 passes missed the 26,996 high-water floor by 1,921. A line-safe
predecessor/candidate join split the pass losses into four concrete cohorts:

- 1,877 illegal casts through `__call_fn_method_4` and 65 through
  `__call_fn_method_2`, both reached from the runtime-eval AOT-callable adapter;
- 100 deliberate refusal-provider `TypeError`s after semantically unsafe
  literal-eval splices were declined (55 Annex B, 10 other primary strict-eval
  cases, and 35 inherited-strict reruns); and
- 29 in-process fixture-graph modules whose harness never attached the cached
  `js2wasm:runtime-eval` provider namespace.

The callable repair preserves the source-level argument count while turning
omitted nullable reference formals into typed nulls before dispatch. It also
makes reference-valued parameters representation-neutral for top-level script
functions published through runtime eval, so a supplied object keeps its
identity and properties instead of being cast to a nominal, unrelated WasmGC
struct. Numeric/native scalar specialization and modules without the runtime-
eval boundary remain unchanged.

The Test262 fixture path now uses the same shared cached-provider selection as
the fork worker and instantiates a fresh provider per fixture. A representative
previously unlinkable module is 1/1 passing, a five-fixture sample has no
missing-provider failures, the 24-file callable sample has zero illegal casts,
the exact host regression replay remains 38/38, the focused callable/provider
unit matrix is 28/28, and typecheck passes. The 100 refusal transfers remain
intentional and are not hidden by weakening the semantic bails. Recovering the
1,942 cast rows plus 29 fixture links projects 27,046 passes on the same merge-
group population, 50 above its floor; the authoritative confirmation remains
the next merge-group run.

### Final #4013 collision checkpoint (2026-08-03)

The authoritative replay replaces that projection. Merge-group run
`30800239895` had 27,041 predecessor passes, 26,953 candidate passes, and a
26,996 floor. Its exact 101 predecessor-pass/candidate-fail paths comprised 65
primary records and 36 inherited-strict reruns. With the full provider selected
through the real fork worker, the repaired branch now records **101 / 101
passes**, with zero runtime failures, compile errors, or skips.

The final repair has four bounded parts:

- runtime-eval reference parameters widen only structurally typed object/
  interface parameters; native strings, vectors, promises, closures, and class
  instances keep their existing representations;
- capturing sibling declarations are pre-registered before any sibling body is
  compiled, and only explicit lifted captures are forwarded, so returned and
  recursively referenced closures materialize the established callable carrier
  without a null dereference;
- full-provider CI uses one canary-verified uploaded cache artifact for every
  standalone shard and fails loud when that artifact is absent, instead of
  silently selecting the refusal tier in an authoritative comparison; and
- append-only signed-shift opcodes close the two line-terminator direct-eval
  rows that remained after the first 99/101 replay.

The tagged-template TCO reproducer now reaches the same ordinary stack overflow
as the merge-group predecessor rather than trapping on a null dereference. The
focused Node/standalone/provider matrix is 81/81, the exact collision replay is
101/101, the required full-provider cache canaries pass, and typecheck passes.
No callable type, rec-group ABI, runtime-eval namespace, or result-envelope ABI
was changed. Generated Test262 reports and cache artifacts remain outside the
commit.

The PR is ready for a fresh merge-group run. If it fails again, the next agent
should diff the new candidate against its exact merge-group predecessor and
work only newly introduced transitions; do not return authoritative standalone
shards to the refusal provider or broaden the shared closure ABI.

## Implementation Plan — EvalDeclarationInstantiation early errors (arch, 2026-08-08)

### 0. Population reality check — the "~89 SyntaxError" cluster is ALREADY LANDED

Fresh measurement on main tip `a8bbc0d7` (this spec's worktree, full Acorn+interpreter
provider, cache key `8d62618f76cb96b7`, run `20260808-072852`):

```sh
TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

Result: **747 / 816 pass (91.5%)** — standard 305/347, Annex B 442/469, 69 fail,
0 CE, 0 timeout. The 2026-08-03 measurement this issue's task text was written
against (473/816, "89 missing EvalDeclarationInstantiation SyntaxErrors in
literal direct-eval / default-parameter shapes") predates the merged collision
slices (PR #4013 lineage; `src/interp/` landed on main 2026-08-07 via the
#4156 merge). **The entire 192-file `declare-arguments` default-parameter
matrix now passes (192/192, zero failures).** The var-env strict shapes and
lower-lex shapes also pass. Do NOT re-implement:
`foldedEvalParameterCollision` / `foldedEvalLowerLexicalCollision`
(`src/codegen/expressions/eval-inline.ts:360-470`), the interpreter's
`validateNonStrictEvalVarNames` / `prepareGlobalDeclarations` / TDZ lexical
records (`src/interp/eval-environment.ts:470-642`), or the
`preparePersistentEvalBindings` atomic preflight — all merged and green.

What REMAINS of the EvalDeclarationInstantiation early-error family, from the
69-failure enumeration (exact file list in
`benchmarks/results/test262-standalone-results-20260808-072852.jsonl`):

| Bucket | Count | Expectation | Status |
| --- | ---: | --- | --- |
| **A. Global lexical collision** (sloppy eval `var x` vs script `let x`) | 2 | runtime SyntaxError | evaluates silently — **this spec** |
| **B. Eval-lexical leak** (`eval("let x=3")` leaks `x` into caller) | 8 | typeof undefined + ReferenceError after eval | binding leaks — **this spec** |
| **C. Global own-property var/func init** (`var-env-{var,func}-init-*`, `var-env-{var,func}-non-strict`) | 13 | own property on globalThis, configurable, deletable | module-global storage, not `$Object` property — **sketch, follow-on slice** |
| **D. Non-definable global** (`non-definable-global-{var,function,generator}`) | 6 | TypeError (CanDeclareGlobalVar/Function) | no runtime check — **sketch, depends on C** |
| E. `SyntaxError: NaN` Annex-B skip-early-err | 24 | must NOT throw early | **#4137's — in-progress, another lane. DO NOT TOUCH** |
| F. Out of scope: new.target (4), super-prop (6), this-value-func-strict-caller (1), indirect realm (1), indirect lex-env-heritage (1), annexB existing-block-fn-update (2), annexB script-decl-lex-no-collision (1) | 16 | various | different mechanisms (metaproperties/method context, realm identity, B.3.3 update) |

2+8+13+6+24+16 = 69 ✓.

**Bucket A files (2):**
- `test/language/eval-code/direct/var-env-global-lex-non-strict.js` — `let x; eval('var x;')` at global; `negative: {phase: runtime, type: SyntaxError}`; currently "expected runtime SyntaxError but succeeded"
- `test/language/eval-code/indirect/var-env-global-lex-non-strict.js` — `let x; (0,eval)('var x;')` in try; caught must be SyntaxError; currently nothing thrown

**Bucket B files (8):** `test/language/eval-code/{direct,indirect}/lex-env-distinct-{let,const}.js`, `test/language/eval-code/{direct,indirect}/lex-env-no-init-{let,const}.js` — e.g. `eval('let xNonStrict = 3;')` then `assert.throws(ReferenceError, () => xNonStrict)`; currently the `let` resolves after the eval returns.

**Bucket C files (13):** direct: `var-env-func-init-global-new`, `var-env-func-init-local-new`, `var-env-func-init-local-new-delete`, `var-env-func-init-local-update`, `var-env-func-non-strict`, `var-env-var-init-global-new`, `var-env-var-init-global-exstng`, `var-env-var-init-local-new-delete`; indirect: `var-env-func-init-global-new`, `var-env-func-non-strict`, `var-env-var-init-global-new`, `var-env-var-init-global-exstng`, `var-env-var-non-strict`.

**Bucket D files (6):** `{direct,indirect}/non-definable-global-{var,function,generator}.js`.

### 1. Root cause (buckets A and B — both in the AOT constant-splice path)

Both failing populations use **literal** eval sources, so they never reach the
interpreter: `tryStaticEvalInline` (`src/codegen/expressions/eval-inline.ts:657`)
splices the foreign AST into the caller and returns before the provider routing
in `calls.ts:6313-6323`. The interpreter side is already correct for both rules
(`prepareGlobalDeclarations` at `eval-environment.ts:554` throws the
HasLexicalDeclaration SyntaxError against the global lexical-cells carrier;
`prepareEvalEnvironment` gives eval lexicals a fresh discarded TDZ record at
`eval-environment.ts:635-642`). The splice reconstructs the
parameter-environment and lower-lexical collision rules (lines 726-738) but is
missing exactly two caller-dependent behaviors:

- **A**: no check of the eval body's VarDeclaredNames against the **script's
  global lexical declarations** (`ctx.globalLexicalBindings`, populated by
  `recordScriptGlobalLexicalBindingNames`, `src/codegen/source-scan-predicates.ts:397`,
  wired in `recordSourceGlobalEnvironment`, `src/codegen/index.ts:3173`). At
  module-init scope `fctx.directEvalBindingNames` is undefined (only
  FunctionLikeDeclarations get it, `src/codegen/function-body.ts:402`), so
  `foldedEvalLowerLexicalCollision` sees an empty set and the splice proceeds.
- **B**: `compileInlinedEvalStatements` (line 911) calls `hoistLetConstWithTdz`
  (`src/codegen/index.ts:8853`) which registers the eval body's top-level
  `let`/`const` **into the caller's live `fctx.localMap`** and never removes
  them. For direct eval, `isolateBindings` is false; for indirect eval it is
  true only when `hasScriptScopeAnnexBFunction(sf)`. Per PerformEval steps
  17-20 the eval's LexicalEnvironment is a fresh record discarded on exit; a
  later caller read of the name must be an unresolved reference.

### 2. Changes

**All changes are in `src/codegen/expressions/eval-inline.ts` only.** Do not
touch `src/interp/emitter.ts` (owned by in-flight #4137) or
`src/interp/eval-environment.ts` (correct already).

#### 2a. Bucket A — global-lexical collision guard in the splice

Location: inside `tryStaticEvalInline`, immediately after
`const declarationNames = foldedEvalDeclarationNames(sf);` (line ~721),
alongside the existing direct-eval collision block (lines 726-738).

```ts
// §19.2.1.3 step 3.a: when eval's VariableEnvironment is the
// GlobalEnvironmentRecord, every VarDeclaredName must miss the script's
// lexical declarations. Applies to ALL sloppy indirect eval (its varEnv is
// always global) and to sloppy direct eval whose call executes in global
// Script code (module-init fctx — blocks/case/catch do not change varEnv).
if (!evalIsStrict && (!directEval || fctx.name === "__module_init")) {
  const globalLexicals = ctx.globalLexicalBindings;
  if (globalLexicals !== undefined && globalLexicals.size > 0) {
    for (const name of declarationNames.varNames) {
      if (globalLexicals.has(name)) {
        emitThrowJsError(ctx, fctx, "SyntaxError",
          `Identifier '${name}' has already been declared`);
        return { kind: "externref" };
      }
    }
  }
}
```

- Use the `fctx.name === "__module_init"` predicate (same precedent as
  `unsupportedGlobalShape`, line 763), NOT a parent-pointer walk: a nested
  `eval('eval("var x")')` recursion compiles foreign AST nodes whose parents
  reach the foreign `EVAL_SOURCE_FILENAME` SourceFile, so an AST walk gives
  the wrong answer, while the fctx identity is inherited correctly. It is also
  deliberately different from `directEvalRunsAtScriptGlobal`
  (`calls.ts:3264`), which stops at Block/Case/Catch/With — that predicate
  models the LexicalEnvironment global-route; varEnv-globality must NOT stop
  at blocks.
- `declarationNames.varNames` already includes top-level FunctionDeclaration
  names (see `foldedEvalDeclarationNames`, line 374-406) — required, since
  VarDeclaredNames covers them.
- **Exclude `declarationNames.blockFunctionNames`** — B.3.3 cancels, never
  throws (this is what keeps `annexB/.../script-decl-lex-no-collision`-family
  and the `*-skip-early-err-*` family unaffected).
- `evalIsStrict` is the already-computed value at line 712 (uses
  `ctx.inferModuleStrictArguments`), so the #1102 AC2 TS-module lane
  (module-strict ⇒ strict eval ⇒ private varEnv ⇒ no collision) is preserved
  automatically.
- Emitting the throw (rather than `return undefined` to the provider) is
  correct AND cheaper: the error does not depend on runtime state — the
  script's lexical name set is static. It also covers host/GC mode, where the
  provider is not in play.

#### 2b. Bucket B — scoped lexical isolation for the splice

Add a collector next to `foldedEvalDeclarationNames` (~line 406):

```ts
/** Top-level LexicallyDeclaredNames of the eval body: let/const declarations
 * and class declarations directly under the foreign SourceFile. */
function foldedEvalTopLevelLexicalNames(sourceFile: ts.SourceFile): Set<string>
```

(let/const via `NodeFlags.Let | NodeFlags.Const` on direct SourceFile-child
VariableStatements, plus named ClassDeclarations; reuse
`addFoldedEvalBindingNames` for destructuring patterns.)

Add a shadow/restore pair mirroring `enterFoldedDirectEvalVarScope` /
`restoreFoldedDirectEvalVarScope` (lines 601-640):

```ts
interface FoldedEvalLexicalShadow {
  name: string;
  localIdx: number | undefined;        // caller's prior localMap entry
  boxed: BoxedCaptureInfo | undefined; // caller's prior boxedCaptures entry
  tdzFlag: number | undefined;         // caller's prior tdzFlagLocals entry
  boxedTdz: ... | undefined;           // caller's prior boxedTdzFlags entry
  preHoisted: ... | undefined;         // caller's prior preHoistedLetConstSlots entry
}
function enterFoldedEvalLexicalScope(fctx, lexNames): FoldedEvalLexicalShadow[]
function restoreFoldedEvalLexicalScope(fctx, shadows): void
```

`enter` snapshots the five per-name structures **before** the splice compiles
(so a caller binding of the same name is captured); `restore` runs **after**
the splice and (a) deletes the eval-created entries for each lexical name,
(b) reinstates the snapshot values where they existed. This makes the eval's
lexical record observably fresh-and-discarded:

- caller `let outside = 23; eval('let outside;')` — no error, eval shadows,
  caller binding restored (lex-env-distinct first half);
- `eval('let x = 3;')` — after restore `x` is unresolved in the caller, so
  `typeof x` is `"undefined"` and a bare read produces the ReferenceError the
  tests assert (the caller-side unresolved-read machinery already does this —
  proven by the strict variants of the same files, which route to the provider
  today and pass).

Apply at both call sites:

1. **Direct tail** (lines 842-858): wrap the existing
   `enterFoldedDirectEvalVarScope`/`compileInlinedEvalStatements` sequence —
   `const lexShadows = enterFoldedEvalLexicalScope(fctx, foldedEvalTopLevelLexicalNames(sf))`
   before `compileInlinedEvalStatements`, `restoreFoldedEvalLexicalScope` in
   the same `finally` that restores `directEvalSloppyThisFallback`. On the
   `result === undefined` bail path restore BEFORE falling through to the
   provider (no double bookkeeping).
2. **Indirect arm** (line 840): same wrap around
   `compileInlinedEvalStatements(ctx, fctx, stmts, isolateIndirectBindings)`.
   Note indirect isolation today is all-or-nothing keyed on Annex B functions;
   the new scoped-lexical restore is orthogonal and must run even when
   `isolateIndirectBindings` is false (vars must still share the caller/global
   scope — only lexicals are isolated).

Var declarations are deliberately NOT touched: sloppy eval-created vars
persisting in the caller activation is spec behavior and #1102 AC2.

#### 2c. How the caller's lexical-binding set reaches the check (already reified)

Nothing new must be threaded for A/B. The inputs all exist:

- script global lexicals → `ctx.globalLexicalBindings` (compile-time set) and,
  for the runtime provider path, the `RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY`
  carrier (`runtime-eval-provider.ts:46`, seeded by
  `emitRuntimeEvalGlobalBindingSeed`) which `createRuntimeEvalGlobalEnvironment`
  rehydrates into `ENV_GLOBAL.names` — that is why the dynamic-source variant
  of bucket A already throws in the interpreter (`prepareGlobalDeclarations`,
  `eval-environment.ts:560-568`);
- function-scope lexicals → `currentDirectEvalLexicalBindingNames`
  (`direct-eval-environment.ts:242`) — already consumed by
  `foldedEvalLowerLexicalCollision`, already passing its tests.

### 3. AOT splice-path guard design (general principle)

A compile-time fold must never erase a required early error. The decision
table this slice completes, for a literal eval body under standalone:

| Condition | Action |
| --- | --- |
| Parse error | emit-throw SyntaxError (exists, line 694) |
| Script early error (strict names, orphan break/continue, dup params) | emit-throw (exists, `eval-early-errors.ts`) |
| Sloppy var/func name ∈ param-env or lower-lexical (function callers) | emit-throw (exists, lines 726-731) |
| **Sloppy var/func name ∈ script global lexicals (global varEnv)** | **emit-throw (NEW, 2a)** |
| Annex B block-fn crossing caller lexical | bail to provider — cancellation, not error (exists, line 738) |
| Explicitly-strict body/caller with scoped declarations | bail to provider (exists, line 748) |
| Non-static preconditions (extensibility, descriptors — bucket D) | cannot be decided statically: bail to provider once C lands (see §5) |

Emit-throw when the error is statically certain; bail-to-provider when the
outcome depends on runtime environment state. Never splice-and-ignore.

### 4. Edge cases

- **Nested evals**: inner literal `eval` recursion inherits the outer fctx —
  the `__module_init` predicate stays correct; an inner eval spliced inside a
  function-caller fctx keeps using the function-scope collision path.
- **Blocks/switch/catch at global scope**: do NOT suppress the bucket-A guard
  (varEnv is still global). This is exactly the shape of
  `non-definable-global-*` (eval inside `if{try{}}`) — those must keep
  compiling (guard only fires on a *lexical-name* collision).
- **catch-adjacent scopes**: `catch (e) { eval('var e') }` inside a function —
  Annex B.3.5 exempts CatchParameter collisions; the function-scope path
  handles it today (passing); the new guard never fires there (not
  module-init... it can be: global `try/catch` — B.3.5 means `var e` must NOT
  throw. CatchClause bindings are NOT in `ctx.globalLexicalBindings` (only
  top-level let/const/class are — verified `source-scan-predicates.ts:407-414`),
  so the guard correctly stays silent. Add the canary anyway.
- **Indirect eval must NOT get caller collisions**: the guard consults only
  `ctx.globalLexicalBindings` — a function-local `let x` around
  `(0,eval)('var x')` never throws. `lex-env-heritage` (bucket F) is a
  separate indirect-splice caller-capture defect; out of scope here.
- **Annex B interactions — leave alone**: blockFunctionNames excluded from the
  guard; the `*-skip-early-err-*` family (bucket E) is #4137's; the B.3.3
  routing arm (lines 750-763) runs after the new guard and is unchanged.
- **Shadow restore vs. closures**: a closure created inside the eval body over
  an eval-lexical captured via `boxedCaptures` during the splice keeps its
  cell after restore (the cell local is not freed; only the name mapping is).
- **Duplicate lexicals inside the eval body** (`let x; let x`): Acorn/TS parse
  diagnostics already reject — unchanged.
- **Module-strict TS lane (#1102 AC2)**: `evalIsStrict` true ⇒ guard skipped,
  isolation for strict bodies already routes to provider — no behavior change
  for `tests/issue-1102.test.ts`.

### 5. Buckets C and D — sketch only (separate follow-on, do not bundle)

C (13 files) is a substrate item, not an eval-inline patch: eval-created
global `var`/`function` must materialize as **own, configurable (D=true),
deletable properties of the real global `$Object`** that
`Object.getOwnPropertyDescriptor(this, 'x')` sees, with `delete` severing the
binding. Today values round-trip through `__runtime_eval_push_globals`/
`__runtime_eval_pull_globals` cells but never become `$Object` own properties.
The live-binding pattern to follow is `src/codegen/annexb-global-live-binding.ts`
(#4182 — module-global-backed live cells for B.3.3.2). D (6 files) is the
runtime `CanDeclareGlobalVar/Function` TypeError arm
(`eval-environment.ts:510-523` already implements the check in the
interpreter); it is unreachable for literal evals until the splice can consult
the real global object's extensibility at runtime, i.e. it depends on C's
identity unification (AOT `this` object ≡ provider `globalObject`). File one
follow-on issue for C+D referencing this section; projected +19 files.

### 6. Verification

```sh
# Focused before/after (in this worktree, dirty-tree mode runs in place):
TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

- Baseline (2026-08-08, run `20260808-072852`): 747/816.
- After 2a: +2 → 749 (both `var-env-global-lex-non-strict` files).
- After 2b: +8 → **757/816** (all 8 `lex-env-{distinct,no-init}-{let,const}`).
- Required zero pass→fail; watch specifically: the 192 `declare-arguments`
  files, `annexB/.../script-decl-lex-no-collision`-family passes,
  `lex-env-*-strict-*` passes, and the 17 currently-passing
  `issue-2923-eval-const-broaden` fast-path canaries.
- Dev canaries (put in `.tmp/`, promote to `tests/issue-2929-*.test.ts`):
  - `let x; eval('var x;')` → SyntaxError (catchable, runtime phase)
  - `let x; (0,eval)('var x;')` → SyntaxError
  - `let x; var s = 'var x;'; eval(s)` → SyntaxError via provider
    (confirms the dynamic tier is already correct — regression tripwire)
  - `let x; eval('{ function x(){} }')` → NO error (B.3.3 cancellation)
  - `try {} catch (e) { eval('var e;') }` at global → NO error (B.3.5)
  - `eval('let a = 1; a')` → 1, then `typeof a === 'undefined'`
  - `let o = 23; eval('let o;')` → no error, `o === 23` after
  - `function f(){ let y; return eval('var y;') }` → SyntaxError (existing
    lower-lex path, must stay green)
- `pnpm run typecheck`; scoped vitest: `npm test -- tests/issue-1102.test.ts
  tests/issue-2923-eval-const-broaden.test.ts` plus any existing
  `tests/*eval*` suites touched by CI's quality gate.

### 7. Risks / gates

- **#4137 concurrency (real)**: in-progress, other lane, owns bucket E and has
  `loc-budget-allow: src/interp/emitter.ts`. This slice touches ONLY
  `src/codegen/expressions/eval-inline.ts` — no file overlap with #4137's
  declared budget. Do not "fix" any `SyntaxError: NaN` file encountered in the
  diff; they are #4137's baseline.
- **Oracle ratchet (#1930/#3273)**: the new code needs no type queries — it is
  pure syntax walking + `ctx.globalLexicalBindings`. Do not add
  `checker.getSymbolAtLocation` calls; if binding info is ever needed use
  `ctx.oracle`.
- **Coercion-sites ratchet** (`check:coercion-sites`): `emitThrowJsError` and
  the existing helpers are already counted; adding calls to existing helpers
  in an existing module does not create a new module needing
  `coercion-sites-allow`.
- **loc/func budget**: issue frontmatter already allows
  `src/codegen/expressions/eval-inline.ts::tryStaticEvalInline`.
- **False-positive SyntaxError is the top regression risk**: the guard flips
  currently-passing files if it fires for (i) strict eval, (ii) Annex B block
  functions, (iii) function-scope callers, or (iv) TS-module-strict lane.
  Each is excluded by construction (§2a); the §6 canaries pin all four.
- **Restore-path bookkeeping**: `compileInlinedEvalStatements` can return
  `undefined` (late bail to provider) — the lexical restore must run on that
  path too, or the provider-path compile sees phantom caller bindings and the
  fold/runtime disagree. Mirror the existing
  `restoreFoldedDirectEvalVarScope` discipline (line 849).
- **Standalone floor / merge-group**: PR-level test262 checks are designed
  no-ops; the real gate is the merge-group standalone floor. The change is
  monotone (+10 projected, 0 regressions) if the canaries hold.

## TODO — follow-on issue for spec buckets C + D (NOT YET FILED, no id allocated)

**Why this is a TODO and not a real issue file:** the implementing agent tried
to allocate an id with
`node scripts/claim-issue.mjs --allocate --by ttraenkler/opus-eval-lane` and it
**REFUSED (exit 6)**: `gh` is not installed in this sandbox, so the open-PR id
scan degraded and the tool would not reserve an unverified id. `--dry-run`
previewed `#4217`, but a DEGRADED-scan preview is not a reservation and
hand-picking it would race an in-flight PR (#2531). **The next agent with a
working `gh` must run `--allocate` for real and move this section into
`plan/issues/$NEW-<slug>.md`** — do not copy `4217` across.

Proposed frontmatter for the new file:

```yaml
id: $NEW
title: "Eval-created global var/function must become real global-object own properties"
status: ready
priority: medium
horizon: l
feasibility: hard
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: current
parent: 2929
related: [2929, 4182]
```

Scope (see [§5 of the 2026-08-08 implementation plan above]):

- **Bucket C — 13 files.** Eval-created global `var`/`function` must materialize
  as **own, configurable (`[[Configurable]]: true`), deletable properties of the
  real global `$Object`**, visible to
  `Object.getOwnPropertyDescriptor(this, 'x')`, with `delete` severing the
  binding. Today the values round-trip through
  `__runtime_eval_push_globals` / `__runtime_eval_pull_globals` cells and never
  become `$Object` own properties. The live-binding pattern to follow is
  `src/codegen/annexb-global-live-binding.ts` (#4182 — module-global-backed live
  cells for B.3.3.2).
  Files: `{direct,indirect}/var-env-{var,func}-init-*`,
  `{direct,indirect}/var-env-{var,func}-non-strict` — enumerated exactly in §0
  of the plan above.
- **Bucket D — 6 files**, `{direct,indirect}/non-definable-global-{var,function,generator}.js`.
  The runtime `CanDeclareGlobalVar` / `CanDeclareGlobalFunction` `TypeError` arm.
  The interpreter already implements the check
  (`src/interp/eval-environment.ts:510-523`); it is unreachable for **literal**
  evals until the splice can consult the real global object's extensibility at
  runtime — i.e. **D depends on C's identity unification** (AOT `this` object ≡
  provider `globalObject`). Per §3 of the plan, this is a
  "bail-to-provider once C lands" case, not an emit-throw: the outcome depends
  on runtime environment state.

Projected: **+19 files** on the `language/eval-code/` standalone lane
(757 → 776 / 816 on top of this issue's buckets A+B).

Explicitly out of scope for that follow-on: bucket E (24 Annex-B
`skip-early-err` `SyntaxError: NaN` files — owned by #4137) and bucket F (16
files: new.target, super-prop, realm identity, B.3.3 update — different
mechanisms).

## Implementation notes — buckets A + B (2026-08-08)

Buckets A and B of the plan above are implemented; C, D, E and F are not (see
the TODO section for the C/D follow-on; E belongs to #4137; F is out of scope).

All changes are in `src/codegen/expressions/eval-inline.ts`. Two things the
plan did not anticipate had to be added to make bucket B's 8 files actually
flip; both are recorded here because they generalise beyond this slice.

### 1. Dropping the NAME→slot mapping is not enough — the slot must be renamed

`restoreFoldedEvalLexicalScope` originally only removed the eval body's
`localMap` / `boxedCaptures` / `tdzFlagLocals` / `boxedTdzFlags` entries, per
§2b. That fixed a caller-scope read (`typeof x` at the splice site, an IIFE) but
NOT the shape test262 actually uses:

```js
eval('let xNonStrict = 3;');
assert.throws(ReferenceError, function () { xNonStrict; });   // did not throw
```

Cause: the **#1177 block-scope-shadow rescue** in
`src/codegen/closures/arrow-phases.ts` (and its twin in
`src/codegen/statements/nested-declarations.ts`) deliberately falls back to
scanning `fctx.locals` **by name** when `localMap` misses, so a closure built
inside a block can still capture a pre-hoisted-then-shadowed slot. That rescan
resurrects the eval's ORPHANED slot for any closure created **after** the eval
returned. Measured discrimination:

| shape | before the rename fix |
| --- | --- |
| IIFE at the splice site | throws (correct) |
| thunk passed to a helper (`assert.throws`) | **no throw** |
| thunk stored in a var, then called | **no throw** |
| thunk declared BEFORE the eval | throws (correct) |
| name never declared at all | throws (correct) |

Fix: after the splice, rename every slot the eval allocated to
`<name>@evallex$<idx>` / `<name>@evaltdz$<idx>`. `@` cannot occur in a JS
identifier, so no by-name probe can match; the slot INDEX is untouched, so
captures already planned for closures created *inside* the eval body keep
working (pinned by a canary). The mangled name deliberately does not start with
`__`, keeping the compiler-temp deduplicator in `context/locals.ts` away from it.

### 2. `lex-env-no-init-*` is a SECOND, unrelated defect: TDZ `typeof` of a foreign identifier

`eval('typeof x; let x;')` must throw ReferenceError. `typeof-delete.ts`
resolves the operand through `checker.getSymbolAtLocation`; a FOREIGN eval
identifier has no checker symbol at all, so it takes the
genuinely-unresolvable arm and statically folds to `"undefined"`, erasing the
error. (A *bare* read of the same binding is fine — it reaches the TDZ check.)
This is orthogonal to the lexical leak and is why the `-cls` variants of the
same files already passed: classes bail to the provider, whose lexical records
carry real TDZ state.

Fixed **in scope** by bailing to the provider (§3's "never splice-and-ignore"):
`foldedEvalTypeofBeforeLexicalDeclaration` detects a `typeof <ident>` textually
before that lexical's own declaration in the eval body. A `typeof` *after* the
declaration, or of an unrelated name, still folds — pinned by canaries.

The alternative one-line fix — teach `typeof-delete.ts` to consult
`fctx.tdzFlagLocals` before the `!hasValueDecl` fold — was deliberately NOT
taken here: it is outside this slice's declared file scope. It is the better
long-term fix and would also restore the fast path for these bodies.

### Measured result

`TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1
--official-scope-only`, all 816 official files, full Acorn+interpreter provider.

| run | pass |
| --- | ---: |
| baseline `20260808-072852` (main `a8bbc0d7`) | 747 / 816 |
| bucket A only, `20260808-082628` | 749 / 816 |
| buckets A + B, `20260808-091553` | **757 / 816** |

Zero pass→fail at every step. The 10 fail→pass files are the exact bucket A + B
enumeration: `{direct,indirect}/var-env-global-lex-non-strict.js` and
`{direct,indirect}/lex-env-{distinct,no-init}-{let,const}.js`.

## Implementation Plan — eval global own-property substrate C+D (arch, 2026-08-08)

Follow-on slice for buckets **C** (13 files, eval-created global/local var+func
binding materialization) and **D** (6 files, CanDeclareGlobalVar/Function
TypeError) of the eval-code failure enumeration in the A/B spec (§0/§5 of the
2026-08-08 EvalDeclarationInstantiation section — written in worktree
`/home/user/js2/.claude/worktrees/agent-ac08047453f4638e8/`, same file, not yet
on main). This section is self-contained: fresh per-file baseline, mechanism
probes, and the design are all re-derived on branch base `8d2f12a6`
(main + #4137 + #2200).

### (a) Fresh per-file baseline + the #4205 verdict

Instrument: faithful worker path — `CompilerPool(1, "unified")` +
`assembleOriginalHarness` + `pool.runTest(..., {originalHarness: true, target:
"standalone"}, 30_000)`, `TEST262_FULL_RUNTIME_EVAL=1`, full Acorn+interpreter
provider rebuilt for this branch (cache key `b83bad5b0b676c8b`, announced tier
INTERPRETER). Probe script pattern preserved in `.tmp/probe-cd-baseline.mts`.
All 19 files FAIL; per-file error text:

| file (`language/eval-code/`) | error |
| --- | --- |
| direct/var-env-var-init-global-new | `Test262Error: x should be an own property` |
| direct/var-env-var-init-global-exstng | `Test262Error: x should be an own property` |
| direct/var-env-func-init-global-new | `Test262Error: f should be an own property` |
| indirect/var-env-var-init-global-new | `Test262Error: x should be an own property` |
| indirect/var-env-var-init-global-exstng | `Test262Error: x should be an own property` |
| indirect/var-env-func-init-global-new | `Test262Error: f should be an own property` |
| indirect/var-env-var-non-strict | `Test262Error: x Expected SameValue(«1», «0»)` (eval `var x=1` wrote the CALLER's local) |
| indirect/var-env-func-non-strict | `Expected SameValue(«"undefined"», «"function"»)` |
| direct/var-env-func-non-strict | `Expected SameValue(«"undefined"», «"function"»)` (typeofInside was "undefined") |
| direct/var-env-func-init-local-new | `Expected a ReferenceError to be thrown but no exception was thrown` (leak) |
| direct/var-env-func-init-local-new-delete | `binding may be deleted Expected a ReferenceError…no exception` |
| direct/var-env-func-init-local-update | `Expected SameValue(«"number"», «"function"»)` |
| direct/var-env-var-init-local-new-delete | `Expected a ReferenceError to be thrown but no exception was thrown` |
| direct/non-definable-global-{var,function,generator} | `Expected true but got false` (`error instanceof TypeError` false — no throw; `preventExtensions(this)` itself WORKS, the guard `nonExtensible` was true) |
| indirect/non-definable-global-{var,function,generator} | `Expected a TypeError to be thrown but no exception was thrown` |

**Routing fact that reframes the whole issue**: a compile-probe of all nine
shapes (`.tmp/probe-route.mts`, inspects the import section for
`js2wasm:runtime-eval`) shows **every one of the 19 files' evals is SPLICED
today** (`tryStaticEvalInline` accepts them). None of these failures is a
provider/interpreter gap — they are all consequences of the AOT constant-splice
reconstructing EvalDeclarationInstantiation without the global-object /
deletable-binding halves.

**Mechanism probe — the interpreter tier already implements C-global and D
correctly, end-to-end** (`.tmp/probe-provider-equiv.mts`: same semantics with a
dynamic source `var s='…'; eval(s)`, which forces provider routing):

| probe (provider-routed) | result |
| --- | --- |
| new global `var` → own property, {writable,enumerable,configurable}=true, initial `undefined` | **PASS** |
| existing script `var x=23` + eval `var x=45` → own property {value:45, configurable:false}, initial 23 | **PASS** |
| new global `function f` → own property, configurable:true, instantiated before statements | **PASS** |
| `Object.preventExtensions(this)` then eval `var …` → TypeError | **PASS** |
| direct eval in IIFE declaring `function f` → caller-varEnv binding, mutable, no global leak, outer `f` throws ReferenceError | **PASS** |
| indirect alias eval `var x` from global → own configurable property | **PASS** |
| eval `delete x` on eval-created LOCAL var → later closure read must throw | **FAIL** (`no ReferenceError after delete`) |
| eval `function fun(){}` in IIFE, then AOT sibling `typeof fun` | **FAIL** (`inside: undefined`) |

This settles the two identity questions the task raised: **(1) AOT `this` ≡
provider `globalObject` is ALREADY unified** — `emitStandaloneDirectEvalRuntime`
(`src/codegen/expressions/runtime-eval-provider.ts:629`) passes
`emitGlobalEnvironmentObject(...)` = the #2996 native `$Object` singleton
(`emitNativeGlobalThisObject`, `src/codegen/array-object-proto.ts:2430`) into
`__runtime_direct_eval`, and `createRuntimeEvalGlobalEnvironment`
(`src/interp/eval-environment.ts:34`) uses that very object as
`ENV_GLOBAL.backing`. **(2) The cross-module property store works** — the
provider's `Object.defineProperty(globalObject, …)` / `Object.isExtensible`
land on the caller's singleton and are visible to caller-side
`hasOwnProperty`/`gOPD`/`verifyProperty` (proved by the four passing global
probes; the WasmGC `$Object` rec-group is structurally canonical across the
module seam, as #2928's carrier ABI requires).

#### #4205 verdict: ADJACENT — the shared substrate already exists; there is no 133-file spillover

`plan/issues/4205-script-goal-global-object-standalone.md` is **`status: done`
(2026-08-07) and its implementation record RETRACTS the filed framing**:

- "Standalone has no realm global object" is **false as of #2996** — the
  identity-stable `$Object` singleton exists, `this === globalThis` at script
  top level, `this.p1 = 1; p1 === 1`, `delete this.p1`, `gOPD(this,'p1')` all
  pass on main. The `!ctx.standalone` gate at
  `src/codegen/expressions/call-builtin-static.ts:2315` is gOPD-local and was
  **not on the symptom's path**.
- The census's 137-file lever was a *shape*, not a mechanism: #4205's full A/B
  (388 files, both arms) fixed 7 files, broke 0, and changed **zero** error
  signatures among the 96/99 `with`-overlap files. The "#4205 unmasks the
  `with` cluster" dependency **does not exist**. Do NOT project a 150-file
  yield from this spec; the honest population is the 19 files here (+2
  probable, see below).
- The one genuinely shared residue is #4205's deferred **G2** (script `var`
  visible as a global-object own property with configurable:false — 10 failing
  ES5 files, 0 passing, design sketched in #4205's record). **Bucket C does
  NOT depend on G2**: the provider's entry-time
  `__runtime_eval_push_globals` (`emitRuntimeEvalGlobalBindingPushBody`,
  `src/codegen/expressions/runtime-eval-provider.ts:132-287`) already defines
  every script var/function as a property (attrs `0x23`:
  writable+enumerable, configurable:false) on the singleton before interpreted
  code runs — which is exactly why the `-exstng` probe passes. G2 remains a
  separate, non-eval-facing 10-file item; recommend a fresh issue (allocate id
  via `claim-issue.mjs`), not bundling.

Where the two DIVERGE so implementations don't fight: #4205/G2 is about the
**static-correspondence read path** (module globals as storage, compile-time
name sets, member-access lowering in `unary-updates.ts` /
`sloppy-this-global.ts`). This slice deliberately adds **zero** new codegen on
any name-resolution or member-access path — its entire AOT-side change is a
routing predicate inside `tryStaticEvalInline`. No shared files, no shared
mechanism beyond the already-built singleton.

### (b) Substrate design — route, don't re-implement

**What object IS the standalone global?** The existing #2996 `$Object`
singleton (`__native_globalThis` module global). No new object, no facade.
Eval-created global vars/functions become own configurable properties on it
**by the interpreter's existing `prepareGlobalDeclarations` /
`prepareGlobalVarBinding` / `prepareGlobalFunctionBinding`**
(`src/interp/eval-environment.ts:510-592`) — code that is already correct and
already reachable for dynamic sources. The defect is only that literal sources
never get there.

**Core change (slice 1): bail the splice to the provider when the eval's
VariableEnvironment is the GlobalEnvironmentRecord and the body declares
vars/functions.**

- File: `src/codegen/expressions/eval-inline.ts`, function `tryStaticEvalInline`
  — place with the other standalone routing arms (after the strict-isolation
  bail at line ~749 and the Annex-B global-shape arm at lines ~751-765, BEFORE
  `containsEvalValueReference` at ~774; must stay ahead of the
  argument-side-effect compilation at ~834, which the existing comment already
  mandates for all eligibility checks):

```ts
// EvalDeclarationInstantiation §19.2.1.3 step 16/CanDeclareGlobal* (buckets
// C+D): when the sloppy eval's varEnv is the GlobalEnvironmentRecord, var and
// function declarations must become own (configurable, D=true) properties of
// the realm global object, gated by IsExtensible — runtime state the splice
// cannot know. The interpreter implements all of it (prepareGlobalDeclarations);
// route there. Direct eval's varEnv is global exactly when the caller fctx is
// the module initializer (blocks/case/catch do not change varEnv — same
// predicate precedent as unsupportedGlobalShape); sloppy indirect eval's
// varEnv is ALWAYS global regardless of call site.
if (
  ctx.standalone &&
  !evalIsStrict &&
  declarationNames.varNames.size > 0 &&
  (directEval ? fctx.name === "__module_init" : true)
) {
  return undefined; // provider owns EvalDeclarationInstantiation here
}
```

- `declarationNames.varNames` already includes top-level FunctionDeclaration
  names (`foldedEvalDeclarationNames`), so one predicate covers var + func +
  generator bodies. `blockFunctionNames` are deliberately NOT counted (B.3.3
  has its own arm at lines 751-765, unchanged).
- `evalIsStrict` (line ~712) excludes strict bodies and strict direct-eval
  callers — strict eval vars live in a private varEnv, never on the global
  (this preserves the #1102 AC2 TS-module lane and all `*-strict` siblings).
- `ctx.standalone` only: WASI has no provider (bail would degrade splice →
  refusal), host/gc keeps today's splice (its dynamic fallback is host `eval`
  with different scope plumbing — do not touch).
- Ordering vs the A/B slice: the bucket-A global-lexical-collision emit-throw
  (§2a of the A/B spec) must run BEFORE this bail — it is statically certain,
  cheaper, and also covers host mode. The provider would throw the same
  SyntaxError anyway (`prepareGlobalDeclarations` lines 560-568), so
  mis-ordering is a perf/coverage wart, not a correctness bug.

**Why routing beats materializing properties in the splice** (the design the
§5 sketch originally gestured at): an in-splice implementation must reproduce,
in emitted Wasm, the CanDeclare* preflight atomicity (validate ALL names before
defining ANY), descriptor-preserving redefinition rules, function-before-var
ordering, existing-property no-reset, AND reroute every subsequent read/write
of the created names through the object so `delete this.x` severs the compiled
read path. That is a re-implementation of `prepareGlobalDeclarations` plus a
new name-resolution mode — precisely the #4055 anti-pattern (new substrate
where an existing answer exists) and a standing perf hazard on identifier
lowering. Routing costs: interpreter-speed execution of these eval sites (eval
is cold), and the provider dependency (CI's standalone lane links the full
provider; local refusal-tier runs will report these files as the documented
TypeError — instrument note, not a regression).

**How reads/writes/delete converge after routing** (all existing machinery,
verified by the probes):

- Eval-created NEW global name, later AOT bare read: the outer identifier has
  no TS symbol → `emitRuntimeEvalGlobalRead` (`src/codegen/global-environment.ts:99`,
  HasProperty + get + unwrap; gated on `ctx.runtimeEvalGlobalFunctionBindings`,
  which is already true for every eval-consuming file via
  `sourceUsesRuntimeEvalBoundary` → `src/codegen/index.ts:6038`). `typeof`
  takes the non-throwing variant (`src/codegen/typeof-delete.ts:1575`).
- `delete this.x` → native `__delete_property` on the singleton (configurable:
  true ⇒ removed) → the SAME HasProperty-guarded read now throws
  ReferenceError. Severed both ways by construction — no static storage ever
  existed for the name.
- Existing script var (`-exstng`): seeded onto the object by
  `__runtime_eval_push_globals` at provider entry (configurable:false per
  ScriptDeclarationInstantiation), value-updated by the interpreter's
  SetMutableBinding, pulled back into the module global by
  `__runtime_eval_pull_globals`. AOT reads keep the `global.get` fast path.

**Slice 2 (local varEnv function declarations, direct eval)**: extend the bail
to sloppy DIRECT evals in FUNCTION callers whose body has top-level
FunctionDeclarations:

```ts
if (ctx.standalone && !evalIsStrict && directEval &&
    fctx.name !== "__module_init" &&
    foldedEvalHasTopLevelFunctionDeclaration(sf)) {
  return undefined;
}
```

(new tiny collector next to `foldedEvalDeclarationNames`; or derive from the
existing declaration walk). The provider models function instantiation order
and caller-varEnv binding via the reified activation cells — probe `lfunc-new`
passes including the mutation (`f = 5`) and the no-leak ReferenceError.
Expected: `func-init-local-new`, `func-init-local-update`. Keep this a
SEPARATE PR: function-scope literal evals are a much larger passing population
than global ones (the entire 192-file `declare-arguments` matrix is
function-scope — it declares only vars, so the predicate must key on function
declarations specifically, and the matrix must be a named canary).

**Slice 3 (interpreter/boundary gaps — the two probes that fail on the
provider tier)**:

1. `delete` of an eval-created binding in a FUNCTION varEnv does not sever
   (`lvar-delete` probe; files `var-env-var-init-local-new-delete`,
   `func-init-local-new-delete`). Investigate the interpreter's Delete opcode
   against `EnvRec` bindings created by `ensureVarBinding`
   (`src/interp/eval-environment.ts:491-508`) and the persistent activation
   cells (`preparePersistentEvalBindings`) — the closure created inside the
   eval (`postDeletion = function(){ x; }`) must observe the binding's removal,
   so deletion has to mark the cell/name-map entry dead, not just remove a
   local alias.
2. An eval-created NEW local binding is invisible to AOT sibling statements in
   the same activation (`lfunc-non-strict` probe; file
   `direct/var-env-func-non-strict`). The AOT caller compiled `typeof fun`
   against the no-symbol dynamic-GLOBAL read, but the binding lives in the
   activation layer the provider returned. Likely fix direction: on provider
   return, `reifyCurrentDirectEvalBindings` /
   the state-cell pool (`DIRECT_EVAL_STATE_BINDING_CAPACITY` cells in
   `emitStandaloneDirectEvalRuntime`) already carries eval-created names — the
   AOT-side no-symbol read inside a function that CONTAINS a direct eval
   should consult the activation state cells before falling through to the
   global object. Spec this as investigation, not prescription; it is
   boundary work across `direct-eval-environment.ts` + `eval-environment.ts`.

### (c) Bucket D wiring

Nothing new to build: `canDeclareGlobalVar`/`canDeclareGlobalFunction`
(`src/interp/eval-environment.ts:510-523`) already run inside
`prepareGlobalDeclarations` with the atomic validate-all-before-create order,
and the caller-side `Object.preventExtensions(this)` /
`Object.isExtensible(this)` already manipulate the singleton's flags field
(`$Object` flags, `src/codegen/object-runtime.ts:28`) in a way the provider
observes across the module seam — the `non-definable` probe passes with ZERO
interpreter changes. The slice-1 bail is the entire wiring for all 6 D files.
The direct-D shape (`eval` nested in `if{try{}}`) is covered because blocks do
not change the module-init fctx (same varEnv-globality argument as the A/B
spec's §2a).

### (d) Slicing / minimal first PR

| PR | change | expected flips | risk |
| --- | --- | --- | --- |
| **1 (minimal)** | slice-1 bail predicate (one `if`, `eval-inline.ts`) | **12 firm**: 6 C-global own-property + 6 D. **+2 probable**: `indirect/var-env-{var,func}-non-strict` (probe the exact files before claiming — the IIFE-caller indirect seed path was validated only from global scope) | low — eval-code-scoped; must stack on the in-flight #2929 A/B PR (same function) |
| 2 | local-varEnv function-decl bail | +2 (`func-init-local-new`, `-update`) | medium — function-scope eval population is large; declare-arguments canary mandatory |
| 3 | interpreter delete-severing + sibling visibility | +3 (`…local-new-delete` ×2, `direct/var-env-func-non-strict`) | medium — touches `src/interp/`; coordinate with #4137 (owns `src/interp/emitter.ts`) |

"Can C ship without D" is moot under this design — one predicate delivers both
(D is just the interpreter's existing check becoming reachable). The
"#4205-facing half" does not exist as work: #4205 is done; G2 is a separate
10-file issue to file independently.

### (e) Edge cases

- **Redeclaration of an existing global** (`var-env-var-init-global-exstng`):
  `prepareGlobalVarBinding` early-returns when the own property exists, so the
  push-seeded configurable:false descriptor survives and only the value updates
  (verified by probe). Do not "fix" the interpreter to redefine.
- **Function vs var descriptors**: eval's D=true makes BOTH configurable:true
  when newly created; functions redefine an existing CONFIGURABLE property to
  {writable,enumerable,configurable:true} but leave a compatible
  non-configurable data property's attributes alone
  (`prepareGlobalFunctionBinding` — already per §9.1.1.4.18).
- **Strict eval**: excluded by `evalIsStrict` in the predicate; strict bodies
  with scoped declarations already route to the provider via the line-749 arm.
- **Host lane**: untouched (`ctx.standalone` gate). WASI: untouched (no
  provider — keep splicing).
- **Annex B block functions**: `blockFunctionNames` not in the predicate; the
  existing 751-765 arm and #4137's bucket E are unaffected.
- **B.3.5 catch-parameter** (`try{}catch(e){ eval('var e') }` at global): the
  bail routes it to the provider, whose `validateNonStrictEvalVarNames` skips
  object records and B.3.5-exempts the catch binding — behavior preserved; add
  the canary from the A/B spec's list anyway.
- **TS-lib-shadowing names** (`eval('var name')` / `length` / `onload`): the
  outer AOT read of such a name resolves a lib symbol instead of the
  no-symbol dynamic path, so post-eval reads may miss the property. Known,
  pre-existing resolution split — note in the PR, do not chase.
- **Nested eval recursion**: an inner literal eval inside a provider-routed
  source is interpreted (fine); an inner eval inside a still-spliced outer
  body inherits the outer fctx, so the `__module_init` predicate remains
  correct (same argument as the A/B spec).
- **`eval('x = 1')` (assignment only, no declaration)**: `varNames` empty → no
  bail → splices exactly as today.

### (f) Verification

```sh
# per-file before/after (fast, faithful worker path — scripts preserved in .tmp/):
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 node --import tsx .tmp/probe-cd-baseline.mts
# full population (needs the machine-global lock free; ~30+ min):
TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

Prereqs on a fresh worktree: `pnpm install --prefer-offline`, `pnpm run
build:compiler-bundle`, the `runtime-bundle.mjs` esbuild line from
`.github/workflows/ci.yml:429`, and `node --import tsx
scripts/build-runtime-eval-provider.mjs` (~3.5 min; the cache key tracks the
compiler bundle, so REBUILD after every src/ change — a stale provider silently
serves the previous compiler's semantics).

- Expected flips: PR1 +12 (firm) to +14; PR2 +2; PR3 +3; total ≤19 in this
  population. NOTE: the A/B spec's 747/816 eval-code baseline predates the
  #4137/#2200 merges on this branch — re-measure the full-population number on
  the PR branch base before quoting deltas.
- **Zero-regression controls (named)**:
  - the **192-file `declare-arguments` matrix** (function-scope var-only
    evals — must NOT match any new predicate; spot-check that their compiled
    modules' import sections are unchanged, i.e. still spliced);
  - **annexB eval-code** current 444/469 — zero pass→fail;
  - the **17 `issue-2923-eval-const-broaden` fast-path canaries**;
  - `tests/issue-1102.test.ts` (module-strict lane), `tests/issue-4162.test.ts`,
    `tests/issue-4195-eval-refusal-message-and-dedupe.test.ts`;
  - `npm test -- tests/equivalence.test.ts`.
- **Hot-path perf**: the design's argument is structural — no codegen change
  on any name-resolution path, so eval-free modules must compile
  **byte-identically**. Verify: compile 3-4 `playground/examples/*.ts` before/
  after and diff wasm sha256 (stronger and cheaper than a perf run). For the
  perf canary on eval-CONTAINING code, `benchmarks/run.ts` →
  `playground-benchmark-sidebar.json` diff is the named benchmark; no entry
  there uses literal global-var eval, so expect noise-level deltas only.
- Promote the two probe scripts to `tests/issue-XXXX-*.test.ts` (id from
  `claim-issue.mjs --allocate` — unreachable from this sandbox, do NOT
  hand-pick) with the provider-linked pool pattern from
  `tests/issue-3426-realm-canary.test.ts`.

### (g) Risks / gates

- **File collision (real, sequencing-critical)**: the in-flight #2929 A/B
  implementer owns `src/codegen/expressions/eval-inline.ts` and edits the SAME
  region of `tryStaticEvalInline` (lines ~720-770). PR1 must stack on that
  PR's branch (predecessor-stacking per CLAUDE.md) or land after it; the
  bucket-A guard must precede the new bail. Slice 3 additionally risks
  `src/interp/emitter.ts` (#4137's declared budget) — keep slice-3 edits in
  `eval-environment.ts`/`direct-eval-environment.ts` or coordinate. **No
  overlap with #4194** (carrier-bag / property-access dispatch): this design
  touches no property-access codegen at all.
- **#4071 hazard (Object.keys widening)**: not triggered — no compiled-side
  property materialization on any receiver; the only object mutated is the
  singleton, by the interpreter, per spec (verifyProperty's enumerability
  probe REQUIRES the new keys there).
- **#4055 composition rule**: honored by construction — the existing answer
  (interpreter EvalDeclarationInstantiation + native property store) is used;
  no new substrate.
- **Query-must-never-allocate / hot-path**: no new queries; reads stay
  `global.get` for script names. The bail only swaps which existing arm an
  eval CALL SITE takes.
- **Oracle ratchet**: the predicate is pure syntax on the foreign AST + fctx
  identity — zero checker/oracle queries.
- **Coercion-sites ratchet**: no new module, no new coercion sites.
- **loc/func budgets**: `src/codegen/expressions/eval-inline.ts` and
  `tryStaticEvalInline` are already on this issue's allow lists.
- **Top regression risk**: a currently-PASSING file whose literal global
  var/func eval silently relied on splice semantics (eval-created var used as
  a TYPED module value later). Mitigation: the A/B over every standalone file
  whose source greps `eval(` with a `var`/`function` literal (bounded, few
  hundred files) before enqueue; anything that flips pass→fail is a provider
  fidelity bug to fix BEFORE landing, not after.
- **Instrument trap** (for whoever re-measures): with no
  `TEST262_FULL_RUNTIME_EVAL=1` (or a stale provider cache) the newly-routed
  files fail with the refusal TypeError / LinkError and the change reads as a
  regression. The tier announcement line (`runtime-eval tier: INTERPRETER
  (key …)`) is the control — quote it in the PR.

## Implementation record — C+D slices 1 & 2 landed, slice 3 NOT landed (2026-08-08)

Branch base for every number below: `main` + the merged #2929 A/B stack
(`64b8bcfc`, `0afe71af`, `08bd1244`). Standalone target, faithful worker path
(`CompilerPool(1,"unified")` + `assembleOriginalHarness` + `runTest`),
`TEST262_FULL_RUNTIME_EVAL=1`.

Tier announcement (the instrument control §f demands):

```
[probe] runtime-eval tier: INTERPRETER (key 4b014a5cc23d45eb, TEST262_FULL_RUNTIME_EVAL=1)
```

(key `1a78259035ddfefe` after slice 2 — the key tracks the compiler bundle and
was rebuilt after every `src/` change.)

### Re-measured baseline — the spec's 747/816 is stale

The §f note is right that the figure predates the merges. Re-measured here, and
the 816 splits into two populations that must be reported separately:

| population | base | after slice 1 | after slice 2 |
| --- | --- | --- | --- |
| `language/eval-code` (347 files) | 312 | 324 | **326** |
| `annexB/language/eval-code` (469 files) | 442 | 442 | 442 |
| combined | 754/816 | 766/816 | **768/816** |

**Zero pass→fail and zero fail-signature changes in either population, at both
slices.** All 19 C+D files reproduced the spec's §a error table exactly on the
base, so the diagnosis transferred intact.

### Slice 1 — +12, and the "probable" pair is CONFIRMED

6 C-global own-property files, 4 bucket-D files, and **both** members of the
spec's probable pair (`indirect/var-env-{var,func}-non-strict`) — probed
explicitly rather than assumed, as §d required.

The spec predicted "12 firm (6 C-global + 6 D) + 2 probable". The count landed
at 12, but the composition differs: only **4** of the 6 D files are reachable
by routing (see the residue below), and the 2 probable files flipped.

### Slice 2 — +2, exactly as predicted

`direct/var-env-func-init-local-new`, `direct/var-env-func-init-local-update`.
The 192-file `declare-arguments` matrix was compiled in full and its import
sections inspected: **192/192 still SPLICED, 0 provider imports**, before and
after. Keying the predicate on top-level FunctionDeclarations rather than on
`varNames` is what preserves it.

### Byte-identity (the §f hot-path argument)

`fib.ts`, `loop.ts`, `array.ts`, `string.ts` from
`website/playground/examples/benchmarks/` compile to **identical wasm sha256**
at base, slice 1 and slice 2. The design's "no codegen on any name-resolution
path" claim holds mechanically.

### RESIDUE 1 (bucket D, 2 files) — direct eval never applies CanDeclareGlobalFunction

`direct/non-definable-global-function` and `direct/non-definable-global-generator`
do **not** flip, and cannot be fixed by routing — they already route.

The spec's §a table describes all six `non-definable-global-*` files as the
`preventExtensions(this)` shape. That is only true of the `-var` pair. The
`-function`/`-generator` pair instead evaluates `function NaN(){}` and needs
`CanDeclareGlobalFunction` to REFUSE because `NaN` is an existing
`{writable:false, enumerable:false, configurable:false}` own property.

Measured, and the cause is **not** `NaN` and **not** realm population:

| probe | result |
| --- | --- |
| `NaN` own property of the realm global after any eval | present, `w=false e=false c=false` (`installRuntimeEvalRealm`, `src/interp/loop.ts:183-197`, works) |
| `(0,eval)("function NaN(){}")` | **TypeError** (correct) |
| `eval("function NaN(){}")` at global | no throw |
| define own `zzTop` `{w:false,e:false,c:false}`, then `(0,eval)("function zzTop(){}")` | **TypeError** (correct) |
| same, `eval("function zzTop(){}")` | **no throw** |

A user-defined property reproduces it, so this is not about `NaN`, the intrinsic
set, or #4205/G2. **A sloppy DIRECT eval whose varEnv is the global record does
not run the `plan.functionNames` CanDeclareGlobalFunction loop of
`prepareGlobalDeclarations` (`src/interp/eval-environment.ts:570-574`), while
the identical INDIRECT eval does.** Everything observed is consistent with
`plan.functionNames` being empty on the direct path (the var loop still runs —
`direct/non-definable-global-var` passes — and a NEW name still materializes as
a property via `prepareGlobalVarBinding`, which is why the direct
function-declaration cases otherwise look right).

This is a provider/interpreter defect in the direct-eval declaration-instantiation
path, independent of the C+D routing work. Worth its own issue.

### RESIDUE 2 (slice 3 gap i, 2 files) — eval-created bindings are not deletable

`direct/var-env-var-init-local-new-delete`, `direct/var-env-func-init-local-new-delete`.
Two independent blockers, both proven:

1. **Runtime**: `envDelete` (`src/interp/loop.ts:777-787`) returns `false` for
   *every* declarative own cell. §19.2.1.3 steps 9/11 create eval's var and
   function bindings with `CreateMutableBinding(n, **true**)` — D = deletable —
   so eval-created bindings must be severable. Deletability is per-binding, but
   `EvalBindingCell` is a frozen cross-module ABI struct and `EnvRec` a frozen
   rec-group, so the flag has to live in an out-of-line side table (the idiom
   `VARIABLE_ENVIRONMENTS` / `EXISTING_VARIABLE_ENVIRONMENTS` already use).
   Severing itself is cheap and needs no array splice: overwrite the entry in
   `env.names` with a unique non-string sentinel, since every own-binding probe
   compares `names[i] === name`. `preparePersistentEvalBindings`
   (`eval-environment.ts:342`) already treats `names[i] === undefined` as a
   reusable vacancy, so that convention exists.
2. **Emitter (the blocker)**: `src/interp/emitter.ts:1859-1862` folds
   `delete <identifier>` to `LdaFalse` at COMPILE time whenever
   `isBoundName(name)` — and `isBoundName` includes the eval body's own
   `hoistedVars`. So `envDelete` is never reached for exactly the names that
   are supposed to be deletable, and no runtime fix alone can work.

A first cut of (1) was written and then **reverted**: keyed on `ensureVarBinding`
it never fires (the direct-eval path allocates through
`preparePersistentEvalBindings` instead), and behind the (2) fold it is
unreachable regardless. Shipping unverifiable dead code would have been worse
than recording the analysis. Fixing this needs (2), which is
`src/interp/emitter.ts` — #4137's declared budget — so it needs coordination,
not a drive-by edit.

### RESIDUE 3 (slice 3 gap ii, 1 file) — eval-created local bindings are invisible to AOT siblings

`direct/var-env-func-non-strict`. Measured contrast:

| shape | result |
| --- | --- |
| `(function(){ eval('var q = 4;'); v = q; }())` | **passes** — SPLICED, so `q` is an ordinary caller local |
| `(function(){ eval('function fun2(){...}'); v = fun2(); }())` | **fails**, `fun2 is not defined` — routed by slice 2 |

The boundary carries only names collected from the CALLER's AST:
`collectDirectEvalBindingNames` / `collectDirectEvalActivationBindingNames`
(`src/codegen/direct-eval-environment.ts:64,109`) feed
`fctx.directEvalBindingNames`, and `currentDirectEvalBindings` builds the cell
layers from that set. A name the eval CREATES has no cell, so the AOT sibling
read falls through to the no-symbol dynamic global read and finds nothing.

The compiler *can* know these names — the eval source is a literal, and
`foldedEvalDeclarationNames(sf)` already computes exactly them. A fix would
pre-allocate activation cells for the eval's declared names at the call site and
have the provider write created bindings back. That is a new write-back
direction across `eval-inline.ts` + `direct-eval-environment.ts` +
`runtime-eval-provider.ts`, i.e. genuinely more than an L-slice, so it is
recorded rather than forced.

### Test coverage

- `tests/issue-2929-cd-global-materialization.test.ts` (new, 11 tests) — own-property
  descriptors, existing-script-var non-configurability, delete-severing at global,
  the assignment-only no-bail case, the three reachable D refusals, and a pin on
  RESIDUE 1. Provider-linked `CompilerPool`; `describe.skipIf`s off the refusal
  tier. Kept under #2929's id because `claim-issue.mjs --allocate` cannot reach
  GitHub from this sandbox and hand-picking an id is forbidden (#2531) — it needs
  a real id before this work is filed as its own issue.
- `tests/issue-2929-evaldecl-early-errors.test.ts` — 28/28. Four tests changed
  from splice-behaviour to routing assertions, because their global-varEnv var
  declarations are now provider-owned by design.

## Implementation record — slice 3 checkpoint (2026-08-11)

The runtime-eval state slice above is implemented on
`codex/2928-runtime-eval-mvp-20260811`, based on `origin/main` `6c1117f8767e9b`.
No provider export or callable/rec-group ABI changed.

### Deletable eval-created bindings

- Eval/script bytecode now emits `DeleteName` for a bound identifier when
  EvalDeclarationInstantiation predeclared the script bindings. Ordinary
  function/module bound-name deletes remain folded to `false`.
- Each persistent source-visible eval binding occupies an even environment
  entry; the adjacent odd entry carries the impossible name
  `\0js2wasm:deletable-eval-binding`. This is a flat, native-string metadata
  carrier: `$EnvRec` and `$EvalBindingCell` stay frozen, and the separately
  compiled provider does not depend on a provider-local weak collection.
- Successful deletion tombstones both entries and clears the live value cell.
  A later eval reuses the pair. Established caller cells have no adjacent marker
  and still reject deletion.
- The caller state pool is one 256-cell flat carrier. Each source-visible
  binding consumes four `$EvalBindingCell` entries —
  `[name, value, markerName, markerValue]` — so the logical capacity remains
  64 bindings. AOT sibling lookup advances by that four-cell stride and never
  exposes the companion marker as a source binding.

The flat marker is deliberate. Self-compiled `WeakMap`/`WeakSet` metadata lost
identity at the provider boundary, while nested array/object metadata either
trapped on a foreign structural cast or made the standalone self-compiler's
type specialisation exceed its heap ceiling.

### AOT sibling visibility

Provider snapshot now normalises values written into caller-owned state cells
through the existing runtime-eval result carrier. A no-symbol AOT identifier
(including the `typeof` paths) first scans those persistent cells, unwraps a
match, and falls back to the ordinary realm-global read on a miss. Functions
without direct eval still take the byte-identical global-read path.

### Measured acceptance

Fresh compiler/runtime bundles and a fresh full interpreter provider were built
after the source changes. Provider key `cea83b3383b5f8ea`, 4,299,913 bytes,
canary-verified. Run `20260811-201606`, `TEST262_FULL_RUNTIME_EVAL=1`:

| file | result |
| --- | --- |
| `direct/var-env-var-init-local-new-delete.js` | PASS |
| `direct/var-env-func-init-local-new-delete.js` | PASS |
| `direct/var-env-func-non-strict.js` | PASS |

Report: **3/3**, zero compile errors. The full 816-file remeasurement is still
required before replacing the recorded aggregate baseline.

Additional gates at this checkpoint:

- `tests/interp/eval-environment.test.ts`: 55/55, including delete, tombstone
  reuse, function closure severing, and caller-binding refusal.
- `tests/issue-2928.test.ts`: standalone interpreter self-compile/canary PASS.
- targeted #2923/#2928/#2929 regression set: 125 passes; its nine failures
  reproduce identically on clean `origin/main` and are stale #2923
  warning-based bail expectations after runtime routing landed.
- typecheck PASS.

The QuickJS adapter shares this caller state pool. Its compatibility patch now
skips the exact marker pair, retains 64 *visible* slots, reconciles successful
deletions, and reuses tombstoned groups. The cross-engine result is recorded in
#4242; it does not change the interpreter default.

## Final runtime-eval parity checkpoint — 2026-08-11

The authoritative full-provider comparison now covers the complete 1,351-file
eval-dependent scope from #4242, not only the three repaired probes. Both arms
used the same compiler/runtime bundle, standalone target, official scope, two
compiler workers, two execution workers, and an identical expected-file gate.

| Engine | Run | Pass | Fail | Compile error | Timeout / skip |
| --- | --- | ---: | ---: | ---: | ---: |
| Acorn + bytecode interpreter | `20260811-222840` | **1,099 / 1,351** | 226 | 26 | 0 / 0 |
| QuickJS compatibility engine | `20260811-221743` | 1,081 / 1,351 | 244 | 26 | 0 / 0 |

The interpreter arm announces `INTERPRETER`, uses a fresh self-compiled
zero-import provider, and passes `tests/issue-2928.test.ts`. Relative to the
fresh promoted standalone baseline it has exactly three `fail -> pass`
transitions:

- `direct/var-env-var-init-local-new-delete.js`;
- `direct/var-env-func-init-local-new-delete.js`; and
- `direct/var-env-func-non-strict.js`.

This closes the three slice-3 residues above: eval-created local bindings are
deletable, deletion severs a returned interpreted closure's persistent state,
and later AOT siblings can observe runtime-created `var`/function bindings.
Direct eval, indirect eval, and `Function`/`new Function` continue to use the
same frozen provider/callable seam.

Two state-coherence extensions remain deliberately explicit rather than hidden
behind the successful simple-assignment surface:

1. compound, logical, and update writes (`+=`, `&&=`, `++`, and peers) still
   need to route through the persistent caller-state lookup; and
2. a nested closure that both captures an outer eval-state pool and owns its
   own direct eval needs an inner/outer two-pool chain. Capture-only nested
   arrows and function expressions already carry the single pool correctly.

Those are conformance follow-ups, not routing blockers for the runtime-eval
MVP. The interpreter remains the default and remains a permanent selectable
engine.

## 2026-10-04 — PR6435 native guard residual implementation gate (Astra)

### Authority, immutable evidence and limits

Docs-only proposal in `codex/4016-split-residual-plan`, base
`fdb116928b5861fd628abfde95da5e3deb91f689`. Only this appendix is new.
The entire preceding 1698-line MD was read and is preserved, SHA256
`874f9194b5de9b3ea0f49931a91e79a0083d9e8b0abda596cf2ca50637423fc5`.
The completed MD4016 audit and separate Script P2 appendix remain frozen.
No source, fixture, runtime, build, provider, claim, dependency, publication
or GitHub-state action was taken. This is not source GO or an issue closure.

The evidence was found through the COMPLETE branch handoff
`plan/issues/6810-executable-native-eval-ci-contract.md` in read-only
`/Users/thomas/.codex/worktrees/es6-native-eval-ci/js2`, head
`16120f29f62e5748f8d9fec795695fca302a4a8a`. Its historical production
baseline is `1f1b0ad61cbc74d0bde3a326e8b7e2e02b7add99`, NOT current main.
The durable directory `/private/tmp/js2-6810-native-provider.xz1tZR/` exists:

- `guards.json`: `9554c0a86f8ebb2afb00f54d9082be93a395a1f2c058f83200f64e118d954751`.
- `guards.log`: `c85a31c1547515f162a18190540f344b6af587378762121e31aa47fc4d584787`.
- `provider-build.log`: `962ece7ec56825737f6c0fc259e8dcb1693988dd7bfd479608bf2f8bd7864f37`.

All three hashes match the handoff. All 67 actual assertion rows and full log
were read: 67 unique names, 60 PASS, 7 FAIL, zero pending/skipped, six files.
The worker explicitly announces INTERPRETER, key `f672c24b5ff46645`, full
selection enabled; the builder reports 6,243,897 bytes and canary success.
Recorded provider SHA is
`5871f19b95b2a791dfa738bc3746ab9f936198374a146bf9363e5ea19070d40b`;
compiler/runtime bundle SHAs are
`35f6f894fe9551d33d5b0cf364cf7d350dc7ec1394622e20632b39abcb3a297e` /
`3aaf2742cdd255fb48f3dbff83ff8abcee5f520b7fceabf0bb6e8f1e314534e6`.
The build log also records building REFUSAL separately: that is NOT the
provider selected for these semantic rows. Historical Node was24.19.0,
pnpm10.30.2; corpus was `b363f29d3c43c626dc852744ad64a0b48a003693`.

The six fixture files are byte-identical between historical1f1b and this
planner's fdb, and between1f1b and the PR6435 head. Their SHA256 pins:

- `tests/issue-1102.test.ts` (31/31):
  `9cc1a9e31d4e9e9502e10a1207b744a13431563e5b55774728de3f4124758520`.
- `tests/issue-2928-refusal-provider.test.ts` (3/3):
  `8c997ca4109a5bdece07aae7b5b725a9aaa3391a79224c9a596a48d963315d51`.
- `tests/issue-2929-cd-global-materialization.test.ts` (5/12):
  `face0c7c4c693deff397060df0efade7284097e0644227855cc98fe1079ee6f6`.
- `tests/issue-2960.test.ts` (13/13):
  `f657a77fb39dcc684c2a5132b3aae405b226351f52505711e45e39801b8a2516`.
- `tests/issue-4197-consumer-mode-decl-getter.test.ts` (4/4):
  `b6cd9306189f38c4598eb5d097b062950407f9465080760dc062227c4c9ca4e6`.
- `tests/issue-4242-no-removal.test.ts` (4/4):
  `998531aad895248efb17849c3248c7f300f5e47d6c2bfbd09f060524e149d0f5`.

Historical total is executable native evidence, not a current score or an
original Test262 gain. The eight CI-contract tests are a different population.
The twelve-case MD2929 fixture was read completely, including its tier selector,
all original bodies and expectations. Its `selectInterpreterTier` explicitly
overrides engine selection for the lookup; the actual worker announcement also
proves native selection. QuickJS/P1/P2 repairs cannot substitute for this run.

### Seven row identities, not seven invented root causes

All seven failures occur in the pinned MD2929 fixture. First six report only
`fail: undefined`; JSON retains the outer Vitest assertion, NOT the full inner
CompilerPool result, exception payload, call trace, compiled source or Wasm.
The retained directory contains only the three receipts above. Consequently
the exact first failing instruction of these six is UNKNOWN, not attributed.

1. `cd/direct-var-new`, source lines84–93: `eval('var cdVarNew;')`, then own
   descriptor, undefined initial value and W/E/C=true. Distinguish declaration
   creation from descriptor lookup/primitive decoding; either can stop this row.
2. `cd/direct-func-new`, lines96–107: `initial = f` BEFORE function declaration,
   then caller `typeof`, call returning33, own `f` and configurable=true.
   Distinguish hoisting from stable callable exposure, pull-back into `initial`,
   invocation and descriptor observation. A failure before the call proves
   nothing about invocation; a successful call proves nothing about descriptor.
3. `cd/indirect-var-new`, lines110–119: indirect `var cdIndirect = 7`, then own
   descriptor value7/configurable=true. Separate creation, initializer store,
   shared-value export and caller descriptor value decoding. It has no caller
   activation binding and must not be repaired by giving indirect eval one.
4. `cd/existing`, lines125–135: script var23 preserved in `before`, eval changes
   it to45, caller reads45, descriptor remains non-configurable. Separate initial
   script publication, provider write and AOT pull synchronization. Making all
   globals configurable or recreating a fresh global object would violate it.
5. `cd/annexb-existing-primitive-call`, lines146–159: TWO sequential subcases,
   numeric `direct`/`indirect` become functions returning41/42. Preserve both.
   Separate conditional AnnexB assignment, marker publication, mutable-global
   type admission and ordinary callable dispatch. First subcase may mask second.
6. `cd/delete-severs`, lines165–177: eval var5, caller reads5, member delete must
   succeed, later bare read must throw caller-observable ReferenceError. Separate
   initial publication from delete status, missing-name lookup and error identity.
   This is a GLOBAL property deletion, not the historical local-pool tombstone
   bug already repaired earlier in this MD.
7. `gap/nan-not-own`, lines236–241: explicit Error states NaN IS now an own
   property. This proves the negative gap assertion fired, not that all NaN
   descriptor semantics work. It is an obsolete contract, not a missing-NaN bug.

ES2015 [18.1.2 NaN](https://262.ecma-international.org/6.0/#sec-value-properties-of-the-global-object-nan)
requires its global value with W/E/C=false. A separately approved fixture repair
must assert the own descriptor, numeric NaN, all three false flags, failed delete
and refused incompatible replacement, not skip/remove this row or manufacture
absence. Keep the original frozen67 receipt; report the revised contract as a
separate revision, not seven unchanged expectations suddenly passing.

Also read the official ES2015
[CanDeclareGlobalFunction](https://262.ecma-international.org/6.0/#sec-candeclareglobalfunction)
and [CreateGlobalFunctionBinding](https://262.ecma-international.org/6.0/#sec-createglobalfunctionbinding)
algorithms: an existing non-configurable data property is function-declarable
only when writable and enumerable; a compatible existing property retains its
attributes. These rules ground the refused NaN declaration and row4 controls,
not a license to reimplement the already-present native declaration preflight.

### Exact source path and falsifiable boundaries

Locations below are source reads at planner fdb; these are hypotheses to test
against actual emitted bodies, NOT proof every source path executes per row.
Compared with1f1b, the surveyed `src/interp/`, provider generator,
`runtime-eval-provider.ts` and `global-environment.ts` are unchanged; calls.ts
and eval-inline.ts have later changes. Do not transplant historical binary
indices or pair its provider with new compiler-bundle keys.

- `expressions/eval-inline.ts::tryStaticEvalInline`1150–1205 declines sloppy
  global var/function declarations to the provider; assignment-only remains a
  splice. `expressions/calls.ts`7893–7902 routes a direct call for which
  `directEvalRunsAtScriptGlobal` is true to `emitStandaloneIndirectEvalRuntime`.
  Therefore labels saying DIRECT do not prove the `__runtime_direct_eval` ABI
  was used. Record actual imports/callsite and assembled Script scope first.
- `eval-inline.ts::emitStandaloneIndirectEvalRuntime`2030–2078 publishes caller
  globals, evaluates/uses source, passes the same global object, calls
  `__runtime_indirect_eval`, then unwraps. Its source-cache/argument staging
  protocol is owned by PR6246/6774; no modification is proposed from these
  single-argument fixtures. Function-local paths use the direct provider ABI
  with live activation/lexical/outer cells (`runtime-eval-provider.ts`751–1050).
- `runtime-eval-provider.ts::emitRuntimeEvalGlobalBindingPushBody`313–541
  publishes script globals and stable AOT callable adapters; it must preserve
  script non-configurability and later user descriptor attributes. Pull body
  543–587 reads shared values, unwraps, adapts interpreted callbacks and writes
  the module global. Inspect actual physical global type before alleging that a
  numeric initializer forces a callable to remain numeric. No blanket widening.
- `scripts/runtime-eval-provider.mjs::PROVIDER_EXPORT_WRAPPER`249–408 creates
  `[ok, wrappedValue]`. Indirect success AND catch paths expose global lexicals
  and `exposeRuntimeEvalObject`; direct additionally exposes live cells and
  snapshots activation state. An exception inside exposure can replace the
  original completion. Distinguish this from an interpreter body exception.
- `interp/dynamic-function.ts::executeIndirectEval`263–287 ensures realm,
  parses, creates global EnvRec, prepares declarations, then enters emitted
  bytecode. `executeDirectEval`317+ is the separate created-local chain. Do NOT
  redirect this work to QuickJS or to `executeGlobalScript`293 merely because
  the outer fixture uses Script goal: its evaluated code is ordinary eval.
- `interp/eval-environment.ts::prepareGlobalDeclarations`778–830 validates
  before creation; `prepareGlobalVarBinding`764 creates missing own W/E/C=true
  undefined; `prepareGlobalFunctionBinding`749 prepares compatible descriptors.
  `emitter.ts::declareScriptGlobals`460–475 emits actual function closures before
  statements without resetting predeclared vars. Existing implementations must
  not be duplicated without proving their generated operation is the first loss.
- `interp/loop.ts::envAssign`850 writes the existing backing property;
  `envLookup`626 normalizes shared values. `exposeRuntimeEvalValue`503 memoizes
  interpreted function markers; `exposeRuntimeEvalSharedValue`520 normalizes
  before wrapping, and `exposeRuntimeEvalObject`540 rewrites enumerable values.
  The latter is a real candidate boundary for descriptor/abrupt-write effects,
  but the opaque errors do NOT establish it as the common cause.
- `runtime-eval-provider.ts::emitRuntimeEvalResultUnwrap`657–701 pulls globals
  BEFORE inspecting envelope success, reads slot1, decodes via
  `runtime-eval-boundary.ts::buildRuntimeEvalValueUnwrap`422+, reads/truth-tests
  slot0 and throws the decoded payload through caller tag on failure. Audit
  reserved/live helper indices and canonical vec/value brand on each side;
  distinguish real `[false, undefined]` from incorrect slot0/slot1 decoding,
  a pull-side exception, or renderer loss. No ABI/layout/global coercion change
  is justified until exact binary evidence identifies the failing contract.
- `calls-guards.ts::runtimeEvalMayReplaceCallee`91–100 ALREADY exempts mutable
  global var/lexical bindings from primitive-callee rejection. Do not add the
  same guard again for row5. `global-environment.ts::emitRuntimeEvalGlobalRead`
  555 delegates to HasProperty-guarded object read416; absence must throw, while
  `typeof` uses missingAsUndefined. Member-delete row6 must reach ordinary
  descriptor-sensitive delete on this SAME realm object, not a second store.
- `interp/loop.ts::installRuntimeEvalRealm`190–245 already installs NaN,
  Infinity and undefined as non-writable/non-enumerable/non-configurable data.
  Row7 needs a standards-positive test contract; deleting this producer is wrong.
- `scripts/test262-worker.mjs::extractWasmExceptionMessage`1761+ can inspect the
  actual exception tag/native renderer only with an instance; instantiate and
  deferred-init catches2450–2550 differ. `runScript`60–75 then retains only the
  returned status/error string in its failed assertion. `undefined` alone does
  not identify the exception type, origin, stage or whether globals changed.

R2-A named capturing apply is NOT yet a demonstrated mechanism for these rows:
their checked functions are interpreter-minted, and row7 uses a built-in borrowed
hasOwnProperty.call, not a capturing named declaration with hidden value/TDZ
parameters. Reuse the already reviewed MD6835 R2-A contract only if WAT proves
that exact physical capture-signature/argument mismatch. Do not duplicate its
held closure-dispatcher work or infer it from an incidental `.call` spelling.

### Smallest executable Sol6.1 High tasks, with explicit STOP gates

N0 — evidence-only baseline and per-row first-loss receipt. Proposed leaf
`2929:native-guard-seven-attribution`, not claimed here. In a NEW own worktree
at root-verified source, under a separately granted heavy lease, build the
ordinary current compiler/runtime and full NATIVE provider with standard
canaries. Verify Node24, actual engine, zero provider imports, originalHarness,
noStrict/inferModuleStrictArguments=false and maintained oracle14; pin every
effective source and binary. Never select QuickJS or refusal to get green.
Run all six unchanged files once; require67 unique rows, no skip/timeout/missing
row. Compare by full identity to historical receipt; current differences are
measured differences, not attributed regression from a docs/workflow patch.

For each of the six opaque failures retain the full CompilerPool response,
assembled unmodified source, consumer/provider binaries, normal WAT, imports,
exports, terminal result, actual tag match and existing native-renderer result.
The six expected-pass identities stay unchanged; keep row7 as historical red.
Use actual provider-entry/call/envelope/read/write/export bodies to distinguish:
not reached; provider throws; exposure throws; pull throws; unwrap misreads;
post-return assertion/descriptor/call/delete fails. If an unmodified run cannot
locate a stage, STOP with that gap and request a bounded supplemental diagnostic
manifest before adding checkpoints. Never replace the original oracle result
with a smaller rewritten probe or claim all six share a first loss.

N1 — native result/publication repair, only AFTER N0 identifies a shared loss.
Proposed leaf `2929:native-eval-result-publication`. Choose exactly ONE proven
producer/consumer hunk pair from the inventory above: native wrapper exposure
and its actual reader, or consumer pull/unwrap and its actual value producer.
Root reviews exact bodies/owners before source GO. Preserve success/throw flag,
undefined versus null, reference/closure identity, normal AND abrupt write-back,
canonical brands, live helper indices after late imports and existing rec-group
ABI. No error swallowing, fallback-null result, second global object, host shim,
global dirty flag or generic conversion rewrite. Include matched controls for
success undefined/null/false/0/string/object/callable; thrown undefined/null/Error;
and write-before-throw followed by another eval. These are supplemental controls,
not substitutions for the fixed67. If only one row moves, report one, not six.

N2 — remaining semantic repairs, independently gated per first loss after N1.
Only request the concrete hunk that failed: missing-var descriptor creation;
function prologue/store before statements; existing-global push/pull descriptor
preservation; AnnexB conditional assignment plus stable callable exposure; or
ordinary member delete plus missing-name read/error identity. Each has its own
row1–6 acceptance above and must preserve all currently passing controls. A
descriptor-reader defect is not permission to change EDI; a successful provider
function store plus failed consumer call is not permission to change hoisting.
Group rows only after binary proof and removal attribution, never by error text.

N3 — separate standards-positive fixture repair for row7. Proposed leaf
`2929:native-global-nan-contract`, requiring explicit fixture-owner grant. Keep
one replacement registered test with own NaN data descriptor W/E/C=false and
numeric NaN, failed sloppy delete and refused incompatible redefine; add direct
and indirect `function NaN(){}` rejection plus non-conflicting declaration
controls separately. Check throw identity and no partially created properties.
Do not call the expected historical fail→new-pass a compiler gain. If positive
assertions reveal a runtime defect, STOP and obtain its own narrow source plan.

N0 and N3 preparation are logically independent; no multiple heavy jobs.
N1/N2 are contingent implementation gates, not speculative repair authorizations.
Finish the finite selected task and report its first complete matched matrix;
do not chase additional files/functions automatically when a new failure appears.

### Ownership questions and acceptance

This docs delegation creates NO execution claim. No fresh GitHub/claim polling
was performed. Retained P1/P2 coordination positively holds4308 EDI,4245 membrane,
4647 receiver,4540 heap/allocator,4542 lifetime and4544 native emission; prior
R2-A evidence positively holds4637 callable-prototype/call/apply. Historical
`done` headers do not release any of these protocols. Current patch absence or
exact hunk clearance has NOT been newly established for this task.

Concrete requests before N1/N2: who owns native-only `exposeRuntimeEvalObject`
and wrapper result transport, distinct from4245 QuickJS membrane? May the exact
caller push/pull/unwrap hunk be edited while preserving4307 callable identity
and4308 declaration contracts? If row2/5 reaches callback application, obtain
4647/4637 clearance for that exact producer/reader pair; shared receiver save/
restore changes are not granted by the existing R2-A private-caller proposal.
For row6, identify ordinary delete/global-read owner before editing MOP. Keep
PR6246 argument staging and6774 spread routing untouched. Separate-machine IR
clearance does not release these claims or authorize interpreter/IR refactors.

Acceptance is all six substantive original guards corrected, all60 historical
PASS identities retained, and a separately approved stronger NaN contract green
with full denominator/accounting. Require per-row matched baseline/candidate and
removal arm on the ACTUAL repaired source with matching fresh provider/bundles;
no instrument changes between arms. Execute ordinary scoped/static/publication
gates under the implementer's authority without allowance increases or disabled
checks. Whole67 must be re-run on the final integrated source; local success
does not certify PR6435's published head. Preserve full native no-removal and
refusal controls, caller identity/error behavior, and zero-import capability.

No Test262 original is newly measured here. Neither67 diagnostic guards nor
8 workflow-contract tests count as gain against the frozen11,778 originals.
PR6435 remains unfinished until actual native semantic verification and normal
owner-led integration/publication are complete. Root must read this FULL appendix
before any Sol dispatch or expansion of its proposed exact source scope.

## Native guard follow-up: ownership and non-instrumented N0 collection

Docs-only adjudication, 2026-10-04. This supplements, and does not replace,
the preceding accepted 286-line plan. No source, fixture, worker, provider,
claim, dependency, or runtime change was made. Historical 67/60/7 remains
historical evidence; no new execution or gain is asserted. The future N0 job
still requires root dispatch and the heavy lease. N1/N2/N3 remain ungranted.

### Bounded current ownership evidence

One bounded snapshot read both books used by `scripts/claim-issue.mjs`
421–476: upstream and legacy, with upstream taking precedence for identical
record filenames. Absence in the upstream book alone is not release. Both
configured legacy remote names resolve to `ttraenkler/js2`; it was read once.
The pinned assignment commits were:

- `loopdive/js2`: `8ed0193fc5f3ba25f5c7bd9e7cd2c60871b0981f`.
- `ttraenkler/js2`: `3d6bc324711e54f4b4d41f71910ee228cc8ed6ac`.

The bounded root-tree filter covered records/slices for 2929, 4245, 4307,
4308, 4637, and 4647. Upstream supplied 2929/4637/4647; legacy supplied
4245/4307/4308. No matching slice record supplied a narrower release.
The actual records, not their age or issue-title status, establish:

- 4245: `in-progress`, `ttraenkler/opus-membrane`, branch
  `issue-4245-membrane-slice1`, write `3673-cuhch2hj`, claimed/updated
  `2026-08-09T18:35:41Z`.
- 4307: `in-progress`, `ttraenkler/opus-senior`, branch
  `issue-4307-closure-carrier-wrap`, write `2644-9ek9n79y`, claimed/updated
  `2026-08-09T19:45:42Z`.
- 4308: `in-progress`, `ttraenkler/senior-dev`, branch
  `issue-4308-slice-a-error-identity`, write `30953-9t03z4oe`, claimed/updated
  `2026-08-09T20:22:54Z`.
- 4637: `in-progress`, `ttraenkler/claude-es5-standalone`, branch
  `issue-4637`, write `21722-b4gyvn3s`, claimed/updated
  `2026-08-23T07:27:17Z`.
- 4647: `in-progress`, `ttraenkler/dev-4647`, branch
  `claude/es5-standalone-pass-rate-6tk9rb`, write `20393-us8ek9sm`,
  claimed/updated `2026-08-23T12:54:38Z`.
- 2929: `reserved`, empty assignee and branch, no write ID; reserved/updated
  `2026-07-01T23:30:25Z`. This identifies neither an active fixture author
  nor permission for this planner to claim or change its fixtures.

This snapshot does not re-adjudicate 4540/4542/4544, inspect new PR patches,
or confer whole-file clearance. Their previously recorded holds stand.

### Exact native scope versus shared protocol

MD4245 lines 75–85 explicitly leave the interpreter provider and all its
`src/interp/`, IR/codegen substrate, and acorn dependencies UNTOUCHED. Its
membrane implementation concerns QuickJS inward/outward wrappers and the
pinned native shim. Therefore `src/interp/loop.ts:540`
`exposeRuntimeEvalObject`, and the native interpreter wrapper string
`scripts/runtime-eval-provider.mjs:248` `PROVIDER_EXPORT_WRAPPER`, are not
4245 implementation hunks. This is a genuine recorded scope distinction,
not a grant to edit them. MD4245's frozen envelope, carrier, push/pull and
borrow/identity protocols remain constraints on any native implementation.
Do not route a native exposure failure into QuickJS membrane changes.

MD4307 lines 75–111 positively own caller callable wrapping, its inverse
`src/codegen/runtime-eval-callable.ts:596`
`emitRuntimeEvalCarrierUnwrapAny`, identity memo/finalize repair, the two
push/direct-cell crossing sites in
`src/codegen/expressions/runtime-eval-provider.ts`, and three closure-call
cast guards. This is a positive exact inverse-helper hold, not merely an
adjacent-file warning. `emitRuntimeEvalGlobalBindingPullBody` at line 543
and `emitRuntimeEvalResultUnwrap` at line 657 are distinct bodies from the
listed push/direct-cell producers; nevertheless their carrier decoding and
identity agreement cannot be altered under an inferred whole-file release.

MD4308 lines 1553–1589 positively describe `qjsWriteBackCallerCells`,
`qjsMirrorNewBindings`, global restoration/routing, and the specific
codegen activation-seed sentinel produced using
`directEvalCallerIsFunctionScoped`. They do not establish ownership of
every pull or result-unwrapping instruction. They do establish a held
global-versus-activation, declaration, error-identity and cell-marker
contract. Preserve it, including the frozen direct-entry ABI, while
investigating the native-only lane.

The current reader order is concrete: `emitRuntimeEvalResultUnwrap`
657–701 stores the envelope, calls global pull, marks provider inactive,
decodes field 1 into a caller-local representation, then branches on field
0 and returns or throws through the caller tag. Thus a pull failure may
precede observation of the provider completion. Neither `undefined` text
nor a failed fixture alone proves which stage failed. Do not reorder this
sequence, remove wrapping, or edit shared inverse helpers as a diagnostic.

Required subsequent owner decision is exact: after N0 proves a first loss,
grant the named native exposure/wrapper body if native-only, or obtain the
4307/4308 carve-out for the named caller pull/decoder body and preserved
carrier/declaration protocol. Callback application additionally intersects
4647 and possibly 4637, as previously recorded. No such edit is authorized
now. N3 requires a separate explicit fixture grant for
`tests/issue-2929-cd-global-materialization.test.ts`; reserved umbrella
2929 is not that grant. Do not change seven historical row identities.

### N0 job: maintained collection without core-worker changes

Run the unchanged full six-file 67-test guard set identified above, against
a freshly matched current native INTERPRETER artifact, in the future
approved lease. Keep the explicit interpreter keystore override, full
provider, Node/oracle provenance, source/flag/bundle/provider hashes and
all original expectations. No QuickJS/P1 substitution, stub8 replacement,
old-provider/new-key pairing, or stronger NaN fixture change in this arm.
Record all 67 statuses, including the unchanged obsolete NaN assertion;
compare identity-by-identity with the historical receipt, not just totals.

For detailed artifacts, an own-temporary sidecar collector can use the
maintained `CompilerPool.runTest` API (`scripts/compiler-pool.ts:217–294`)
on the exact original `runScript` bodies from that fixture. Freeze its
finite observation manifest for root review before execution: all 11
existing script bodies, plus the existing provider-tier assertion retained
by the full fixture run. Preserve byte-for-byte bodies, original harness
assembly/metadata, labels, strictness, timeout and all evaluation options;
add only distinct `wasmPath` and `metaPath` destinations. Do not rewrite
the fixture's source to add exports, counters, catches or sentinel returns.
Do not reinterpret this artifact pass as extra test identities or gain.

Persist each complete maintained pool response before fixture-level status
conversion, including status/error/ret, exception/instantiation flags,
imports, reachedTest, timings, and any other returned fields. Preserve
absence versus a serialized value; a string `undefined` is not a payload
classification. `runTest` forwards artifact paths explicitly. No worker
patch, option bypass, custom import replacement or trace hook is needed.

The worker saves successful binaries and metadata before execution at
`scripts/test262-worker.mjs:2348–2365`, including string pool, imports,
source map and bundle hash. Its save catch is silent, and compile-error
paths can write a zero-byte binary. Therefore independently require files
to exist, nonzero Wasm, parseable success metadata, matching bundle/source
provenance, and SHA-256 receipts. Artifact absence is instrumentation
incomplete, not a semantic result. Do not rely on `compile()` returning a
binary: the maintained compile-only worker result is status `compiled`.

Inspect imports/exports from the exact retained binary without executing
it; disassemble that same binary with an already available pinned local
tool, recording tool identity and WAT hash. If unavailable, report missing
WAT rather than installing a tool or recompiling a different variant.
Use source map and concrete function/call/field sequence to separate
wrapper publication, caller pull, result decoding, callback and MOP paths.
WAT alone proves generated instructions, not which dynamic branch ran.

### Explicit observation limit and stop condition

The pool returns serialized execution results, not live exception objects
or instances. Its existing renderer already calls `tryNativeExnRender`
(`scripts/test262-worker.mjs:1761` onward). The maintained shared renderer
is `scripts/lib/wasm-exn-render.mjs`: `tryNativeExnRender` line 68,
`exceptionPayload` line 92, `renderHarnessThrownText` line 120. Preserve
this policy; do not replace it with JavaScript stringification and call the
result an equivalent rendered exception.

`instantiateRuntimeEvalNamespace` at
`scripts/runtime-eval-provider.mjs:832–857` returns only the five runtime
entry functions for native providers, not the underlying instance, tag or
renderer exports. A start-time failure may also occur before the consumer
instance is available. Consequently the unchanged pool/artifact job cannot
promise a live provider payload/tag trace. The renderer helper's returned
`undefined` also conflates unavailable extraction with a genuine undefined
payload; a future authorized live observation must retain explicit tag
match success separately. No inference from that value is admissible now.

Stop N0 at the strongest supported first-loss evidence per row. If retained
raw results plus binary/WAT cannot distinguish two candidate stages, name
both and request a finite separate observation grant. Do not wrap provider
imports, expose private tags, alter start/deferred-init, edit the renderer,
or instrument the core worker under N0. A later approved replay must use
the maintained import-object/instantiation path and matched provider; it
is not silently included in this non-instrumented collection authority.

Deliver all rows and provenance, artifact completeness, exact producer/
consumer evidence, unresolved alternatives, and the smallest owner-scoped
next question. Six identical historical failure strings remain six
unattributed failures until this evidence separates or unifies them. This
addendum supplies no source GO, fixture GO, publication readiness, or
Test262-original gain. Root must read the entire addition before dispatch.

## N0 dispatch packet: frozen eleven bodies and ordinary native preparation

2026-10-04, docs only. No build, provider selection, test, replay, network
read, or source edit was performed for this packet. The preceding 2161 lines
remain unchanged. This specifies the future owner-dispatched diagnosis;
it does not start that job or confer a heavy lease.

### Finite source manifest

Read the complete 243-line fixture
`tests/issue-2929-cd-global-materialization.test.ts`, SHA256
`face0c7c4c693deff397060df0efade7284097e0644227855cc98fe1079ee6f6`.
Its eleven `await runScript` template literals contain neither interpolation
nor escape sequences. A read-only extraction verified exactly eleven bodies.
Body hashes below include their original terminating newline, not the template
delimiters. Wrapped hashes use EXACTLY the fixture's source construction:
`/*---\ndescription: ${label}\nflags: [noStrict]\n---*/\n${body}`.
These are input hashes, not compiled-result or harness-assembly hashes.
No current result is predicted. Historical statuses are only locator evidence.

1. `cd/direct-var-new`, body starts line 85, 359 UTF-8 bytes; historical FAIL.
   Body `e300df81f3bfa04f53419eadab75b526d3b1a94431a55b07b7944b192da58996`;
   wrapped `e54bf56968227a6689732fbfa2cd30de1cf535d5cf19e7cd898b948dd8d7d374`.
2. `cd/direct-func-new`, line 97, 458 bytes; historical FAIL.
   Body `e849ac2d43af94ff2758803277ed8e813fc2b3b3484de6941cc9a41979a4a981`;
   wrapped `3cda8ca82392fb49a499dd2ab018e6e41e2df97cd981f76f8369ef56be023767`.
3. `cd/indirect-var-new`, line 111, 309 bytes; historical FAIL.
   Body `ed6850a882050d4cfa2f513ff9b27a3e76c092ec9d6b11eaea21290f5f7ecc0a`;
   wrapped `b61ff6a35463c9abe11587854ad891eb0b3d10fe7616f851c0b41b3df0d1f166`.
4. `cd/existing`, line 126, 494 bytes; historical FAIL.
   Body `5d0b371785df21d50a2bcbfd07a774c8125370eaa45ba3d883c1e9eb5e5358bb`;
   wrapped `3e13d192b5e711656643dcbaafceab15f674419c79fa48e306d7efc754541130`.
5. `cd/annexb-existing-primitive-call`, line 147, 471 bytes; historical FAIL.
   Body `73c13b33c5ea6bc116bf2e3b8c84dab364ecf52e830a91c14df4f2c48d996941`;
   wrapped `6d3d7b44340512f1a4ba6c87236f1c6180d10d2f7de7ae3e93b4c7cf278a06b8`.
6. `cd/delete-severs`, line 166, 388 bytes; historical FAIL.
   Body `c95f1f3bc313d412201063fe0ad9871b11892d82ed80a27558340be8fa0318ab`;
   wrapped `38073079921b542080333066b828c28e7b1edb0c190fc5f267fa422434fa6bbd`.
7. `cd/assign-only`, line 181, 145 bytes; historical PASS.
   Body `1a2bc488988ce69a4732cc006a13c819c92ca8107d76d14ff1fa79277eef6472`;
   wrapped `e215d762b64a7053d83b04980949288153ad24541ed27448fd16ab7d761d5be3`.
8. `d/direct-var`, line 193, 411 bytes; historical PASS.
   Body `fbf76a053b43880e97215a8d31fa1602dcb517601deb5c7a4d16a00256a39033`;
   wrapped `5b5c540e505c110f7d2a693a01b961ba098e6cdfa8681f9b3e614b6198822603`.
9. `d/indirect-var`, line 206, 202 bytes; historical PASS.
   Body `1e1dfbda640f47b0a2dd89325f5de0f368eb1a268db179e6f37ef373009c9416`;
   wrapped `5e060ded154664fabcdc4c13ac1d89ee0de68b4adb1fb1efd16873bbff5f3cea`.
10. `d/indirect-func`, line 217, 212 bytes; historical PASS.
    Body `7604e5d0b1e14433dcbabfcbb7f3a236f528efe7fd1c940fa7e580210770d89a`;
    wrapped `c32e70fee07a1b479b8fbd3208dedcb8e886cbc1886b1820e08270e07ade04d0`.
11. `gap/nan-not-own`, line 237, 180 bytes; historical FAIL, obsolete negative
    assertion deliberately unchanged in N0.
    Body `af82dfb4501ffb72d2d478e41ed6fb7a71602dfab0b297cab67233f27c1dbc30`;
    wrapped `c223e744c1fa2da777bc4472c5d4887e21715616e7b524346d50c1b9b60e1d28`.

The twelfth fixture assertion is the INTERPRETER tier announcement, not a
script body. Keep it in the ordinary twelve-test fixture execution. Do not
turn eleven artifact invocations into twelve, or count them again in the 67.
The five historical PASS assertions in this fixture comprise four passing
bodies plus the tier assertion. The other five unchanged guard files supply
55 more; the complete historical PASS denominator remains 60.

### Exact future preparation and execution order

1. Root assigns Sol6.1 High an own execution worktree and reviewed current
   source revision, then separately grants the heavy lease. Pin that actual
   revision plus complete dirty-source diff if any; do not label the planner's
   fdb or historical 1f1b as current. This job changes no production source or
   fixture and needs no semantic claim takeover. Verify all six fixture pins,
   the corpus pin and actual harness bytes before work; STOP on a mismatch.
   Use existing approved dependencies and Node 24/pnpm provenance. No package
   install, submodule reset, cache purge, provider fallback, or configuration
   repair is part of this dispatch. Missing prerequisites are a root question.
2. Under the lease, prepare current compiler and runtime bundles with the
   ordinary CI commands below, followed by the ordinary full native builder.
   The source for this sequence is PR6435's `ci.yml:593–610` and
   `scripts/build-runtime-eval-provider.mjs`, not a private alternate compiler.
   Set `NODE_OPTIONS=--max-old-space-size=3072` for the bounded preparation.

   ```sh
   pnpm run build:compiler-bundle
   pnpm exec esbuild scripts/runtime-bundle-entry.ts --bundle --platform=node --format=esm --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
   node scripts/build-runtime-eval-provider.mjs
   ```

   Do not use `--refusal-only`. The normal builder prepares refusal separately
   and builds or reuses full native source/options/bundle-keyed bytes. A cache
   hit is acceptable only for the computed current key; record hit versus
   build honestly. The maintained `--require-full-cache` verification may
   confirm the matching full entry and its canaries after preparation, not
   substitute old bytes under a new key. Verify zero imports and five builder
   canaries (3, 3, 84, 3, 30) plus all five namespace entry functions. Record
   actual source key, compiler key, paths, hashes, bytes, terminal/log and
   selector announcement with `JS2WASM_EVAL_ENGINE=interpreter` and
   `TEST262_FULL_RUNTIME_EVAL=1`. Missing full selection is STOP, not REFUSAL
   semantic scoring. Do not point the QuickJS selector at native P1 artifacts.
3. Run the ordinary fixed six-file guard set serially, with the same two
   native-selection environment values and 3 GiB worker limit. The following
   command is a future instruction, not an executed or successful receipt:

   ```sh
   pnpm exec vitest run tests/issue-1102.test.ts tests/issue-2928-refusal-provider.test.ts tests/issue-2929-cd-global-materialization.test.ts tests/issue-2960.test.ts tests/issue-4197-consumer-mode-decl-getter.test.ts tests/issue-4242-no-removal.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=.tmp/2929-n0/guards.json
   ```

   The implementer creates a fresh own output directory without deleting any
   prior result and retains separate stdout/stderr/terminal receipts. Check
   67 unique complete assertion identities against the historical raw JSON,
   six files, zero pending/skips, and actual worker INTERPRETER announcement.
   Nonzero exit with complete semantic FAIL rows is not an instrument failure;
   OOM, signal, missing rows/provider/bundle or incomplete JSON is. Preserve
   actual results even if they differ from 60/7. Do not require historical
   totals as an oracle or rewrite the NaN assertion to make this run green.
4. Sequentially collect the eleven artifact observations in a temporary
   sidecar using `CompilerPool(1, "unified")`, `await pool.ready()`, and the
   exact fixture `assembleOriginalHarness(source, parseMeta(source))`. Retain
   wrapped and assembled source separately and hash actual assembly bytes.
   Keep `originalHarness:true`, `asyncTest:assembly.async`,
   `inferModuleStrictArguments:false`, `target:"standalone"`, original label,
   30,000 ms timeout. Do NOT add `scriptGoal`, native/linked harness, semantic
   provider, deferred-init, export wrapper or compile-only options absent from
   the fixture. The only run options added are unique wasm/meta destinations.
   Persist the entire pool response and finally shut down the pool. Each run
   continues to use maintained import-object/provider instantiation semantics;
   never reuse a single mutated realm across separate bodies.
5. Validate artifacts and inspect exact binary/WAT/imports/exports under the
   accepted non-instrumented limits above. Match each artifact run's status to
   its ordinary fixture row; divergence is a collection-equivalence problem,
   not evidence that a compiler fix occurred. Preserve the four historical
   passing bodies as positive controls for assignment routing and refusal.
   Finish with source/fixture/provider/bundle before/after invariants, all
   hashes and the finite per-row first-loss/unresolved-alternatives handoff.
   No source repair follows automatically; root reviews before N1/N2/N3.

The smallest native-only *candidate inspection area* is
`src/interp/loop.ts::exposeRuntimeEvalObject` and its native wrapper callers:
it is outside MD4245's explicit implementation scope and needs no QuickJS
shim edit to inspect. That is not a proven cause, an unconditionally unheld
execution leaf, or permission to patch. The first loss could instead be
caller pull before envelope decode. Exact owner clearance follows evidence,
not a desire to choose the cheapest apparent repair.

### Passive owned-PR next action from retained local receipts

No new remote state or logs were read. The prior six-PR audit is a dated
snapshot, not present-day readiness. A concrete already owner-scoped next
step exists for PR6246: its retained shepherd MD5157 lines 1700–1771 and
`.tmp/6246-refactor-cheap-terminal.json` prove all nine static checks passed
after the approved dependency repair, including SCC697, IR edges295 and
flat829. Receipt SHA256 is
`f65234286b2f16b00d0cd71dc15576cfb83d8963f1553d998dd3b1a1293c69ce`.
Thus another SCC exemption or source refactor is not the next action.

The assigned shepherd's next finite step, after root grants a lease, is its
already frozen matched preservation run: unchanged 15 controls and seven
canonical originals, baseline at
`/Users/thomas/.codex/worktrees/pr-6246-matched-baseline/js2`, candidate at
`/Users/thomas/.codex/worktrees/pr-6246-shepherd/js2`, manifest
`.tmp/6246-preservation-manifest.json` SHA256
`f3b62074a6fe06fe5e59cf5c9dd9ccf08505c4f7dc413b071cd3c8cc1835cfd5`.
Use its retained pre-refactor M1 baseline, not an invented clean-main
equivalence arm. Seven originals are seven identities, not thirteen strict
variants; four are frozen ES2015 spread targets and three preservation cases.
This packet does not dispatch that run or replace its own preflight.

M2 direct-spread/#6774 and strict-iterator scope remain held. Static success
and M1 preservation cannot certify M2 or complete PR6246. The old published
CLAUDE path failure is not a reason to edit unrelated docs in this planner:
current retained local document validation already passed. PR6206's four
retained reds need the separate four-source diagnosis; 6809 remains held;
5883's hold/conflict is not a takeover invitation; PR6435 awaits N0 and the
separate semantic/fixture grants. Map's assigned work must not be duplicated.
Await root's new P1 URL before the separately requested one-shot publication
audit. No watch, poll, source mutation or readiness transition is scheduled.

## Docs-only checkpoint publication manifest

Prepared 2026-10-04 after root's complete read of the N0 dispatch packet.
This section plans publication; no worktree staging, publication commit/hook,
branch push, PR creation or runtime action has occurred. Root's queue is Map's short
diagnosis, PR6246's frozen matched preservation, then native N0. This document
does not reorder that queue or reserve a concurrent lease.

### Exact two-file scope and ownership

One coherent docs checkpoint is appropriate: retained split/native diagnostic
plans and their owned-PR shepherd handoffs share evidence/ownership boundaries.
No separate PR per appendix is needed. Repository policy at CLAUDE.md's
docs-only merge protocol requires using an existing open docs PR if present;
otherwise one new docs PR may contain both files. That current open-docs-PR
check remains a later authorized publication action, not a stale audit guess.
An existing foreign-owned docs branch is not permission to overwrite it: root
must coordinate append integration if that is the selected publication vehicle.

The only publication paths are:

- `plan/issues/4016-standalone-string-search-value-tostring-path.md`:
  preserve base lines 1–390; append lines 391–834 only, 444 insertions and
  zero deletions. Whole file SHA256 remains
  `4e32b97c7aecbebe6af9120a06bac7a5ac2221ed61d7945dcdd492798ca08114`.
  This includes the two split residual diagnostic plan and dated six-PR audit,
  not a claim that those PRs are now ready or their defects repaired.
- `plan/issues/2929-interpreter-direct-eval-with-proxy-mop.md`:
  preserve base lines 1–1698, SHA256
  `874f9194b5de9b3ea0f49931a91e79a0083d9e8b0abda596cf2ca50637423fc5`;
  publish append 1699 onward, including historical 67-row evidence, ownership
  adjudication, frozen eleven-body dispatch packet and this manifest. The
  accepted 2161-line prefix remains SHA256
  `e7f0891adbffd75d66e7716b63da50d6ae7f72255c9449a144cab63aeb5cd6a6`.
  The accepted N0 packet at 2162–2335 hashes to
  `468003f6786f3c0128e061269a764fdcfdaa346d59fbb16a1bb8304f1c00d03b`.

Normal maintained claim operations, explicitly authorized by root after the
docs-only plan, checked each new leaf unassigned and then returned verified
upstream success, exit 0, for actor `ttraenkler/join_residual_plan_astra`,
branch `codex/4016-split-residual-plan`:

- `2929:native-guard-plan-shepherd-docs` (claim session 38634).
- `4016:docs-audit-native-guard-plan` (claim session 41128).

These grant ONLY the two owned MD append/publication scopes. The maintained
check also positively retained `4016:pr-6206-shepherd` for
`ttraenkler/pr_shepherd_sol`; it was not reassigned. No umbrella, reserved2929,
runtime, fixture, source, or foreign claim was taken over. Earlier sections'
statements that their planning passes made no claims remain true for those
dated passes; these two later publication claims are expressly recorded here.

### Local base, frozen exclusions and deferred gates

Own worktree remains
`/Users/thomas/Code/js2/.codex-worktrees/4016-split-residual-plan`, HEAD
`fdb116928b5861fd628abfde95da5e3deb91f689`. Read-only local upstream/main is
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`; that is NOT a fresh server
verification. The local commit-to-commit comparison contains only the same
six npm benchmark/mirror files recorded in the prior audit. Neither publication
MD differs between those two commits. Any later server/source change requires
ordinary integration review before publication, not an automatic reset/rebase.

No P2 transfer, MD5157 edit, corpus/test/source change, evidence-cache commit,
status/frontmatter rewrite or epic closure belongs in this checkpoint. The
separate P2 MD's SHA remains
`ed02b2ed6563459ddd6e330565194c9f1608338b6e28c31f0ed4405abf6900c7`.
Retain local evidence rather than publishing private temporary artifacts.
Only the two explicit MD paths may be staged; verify exact staged names and
append-only diffs before any commit. Do not use broad staging. Whole-worktree
diff enumeration encountered an unrelated Acorn LFS clean-filter sandbox error;
it supplied no clean-tree proof. No LFS/config repair or cleanup was attempted.
Two-path scoped checks work and remain the publication boundary.

Root must read this complete manifest and grant a separate hooks/commit lease
before normal validation/publication. Do not bypass hooks, alter gate budgets,
or run competing compiler/provider jobs. Later record actual docs checks and
their terminal statuses; this packet claims only source readback/hash and
scoped diff-check, not CI success. Follow normal server head/base/queue and
existing-docs-PR checks once authorized; no polling watcher is created here.

### Proposed commit and repository PR template

Author configuration was read and is `Thomas Tränkler <git@thomas.traenkler.com>`;
verify again immediately before the eventual commit. Proposed subject:
`docs(plan): preserve split and native eval diagnostic handoffs`.
Body: record the frozen diagnostic inputs, exact held boundaries and finite
native observation workflow; explain that no compiler/fixture changes or new
conformance gains are included. Required trailers for this Astra-authored work:
`Co-authored-by: Codex <codex@openai.com>` and
`Model: Codex GPT-6 Astra High`.

Proposed PR description follows the actual `.github/PULL_REQUEST_TEMPLATE.md`
headings, with no automatic-closing keywords:

### Description (proposed PR body)

Preserve the reviewed diagnostic plans and dated owned-PR handoffs for
[issue4016](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4016-standalone-string-search-value-tostring-path)
and [issue2929](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2929-interpreter-direct-eval-with-proxy-mop).
This is an append-only, two-Markdown-file checkpoint. It records the unchanged
split residual evidence, historical full-native 60/67 result, current ownership
boundaries, and eleven pinned script bodies for a separately authorized future
diagnostic run. No source/tests/providers are changed; no new runtime result,
original Test262 gain, semantic completion or implementation permission is
claimed. Prior issue history and P2 planning remain untouched.

Validation: full append readback, exact prefix/hash preservation and scoped
diff-check. Add actual normal publication-gate receipts after they run; do not
substitute planned native execution for completed verification.

### CLA (proposed PR body)

Please read the [Contributor License Agreement](https://github.com/loopdive/js2/blob/main/CLA.md).

- [ ] I have read and agree to the CLA

The checkbox is intentionally unsigned in this preparation. Thomas/Codex
commit attribution is not a legal signature. Do not check it on the user's
behalf without the relevant authorization. No PR was opened by this manifest.

## 2026-10-04 21:23 UTC — one-shot P1 and docs-publication preflight

Root authorized this bounded server read after the preceding publication
manifest. The complete prior 2456-line MD is preserved, SHA256
`ca77c1fbf6053d9dcdb417c65afd11b75fe210a02576794191687a6443eec224`.
MD4016 and P2 remain unchanged. No build, test, hook, branch push, merge,
review reply, queue/readiness change, CLA acceptance or CI rerun occurred.
The autopilot skill supplied conflict/review/CI triage order only; its usual
watch/fix loop is excluded by the explicit one-shot, read-only delegation.

### Owned PR6476: exact head and current gate

[PR6476](https://github.com/loopdive/js2/pull/6476),
`feat(quickjs): add inactive Script declaration plan producer`, is OPEN and
non-draft at head `17fd13bcc798705f0cd364a5d83445d4686f1d80`, branch
`codex/5157-script-plan-producer-p1`. Base main is
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`. Server state is
MERGEABLE/BLOCKED, no labels, reviewDecision null, mergeQueueEntry null.
There are zero issue comments and zero review threads; both connections have
`hasNextPage:false`. No unresolved discussion or merge conflict was exposed
by this snapshot, but that is not approval or a future-state guarantee.

The head's complete check-rollup connection also has no next page. No
completed failure/cancellation/timed-out context was returned. The separate
required-check classification reports six actual workflow contexts:

- [quality](https://github.com/loopdive/js2/actions/runs/37235405114/job/111533384729):
  IN_PROGRESS, not passed; this is the observed pending required gate.
- [equivalence-gate](https://github.com/loopdive/js2/actions/runs/37235405114/job/111533897170): SUCCESS.
- [cla-check](https://github.com/loopdive/js2/actions/runs/37235404957/job/111533385270): SUCCESS.
- [cheap gate](https://github.com/loopdive/js2/actions/runs/37235405100/job/111533385452): SUCCESS.
- [merge shard reports](https://github.com/loopdive/js2/actions/runs/37235405100/job/111533407230): SUCCESS.
- [check for test262 regressions](https://github.com/loopdive/js2/actions/runs/37235405100/job/111533407212): SUCCESS.

Three additional same-name PR-stub contexts are SKIPPED; they do not add
verification. A duplicate legacy CLA status is SUCCESS with no job URL, not
a separate legal agreement supplied by this agent. All eight equivalence
shards, aggregate issue-tests, and the changed
`tests/issue-5157-script-plan-artifact.test.ts` job are SUCCESS.
[libquickjs native build](https://github.com/loopdive/js2/actions/runs/37235405096/job/111533384920)
and [non-required QuickJS lane](https://github.com/loopdive/js2/actions/runs/37235405096/job/111533653657)
are also SUCCESS. Those are job verdicts, not newly audited assertion counts.
Actual Test262 shard execution contexts in this PR rollup are SKIPPED; green
report/regression aggregation is not a fresh conformance sweep or goal gain.

Because there is no terminal red, there is no failing log to diagnose in this
pass. Do not rerun quality, infer its result, or push a speculative fix. This
snapshot does not certify readiness while quality is pending. Root received
the exact head and absence of queue entry; no watcher or follow-up poll was
started. Any later authorized audit must re-read the then-current head, not
treat this result as continuing state.

### Existing docs-PR discovery and main comparison

The open-PR connection returned all 18 entries, no next page. Titles were
not used to decide whether a PR is docs-only. Every entry has an actual
non-docs path, so this snapshot contains no existing docs-only PR:

- 6476: `scripts/build-quickjs-eval-provider.mjs`.
- 6468: `.github/workflows/benchmark-refresh.yml`.
- 6475, 6436, 5883, 6246, 6206, 5753, 5911, 5784:
  `scripts/compiler-boundaries.json` in each PR.
- 6435: `.github/workflows/ci.yml`.
- 6341: `src/backend/wasmgc/resources/native-promises.ts`.
- 6383: `src/codegen/binary-ops-in.ts`.
- 6288: `scripts/compiler-extension-boundaries.json`.
- 6234: `src/codegen/binary-ops-typed-dispatch.ts`.
- 6195: `src/runtime/instance-lifecycle-adapter.ts`.
- 5748: `scripts/audit-javascript-soundness-probe.ts`.
- 5942: `tests/issue-3518-independent-pipeline-spike.test.ts`.

First 100-file pages provided positive code witnesses except PR5883, whose
second page still contained only plan material; its third page supplied the
listed witness at unchanged head6f73c8ed. These are pagination reads, not
state polling. A positive code path suffices to exclude docs-only status;
this does NOT claim complete file inventories or renewed overlap clearance
for the large PRs. No foreign PR is adopted as a publication vehicle.

Fresh server main is `1787b1af4a2f010f51ca1f45fc68fa540bfa4673`, matching
the locally recorded ref. Server comparison from own HEADfdb reports
ahead2/behind0, total_commits2, merge-base
`fdb116928b5861fd628abfde95da5e3deb91f689`. Its exact six changed paths are:

- `benchmarks/results/npm-compat-history.json`.
- `benchmarks/results/npm-compat-perf.json`.
- `benchmarks/results/npm-compat.json`.
- `website/public/benchmarks/results/npm-compat-history.json`.
- `website/public/benchmarks/results/npm-compat-perf.json`.
- `website/public/benchmarks/results/npm-compat.json`.

Thus the reviewed two-MD checkpoint can use one new docs PR when root grants
normal publication/hooks authority and current integration is performed.
This preflight itself did not merge even the safe benchmark delta, run hooks,
stage files or open that PR. Preserve both docs leaf claims and all previous
append-only history. If another docs PR appears before actual publication,
coordinate the existing vehicle rather than using this dated absence forever.
