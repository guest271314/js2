---
id: 2860
title: "Umbrella: close the standalone-vs-js-host test262 gap (~20,500 host-free, honest metric #2879/#2360)"
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
related: [2861, 2862, 2863, 2864, 2865, 2866, 2867, 2868, 2872, 2873, 2874, 2875, 2876, 2877, 2878, 2879]
---

# Umbrella: close the standalone-vs-js-host test262 gap

> **THE SPRINT FOCUS (stakeholder directive, 2026-06-30).** Closing the
> standalone-vs-js-host gap is the top priority for the current budget window.
> Every child issue here is `priority: high` + `sprint: current` and sorts to
> the TOP of the auto-synced TaskList. Non-standalone `sprint: current` work
> (acorn remnants #2850/#2853, IR-migration #2855–#2859, and the other ES/spec
> umbrellas #2669/#2803/#1042) is demoted to `priority: low` — kept claimable
> as tail-filler but sorting under the standalone work.

## The gap (honest metric, #2879 via #2360)

The metric was made **honest** in #2879/#2360: a standalone pass is only
credited when it is **host-free** (no leaked host imports), not when a leaky
binary is host-satisfied. On the honest metric:

- **js-host** passes **~34,052** official tests.
- **host-free standalone** passes **~12,883**.
- The honest **standalone gap is ~20,500 tests** — roughly double the earlier
  ~9,177 figure, which counted host-satisfied leaky passes as standalone wins.

The gap decomposes into two halves:

1. **The carriers (~architecture-scale half).** Whole language features that
   leak host imports because there is no Wasm-native carrier yet:
   generators **#2864** (697), async-generators **#2865** (986), Promise/
   microtask **#2867** (375), Symbol **#2866** (418). These are the biggest
   single lever and warrant an architect frame-substrate design pass.
2. **The substrate + de-masked real-failure clusters (the other half).** The
   dynamic-object substrate, the proto-glue / CE clusters (**#2861** remaining,
   **#2863**), and the de-masked real-failure clusters that surfaced once the
   metric stopped masking them behind #2862: TypedArray **#2872** (294),
   language/expressions **#2873** (276), String **#2875** (159), RegExp
   **#2876** (125), tooling/triage **#2877**, plus the invalid-Wasm residual
   **#2878**.

Measured 2026-06-30 from the two lane baselines in `loopdive/js2wasm-baselines`
(`test262-current.jsonl` vs `test262-standalone-current.jsonl`, official-scope,
matched by file+strict). The standalone baseline tags each row with
`host_import_leak_class` and the leaked `imports` set, which drives the
clustering below. (The legacy per-cluster counts in the table below are from
the pre-honest measure and are kept as the relative root-cause breakdown; the
absolute total is now ~20,500 per the honest metric.)

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

## Sequencing (carriers are the biggest lever)

**Carrier track (architecture-scale — the dominant lever, ~2,476 combined).**
The carriers share a common need: a Wasm-native suspendable-**frame substrate**
(the arch-frame design). Build that once, then layer the carriers on it:

1. **Frame substrate** — the suspendable activation-frame ABI shared by
   generators, async-generators and the Promise/microtask scheduler. Architect
   frame-substrate spec lives in **#2860 / #2864** (`architect_spec: candidate`).
2. **#2864** sync generator carrier (697) — first carrier on the frame; proves
   the substrate end-to-end.
3. **#2867** Promise / microtask carrier (375) — the microtask scheduler the
   async machinery needs; independent enough to land in parallel once the frame
   exists.
4. **#2865** async-generator / for-await carrier (986) — composes the generator
   frame (#2864) with the microtask scheduler (#2867); `depends_on: [2864, 2867]`.

**#2866** Symbol carrier (418) is independent of the frame substrate and can run
in parallel on its own track.

**Substrate + cluster track (runs in parallel with carriers).**

5. **#2861** built-in static/proto value-read glue (mechanical, ~882 remaining) —
   dev-standalone, start now.
6. **#2863** dynamic-shape `__get_builtin` / reflective read codegen.
7. **#2878** invalid-Wasm residual (`__str_flatten` + user-body shapes) — broken
   binaries are worst-class correctness; follows the #2868 URI-carrier fix.
8. De-masked real-failure clusters (surfaced once the honest metric stopped
   masking them behind #2862): **#2872** TypedArray (294), **#2873**
   language/expressions (276), **#2875** String (159), **#2876** RegExp (125).
9. **#2877** standalone exception message readability — tooling/triage enabler
   (lower lever; unblocks message-level triage of the residual).

**Done / blocked children (no longer queued):**

- **#2868** invalid-Wasm emission (URI/str_flatten carrier) — **done** (via #2350).
- **#2874** getOwnPropertyDescriptor numeric-key coercion — **done** (via #2354).
- **#2879** honest host-free metric — **done** (via #2360); this is what
  re-based the gap to ~20,500.
- **#2862** ToPrimitive over built-in exotics — **blocked** (superseded; the
  de-masked clusters #2872/#2873/#2875/#2876 carry the tractable residual).

## Definition of done (umbrella)

Standalone official_pass climbs from 24,656 toward the 33,032 host figure.
Each child issue's test plan = its cluster's standalone-CE/fail tests flip to
pass under full `merge_group` + the standalone high-water floor
(`check-standalone-highwater.mjs`), with zero host-mode regression (all changes
`ctx.standalone`-gated).
