---
id: 3137
title: "Standalone: native Promise.allSettled / Promise.any combinators — clears the 99-file vacuous native-into-host boundary class + compounds the #2903 de-leak"
status: in-progress
assignee: ttraenkler/fable-harvest1
sprint: current
created: 2026-07-11
updated: 2026-07-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: promises, combinators, aggregate-error
goal: standalone
umbrella: 2860
related: [2860, 2919, 2867, 2980, 2903, 3036]
depends_on: [2903]
origin: "2026-07-11 post-#2980-flip built-ins/Promise standalone harvest (fable-harvest1) — measured from the 2026-07-10 post-flip standalone baseline @ main 34e3812"
---

# #3137 — native `Promise.allSettled` / `Promise.any` (standalone)

## Problem (measured, post-flip standalone baseline 2026-07-10)

`Promise.all`/`race` are native since #2919/#2867-Gap-4, but `allSettled`/
`any` still lower to the **host imports** `Promise_allSettled`/`Promise_any`.
Post-#2980-flip every promise a standalone module mints is a **native
`$Promise` struct** — opaque to the host combinator (no host-side `.then`),
so the aggregate promise **never settles**:

- **~99 `built-ins/Promise` fails are `vacuous`** (harness callback never
  ran), almost all in `allSettled/**` + `any/**` — the native-into-host
  boundary class. This class is **standalone-specific** (js-host passes these
  shapes) — unlike the shared capability-protocol fails.
- Standalone dir counts: `allSettled` 83 fail / 21 pass (15 leaky) / 6 CE;
  `any` 81 fail / 10 pass (5 leaky) / 3 CE.
- js-host ceiling (same dirs): `allSettled` 37/110, `any` 21/94 — the
  shared-protocol fails (capability/resolve-element fidelity, the 69-file
  "Promise resolve or reject function is not callable" cluster) are **NOT
  claimed by this issue**.
- `Promise.allSettled`/`Promise.any` syntactic presence also **flags the
  whole module as a host-promise source** under #2903's de-leak gate, so
  every `.then` bridge in such modules keeps its host arm. Landing native
  combinators removes them from the producer sets — a compounding de-leak.

**Realistic target: ≈ +60–120 standalone `host_free_pass`** (vacuous class
flips + leaky passes de-leaked + standalone pass counts converging toward the
host-lane ceiling), zero gc/host movement.

## Design (extend the #2919 machinery, `src/codegen/promise-combinators.ts`)

The module is cleanly factored (subscribe / per-combinator fulfill / reject
builders over a shared count-down runtime). Extension:

1. **`allSettled`** (§27.2.4.2): like `all`, but each element's reactions are
   settle-wrappers that write a **status object** into the results vec —
   `{ status: "fulfilled", value }` / `{ status: "rejected", reason }`
   (plain `$Object` via the `__new_plain_object` runtime) — and the aggregate
   **never rejects**; the remaining-count decrement fires on BOTH arms.
2. **`any`** (§27.2.4.3): mirror of `all` with roles swapped — first
   fulfillment resolves the aggregate; each rejection stores its reason into
   an errors vec and decrements; count reaching zero rejects with a native
   **`AggregateError`** (`errors` array own property, §20.5.7.1 — reuse the
   `emitWasiErrorConstructor` family / `$Error_struct` brand machinery; check
   what `AggregateError` support already exists before inventing).
3. **Routing**: add both to `isNativeCombinatorMethod` +
   `emitStandalonePromiseCombinator`; skip the upfront
   `Promise_allSettled`/`Promise_any` registration in the
   `collectPromiseImports` finalize under `isStandalonePromiseActive` (the
   exact #2867-Gap-4 pattern used for `all`/`race`).
4. **Compounding de-leak (#2903)**: remove `allSettled`/`any` from
   `HOST_PROMISE_SOURCE_METHOD_NAMES` (declarations.ts) — they no longer mint
   host promises. `allKeyed`/`allSettledKeyed`/`fromAsync`/`finally`/subclass
   `all`/`race` stay flagged.
5. **Lanes**: gc/host byte-identical (all changes behind
   `isStandalonePromiseActive`); wasi inherits the native path (it already
   takes native `all`/`race`).

## Acceptance criteria

- The vacuous `allSettled/**` + `any/**` standalone class drops materially
  (target: standalone dir pass counts ≥ the js-host ceiling shapes that are
  not capability-protocol-blocked), measured via `runTest262File` over both
  dirs before/after.
- Modules using `allSettled`/`any` (and nothing else host-routed) become
  **host-free** (instantiate with `{}`), compounding the #2903 gate.
- `prove-emit-identity`: gc lane byte-identical; existing native `all`/`race`
  suites + `tests/issue-2903.test.ts` (updated: the allSettled producer
  control flips to host-free) stay green.
- Zero regressions on the 662/217-file #2903 measure sets.

## Notes

- Stacked on `issue-2903-then-chain-deleak` (PR #2877, in queue) — same
  producer-set files; enqueue only after #2877 lands.
- The 69-file capability cluster ("Promise resolve or reject function is not
  callable", custom-capability `Promise.all.call(C, …)` shapes) is a separate
  mechanism (#2671's standalone twin) — file separately if it survives this.
