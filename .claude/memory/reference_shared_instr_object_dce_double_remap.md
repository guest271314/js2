---
name: reference_shared_instr_object_dce_double_remap
description: "Never alias one Instr[]/instruction OBJECT into two reachable positions (if then+else, etc.) — DCE's in-place remapTypeIdxInBody walks it twice and double-applies a chained type-idx remap (e.g. 46→40→34) → invalid struct index. Build a fresh arm per branch."
metadata:
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

**Symptom:** a native helper body emits `struct.new <T>` at the WRONG type index
→ V8 `invalid struct index: N` / wrong-arity (`struct.new need 4 got 2`), while
the type-def itself is at the right index. Often only triggers for SOME inputs
(e.g. `Array.from(<native iterator>)` but not plain for-of) — because it needs the
type-table shape to produce a *chained* DCE remap.

**Root cause (#2169b, sprint 64):** `eliminateDeadImports`
(`src/codegen/dead-elimination.ts`) remaps surviving type indices and mutates
each function body IN PLACE via `remapTypeIdxInBody` (a `walkInstructions` that
sets `a.typeIdx = tR.get(a.typeIdx)`). This is **non-idempotent**: if the remap
table `tR` is CHAINED — `46→40` AND `40→34` (both old indices survive to
different new slots) — and the SAME instruction OBJECT is reachable twice in the
walk, the rewrite composes: `46 → 40 → 34`. The type-def array is remapped once
(`surv.map(remapTD)` reads the original), so only the body desyncs.

The double-visit came from `buildIteratorBody` returning
`{ op:"if", then: vecArm, else: elseArm }` where `elseArm = vecArm` on the
vec-only path — **the same `Instr[]` array (and its `struct.new` object)** aliased
into both `then` and `else`. The walk visited it via `then` and via `else`.

**Confirm it with an object-identity probe**, not just index values: tag the
function's body array (`(fn as any).__tag = rand`) at DCE-entry, log the
`struct.new` operand BEFORE and AFTER the remap loop, and at emit. If the tag is
the same array but the operand changed from `[46,46]`→`[34,34]` inside the loop
while `tR.get(46)=40` AND `tR.get(40)=34`, it's the chained double-apply (NOT a
savedBody/stale-copy desync). Pass-bisecting later passes (repair/peephole) all
still-fail confirms the corruption is inside DCE.

**Localized fix:** build a FRESH arm per branch — a `buildVecArm()` factory that
returns new object literals each call, so `then` and `else` hold DISTINCT
instruction objects, each remapped exactly once. NOT a shallow array copy (that
still shares the instruction objects). WAT-byte-identical everywhere the chained
shape doesn't occur.

**Durable global fix (filed #2370, arch):** make `remapTypeIdxInBody` idempotent
(snapshot-then-write, or guard already-mapped instructions) so ANY aliased body
is safe regardless of `tR` chaining. Until then, the codegen invariant is:
**never share one instruction/Instr[] object across two reachable positions in a
body** (then/else, multiple block arms, etc.). This is the
[[reference_no_rebuild_helper_body_at_finalize]] family (it cost #1673 three
rounds; related to #40/#2190/#2191 type-/idx-stability bugs).
