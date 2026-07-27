---
id: 3683
title: "perf: typed-`this` monomorphization for fnctor prototype methods — the measured path past the #3673 inline-cache asymptote"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
goal: value-rep
sprint: Backlog
related: [3673, 1946, 1947, 1584]
loc-budget-allow:
  - src/codegen/fnctor-escape-gate.ts
  # S2: the four lowering-branch call sites. The emitters themselves live in
  # the new subsystem module `src/codegen/typed-this.ts` (which also absorbed
  # `EMIT_COMPOUND_OP_HANDLES`); what remains in each god-file is one guarded
  # call plus the comment explaining why it must run before the pinned
  # dispatcher — 42 net lines across all four, down from 161 before the move.
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/unary-updates.ts
---

# #3683 — Typed-`this` monomorphization for fnctor prototype methods

## Problem

#3673 drove the standalone compiled-acorn parse from 52.4ms to 1.51ms
(~35x) with runtime fast paths and inline caches, and then measured the
asymptote: **runtime helpers are ≈58% of remaining wasm time, the compiled
parser bodies ≈38%** — so even zeroing every helper lands ~0.8ms against
node-acorn's 0.0341ms. The parser bodies are slow for exactly one
structural reason: acorn's methods are compiled as generic closures with a
DYNAMIC `this` (the `__current_this` externref global), so

- every `this.pos` read is a CALL to a `__get_member_pos(__f64)`
  dispatcher (≈30 instrs + `ref.test` per read; node: one inline-cached
  load),
- every intermediate value round-trips through externref boxing
  (`__box_number`/`__unbox_number`/i31, `$AnyValue` lanes),
- every `this.method(...)` crosses `__call_m_*` → cache → closure-call
  bridge (`__call_fn_method_N`: argc globals, per-entry unbox, `call_ref`,
  re-box).

## Direction

For a fnctor class `F` whose instances are a single known struct type
`$__fnctor_F` (the common case — acorn's Parser/Node/TokenType/etc.),
compile each prototype method body a SECOND time as a typed twin:

    `F_proto_<m>_typed(this: (ref $__fnctor_F), ...params) -> ret`

with these lowering changes inside the twin only:

1. **`this.X` reads/writes** where `X` is a field of `$__fnctor_F` lower
   to bare `struct.get`/`struct.set` — no dispatcher call, no boxing when
   the consumer context is numeric (compose with the #3673 round-8 typed
   f64 lowering decisions).
2. **`this.m2(...)` calls** where `m2` is provably a prototype method of
   the SAME class (assigned exactly once at module init, never reassigned
   — see the write-once analysis below) lower to a DIRECT `call` to
   `F_proto_<m2>_typed`, keeping `this` in its typed register. No closure
   struct, no arity probe, no `call_ref` ladder.
3. All other constructs keep their current dynamic lowering (the twin can
   always fall back to boxing at genuine `any` boundaries).

The DYNAMIC entry points stay: the prototype `$Object` still holds the
generic closure (identity for `Parser.prototype.readToken` reads,
`.call/.apply`, reflection), whose body becomes a thin shim: cast
`__current_this` to `(ref $__fnctor_F)` on success → tail-call the typed
twin; cast failure → the ORIGINAL generic body (detached `this`, patched
prototypes, subclass shapes).

## Admission analysis (compile-time, conservative)

A method `m` of fnctor `F` is admissible iff:
- `F.prototype.<m> = <function-expr>` is assigned exactly ONCE, at module
  top level (acorn's `pp.readToken = function() {…}` pattern); no other
  write to `F.prototype.<m>` or computed write to `F.prototype` exists in
  the program (reuse the fnctor escape-gate machinery that already
  classifies "approved" fnctors);
- the method body contains no `eval`/`with`/`arguments`-aliasing that the
  IR path already rejects;
- direct-call devirtualization (2) additionally requires the CALLEE to be
  admissible.

Inheritance: a fnctor with subclass shapes (two struct types for one
logical class — the #2674 `$__anon_5`/`$__fnctor_Parser` pair) admits the
typed twin against the SUPERTYPE struct only if both shapes share the
field layout prefix used by the body; otherwise skip (conservative).

## Implementation plan (slices)

- **S1 — write-once prototype analysis**: extend the fnctor escape gate
  with a per-(class, method) "assigned once at init, never reassigned"
  verdict + the field-use set of each method body. Pure analysis + tests.
- **S2 — typed twin emission for leaf methods** (no `this.m2()` calls):
  compile the twin with `this` typed; shim the generic closure. Gate:
  acorn canaries + corpus; measure (expect the `__get_member_*` +
  `__to_primitive` residue and much boxing in hot bodies to drop).
- **S3 — direct-call devirtualization** between admissible methods
  (call graph over the S1 verdicts; emit direct calls in twins).
- **S4 — numeric locals**: inside twins, keep number-typed locals as raw
  f64/i32 through expressions (the #1584 value-rep question, scoped to
  twin bodies only).

Each slice is independently landable and measurable on the #3673 bench
(`.tmp/bench-min.mjs` methodology, 330B corpus input, min-of-batches).

## S3 design notes (scoped during S1, 2026-07-27)

- **Admission facts landed (S1b)**: `otherNameWrites` (name-shadowing
  proof, with a null sentinel when any dynamic computed member write
  exists — acorn's `keywordTypes[name] = …` trips it, so S3 on acorn MUST
  use receiver-shape runtime guards, not name-only proofs) and
  `inheritedFrom` (`Object.create(F.prototype)` consumers).
- **The `self` operand is the real S3 design problem.** A direct call to
  the lifted method function needs its closure-struct `self` argument.
  The write-once closure singleton is materialized during `__module_init`
  straight into the prototype `$Object` entry — there is no global
  holding it, and anonymous function expressions get a NON-NULLABLE
  `(ref $struct)` self param, so `ref.null` cannot be passed even though
  admitted (capture-free) methods never read it. Two viable designs:
  (a) per-admitted-method singleton GLOBALS `__pm_<F>_<m>` written at the
  construction site (extend `emitClosureConstruction` to `global.tee`
  when the assignment target is an admitted prototype slot) — trampoline
  loads the global, `struct.get` funcref + `call_ref`; or (b) widen
  admitted methods' lifted self params to the nullable root (the round-5
  named-expr mechanism generalized), enabling plain `call` with
  `ref.null`. (a) is less invasive (no signature changes ripple into
  `__call_fn_method_N` entries); prefer it.
- **funcIdx staleness**: record lifted-function NAMES (funcMap is
  late-import-shift-maintained), never raw indices, in any node→function
  map added for the trampoline fill.
- **Runtime guard set** (mirrors the round-12/13 cache guards, all O(1)):
  `ref.test $__fnctor_F(recv)` + own-dynamic-props emptiness (when the
  fnctor struct carries a sidecar field) + compile-time `m ∉ F's struct
  fields`; miss → the legacy `__call_m_` path unchanged.

## S2 scoping (2026-07-27) — prerequisite refactor identified

The twin emission point is `compileArrowAsClosure` (closures.ts ~1900-
2500): the generic lifted body is compiled through ~200 lines of coupled
machinery (capture/TDZ materialization, named-expr self bindings,
savedFunc swap + liveBodies tracking, param defaults/destructuring,
`arguments` vec, string-builder detection, var/let-const hoisting,
generator/async lanes) that is NOT reusable as-is for a second
compilation of the same AST. **S2 therefore starts with an extraction
refactor**: pull the body-compilation core into a parameterized
`compileLiftedClosureBody(ctx, arrow, opts)` consumed twice — once for
the generic body (byte-identical output, verified by the full battery)
and once for the twin with `opts.typedThis = {structTypeIdx,
thisLocalIdx}`. Only then do the three lowering branches land
(property-read, assignment, compound/update on a ThisKeyword receiver
with `typedThisStructIdx` set — each an additive early-return that emits
`struct.get`/`struct.set` and returns the FIELD's unboxed ValType, which
is what lets downstream expression lowering stay numeric). Twin entry:
`this` cast once from `__current_this`; the generic body gets a 3-instr
`ref.test → forward-call` prepend. Additional S2 admission gates
discovered: no nested function-likes in the body (a second compile would
re-mint their closures), presence-tracked/optional fields excluded from
the inline branches (the dispatcher's presence check is semantic), and
`!moduleUsesDelete` (tombstone-aware reads). The shim keeps
`__current_this` semantics for all non-field uses inside the twin.

## S2 implementation notes (2026-07-27) — landed

**Step 1 (the risky one) — `compileLiftedClosureBody` extraction.** Phase 5 of
`compileArrowAsClosure` (the ~590 lines from "5. Build the lifted function
body" to the `ctx.currentFunc = savedFunc` restore) moved verbatim into
`compileLiftedClosureBody(ctx, fctx, arrow, opts)`. Minting/registering the
wasm function, the construction site and `registerClosureBindingInfo` stayed
with the caller — they must run exactly ONCE per arrow even when two bodies are
emitted. Verified **byte-identical**: the standalone acorn bench binary before
and after `cmp`s equal at 1,353,337 bytes. One non-behavioural edit was
required: `arrow` used to be narrowed to `FunctionExpression` at the
native-generator arm by TS aliased-condition analysis on `const isGenerator =
ts.isFunctionExpression(arrow) && …`; that alias no longer reaches the
extracted scope, so the arm restates a condition its own non-null
`nativeGenExprInfo` already implies.

**Why `!moduleUsesDelete` was dropped.** The scoping note listed it as an
admission gate on tombstone grounds. It is not what makes the inline branches
safe, and applying it would have made S2 a **measured no-op**: acorn contains
`delete node.operator` and `delete this.undefinedExports[name]`, so the flag is
TRUE for the entire benchmark target. The tombstone-aware read
(`tryEmitDeleteAwareDynamicGet`) is a JS-HOST lowering that runs *after* the
pinned branch in `tryPinnedAndDeleteAwareDynamicGet`, so a pinned `this`
receiver never reaches it today. What actually protects a deleted slot is the
presence-bit carve-out plus the standalone struct-delete lowering, which writes
a delete sentinel into the field itself. A regression pin covers exactly this.

**Why the inline branches are equivalent** (the load-bearing argument, restated
in full in `src/codegen/typed-this.ts`'s header): they fire only where today's
lowering is the pinned dispatcher path, and they are that path's own
`$__fnctor_F` arm inlined. The dispatcher's arm is `ref.test $C → ref.cast $C →
struct.get/set`; the twin's receiver is `ref.cast $__fnctor_F`-verified, so the
arm the dispatcher would select is that struct's own or a super/subtype's in
the same WasmGC chain, whose shared field PREFIX puts the same-named field at
the same index. The caller then immediately unboxed back via
`coerceType(externref → fieldType)`, so inlining collapses box∘unbox to the
identity.

**Measured result (this is the headline, and it is NOT what S2 alone was hoped
to deliver).** Three builds loaded into ONE process and benchmarked
round-robin, min-of-24-batches × 200 parses, 330B corpus — interleaving is what
made the signal readable, cross-process runs were pure noise at this effect
size. Five independent sessions:

| session | baseline (S1 tip) | shim only (`=shim`) | full S2 | full vs base | full vs shim |
| --- | --- | --- | --- | --- | --- |
| A | 1.5902 | 1.6652 | 1.5074 | −5.2 % | −9.5 % |
| B | 1.5102 | 1.5863 | 1.4373 | −4.8 % | −9.4 % |
| C | 1.6527 | 1.7700 | 1.5996 | −3.2 % | −9.6 % |
| D | 1.6429 | 1.7507 | 1.5400 | −6.3 % | −12.0 % |
| E | 1.6991 | 1.7804 | 1.6543 | −2.6 % | −7.1 % |

The ORDERING (`full < baseline < shim`) is identical in all five, which is the
robust result; the absolute ms wander with machine load. Median: **≈5 % faster
than baseline, ≈9.5 % faster than shim-only.** Read that as: the inline
branches are worth **≈10 %** of parse time, and the `ref.test` forward shim
gives **≈5 %** of it straight back. The shim is pure S2 scaffolding — S3's
direct calls into the twin delete it from the hot path, at which point the full
10 % banks.

**Why S2 alone cannot deliver more, and what that means for S4.** With
`JS2WASM_TYPED_THIS_DEBUG=1`, acorn gets 244 twins and 1,340 inline reads / 98
writes / 20 compounds / 98 inc-decs — essentially full coverage, with almost no
declines (top declines are `nofield:inAsync`, `nofield:canAwait` — option flags
that are not struct fields at all; **zero** presence-tracked declines). But the
per-site win is small because **`$__fnctor_Parser`'s hot fields are
`externref`**: `type`, `pos`, `options`, `start`, `value`, `strict`,
`lastTokEnd`… all boxed (`input`, `labels`, `scopeStack` are `ref_null`; only
`awaitPos`/`yieldPos`/`awaitIdentPos` are `f64` and `containsEsc`/`inModule`/
`exprAllowed` are `i32`). So `struct.get` hands back an externref and the
consumer still unboxes — S2 removes the *dispatcher call*, not the *boxing*.
The boxing is the #1584 value-rep question, i.e. **S4 is where the typed lane
pays off**, and S2's branches are the substrate it needs. Recommend
re-sequencing S4 ahead of, or alongside, S3.

**Diagnostics shipped**: `JS2WASM_TYPED_THIS=0` (kill-switch — reproduces
pre-S2 output byte-for-byte on any program), `=shim` (twins + shim, no inline
lowering — isolates shim cost from branch win; this is what produced the table
above), `JS2WASM_TYPED_THIS_DEBUG=1` (per-compile tallies + declined-field
histogram).

**Binary size**: 1,353,337 → 1,808,339 bytes (+34 %) on acorn, from duplicating
244 method bodies. If size becomes a gate, admission can be narrowed to methods
with ≥N inline sites.

**Regression evidence.** `tests/equivalence` (213 files / 1,646 tests) run on
this branch AND on the base commit `ff944acc`: **identical** — 14 failed files
/ 35 failed tests / 1,608 passed / 3 todo on both. All 14 are pre-existing
(`coercion-arithmetic-add`, `delete-sentinel`, `reflect-api`, `symbol-basic`,
`tdz-reference-error`, `yield-as-expression`, …); `coercion-arithmetic-add` was
additionally re-run alone at the base commit and fails 8/20 there too. Also
green: `DOGFOOD_ACORN=1 dogfood:acorn-corpus` (distinct REAL gaps 0),
`issue-1712` acorn differential AST parity, `issue-3673-i31-smallint`,
`issue-2151-nary`, `issue-2674-*`, `issue-3683-proto-method-write-once`, and
the 12 new `issue-3683-typed-this-twin` pins.

## Acceptance criteria

- S2: standalone acorn parse measurably faster than the #3673 round-13
  baseline (1.51ms) with corpus 23/23 exact and the full #3673 battery
  green; every admission-rejected method keeps byte-identical output.
- S3+S4: cumulative ≥5x over the round-13 baseline on the 330B bench
  (≤0.3ms/parse), putting the node-acorn gap under 10x for the first
  time.
