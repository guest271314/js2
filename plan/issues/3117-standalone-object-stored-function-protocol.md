---
id: 3117
title: "Standalone $Object stored-function substrate: dot-member-set drops closures (o.f = fn → uncallable) + the plain-$Object @@iterator protocol arm (#3100 Design arm 3) — 810-file test262 population, 0 host-free"
status: in-progress
assignee: ttraenkler/fable-3100s4
sprint: current
model: fable
created: 2026-07-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: iterators, functions, objects
goal: standalone-mode
umbrella: 2860
related: [3100, 3098, 1888, 2664, 2866, 3031]
origin: "2026-07-09 fable-3100s4 prove-first probe after S5 measured zero test262 flips — the *-close cluster (and per fable-3058, the broader standalone frontier) bottoms out on this lane; #3098's author stood down, lane unowned"
---

# #3117 — $Object stored-function invocation substrate (two slices)

## Problem (verified against origin/main @ abdaabf, 2026-07-09, standalone)

Two empirically-pinned sub-gaps, both in the dynamic-`$Object` lane:

**(1) Dot-member-set DROPS function values.** Differential probes:

```ts
const o: any = {};
o["f"] = function () {
  return 7;
};
o.f(); // ✓ 7  (computed set)
o["g"] = (x) => x + 1;
o.g(4); // ✓ 5  (computed set)
o.f = function () {
  return 7;
};
o.f(); // ✗ 0  (dot set — silently uncallable)
o.f = () => 7;
o.f(); // ✗ 0  (dot set)
```

Arrow vs function-expression is irrelevant — it is dot-set vs computed-set.
So the #3098/#1888 invocation machinery (`__apply_closure`, boxed-closure
read-back, `__call_fn_method_N`) is COMPLETE and reachable; the dot-property
WRITE path loses the closure. Broad-population correctness bug beyond
iteration (`obj.method = function` is pervasive in test262).

**(2) No plain-`$Object` `@@iterator` protocol arm in the native `__iterator`
ladder** — #3100's day-one Design arm 3, never built (tracked here, not by
reopening #3100). The install itself works (computed set), but iteration has
no arm:

```ts
const o: any = {};
o[Symbol.iterator] = function () {
  let i = 0;
  return {
    next: function () {
      i += 1;
      return { value: i * 10, done: i > 3 };
    },
  };
};
[...o]; // ✗ [] (length 0)
for (const v of o) // ✗ TRAP: illegal cast (ladder tail)
  let x;
[x] = o; // ✗ x undefined
```

## Population (fresh standalone baseline, 2026-07-09)

**810 test262 files** use the post-hoc `x[Symbol.iterator] = fn` install
(185 in the dstr/for-of clusters alone, including the 57 `*-close.js` rows
S5's closed-struct IteratorClose could not reach). Standalone lane status:
740 fail(leaky) + 57 pass(leaky) + 13 CE — **zero host-free**. The protocol
arm is NECESSARY for all of them; the dot-set fix additionally unblocks the
general dynamic-method population outside the 810.

## Design

- **S1 (dot-set fix)**: make the property-access member-set on `$Object`
  receivers store function values exactly as the element-access set does
  (boxed closure → `__extern_set`). Root cause to be pinned by WAT-diffing
  the working (`o["f"]=`) vs broken (`o.f=`) stores.
- **S2 (protocol arm)**: new `$IterRec` kind OBJ in the `__iterator` ladder
  (fill-time, same reserve-then-fill infrastructure as S1/S5 of #3100):
  - GetIterator: `ref.test $Object` → `Get(v, @@iterator)` via the
    symbol-keyed object-runtime read (#2866 carrier) → callable →
    `__apply_closure(fn, v, [])` → iterator object (must be Object else
    TypeError §7.4.3) → `$IterRec{OBJ, iterObj}`.
  - IteratorStep: `next = Get(iter, "next")` → `__apply_closure(next, iter,
[])` → `done`/`value` via `__extern_get`.
  - IteratorClose: `ret = Get(iter, "return")` → absent ⇒ no-op; else
    `__apply_closure(ret, iter, [])`.
  - Consumers (for-of, dstr materializer, `__iterator_rest`, spread) bind
    through the existing names — no consumer changes (the #3100 chokepoint).

## Acceptance

1. Differential probes flip (dot-set stored fns callable; `[...o]`, for-of,
   dstr over post-hoc-`@@iterator` objects produce values host-free).
2. Measured flips in the 810-file population (fresh sweep, branch vs main);
   zero unexplained pass→fail anywhere; byte-identity on unrelated corpus.
3. merge_group + standalone floor green.

## Dependencies

Stacked on #3100 S5 (PR #2823) — the fill infrastructure and
`__call_return`/materializer builders. Enqueue after S5 lands.
