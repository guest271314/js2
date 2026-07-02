# Leak-analysis round 6 — vacuity scorer landed, sole-lever budget re-baselined, #2963 unlock check (2026-07-03)

**Task:** round-6 measurement (fresh session, dev), same method as round-5
(`plan/log/investigations/2026-07-02-leak-analysis-round5.md`). **Source
artifact:** freshest successful `merge_group` `test262-merged-report` — run
**28624020153** (2026-07-02T21:54Z, speculative head **`0585f3179`** =
current main `bf0117117` + PR #2554 async scheduler). Recomputed `host_free_pass`
raw from records (`status == "pass"` AND zero `env::` imports); re-ran
inject-throw execution proofs against current main; applied the
**swap-wrong-value** check (memory
`project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`) to the
`.constructor` cluster, not just inject-throw.

## Two structural changes since round-5

1. **The vacuity scorer #2463 (PR, round-5's headline caveat) LANDED**
   (`0670ea46c`, `bf0117117` on main). The merged report now carries a
   `vacuous` field: **1,433 standalone / 1,496 js-host** records flagged
   `vacuous:true` and forced to `status:"fail"` in **both lanes**. Of the 1,433
   standalone, **790 are now host-free** (the BigInt-TA runner shim removed their
   imports) — but because the scorer scores them `fail`, they are correctly
   **excluded from `host_free_pass`**. Round-5's caveat ("18,586 is honest only
   because the TA cluster is still leaky on main; shipping the shim without the
   scorer would dishonestly inflate to ~20,019") is now **structurally resolved**
   — the metric can no longer be gamed by removing imports without executing.
2. **#2963 Phase 1 has NOT merged** — it is **OPEN as PR #2555**
   (`feat(codegen): #2963 Phase 1 — identity-stable reified builtin static-method
values`). The task brief said it "landed today"; on main (`bf0117117`) it is
   not present (`git merge-base --is-ancestor a9f829881 origin/main` → false).
   So its mechanism is available to _design against_ but is not yet reflected in
   any host-free count. (Also still open: **PR #2537 / #2999**, the
   `Object_get_constructor` null-fold.)

## Headline numbers (current, run 28624020153)

| scope        | standalone n | pass   | **host_free_pass** | leaky_pass | js-host pass | honest gap |
| ------------ | ------------ | ------ | ------------------ | ---------- | ------------ | ---------- |
| ALL          | 48,118       | 26,209 | 18,529             | 7,680      | 33,316       | 14,787     |
| **OFFICIAL** | 43,136       | 25,069 | **18,178**         | 6,891      | 31,825       | **13,647** |

**Movement vs round-5 (official):** `host_free_pass` 18,586 → **18,178 (−408)**;
js-host pass 33,333 → **31,825 (−1,508)**; leaky_pass 7,921 → **6,891 (−1,030)**;
honest gap 14,747 → **13,647 (−1,100)**; sole-leak passes 1,440 → **700 (−740)**.

**Read these deltas as an HONESTY correction, not regression or convertible
progress.** The vacuity scorer reclassified ~1,433 vacuous passes to `fail` in
both lanes — that is the dominant driver of the −1,508 js-host and −740 sole
drops. The gap shrank because the js-host numerator lost its dishonest vacuous
passes, not because standalone converted leaks. The −408 in `host_free_pass` is
within run-to-run flux between the two speculative heads (round-5 `cab9680` vs
round-6 `0585f3179`; different PR stacks) — none of the 790 host-free-vacuous
were in round-5's hfp (they still had imports on `cab9680`), so they don't
explain it; no single-cluster regression is visible.

Official gap decomposition: 6,891 leaky passes + 6,756 standalone-fail/CE where
js-host passes. Official **sole-leak** passes (exactly one distinct `env::`
import): **700** (down from 1,440 — the ≈817 vacuous TA-wrapper cluster is now
scored `fail` and no longer appears as leaky sole passes).

## Sole-import lever ranking (official leaky passes) + verdicts

Probe = inject `throw new Error('VACUITY_RAN')` before the first executing
assert/verify/if, run standalone via `runTest262File(..., "standalone")` on
current main. VACUOUS = injected copy still passes; GENUINE = injected copy
fails. **Note:** `runTest262File`'s result object carries no `imports` field —
import data is authoritative only from the merged-report jsonl. The runner is
used solely for pass/fail execution proofs.

| lever                                 | sole   | verdict (this session, main)                 | class                                                                      |
| ------------------------------------- | ------ | -------------------------------------------- | -------------------------------------------------------------------------- |
| `env::__extern_eval`                  | 316    | — (SKIP-CLASS: eval)                         | excluded                                                                   |
| `env::__dynamic_import`               | 80     | — (SKIP-CLASS: dynamic import)               | excluded                                                                   |
| `env::__make_callback`                | **59** | **GENUINE** (Iterator/reduce probed)         | genuine builtin-method closure-arg dispatch (NOT the old TA-vacuous class) |
| `env::__get_globalThis`               | **47** | **GENUINE**                                  | globalThis substrate                                                       |
| `env::Promise_new`                    | 17     | mixed (~5 genuine, rest TLA-syntax adjacent) | Object.seal/Promise                                                        |
| `env::__instanceof_check`             | **13** | **GENUINE** (S15.3.5.3 probed)               | legacy instanceof routing                                                  |
| `env::Object_isPrototypeOf`           | **12** | **GENUINE** (S15.7.3_A7 probed)              | native isPrototypeOf                                                       |
| `env::__array_from_iter`              | 10     | **GENUINE**                                  | iterator-protocol (dstr-from-iterable)                                     |
| `env::__iterator`                     | 9      | **GENUINE**                                  | iterator-protocol (entries/values)                                         |
| `env::Object_get_constructor`         | **9**  | **executes but COINCIDENTAL-value** (below)  | `.constructor` identity — needs reification                                |
| `env::Uint8ClampedArray_forEach/some` | **16** | **GENUINE** (Array/forEach 8-5 probed)       | Array.prototype.forEach (misnamed import)                                  |
| `env::DisposableStack_new`            | 7      | (ERM feature, not a sole-lever)              | explicit-resource-mgmt                                                     |
| `env::__call_1_f64`                   | 6      | **GENUINE**                                  | Array predicate-method routing                                             |
| `env::SharedArrayBuffer_new`          | 6      | (shrunk from 27; residual TA-adjacent)       | net-near-zero                                                              |
| `env::AsyncDisposableStack_new`       | 5      | (ERM feature)                                | explicit-resource-mgmt                                                     |
| `env::__new_Object`                   | 5      | **GENUINE**                                  | subclass-of-builtin Object                                                 |
| `env::Object_set_constructor`         | 5      | COINCIDENTAL (paired w/ get_constructor)     | `.constructor` set — needs reification                                     |

**Honest convertible sole-lever budget:** 700 total − 396 skip-class
(`__extern_eval` + `__dynamic_import`) − ~12 ERM (DisposableStack/AsyncDisposableStack,
whole-feature not a lever) − 14 coincidental-constructor (get+set, need #2963
reification, NOT the null-fold) ≈ **~278 genuine, execution-verified, convertible
sole passes.** Same order as round-5's ~227 but now the count is _clean_ — the
vacuous TA cluster is structurally excluded by the scorer, so no vacuity caveat
sits on top of the number this round.

## Object_get_constructor: still COINCIDENTAL — and #2963 is the genuine fix

The 9 `env::Object_get_constructor` sole passes are all
`<Builtin>.prototype.constructor === <Builtin>` shapes (WeakRef / Set / WeakMap /
WeakSet / RegExp / FinalizationRegistry / DisposableStack / SuppressedError).
They **execute** (inject-throw would not catch them) but the _value_ is wrong:
PR #2537's proposed fix folds `.constructor` on a builtin receiver to
`ref.null.extern` — the same nullish carrier a bare builtin identifier compiles
to standalone — so `X.prototype.constructor === X` passes **tautologically**
(null === null). PR #2537's own doc records the swap-wrong-value proof:
`assert.sameValue(Set.prototype.constructor, Map)` _also_ passes. This is the
coincidental-wrongness class (memory
`project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`), not a
genuine conversion.

**#2963's mechanism IS the genuine unlock for this cluster.** Phase 1
(`src/codegen/builtin-fn-meta.ts::pushBuiltinFnSingletonValueInstrs`) introduces
one `(ref null <metaType>)` **mutable global per (builtin, member)**, lazily
materialized once behind an `if (ref.is_null) { struct.new; global.set }` guard
in the function body — giving builtin static-method values **real, per-builtin
object identity** (`Array.isArray === Array.isArray` → 1; the swap guard
`Array.isArray === Object.keys` → 0). That singleton substrate generalizes
directly to reified builtin **constructor** objects:

- reify each builtin constructor (`WeakRef`, `Set`, …) as an identity-stable
  singleton via the same per-builtin mutable global;
- route BOTH the bare-identifier read (`WeakRef`) AND the `.constructor` property
  read on a builtin receiver to that **same** singleton.

Then `WeakRef.prototype.constructor === WeakRef` holds _genuinely_ AND the
swap-wrong-value guard `WeakRef.prototype.constructor === WeakMap` genuinely
**fails** — not a coincidental null==null. This converts the
`Object_get_constructor` (9) + `Object_set_constructor` (5) clusters, and shares
substrate with `__new_Object` (5, subclass-of-builtin) — ~14–19 sole passes,
GENUINELY.

**Recommendation to lead:** do **NOT** merge PR #2537's null-fold — it banks a
coincidental pass that later has to be un-done. Instead extend #2963's singleton
mechanism to builtin constructors (a Phase-1.5 on PR #2555's substrate). #2963
Phase 2 is already blocked on the same any-callable scalar-param dispatch fix
that gates `__make_callback`; the constructor-reification extension is
independent of that dispatch blocker and could land on the Phase 1 substrate
first.

## Top GENUINE (execution-verified, non-coincidental) sole levers

1. **`__make_callback` residual — 59 sole (GENUINE).** No longer the TA-vacuous
   class (that's now scored `fail`). Now genuine builtin-method closure-arg
   dispatch: Iterator.prototype helpers (18), RegExp.prototype Symbol.replace (9),
   Array.prototype (8), Function.prototype.toString (6), Uint8Array (5). Converts
   with the any-callable scalar-param dispatch fix (#2939-adjacent). **Largest
   honest sole lever this round.**
2. **`__get_globalThis` native substrate — 47 sole (GENUINE).** annexB
   `emulates-undefined` (document.all), `global-code`, Array/prototype, Proxy.
   Needs a standalone `globalThis` value/identity object. **Small-M.**
3. **Iterator-protocol tail — ~19 sole (GENUINE):** `__array_from_iter` 10 +
   `__iterator` 9. Native iterator lowering. **S/M.**
4. **`Object_isPrototypeOf` 12 + `__instanceof_check` 13 (GENUINE):** native
   `isPrototypeOf` + legacy `instanceof/S15.x` routing. **S.**
5. **Array-method routing — `Uint8ClampedArray_forEach/some` 16 + `__call_1_f64`
   6 (GENUINE):** `Array.prototype.forEach`/predicate methods still routing to a
   host import though native methods exist (import name is a routing artifact).
   **S.**

## The real mass is still the multi-import async/gen/Promise substrate

Sole levers cap at ~278 honest passes. The leaky **mass** is multi-import,
by touch-count across official leaky passes (essentially unchanged from round-5):

| import                     | touch |
| -------------------------- | ----- |
| `__get_caught_exception`   | 6,155 |
| `__gen_create_buffer`      | 4,907 |
| `__make_callback` (multi)  | 3,992 |
| `__gen_next`               | 3,958 |
| `Promise_reject`           | 3,214 |
| `Promise_resolve`          | 3,200 |
| `Promise_then2`            | 3,146 |
| `__create_async_generator` | 2,936 |
| `__create_generator`       | 2,212 |
| `Promise_then`             | 2,064 |

Sole counts here ≈ 0 — these ride the in-flight XL generator/async/Promise
lanes. No new issue; this is where convertible leaky mass lives, converting in
bulk only as the generator/async/Promise substrate lands natively.

## Judgment calls flagged to lead

- **Metric is now structurally self-honest** — the vacuity scorer #2463 landed,
  so `host_free_pass = 18,178` (official) cannot be gamed by import-removal. No
  vacuity caveat sits on the number this round.
- **PR #2537 (`Object_get_constructor` null-fold) is OPEN — recommend NOT
  merging it.** It banks a coincidental (null==null) pass. Route the cluster
  through #2963's reification substrate (PR #2555) instead for a genuine fix
  that survives the swap-wrong-value check.
- **#2963 Phase 1 is PR #2555 (OPEN), not on main.** Prioritise landing it: it
  is the correct substrate for builtin object identity (constructor + static
  method), and a constructor-reification extension is independent of the
  any-callable dispatch blocker that gates its Phase 2.

## Method / repro

- Artifact: `gh run download 28624020153 -R loopdive/js2 -n test262-merged-report`
  (→ `test262-standalone-results-merged.jsonl` + `test262-results-merged.jsonl`).
- Recompute + ranking: worktree-local python over the jsonl (logic inline in
  this note's tables); `vacuous`/`scope_official` fields honored.
- Execution proofs: inject-throw copies through `runTest262File(file, cat,
30000, "standalone")` on main `0585f3179`; swap-wrong-value verdict on the
  `.constructor` cluster sourced from PR #2537's own cross-check +
  `src/codegen/builtin-fn-meta.ts` (`pushBuiltinFnSingletonValueInstrs`) on
  branch `issue-2963-builtin-reification` (PR #2555).
