---
id: 3119
title: "Standalone plain-$Object @@iterator protocol arm in the native __iterator ladder (#3100 Design arm 3) — post-hoc x[Symbol.iterator]=fn: 810 test262 files, 0 host-free"
status: ready
sprint: current
model: fable
created: 2026-07-09
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: iterators, for-of, destructuring, spread
goal: standalone-mode
umbrella: 2860
related: [3100, 3117, 3098, 1888, 2866, 2038]
origin: "2026-07-09 fable-3100s4 — split from #3117. The dot-set closure-store fix (#3117) landed; this is the remaining, larger S1-grade slice: a $Object @@iterator arm in the GetIterator ladder. Prove-first quantified 810 files."
---

# #3119 — plain-$Object @@iterator protocol arm

## Problem (verified against origin/main, 2026-07-09, standalone)

The native `__iterator` GetIterator ladder (#3100 S1/S5, iterator-native.ts)
has arms for the canonical `$Vec`, the vec-FAMILY carriers (`$ObjVec` /
typed vecs), and the closed-struct USER `{next()}` carrier — but **NO arm for
a plain `$Object` whose `@@iterator` was installed dynamically**
(`o[Symbol.iterator] = fn`). The install itself works (computed member-set is
a genuine `$Object` store, #3117-adjacent), but iteration finds no arm:

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
[...o]; // ✗ [] (length 0 — __iterator_rest sees a non-vec, non-USER record)
for (const v of o) // ✗ TRAP: illegal cast (ladder tail hard-casts to $Vec)
  let x;
[x] = o; // ✗ x undefined
```

This is #3100's **Design arm 3** (§"Design — **get_iterator / **iter*step"),
specced day one, never built. It is distinct from the S3 closed-struct USER
arm: that dispatches through the closed nominal `<Struct>*@@iterator`/`<Struct>\_next`type-switch; this needs to read`@@iterator`/`next`/`return`as`$Object`PROPERTIES and invoke them via`\_\_apply_closure`.

## Population (fresh standalone baseline, 2026-07-09)

**810 test262 files** use the post-hoc `x[Symbol.iterator] = fn` install
(185 in the dstr/for-of clusters alone, including the 57 `*-close.js` rows
that #3100 S5's closed-struct IteratorClose could not reach — those iterators
are plain `$Object`s, not closed structs). Standalone lane today:
740 fail(leaky) + 57 pass(leaky) + 13 CE — **zero host-free**. The arm is
NECESSARY for all of them.

## Design (new $IterRec kind OBJ, fill-time — same reserve-then-fill as S1/S5)

Add an OBJ kind (e.g. `ITER_KIND_OBJ = 4`) to the `__iterator` ladder,
between the vec-family arms and the USER/trap tail:

- **GetIterator** (`buildIteratorBody`): `ref.test $Object` →
  `iterFn = Get(v, @@iterator)` via the symbol-keyed object-runtime read
  (`@@iterator` is well-known symbol id 1; the `$Object` hash-map keys on the
  `$Symbol` carrier — #2866). callable ⇒ `iterObj = __apply_closure(iterFn,
v, [])`; validate `iterObj` is an Object else TypeError §7.4.3 (deferred
  refinement OK) → `$IterRec{OBJ, vec:null, 0, userIter:iterObj}`.
- **IteratorStep** (`buildIteratorNextBody`): OBJ arm →
  `next = Get(iterObj, "next")` → `res = __apply_closure(next, iterObj, [])`
  → `done = ToBoolean(Get(res,"done"))`, `value = Get(res,"value")` through
  the dynamic reader (`__extern_get`, carrier-correct #3053).
- **IteratorClose** (`buildIteratorReturnBody`, extend the S5 USER arm):
  OBJ arm → `ret = Get(iterObj, "return")` → absent/undefined ⇒ no-op; else
  `__apply_closure(ret, iterObj, [])`.

Consumers (for-of, dstr materializer `__array_from_iter_n`, `__iterator_rest`,
spread) bind through the existing names — **no consumer changes** (the #3100
chokepoint discipline). The OBJ record reuses the USER `userIter` field, so
`__iterator_rest`'s S5 USER step-to-exhaustion drain and the materializer's
user-iterable drain arms already handle it once `next` dispatches.

### Infra dependencies (all landed)

- `__apply_closure` (#1888) — arity bridge, reserve-then-fill; degrades safe.
- symbol-keyed `$Object` read (#2866 `$Symbol` carrier + `__obj_hash`/
  `__key_equals` symbol branches) — the `@@iterator` key is a `$Symbol` box.
- `__extern_get` / `__is_truthy` (object runtime) for `next`/`done`/`value`.

### Hazards to respect (from #3100 S1/S5)

- Fresh `Instr` objects per arm (factory style — #2169b shared-object
  double-remap).
- Baked funcIdxs (`__apply_closure`, `__extern_get`, `__is_truthy`,
  symbol-read helper) resolved from funcMap at fill time; import shifts walk
  the defined body.
- The GetIterator `@@iterator` read must materialize the well-known
  `$Symbol` for id 1 host-free (verify `nativeStringLiteralInstrs` is not on
  the symbol path — the key is a symbol carrier, not a string).

## Acceptance

1. `[...o]`, `for (const v of o)`, `[x] = o`, `const [x] = o` over a
   post-hoc-`@@iterator` plain object produce values host-free; IteratorClose
   fires on break/throw/non-exhaust (reuse #3100 S5 probes with a plain-object
   iterable).
2. Measured flips in the 810-file population (fresh sweep, branch vs main);
   zero unexplained pass→fail; byte-identity on unrelated corpus.
3. merge_group + standalone floor green.

## Effort

L — the GetIterator/Step/Close arms are new codegen over `$Object` reads +
`__apply_closure`, but slot into the existing fill infrastructure. Solo Fable
design slice (arm ABI + symbol-read wiring); the consumer side is already
built (S4/S5).
