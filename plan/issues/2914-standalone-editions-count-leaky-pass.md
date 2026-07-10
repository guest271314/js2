---
id: 2914
title: "Standalone per-edition pass rates count leaky (host-import) passes, diverging from the host-free headline/floor"
status: done
assignee: ttraenkler/fix2914
priority: medium
sprint: 69
created: 2026-07-01
completed: 2026-07-01
feasibility: medium
task_type: bug
area: tooling
goal: developer-experience
related: [2911, 2636, 2879, 2097]
---

# #2914 — Standalone editions JSON counts raw `pass`, not `host_free_pass`

Found during the #2911 test262-setup audit.

## Problem

The standalone lane has **two different definitions of "pass" in production at
the same time**:

- **Honest metric (headline + floor).** `scripts/build-test262-report.mjs:844`
  defines `hostFreePass = status === "pass" && !record.host_import_leak_class`
  and the `--target standalone` report headlines on `host_free_pass` (#2879).
  The #2097 absolute floor also keys on it —
  `scripts/check-standalone-highwater.mjs:28` reads
  `full_summary.host_free_pass`. This correctly *excludes* "leaky" passes (a
  standalone-compiled test that only passed because it still pulled a JS host
  `env::__*` import).

- **Leaky metric (per-edition landing slider).** Per #2636, the standalone
  per-edition file is produced by running the **host** classifier over the
  standalone JSONL: `scripts/run-pages-build.mjs:47-63` calls
  `generate-editions.ts --results …standalone-current.jsonl --output
  …test262-standalone-editions.json`. But `scripts/generate-editions.ts` counts
  raw `status === "pass"` (`normalizeStatus`, lines 457-461) and its
  `ResultRecord` type (lines 487-493) has **no** `host_import_leak_class` field —
  it has no notion of host-free at all.

So the landing page's standalone **donut/headline** shows the honest host-free
number while the standalone **ES-edition slider** shows a leaky-pass-inflated
number for each edition. The two disagree, and the per-edition standalone rates
are optimistic.

The edition *classifier* (es5id/es6id/features/path → edition) is shared and
fine — the divergence is purely in the **pass definition**.

## Fix direction

- Give `scripts/generate-editions.ts` a `--host-free` (or `--target standalone`)
  flag that, when set, counts a pass only when
  `status === "pass" && !record.host_import_leak_class` — mirroring
  `build-test262-report.mjs:844`. Wire it in the standalone invocation at
  `scripts/run-pages-build.mjs:55-59`.
- Verify the standalone JSONL rows actually carry `host_import_leak_class` (the
  worker emits it via `metadataFromWorkerResult`; confirm the fetched
  `test262-standalone-current.jsonl` preserves the field).
- Keep the host (`gc`) editions counting raw `pass` (host imports are expected
  there).

## Acceptance
- Standalone per-edition pass rates and the standalone headline both use
  `host_free_pass`; the landing-page slider and donut agree for the standalone
  toggle.

## Resolution (2026-07-01)

Implemented the `--host-free` flag (also triggered by `--target standalone`) in
`scripts/generate-editions.ts` and wired it into the standalone invocation in
`scripts/run-pages-build.mjs`.

**Changes:**
- `scripts/generate-editions.ts`
  - `ResultRecord` gains `host_import_leak_class?: string` (the field was already
    present in the standalone JSONL rows — confirmed 23,987/48,118 rows carry it).
  - New `resolveStatusKey(record, hostFree)` helper: in host-free mode a raw
    `status === "pass"` with a truthy `host_import_leak_class` is demoted to
    `fail` (kept in `total`, dropped from `pass`) — mirroring
    `build-test262-report.mjs:844` and `check-standalone-highwater.mjs`. All three
    counting sites (proposal bucket, edition bucket, category bucket) route
    through it.
  - `--host-free` / `--target standalone` arg parsing; default (host/`gc`) mode is
    unchanged and still counts raw `pass`.
- `scripts/run-pages-build.mjs` — the standalone `generate-editions.ts` invocation
  now passes `--host-free`.
- `website/public/benchmarks/results/test262-standalone-editions.json` regenerated
  with the honest counts.

**Verification (against the fetched standalone baseline JSONL):**

| metric                                   | before (raw) | after (host-free) |
| ---------------------------------------- | ------------ | ----------------- |
| Σ edition `pass` (standalone slider)     | 25,292       | **12,615**        |
| donut/floor `host_free_pass`             | 12,615       | 12,615            |
| leaky passes demoted (pass w/ host leak) | —            | 12,677            |

The standalone slider total now **exactly equals** the donut/floor
`host_free_pass` (12,615), so all standalone surfaces agree. Per-edition rates
drop to the honest host-free rate (e.g. ES5 56%→24%, ES2015 50%→33%). The host
(`gc`) editions invocation is untouched and still counts raw `pass`. `tsc
--noEmit` clean; prettier clean.

Leaky-pass breakdown (why the slider was inflated): `host_import` 4,916,
`iterator_protocol` 4,783, `dynamic_object_property` 2,645, `dynamic_code` 325,
`regexp` 8.
