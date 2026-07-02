---
id: 2941
title: "Native SYNC-generator resumeFuncIdx is an un-shifted late-import side-channel (funcIdx desync)"
status: done
assignee: ttraenkler/sr-funcidx
created: 2026-07-02
completed: 2026-07-02
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [2938, 2936, 2918, 1461, 2193]
---

# #2941 — native-generator `resumeFuncIdx` un-shifted side-channel

## Problem

`ctx.nativeGenerators[].resumeFuncIdx` (the generated `__gen_resume_*` function
index, cached on each `NativeGeneratorInfo`) is a plain number read at every
`.next()` / `.return()` / `.throw()` / for-of driver + `yield*` bake site via
`ensureNativeGeneratorResumeFunction`. Unlike the other funcIdx side-channels
(`nativeStrHelpers`, `mapHelpers`, `pendingMethodTrampolines`, the
async-scheduler / combinator fields), **no late-import shift pass walked
`ctx.nativeGenerators`**. So once a resume function is emitted, a late import
that lands afterwards bumps the `funcMap` entry (and the shifter's body walk
repairs already-baked `call` instrs), but the **cached `resumeFuncIdx` stays
stale-low**. A _new_ bake after that shift reads the stale cache and targets one
function too early → the class-static generator invalid module
`call[…] not enough arguments on the stack for call (need N, got 1)`.

This is the reference_1461 / reference_2193 lineage (a side-channel funcIdx not
kept in lockstep with late-import shifts) — a **sibling of #2936, distinct
mechanism**: #2936 fixed the `ensureLateImport` batch-regime _mix_ (settling
native-string finalize drift before a deferred batch) and is on `main`, yet does
NOT fix this — proving the two are independent.

## Origin

Surfaced as ~16 of the 20 `#2938` no-yield-relax merge_group regressions
(`class/elements/*-gen-rs-static-*` → invalid Wasm). The no-yield relax makes
those class-static generators native candidates, exposing the desync; the hazard
is general (with-yield native generators cross the same shift paths), so it is
worth fixing independent of whether the #2938 relax ever ships.

## Fix (2 files)

1. `src/codegen/generators-native.ts` — `ensureNativeGeneratorResumeFunction`
   re-reads `ctx.funcMap` (the shift-maintained source of truth) on every cached
   hit and refreshes the cache. Primary fix: bakes always get the current idx.
2. `src/codegen/expressions/late-imports.ts` — `shiftLateImportIndices` now
   walks `ctx.nativeGenerators` and bumps each `resumeFuncIdx >= importsBefore`,
   keeping the cached field itself in lockstep for any direct reader
   (belt-and-suspenders, mirrors the trampoline / async side-channel walks).

Both are inert unless native generators were emitted (gc/host default path never
registers any) → byte-inert off-carrier.

## Validation

- **Empirical proof (the load-bearing one):** the 20 `#2938` merge_group
  standalone regressions, re-run with this fix layered onto the relax branch:
  **18 pass / 2 fail / 0 invalid modules** (was 0/0/16-invalid). All ~16
  class-static invalid-Wasm regressions become valid. The 2 residual fails are
  the orthogonal no-yield `.value` semantic bug (#2938 bug (b)), which this fix
  correctly does not touch. Reproduce: overlay `generators-native.ts` from
  `issue-2933-noyield-relax` + this fix, run
  `.tmp/2930/corpus.mts .tmp/2938/reg20fix.txt`.
- **Byte-inert:** 50 non-generator gc test262 files sha256-identical vs
  `main` (the fix is unreachable without native generators).
- Regression test: `tests/issue-2941.test.ts` compiles a native sync generator
  in `--target standalone` across a late-import boundary and asserts the module
  validates (guards the general resume-idx path). NB the _observable_ class-static
  desync only manifests with the #2938 relax active (the failing files are
  no-yield), so the committed test guards the path and the authoritative proof is
  the corpus flip above.

## Note for #2938 corpus design

The 542-file no-yield sample missed these class-statics because it filtered
generators by `!yield` and sampled by directory: the `class/elements/*` templates
that carry static generators were dropped (they contain an `async *` sibling → a
`yield` match) and the sample was directory-strided, not construct-strided. The
next corpus must **sample by construct** (class-static generator, object-method
generator, free-function, …), not by directory, and validate on the full
`merge_group` standalone lane, never a scoped sample.
