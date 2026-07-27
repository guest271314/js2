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

## Acceptance criteria

- S2: standalone acorn parse measurably faster than the #3673 round-13
  baseline (1.51ms) with corpus 23/23 exact and the full #3673 battery
  green; every admission-rejected method keeps byte-identical output.
- S3+S4: cumulative ≥5x over the round-13 baseline on the 330B bench
  (≤0.3ms/parse), putting the node-acorn gap under 10x for the first
  time.
