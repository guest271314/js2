---
agent: dev-a
session_end: 2026-07-02
sprint: current
issues: [2849, 2861, 2923]
prs: [2432, 2436, 2441]
---

# dev-a session summary (2026-07-02)

Five PRs, all root-caused via measure-first deep-tracing (not spec-following).
Two of the assigned fronts (#2875, first-pass #2861) were found stale/blocked and
released/reported rather than built — the measure-first discipline paid off.

## PRs this session

1. **PR #2432 — `fix(#2849)`** dynamic-object static-write shadows sidecar. MERGED
   (its `tests/issue-2849.test.ts` is on main).
2. **PR #2436 — `feat(#2861 residual)`** standalone native-proto glue for
   DisposableStack / AsyncDisposableStack / SuppressedError. **+55 standalone
   flips**. Green, stood down.
3. **PR #2441 — `fix(#2923)`** any-typed closure-param dispatch arity semantics.
   (Status at session end: riding CI / BEHIND-drift, auto-refresh handling.)

## #2849 — the one-line coherence fix (MERGED)

Root cause: a `{}` object populated via dynamic-key writes `o[k]=v` (for-in copy)
keeps values in the dynamic `$Object` **sidecar**, but a STATIC-named write
`o.prop = <const>` anywhere (even an UNREACHED branch) makes the
reachability-blind `collectEmptyObjectWidening` pre-pass register a real struct
field (default 0) that SHADOWS the sidecar — reads return 0.
Fix: the #2584 `objectHashConsumerVars` poison (keep such objects on `$Object`)
was `ctx.standalone`-gated on a false "host live-mirror Proxy covers it"
assumption; dropped the gate at `src/codegen/declarations.ts:~2228`.
Note: my first theory (for-in enumeration) was a **harness false-negative** — the
repro didn't call `setExports`; once wired, for-in over a struct already works.
**Lesson baked in:** always `setExports(instance.exports)` when host-probing a
struct-sidecar read, else `__extern_get`/`_safeGet` returns undefined.

## #2861 residual — native-proto glue (MERGED/green)

Earlier PRs 2340/2341/2344 wired most builtins; the residual was
DisposableStack/AsyncDisposableStack (`makeGlueWithGetters`, `disposed` getter) +
SuppressedError (reuses NativeError glue). Brand slots 41-43 in
`native-proto.ts`. Standalone-only, purely additive → host unchanged, 42 existing
native-proto tests green. **Still open follow-up:** Math/JSON/Reflect/Atomics
namespace _static_ reads (not `$NativeProto` proto glue) — separate task.

## #2923 — dispatch arity fix (SITE REFINEMENT — read this for #2931)

**The #2923 spec (living on the #2921 branch, not yet on main) pointed at
`calls-closures.ts:688` (the `compileCallablePropertyCall` PROPERTY-call path).
That is NOT where the actual test262 harness bug lives.** Measured via the
inject-throw probe: the real harness `fn(ctor, makeCtorArg)` is a **bare
identifier** call, which routes through **`tryEmitInlineDynamicCall` in
`src/codegen/expressions/calls.ts` (~L2911)** — a different function. If a #2931
(or renumbered) issue file is written from the spec, correct the site pointer:
**L2911 in calls.ts, not L688 in calls-closures.ts.**

Fix: removed the `if (info.paramTypes.length < arity) continue;` hard pre-filter.
The per-candidate dispatch arm ALREADY marshals exactly the candidate's declared
formals (truncates extras, pads `undefined`), and every call-site arg is
evaluated into a temp local first (side effects preserved), so dropping the
filter simply adopts JS §7.3.14 arity semantics. **Kept** the #1837
void-OVER-arity guard (a void-result closure padded past its arity marshals a
stack-invalid `call_ref`) — so "fewer args + void callback" is a KNOWN remaining
gap, not covered here (the harness is the "more args" shape).

**Measurement discipline (per project rule):** proved the callback body EXECUTES
via **inject-throw** (a `throw` in the body traps iff it ran) on BOTH standalone
and gc/host lanes — a vanished import is NOT proof of execution.

### #2923 shim dependency (now its own queued task)

The test262 flip MEASUREMENT (output-vs-js-host on the 468+ BigInt corpus,
honest-pass fraction) requires **#2921's runner-shim** (dev-callback): add a
`testWithBigIntTypedArrayConstructors` wrapper + passthrough `makeCtorArg` +
regex `/testWith(?:BigInt)?TypedArrayConstructors/` in `tests/test262-runner.ts`.
The shim ALONE (without my dispatch fix) produces **dishonest vacuous host-free
passes** — leak-elim must prove bodies execute. My dispatch fix is safe to land
independently (no harness change → cannot itself create a vacuous pass). Whoever
picks up the shim task: gate honest-pass scoring with the inject-throw + output
diff described in the #2923 spec's acceptance section.

### #2923 issue-file caveat

I deliberately did NOT include the #2923 issue file in PR #2441 — it lives on
the #2921/#2429 branch and was being re-id'd for a dup-id collision. Adding it
would risk a `merge_group` id collision. Status reconciliation left to
lead/dev-callback.

## Released / reported (not built)

- **#2875** (String.prototype standalone cluster) — dominant sub-cluster
  (descriptor reflection over method objects) is BLOCKED on unimplemented **#2896**
  (native function-object metadata substrate, XL/hard). Released.
- **#2873 / #2878** — correctly skipped (owned by other devs, exit-3 locks).

## Key files touched

- `src/codegen/declarations.ts` (~L2228 — #2849 poison gate)
- `src/codegen/native-proto.ts`, `src/codegen/array-object-proto.ts`,
  `src/codegen/property-access.ts` (#2861 glue, brand slots 41-43)
- `src/codegen/expressions/calls.ts` (~L2911 — #2923 arity filter)
- `tests/issue-2849.test.ts`, `tests/issue-2861-suppressederror-glue.test.ts`,
  `tests/issue-2923.test.ts`

## Addendum — #2436 reconciliation (post parallel-merge)

A parallel session landed #2433 (DisposableStack/AsyncDisposableStack glue,
brand slots 41/42 — identical to #2436's original scope) and #2438 (Ctor
length/name folds), making #2436 DIRTY. Reconciled per lead direction (outcome
b, partial delta): merged origin/main, took the parallel session's version of the
three codegen files (do not fight their merge), and kept ONLY the still-unwired
**SuppressedError** glue as the honest delta:

- SuppressedError brand slot 43 (`native-proto.ts`).
- SuppressedError arm → `ensureNativeErrorNativeProtoGlue` (Error subclass;
  reuses the shared NativeError glue, no new factory).
- Test trimmed to `tests/issue-2861-suppressederror-glue.test.ts` (DisposableStack
  / AsyncDisposableStack now covered by #2433's test).

Verified on the merged state: `SuppressedError.prototype` value read flips CE→works
(standalone, ~5 flips), DisposableStack control still works via #2433, tsc clean.
The DisposableStack/AsyncDisposableStack half of my original +55 claim is now
attributable to #2433; my net remaining contribution here is the SuppressedError
subset.
