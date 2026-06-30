---
id: 2860
title: "Umbrella: close the standalone-vs-js-host test262 gap (9,177 tests)"
status: ready
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
task_type: epic
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2861, 2862, 2863, 2864, 2865, 2866, 2867, 2868]
---

# Umbrella: close the standalone-vs-js-host test262 gap

## The gap

js-host passes **33,032 / 43,135** official tests; `--target standalone`
passes **24,656**. The **standalone-only failure set** (tests that PASS in
js-host but FAIL or compile-error in standalone) is **9,177 tests**.

Measured 2026-06-30 from the two lane baselines in `loopdive/js2wasm-baselines`
(`test262-current.jsonl` vs `test262-standalone-current.jsonl`, official-scope,
matched by file+strict). Method: `host.status==pass AND standalone.status!=pass`.
The standalone baseline tags each row with `host_import_leak_class` and the
leaked `imports` set, which drives the clustering below.

By standalone status: **5,989 fail, 3,187 compile_error, 1 timeout.**

## Clusters (by root cause → est. tests → issue)

Counts are **overlapping** for the cross-cutting substrate signatures (a test
can leak a host import AND fail at ToPrimitive); the "pure" column is the count
where that cluster is the sole blocker (no host-import leak), i.e. the count a
single fix flips directly.

| # | Cluster | total | pure | tractability | issue |
| - | ------- | ----- | ---- | ------------ | ----- |
| 1 | built-in static/proto value read refused (CE) | 882 | 882 | mechanical (glue pattern) | **2861** |
| 2 | ToPrimitive over built-in exotics + inherited valueOf/toString | 2,039 | 728 | medium (extend `__to_primitive`) | **2862** |
| 3 | dynamic-shape object/property codegen (`__get_builtin`, `__extern_toLocaleString`) CE | 365 | 365 | medium codegen | **2863** |
| 4 | sync generators — no standalone carrier (`__gen_*`/`__create_generator`) | 697 | — | hard (new carrier) | **2864** |
| 5 | async generators — no standalone carrier (`__create_async_generator`) | 986 | — | hard (dep #2864) | **2865** |
| 6 | Symbol — standalone carrier (`__box_symbol`) | 418 | — | medium-hard | **2866** |
| 7 | Promise / async microtask — standalone carrier (`Promise_*`, `__make_callback`) | 375 | — | hard | **2867** |
| 8 | invalid Wasm binary emitted in standalone (correctness) | 523 | 118 | triage-then-fix | **2868** |

### Not-yet-issued follow-ons (tracked here)

- **$Object dynamic-object-property reader** (`__extern_get`/`__extern_rest_object`
  leak) — ~669 tests. The known substrate root
  (`project_standalone_any_string_value_read_substrate`). Heavily overlaps
  clusters 2/3; revisit after #2862/#2863 land to measure the true residual.
- **spread / `Array.from(iter, n)`** (`__array_from_iter_n`) — ~321 tests.
  Depends on the iterator-protocol carrier (#2864).
- **Namespace static reads** (`Math.PI`, `JSON.stringify`, `Reflect.get`,
  `Atomics.add`) — ~120 tests. Split out of #2861 (different mechanism: not
  `.prototype` proto-glue).
- **illegal cast** — 1,177 total but only ~102 pure; the rest are inside the
  generator/iterator machinery and clear when #2864/#2865 land. The ~102 pure
  ref.test-before-cast misses fold into #2863/#2868 triage.
- **null deref in `__str_flatten`/RegExp** — ~185, mostly `String.prototype.split`
  with a RegExp arg + RegExp character-class escapes; standalone-native string/regex
  bug. File separately if it doesn't clear with #2863.

## Sequencing

1. **#2861** (mechanical, ~882, start now) — dev-standalone.
2. **#2862** ToPrimitive (architect_spec) + **#2863** dynamic-shape — these two
   substrate fixes likely also drop a chunk of the "leak" buckets' proximate
   failures. Re-measure the gap after they land.
3. **#2868** invalid-wasm (correctness — broken binaries are worst-class).
4. Carriers **#2866** (Symbol), **#2864→#2865** (generators, epic), **#2867**
   (Promise) — biggest but architecture-scale; #2864/#2865 are the largest
   single lever (1,683 combined) and warrant an architect design pass.

## Definition of done (umbrella)

Standalone official_pass climbs from 24,656 toward the 33,032 host figure.
Each child issue's test plan = its cluster's standalone-CE/fail tests flip to
pass under full `merge_group` + the standalone high-water floor
(`check-standalone-highwater.mjs`), with zero host-mode regression (all changes
`ctx.standalone`-gated).
