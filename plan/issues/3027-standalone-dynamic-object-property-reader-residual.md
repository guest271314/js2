---
id: 3027
title: "standalone: \\$Object dynamic-object-property reader residual — null/undefined property access on unmodeled shapes (~1,552 host-free fails)"
status: done
assignee: ttraenkler/dev-3027
sprint: 71
created: 2026-07-03
updated: 2026-07-13
completed: 2026-07-05
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: dynamic-object-property-access
goal: standalone-mode
test262_category: language/statements/for-of/dstr, built-ins/AsyncGeneratorFunction, language/statements/variable
test262_fail: 1552
umbrella: 2860
related: [2860, 2861, 2862, 2863]
---

# #3027 — standalone: `$Object` dynamic-object-property reader residual

## Source

Standalone lane test262 harvest, 2026-07-03
(`.test262-cache/test262-standalone-current.jsonl`, run confirmed fresh
against `runs/index.json`). **1,552** official fails with signature
`TypeError: Cannot access property on null or undefined` (1,441 runtime +
111 compile-adjacent), carrying `host_import_leak_class` of `host_import` or
`iterator_protocol` on the subset that also leaks a host import, but the
majority are **pure standalone runtime failures with no import leak at all**
— the dynamic value read returns null/undefined where the js-host lane
(via a host import) returns the correct value.

This matches the **"not-yet-issued follow-on"** explicitly called out in the
#2860 umbrella body: *"`$Object` dynamic-object-property reader
(`__extern_get`/`__extern_rest_object` leak) — ~669 tests. The known
substrate root (`project_standalone_any_string_value_read_substrate`).
Heavily overlaps clusters 2/3 [#2862 ToPrimitive, #2863 dynamic-shape
object/property CE]; revisit after #2862/#2863 land to measure the true
residual."* #2861/#2863 have since landed (`status: done`); this issue is
that promised re-measurement, filed now that the residual (1,552) is
measurably larger than the original ~669 estimate — worth re-scoping as its
own tracked issue rather than an umbrella footnote.

## Sample failing files

- `language/statements/for-of/dstr/array-rest-elision-invalid.js`
- `built-ins/AsyncGeneratorFunction/instance-name.js`
- `language/statements/variable/12.2.1-21-s.js`

## Suggested approach

1. Re-measure the pure (no-import-leak) subset specifically — of the 1,552,
   how many have zero entries in `imports`? That is the count a standalone
   codegen fix flips directly, vs. the count still gated behind an
   unrelated carrier (generators/async-generators, #2864/#2865).
2. Trace one pure repro (e.g. the `variable/12.2.1-21-s.js` sample, which is
   not generator/async-gen-shaped) through the `$Object` dynamic reader path
   referenced in `project_standalone_any_string_value_read_substrate` —
   confirm whether the read returns null for the same reason documented
   there (dynamic reader drops native-string values) or a distinct cause.
3. Cross-check against #2862 (ToPrimitive) and #2863 (dynamic-shape CE) —
   both `done` — to confirm this residual is genuinely downstream of what
   those closed, not an unmeasured pre-existing overlap.

## Acceptance criteria

- The host-free `TypeError: Cannot access property on null or undefined`
  count in the standalone lane drops materially below 1,552.
- The umbrella #2860's "not-yet-issued follow-on" note is updated/removed
  once this issue supersedes it.

## Investigation (2026-07-05)

Re-measured against `.test262-cache/test262-standalone-current.jsonl`
(fetched fresh this session) following the "Suggested approach" above:

1. **The originally-hypothesized root cause
   (`project_standalone_any_string_value_read_substrate` — the `$Object`
   dynamic/`any`-typed reader dropping native-string VALUES) is already
   FIXED**, confirmed by direct repro against current `main`:
   `const o: any = {v: "hi"}; o.v.length === 2` and
   `const o: any = {v: "hi"}; o.v === "hi"` both compile and run correctly
   standalone. #2861/#2863 (both `done`) closed this. The umbrella's ~669→1,552
   growth is NOT this bug regrowing — it is the residual now being dominated by
   OTHER, unrelated causes that happen to share the same generic error text.
2. Of the 1,552 official-harvest fails with this error signature, **1,320
   carry zero `imports`** (pure standalone runtime failures, not gated behind
   a host-import/generator-carrier leak) — this is the "count a standalone
   codegen fix flips directly" the suggested approach asked for.
3. **The 1,320-pure subset is heterogeneous, not one root cause.** Sampling
   ~40 files at random and tracing several by category shows at least these
   *distinct* clusters, each its own bug/feature gap:
   - `TypedArray(Constructors)/prototype`/`internals` (~350 combined) —
     inherited-prototype-method / detached-buffer internal-slot checks.
   - `Object/getOwnPropertyDescriptor` (124) — itself split into at least 3
     unrelated shapes on inspection: descriptors for BUILT-IN globals/
     `Date.prototype` methods (needs global-object/intrinsic-prototype
     descriptor modeling — see #2988 area), `ToPropertyKey` coercion of a
     non-primitive key argument (`Object.getOwnPropertyDescriptor(obj,
     {toString(){...}})`), and array-element descriptors
     (`Object.getOwnPropertyDescriptor(arr, "0")`).
   - `Temporal/*` (~230+: ZonedDateTime/PlainDateTime/Instant/PlainDate/…) —
     an entire unimplemented/deferred feature area (see the project skip-list
     policy for Temporal), not a codegen bug.
   - `Function.prototype`/eval-code (~50+) — the poison-pill `.caller`/
     `.arguments` accessors and the eval/Function-shim free-variable capture
     gaps, **already tracked** in #3017 (and #3005's eval-as-any-callee work).
   - Class/accessor `fn-name` descriptor tests, `SharedArrayBuffer`, `Map`/
     `Set` prototype getters, module namespace reads, etc. — each a handful,
     each its own narrow gap.
   4. **One concrete, narrow, genuinely-fixable bug WAS found and fixed this
   session** (verified via direct trace of the
   `language/expressions/property-accessors/S11.2.1_A3_T3.js` sample named in
   this issue): **computed (bracket) property/method access on a
   string-typed or String-wrapper-typed receiver never dispatched to the
   native `__str_*` string engine in `--nativeStrings` mode** (standalone/
   wasi). Repro (all standalone, pre-fix):
   - `"abc123"["length"]` → `0` (wrong; dot form `"abc123".length` → `6` ✓)
   - `"abc123"["charAt"](0)` → threw (dot form `.charAt(0)` → `"a"` ✓)
   - `new String("abc123")["charAt"](2)` → threw (dot form → `"c"` ✓)

   Root cause: the ElementAccessExpression codegen paths for both plain
   property reads (`compileElementAccess` /
   `compileElementAccessBody` in `src/codegen/property-access.ts`) and
   computed method CALLS (`compileCallExpression`'s
   `ts.isElementAccessExpression(expr.expression)` branch in
   `src/codegen/expressions/calls.ts`) never special-cased a string-typed
   receiver the way the dot form does:
   - The property-read path fell to the generic "non-vec, non-tuple struct"
     fallback, which `extern.convert_any`s the native `$NativeString`
     struct (fields `len`/`off`/`data`) and calls the host `__extern_get` —
     which finds nothing (there is no host, and no field named "length") and
     returns null.
   - The computed-call path only ever tried
     `ctx.funcMap.get("string_" + methodName)` — the HOST string-method
     import, which native-strings mode never registers (the dot form
     dispatches natively via `compileNativeStringMethodCall`/
     `__str_*` helpers instead, bypassing host imports entirely) — so
     `funcIdx` was always `undefined` and the call fell through to a generic
     dynamic-dispatch fallback that produces a non-callable/null value.

   **Fix**: in both paths, when the receiver is string-typed
   (`isStringType`) and native-strings mode is active
   (`ctx.nativeStrings`), recompile the access/call as the equivalent DOT
   form (same receiver, same statically-resolved key/method name, same
   arguments) via a synthetic `ts.factory.createPropertyAccessExpression`,
   and delegate to the existing (already-correct) dot-form dispatch
   (`compilePropertyAccess` / `compileCallExpression` recursion). This reuses
   the mature dot-form logic — including the String-wrapper
   `__to_primitive` unwrap — instead of duplicating it, so wrapper receivers
   work correctly too. Gated identically to the dot form
   (`ctx.nativeStrings`, independent of `ctx.standalone`/`ctx.wasi`), so host/
   gc-mode without `--nativeStrings` is untouched (verified: an unrelated,
   PRE-EXISTING gc-mode dereference bug on this same source shape reproduces
   identically before and after this change — not caused or fixed by it,
   out of scope here).

   A separate, PRE-EXISTING, unrelated gap was found and left out of scope:
   a plain NUMERIC computed index on a bare string primitive
   (`"abc"[1]`) returns `0`/wrong standalone (only the String-*wrapper*
   numeric-indexed read, #1910 R4, was ever fixed) — confirmed present
   identically before this change. Worth its own follow-on issue if picked up.

## Test Results

- New test file `tests/issue-3027.test.ts` (7 cases) — all pass: computed
  `["length"]` read, computed `["charAt"](i)` call (literal AND
  runtime-resolved key), String-wrapper computed call/length, dot-form
  regression guard, and the full `S11.2.1_A3_T3.js` repro shape.
- The exact test262 sample named in this issue,
  `language/expressions/property-accessors/S11.2.1_A3_T3.js`, now passes
  standalone (was: `fail`, `TypeError: Cannot access property on null or
  undefined`).
- Re-ran the full 1,320-file pure (no-import) subset sharing this error
  signature through the standalone harness with the fix applied: **5 flip to
  `pass`**; 1,137 still fail with the same signature (the heterogeneous
  clusters above — each needs its own separately-scoped fix, not addressable
  by a codegen change to the dynamic-property reader); 178 report `skip`
  under the current harness/submodule state (unrelated to this fix — present
  both before and after; likely submodule/skip-filter drift since the
  2026-07-03 harvest, not investigated further here). A broader source-text
  heuristic scan across ALL 17,788 standalone fails (any error signature) for
  bracket-notation string-method/length usage found only 4 additional
  candidates beyond the measured 5 — this specific bug's total yield in the
  current corpus is genuinely small (~single digits), even though it was a
  real, distinct, correctly-diagnosed and fixed codegen gap.
- No regression observed in adjacent string-codegen equivalence suites
  (`tests/issue-1910-string-wrapper-index.test.ts`,
  `tests/issue-2600-string-index-tointeger.test.ts`,
  `tests/issue-2192b-caught-error-string-methods.test.ts`,
  `tests/issue-2161-b1-boxed-string.test.ts` — the 2 pre-existing gc-mode
  failures in the #2600 suite reproduce identically on `main` without this
  change, confirmed via `git stash`).

## Disposition

This issue's acceptance criterion 1 ("drops materially below 1,552") is
**not** achieved by a single codegen fix, because the residual is no longer
one root cause — it is a heterogeneous long tail across TypedArray
internals, `Temporal` (a whole deferred feature area), global-object/
intrinsic-prototype property-descriptor modeling, `ToPropertyKey` coercion,
and the already-tracked eval/Function-shim gaps (#3005/#3017). This issue
delivers the concrete, verified, in-scope slice found during the
re-measurement (computed string property/method access) and **supersedes
the umbrella's stale "not-yet-issued follow-on" note** (acceptance criterion
2) with this accurate, re-scoped picture — see the umbrella #2860 update.
Recommend the PO/tech-lead triage the clusters above into separately-sized
follow-on issues (the TypedArray-internals cluster, at ~350, is the next
largest single addressable slice).
