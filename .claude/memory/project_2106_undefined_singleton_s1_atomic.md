---
name: project_2106_undefined_singleton_s1_atomic
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2106 S1 makes standalone `undefined` a distinct tag-1 `$AnyValue` singleton
(vs `null` = `ref.null extern`) so null/undefined are distinguishable for
`===`/`typeof`/`Object.is`. Branch `issue-2106-s1-undefined-singleton`
(3 commits: spec → inert S1.0 → S1.1 WIP), all pushed; resume from the issue
file's `## Suspended Work`.

**Why it's ONE atomic PR, not splittable:** the moment standalone `emitUndefined`
stops returning `ref.null.extern` and returns the singleton, EVERY `ref.is_null`-
based nullish consumer (`== null`, `??`, `?.`, default-fill, array-hole,
SameValueZero-nullish) stops detecting undefined in the SAME build. So producer +
ALL consumer classes must flip together (~40 sites).

**The chokepoint win:** undefined-specific checks funnel through 2 native helpers —
`__extern_is_undefined` (`object-runtime.ts`) and `__typeof_undefined`
(`index.ts`) — flipping their bodies to a tag-1 test fixes all ~35 callers at
once. The strict-eq `bothNullishGuard` (binary-ops.ts) becomes correct under S1
(keyed on `ref.is_null` = "is null" since undefined is now non-null) — it
supersedes held PR #1961 (which collapsed null/undefined because they shared bits).

**The two unfinished root causes (S1.1 WIP frontier):**
1. STORED `undefined` isn't the singleton — array/object literal element stores
   (`literals.ts`) and `boxToAny`'s tag-1 arm (`value-tags.ts:168` currently
   `break`s) push raw `ref.null.extern`, so `[undefined,undefined]` doesn't `ref.eq`.
   Fix: route ALL undefined producers (literals, boxToAny, omitted-arg padding)
   through the singleton.
2. loose `null==undefined` false — the loose nullish guard's bare `ref.is_null`
   misses the non-null singleton. Fix: `emitIsNullish` = `is_null ||
   is_undefined_singleton`, swept through the ~42 nullish-intent `ref.is_null`
   sites (S1.2 ripple; `=== null` stays bare `ref.is_null`).

**#329 hazard:** the `$undefined` global MUST be reserved up-front at
`ensureAnyValueType` (it's a GLOBAL, not a late func import) — a late func import
after native-string finalize off-by-ones the baked `__str_flatten` call.

Value-rep broad-impact ⇒ validate via merge_group, not a scoped sweep
([[project_broad_impact_validate_full_ci]]). Lane: I own the value-rep equality
substrate; #1917 Step 5 (abstract equality) builds ON this later.
