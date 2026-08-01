---
id: 3951
title: "perf: narrowly-typed Map/Set entry storage — `$MapEntry` boxes key and value as `anyref`"
status: ready
sprint: Backlog
created: 2026-07-31
updated: 2026-07-31
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen, collections
language_feature: Map, Set
goal: standalone-mode
related: [1103, 2162, 2622, 3673, 3899, 3921, 3927, 3685]
---

# #3951 — Narrowly-typed collection entry storage

## Problem

The WasmGC-native collection runtime stores every key and value boxed:

```
$MapEntry: struct { key: anyref(mut); value: anyref(mut); next: i32(mut); hash: i32(mut) }
```

(`src/codegen/map-runtime.ts`, `ensureMapRuntimeTypes`.)

So a `Map<string, number>` — where both types are statically known at every
insertion site — allocates a box per value on the way in and goes through
generic hash/equality dispatch on every lookup. The type information exists at
the producer and is discarded at the container boundary.

`$Map` also backs `Set` (`__map_new` yields the `$Map` a Set wraps, branded by
the trailing `kind` field, #3171), so the same cost applies to
`Set<number>`/`Set<string>`.

## Why this is filed as a consumer of the representation work, not a collections fix

**This is one instance of a larger measured problem, and should not be scoped as
a standalone collections optimisation.** #3921's per-type allocation census over
the real acorn self-parse found:

> **`$AnyValue` boxing is 48% of every allocation in the parse — 310,485 boxes,
> ~7.4 per token — and it appeared on no one's list.** The AST is **5%** of
> allocations by count.

and framed the cause in exactly the terms that apply here:

> the carrier a value takes when a statically-typed value flows somewhere its
> type is no longer known … Whatever fraction of those 310 K boxes is a value
> that was *provably* typed at the producer and re-widened for a generic
> consumer is pure loss, and it is a **representation question**.

`anyref` map entries are that pattern with the container as the widening
boundary. If a general "keep a provably-typed value unboxed across a generic
boundary" mechanism is built (#3927/#3685 territory), **collections should be a
consumer of it** rather than growing a bespoke parallel solution.

**Caveat on citing #3921:** its *byte* column is explicitly not reconciled
(29 MB estimated vs 43.6 MB measured) and must not be quoted as measurement.
The **counts** above are exact — each is a counter incremented at the
allocation site.

### Honest scoping note — acorn is NOT the motivating workload

The 48% figure is about `$AnyValue` in general **value flow**, not about
collections. acorn makes little use of `Map`/`Set` on its hot path, so this
issue should **not** be sold as an acorn win. It is the same disease in a
different container, and its own workload evidence is still owed (see below).

## What is NOT missing

Two corrections, so nobody re-litigates settled ground:

- **Type-aware hashing already exists.** #1103's design specified "compile a
  hash function for each key type (number → identity, string → FNV/djb2, object
  → identity/address)". What shipped hashes by **runtime type dispatch** —
  `__obj_hash` `ref.test`s `$HashedString`, and #3673 Round 9 added
  `$HashedString <: $NativeString` carrying a cached FNV-1a hash with a
  write-back fast path. So hashing is type-aware; it is not *compile-time
  specialised*. Turning the runtime dispatch into a per-call-site specialised
  hash is a **further, smaller slice**, not an unimplemented promise.
- **This is not a regression.** Nothing worked and broke. #1103 never specified
  unboxed entry storage; narrow typing is a new idea here, which makes it weaker
  as a standalone pitch and is a further reason to attach it to the
  representation work.

## Sketch

Specialise the entry struct when key/value wasm types are statically known and
monomorphic at every insertion site for a given collection allocation:

- `Map<string, number>` → `struct { key: ref $NativeString, value: f64, … }`
- `Set<number>` → an f64-keyed variant
- anything polymorphic, `any`-typed, or escaping to a generic consumer → today's
  `anyref` entry, unchanged.

Open design questions, none of which are answered here:

1. **Where does the specialisation decision live?** Per allocation site
   (escape/monomorphism analysis) or per static type? A `Map` that escapes into
   an `any`-typed consumer must degrade safely.
2. **How many variants?** A per-type-pair struct explosion is its own cost; a
   small closed set (f64 / `$NativeString` / anyref) is likely the tractable
   shape.
3. **Interaction with #2622.** The native subclass design declares
   `$MySub <: $Map` so every `__map_*` helper accepts it by subtyping. A
   specialised entry type changes `$Map`'s own field types, so the two must
   agree on whether specialisation is per-`$Map`-type (forcing subclass
   variants) or confined to the entry array.
4. **`__map_*` helper duplication.** The helpers take `ref $Map`; specialised
   entries imply either specialised helper variants or a generic helper that
   dispatches, which would give back much of the win.

## Acceptance criteria

- [ ] A benchmark that is genuinely collection-hot (acorn is **not** — pick or
      write one; `Map`/`Set`-heavy dogfood code or a targeted microbenchmark)
      with a recorded before/after on both allocation count (via #3921's census)
      and wall-clock.
- [ ] `Map<string, number>` / `Set<number>` allocate no per-entry box on the
      insertion path in the specialised case.
- [ ] Polymorphic / `any` / escaping collections still compile and behave
      identically — a degradation path, not a refusal.
- [ ] test262 pass counts unchanged on both lanes (this is a representation
      change, not a semantics change).
- [ ] Decision recorded on whether this is implemented as a consumer of the
      general `$AnyValue` representation work or independently, with the reason.

## References

- `src/codegen/map-runtime.ts` — `$MapEntry` / `$Map` layout, `MAP_LAYOUT`.
- #3921 — per-type WasmGC allocation census; the 48% `$AnyValue` finding.
- #1103 — original native Map/Set design (per-key-type hashing plan).
- #3673 — acorn self-parse perf; Round 9 `$HashedString` + `__obj_hash` cache.
- #3899 — boolean interning; one narrow case of the same widening crossing.
- #2622 — native builtin-collection subclass; shares the `$Map` type decision.
- #2620 — where this gap was first written down (architectural note).
