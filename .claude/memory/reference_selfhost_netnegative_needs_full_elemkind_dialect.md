---
name: reference_selfhost_netnegative_needs_full_elemkind_dialect
description: "Self-hosting a stdlib family (the bloat lever) nets NEGATIVE LOC only if the TS dialect covers ALL elem/value kinds the unit instantiates — codegen hand-emitters are element-type-GENERIC (one emitter param over f64/i32/i8/i16/ref/externref), so a partial (e.g. f64-only) conversion keeps the generic hand emitter alive and goes net-POSITIVE. Convert already-type-restricted + pure + fixed-ABI units first."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Finding (2026-07-12, fable-selfhost while scoping array-methods self-host
slice 1, issue #3159):** the self-hosting bloat lever (convert hand-emitted
Wasm builtins → TS source compiled through our own IR driver
`src/codegen/stdlib-selfhost.ts`) only DELETES hand code — i.e. nets negative
LOC — if the compilable TS dialect covers **all** the elem/value kinds the
target unit instantiates.

**Why:** the `compile*` emitters in `array-methods.ts` (and by extension the
other big stdlib files) are **element-type-GENERIC** — one inline emitter
parameterized over f64/i32/i8/i16/ref/externref. If you self-host only the
common case (e.g. the f64 path), the generic hand emitter STAYS ALIVE to serve
the other elem kinds, so you've ADDED the TS-source version on top of code you
couldn't delete → **net-POSITIVE**, which defeats the whole point.

**Dialect coverage today (verify — it grows):** f64 fully; i32 compares
(polymorphic, #1126); element STORES only f64/externref (i8/i16 not yet).

**Strategy that nets negative:**
1. Convert units that are **already type/shape-restricted + pure computation +
   funcMap-registered with a fixed external ABI** first — the Math-pilot
   (#3141) drop-in shape. Concrete win: `src/codegen/timsort.ts` (922 lines,
   the array sort engine, already restricted to i32|f64 by #2502 guards, pure,
   called only from array-methods sort/toSorted) → slice 1, est. net −550..−650.
2. Build **"Precursor B"** = tiny typed intrinsic callees (typed element
   access materialized on demand) — reusable by every later array/string/
   dataview slice.
3. Only AFTER expanding elem-kind dialect coverage (element stores beyond
   f64/externref; i8/i16) do the generic inline emitters become net-negative
   to convert.

**Rule for dispatch:** before writing any self-host conversion, estimate
deleted-hand-LOC vs added-TS-LOC and confirm net-negative. object-runtime is a
poor early target (heavy on identity/proto/brand — NOT pure); prefer
Math/timsort/native-strings/dataview pure units. Proof method per family: the
pilot's bit-exact behavioral sweep vs main-built control binaries
(NaN/±0/±Inf/denormals/dups/boundary lengths, all elem kinds, host+standalone)
+ SHA byte-inertness for programs that don't use the unit. Plan:
`plan/self-hosting-scale-up.md`. Related: [[project_bloat_reduction_week_of_2026_07_11]].
