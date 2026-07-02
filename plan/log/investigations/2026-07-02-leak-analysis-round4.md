# Leak-analysis round 4 — post-batch sole-import levers (2026-07-02)

**Task:** session task #20 (dev-f1). **Source artifact:** freshest `merge_group`
`test262-merged-report` (run 28561440342, 2026-07-02T02:37Z, both-lane jsonl),
recomputed raw per the round-1..3 method (`host_free_pass` = `status == "pass"`
AND zero `env::` imports).

## Headline numbers

| scope                           | standalone n | pass   | **host_free_pass** | leaky_pass | js-host pass | honest gap |
| ------------------------------- | ------------ | ------ | ------------------ | ---------- | ------------ | ---------- |
| ALL records                     | 48,088       | 27,017 | 18,375             | 8,642      | 34,774       | 16,399     |
| **OFFICIAL** (`scope_official`) | 43,106       | 25,877 | **18,024**         | 7,853      | 33,283       | **15,259** |

Gap decomposition (official): 7,853 leaky passes + 7,406 standalone-fail/CE
where js-host passes. Official sole-leak passes (exactly one distinct `env::`
import): **1,426**.

## Top sole-import levers (official scope, excl. `__extern_eval` 326 / `__dynamic_import` 80)

| lever                                                              | sole    | where                                                                           | inject-throw verdict                                                                                                                    |
| ------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `env::__make_callback`                                             | **660** | TypedArray/prototype 351, TypedArrayConstructors/internals 110, ctors-bigint 73 | **VACUOUS** (probe: `TypedArray/prototype/reduce/BigInt/callbackfn-this.js` still passes with `throw` injected in the wrapper callback) |
| `env::__get_globalThis`                                            | **46**  | Array/prototype, annexB emulates-undefined, Proxy/defineProperty                | **GENUINE** (inject → fail)                                                                                                             |
| `env::WeakMap_set`                                                 | 34      | TypedArray/prototype/set                                                        | **VACUOUS** (same wrapper class)                                                                                                        |
| `env::SharedArrayBuffer_new`                                       | 27      | TypedArrayConstructors/ctors buffer-arg                                         | **VACUOUS** (same wrapper class)                                                                                                        |
| `env::__instanceof_check`                                          | **17**  | language/expressions/instanceof legacy S15.x                                    | **GENUINE** (inject → fail)                                                                                                             |
| `env::Uint8ClampedArray_{some,join,forEach,sort,toSorted,reverse}` | ~48     | TypedArray/prototype + Array/prototype                                          | **VACUOUS** (probe: TypedArray/join)                                                                                                    |
| `env::Promise_new`                                                 | 14      | module-code/top-level-await syntax                                              | not probed (TLA is a skip-class adjacent lane)                                                                                          |
| `env::Object_isPrototypeOf`                                        | 12      | scattered legacy                                                                | not probed                                                                                                                              |
| `env::__array_from_iter` / `env::__iterator`                       | 10 / 9  | class-elements / iterator-proto                                                 | not probed                                                                                                                              |
| `env::CanvasRenderingContext2D_fill` (sic)                         | 8       | TypedArray/prototype/fill                                                       | same wrapper class (receiver-name misclassification of `.fill` dispatch)                                                                |

## The big finding: the #1 "lever" is an EXECUTION lever, not a leak lever

**≈814 of the 1,426 official sole-leak passes (57%)** are the
`testWith[BigInt]TypedArrayConstructors(function(TA){...})` wrapper class
(`__make_callback` 660 + `WeakMap_set` 34 + `SharedArrayBuffer_new` 27 +
`Uint8ClampedArray_*` ~48 + `CanvasRenderingContext2D_fill` 8 + tail), and
inject-throw probes confirm the wrapper callbacks are **still dead on current
main** (post #2923/#2441): removing these imports without making the callbacks
execute would dishonestly inflate `host_free_pass` by ~814 (memory:
`project_hostfree_pass_can_be_vacuous_inject_throw_probe`). The honest lever is
the in-flight execution lane — session task #16 (BigInt-ctor runner shim +
re-measure #2923 flips, dev-f2) + the ctor-iteration harness execution work.
Once the callbacks RUN, these tests convert to genuine pass/fail on their own
merits (many will need the TypedArray semantics they assert).

## Honest top-5 next levers (post-batch)

1. **Execute the TypedArray-wrapper callbacks** (≈814 sole + a long multi-import
   tail; task #16 / #2921 / #2923 lane) — largest honest conversion, but yields
   genuine passes only where the asserted semantics already work.
2. **Async/generator/Promise substrate lanes** (multi-import, official touch):
   `__get_caught_exception` 6,105 · `__gen_create_buffer` 4,858 · `__gen_next`
   3,957 · `Promise_reject/resolve/then2` ≈3,150 each. Sole counts ~0 — these
   ride the in-flight XL lanes (#2938 no-yield generators, #2922 combinators,
   async widen). No new issue needed; this is where the leaky mass is.
3. **`__get_globalThis` native lowering** (46 sole, GENUINE) — a `globalThis`
   value/identity substrate for standalone (annexB emulates-undefined +
   global-code clusters). Small-M issue candidate.
4. **`__instanceof_check` residual** (17 sole, GENUINE) — legacy S15.x
   instanceof shapes still routing to the host predicate; native
   `instanceof` exists, so this is a routing/coverage gap. S issue candidate.
5. **Iterator-protocol tail** (`__array_from_iter` 10 + `__iterator` 9, plus
   `Object_get_constructor` 9 / `Object_set_constructor` 5 / `__new_Object` 5 /
   `__new_RegExp` 4) — small genuine-looking tails; probe before filing.

**Not levers:** `__extern_eval` (326) and `__dynamic_import` (80) are
skip-class (eval / dynamic code); excluded per task mandate.

## Method / repro

- Artifact: `gh api repos/loopdive/js2/actions/artifacts/8027633662/zip`
- Recompute + ranking: `.tmp/leak-analysis.py`, `.tmp/leak-analysis2.py`
  (worktree-local, gitignored; logic inline in this note's tables)
- Vacuity probes: `.tmp/probe-vacuity.mts` — control + injected copies run
  through the real `runTest262File(..., "standalone")` from a scratch dir
  inside the test262 tree (cleaned up after).
