---
name: reference_standalone_leak_gate_vs_substrate_numeric_callN
description: "Classifying standalone sole-import leaks as bounded GATE (declared-but-uncalled, #3016-style, a few-file fix) vs SUBSTRATE (genuinely called, needs native impl) MUST count NUMERIC `call N` sites in the emitted wat, not grep the symbolic `$name`: wat renders import calls as `call <0-based-func-index>`, so a name-only grep FALSELY labels every substrate import as a dead gate (fake bounded win). Corrected probe: map each `(import … (func $sym))` to its func index, then count call|ref.func|return_call by BOTH index and symbol. Also: as of 2026-07-13 the #3016 bounded-gate seam is EXHAUSTED (0 gates / 200 sampled leaky-passes = all substrate); remaining sole-import leaks are all substrate."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Observed 2026-07-13 (opus-leak2, standalone leak re-rank after #3016 merged).**

**The trap:** to decide whether a standalone `env::__foo` sole-import leaky-pass is a
bounded GATE (import DECLARED but never CALLED — a #3016/#3235-style spurious
unconditional registration, fixable by a standalone gate on the registration,
flips host-free with a few-file change) vs SUBSTRATE (the import is genuinely
CALLED — needs a real native implementation), you must inspect the emitted wat's
CALL sites. The wat renders an import call as **numeric `call N`** where N is the
import's 0-based func index — NOT the symbolic `$name`. A **name-only grep**
(`grep '\$__foo'`) for call sites finds the import DECLARATION but misses the
numeric call, so it FALSELY reports "0 call sites → dead gate → bounded win."
opus-leak2's first pass hit this and mislabeled substrate imports
(`__extern_rest_object` etc.) as dead gates.

**Corrected probe:** parse each `(import … (func $sym))` to its 0-based func
index (order of appearance), then count `call|ref.func|return_call` occurrences
by BOTH the numeric index AND the symbol. Only truly-zero → bounded gate.

**Strategic state (2026-07-13): the bounded-gate seam is MINED OUT.** Rigorous
sample of 200 random standalone leaky-passes → **0 gates / 200 substrate**. The
only true declared-but-uncalled gate left in the whole corpus is
`__instanceof_check` on ONE test (instanceof in a ReferenceError-short-circuited
position) — not PR-worthy. So the next standalone-conformance levers are all
SUBSTRATE, ranked by distinct host-free flips (excluding in-flight/deferred):
`__new_*` subclass-builtins **49** (`class Sub extends Object/Array/Function/
Date/RegExp/TypedArray` super()→native builtin construction; biggest, builds on
#56/#3053 native $Object substrate) > `__extern_rest_object` obj-rest
CopyDataProperties **9** > weak-collections **8**. Callback-dispatch
`__call_*`/`__make_callback` (164) was #3016 (done); `__dynamic_import`/
SharedArrayBuffer/Temporal/Array.fromAsync are deferred features. Related:
[[reference_selfhost_netnegative_needs_full_elemkind_dialect]],
the #3016/#3235 gate-fix pattern.
