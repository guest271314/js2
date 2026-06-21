---
id: 2541
renumbered_from: 2375
title: "standalone: Object.fromEntries / o.propertyIsEnumerable / Object.is refuse with a dynamic-shape CE"
status: done
sprint: 64
created: 2026-06-19
updated: 2026-06-21
completed: 2026-06-21
priority: low
task_type: bugfix
area: codegen, standalone
language_feature: object-static-methods
goal: standalone-mode
related: [2374, 2151]
origin: "2026-06-19 sd1 standalone host-import-leak hunt (object/class/property lane)"
---

# #2541 — standalone Object.fromEntries / propertyIsEnumerable / Object.is dynamic-shape CE

## Problem

In `--target standalone --nativeStrings`, three object built-ins refuse with a
`Codegen error: '<helper>' (dynamic-shape object/...)` compile error rather than
a working native lowering:

| form | refuses with |
|---|---|
| `Object.fromEntries([["a",5]])` | `__object_fromEntries` (dynamic-shape object) |
| `o.propertyIsEnumerable("x")` | `__propertyIsEnumerable` (dynamic-shape object) |
| `Object.is(NaN, NaN)` | `__object_is` (dynamic-shape object) |

These graceful-refuse (a clear CE, not a silent miscompile and not a host-import
leak), so they are **lower priority** than the un-instantiable leaks — but each is
a standalone conformance gap.

## Notes / scope

- `Object.is(a, b)` is the most tractable: §20.1.2.13 SameValue is a pure
  small comparison (`a===b` except `+0/-0` distinguished and `NaN` equal) — a
  candidate for a Wasm-native lowering with no dynamic-shape dependency.
- `Object.fromEntries` and `propertyIsEnumerable` are bound up with the same
  runtime dynamic-property / own-key machinery as #2374 (dynamic property
  read/write by runtime key) and #2151 (any-receiver dispatch); their
  "dynamic-shape" refusal is the same family. They likely follow #2374.

## Acceptance criteria

- `Object.is(NaN, NaN)` → `true`, `Object.is(0, -0)` → `false`, in standalone
  with zero host imports (the bounded sub-slice).
- `Object.fromEntries` / `propertyIsEnumerable` either lower natively or remain a
  documented refusal gated on the #2374 dynamic-property machinery.

## Validation caveat (lesson from #2371/#1734)

Before any gate/refusal change, VALIDATE against the real test262 standalone
harness — a host-import "leak" or refusal seen against an empty importObject may
be benign because the harness provides the import. A native lowering (additive)
is always safe; demoting a working path is not.

## Resolution (2026-06-21, sdev-reflect)

PROBE-VERIFIED on upstream/main HEAD 325c8054c — two of the three forms had
already been lowered natively since this issue was filed:

- **`Object.is(NaN, NaN)` → true, `Object.is(0, -0)` → false** — ALREADY WORKS.
  The `__object_is` native (SameValue §7.2.10) landed and is wired to the
  standalone call site. No work needed.
- **`Object.fromEntries([["a",5]])` → `{a:5}`** — ALREADY WORKS. The
  `__object_fromEntries` native landed. No work needed.
- **`o.propertyIsEnumerable("x")`** — was STILL refused. Fixed in this slice.

**Fix** (`src/codegen/object-runtime.ts`): registered `__propertyIsEnumerable`
as a native helper (§20.1.3.4) — the same own-only `__obj_find` lookup as
`__hasOwnProperty`, then a `FLAG_ENUMERABLE` test on the found `$PropEntry`
(missing own prop / non-`$Object` receiver → false; no prototype walk). Added it
to `OBJECT_RUNTIME_HELPER_NAMES` so the call site's late import resolves to the
in-module native instead of hitting the #1472-Phase-B refusal. Additive (a new
native lowering) — host mode keeps its JS import, byte-identical.

Tests: `tests/issue-2541-propertyisenumerable.test.ts` (6) — enumerable own →
true, missing → false, non-enumerable (via defineProperty) → false,
explicitly-enumerable defined → true, inherited proto prop → false (own-only),
hasOwnProperty unregressed. Object suites 35/35; tsc + prettier clean.

All three acceptance criteria met; issue closed.

## Merge-queue ejection (2026-06-21, sd-2) — stale base, not a code regression

PR #1860 ejected from the merge_group on "test262 standalone shard 56" +
"merge shard reports" at 13:49. Root cause: the branch was **49 commits behind
origin/main** (merge-base #1856) — missing #2542/#2574/#2575/#2001-S1/#2552 and
the baseline sync that raised the standalone pass floor to 31569. The merge_group
tests the *speculative merge* onto current main, so a stale base fails the raised
standalone floor / drifts even when the isolated change is fine (standalone-floor
is merge_group-only; the per-PR checks green-skip the heavy standalone shards).

Verified the `__propertyIsEnumerable` native is NOT the regression: its behavior
matches `__hasOwnProperty` exactly on every shape (own-enumerable → true, absent
→ false, non-`$Object` → false), with zero host-import leak and valid Wasm. The
one shape where it returns "wrong" (`const o:any={}; o.x=9; o.pie("x")` → false)
is a *pre-existing* empty-`{}` open-object gap that `hasOwnProperty` shares
identically — out of #2541's scope, untouched by this change.

Resolution: merged current origin/main into the branch (clean, no conflicts; diff
vs main stays the same 3 #2541 files), re-validated (tsc + #2541 suite 6/6 +
hard-error gate 0 + targeted standalone sweep all green), and let the merge_group
re-validate shard 56 on the now-current base.
