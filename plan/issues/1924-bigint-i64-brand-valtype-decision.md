---
id: 1924
title: "architect decision: BigInt value representation — i64-bigint-brand ValType vs TS-type-driven boxing (gates #1644 slices, implicated in #1919 i64 ABI bucket)"
status: done
completed: 2026-06-10
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: planning
area: codegen, ir
language_feature: bigint
goal: core-semantics
related: [1644, 1349, 1919, 1852]
origin: "Standing gate recorded since sprint 50: #1349/#1644 BigInt slices are blocked on an architect ratifying the i64-bigint-brand ValType design; the 2026-06-10 standalone gap review surfaced ~230 async-generator invalid-Wasm rows with `call[0] expected i64, found extern.convert_any` (#1919), which sit on the same representation boundary."
---

# #1924 — BigInt representation decision (i64-bigint-brand)

## Problem

BigInt values currently ride as externref (host-boxed) while native `i64`
numeric code uses raw i64 — and the type system cannot tell a "BigInt-shaped"
value from either neighbor. Consequences:

- Typed paths emit `f64.add` on externref BigInt operands → `illegal_cast`
  (#1644's core bucket; `built-ins/BigInt` pass rate stuck at 39%).
- `BigInt(x)`, `asIntN`/`asUintN`, mixed-operand TypeError semantics
  (`1n + 1` must throw) have no brand to dispatch on.
- Boxing *all* i64→externref as BigInt would break native i64 numeric code
  (the `type i64 = number` annotation feature), so the distinction must be
  carried in the type system, not guessed at coercion sites.
- The #1919 standalone bucket (`call[0] expected type i64, found
  extern.convert_any` in async-generator destructuring, ~230 tests) sits on
  this same i64↔externref ABI boundary — diagnose whether it is the same
  representation confusion or an unrelated async-gen ABI bug, and record the
  answer here either way.

## Decision to ratify (from #1644's analysis)

Choose and specify one:

- **(a) `bigint`-branded ValType** — `{kind: "i64", bigint: true}` threaded
  through type inference and **every coercion site** (`coerceType`,
  `__typeof`, truthiness, arithmetic dispatch, boxing round-trips). Honest
  and explicit; the cost is the cross-cutting thread through
  `src/codegen/type-coercion.ts` and the IR ValType union.
- **(b) TS-type-driven boxing decisions** — use `ctx.checker` at call sites
  to decide boxing; `coerceType` keeps seeing plain ValType. Cheaper to
  introduce, but pushes brand knowledge to call sites and risks divergence
  (the exact pattern that produced the #1919-style mismatches).

Constraints the ratified design must satisfy:

- GC/host mode and standalone mode lower **identically** at this boundary
  (the #1644 "ratify once, both modes" invariant).
- Native `i64` annotation code keeps raw-i64 performance (no boxing).
- `typeof 1n === "bigint"`, mixed-arithmetic TypeError, and `asIntN/asUintN`
  wrap semantics are all expressible via the brand.
- Standalone mode has a pure-Wasm story (i64 pair / struct for >64-bit
  values is out of scope; document the supported range honestly).

Deliverable: `## Implementation Plan` in this issue with the chosen
representation, the list of consultation sites (boxing, `__typeof`,
truthiness, arithmetic, equality/`isSameValue`), and re-sized #1644 slices.

## Why model: fable

One-shot, expensive-to-reverse representation decision that ripples through
every coercion site and both backends — the same class of decision as #1852
(per-backend value representation), with which it must stay consistent.

## Acceptance criteria

- A ratified representation design recorded here; #1644 unblocked with
  re-sized slices referencing it.
- The #1919 `i64`/`extern.convert_any` async-gen bucket is attributed (same
  root cause or explicitly ruled out), with the evidence cited.
- No regression in native-i64 benchmark code paths
  (`benchmarks/` numeric suites) under the chosen design.

## Implementation Plan — RATIFIED (sd-fable-arch, 2026-06-10)

### Decision: option (a), `bigint`-branded ValType — re-ratified against current main

The decision this issue asks for was first ratified in #1644 (2026-05-27) and
is **already implemented and merged on main** (verified on `8ba0a82b6`,
2026-06-10). The "standing gate since sprint 50" framing is stale: #1349 is a
`wont-fix` duplicate redirect, and #1644's Slices A–D plus the standalone E1
carrier are landed. This section re-ratifies option (a) against the *current*
code with fresh citations, records the constraint matrix, re-sizes the
residual #1644 slices, and settles the #1919 attribution (ruled OUT — see
below).

**Why (a) stands, re-confirmed:** `coerceType` receives `from`/`to: ValType`
at every frontier — including post-AST fixup sites (stack-balance repairs,
trampoline coercions) where no `ts.Node`/`ctx.checker` view exists. Option (b)
would push brand knowledge to call sites and re-create the divergence class
this brand was introduced to kill. The brand is compile-time-only metadata:
it never changes the emitted i64 instruction, only (1) the boxing instruction
at the i64↔externref frontier and (2) the mixed-operand TypeError gate.
`{ kind: "i64" }` with the flag unset keeps today's native-i64 meaning with
zero edits, which is what protects `type i64 = number` annotation code.

### Verified consultation-site inventory (main @ 8ba0a82b6)

The full set of sites that consult `bigint` on the i64 ValType today:

**Brand producers:**
- `src/ir/types.ts:115` — `{ kind: "i64"; bigint?: boolean }` ValType variant.
- `src/codegen/expressions.ts:816` — BigInt literal → branded i64.
- `src/codegen/expressions/calls.ts:7910-7946` — `BigInt(x)` /
  `BigInt.asIntN/asUintN` results (incl. compile-time literal folds).
- `src/codegen/expressions/identifiers.ts:314,864` — bigint-typed
  identifier reads re-emit the brand (storage round-trip, §3 of the
  #1644 spec).
- `src/codegen/binary-ops.ts:1178-1183` — both-bigint i64 arithmetic result
  re-branded (propagation).

**Brand consumers (boxing frontier):**
- `src/codegen/type-coercion.ts:1493-…` — `i64 → externref`: branded →
  `__box_bigint`; unbranded → `f64.convert_i64_s` + `__box_number`
  (byte-identical to pre-brand output — the native-i64 no-regression
  guarantee).
- `src/codegen/type-coercion.ts:1393-…` — `externref → i64`: branded target
  → `__to_bigint` (§7.1.13 ToBigInt); unbranded → `__unbox_number` path.

**Dispatch / semantics sites:**
- `src/codegen/binary-ops.ts:955-1132` — BigInt operator dispatch: pure-bigint
  → i64 ops; mixed bigint+number arithmetic → TypeError
  (`emitThrowTypeError`, binary-ops.ts:1130); mixed loose-eq → exact
  mathematical-value compare (#1827, binary-ops.ts:989-1011); mixed
  strict-eq → constant false/true.
- `src/codegen/binary-ops.ts:1777-1850` — standalone dynamic strict-equality:
  bigint arm via `__typeof_bigint` ×2 + `__to_bigint` ×2 + `i64.eq`
  (value compare, NOT `ref.eq` — the #1644 Slice-E4 requirement, done).
- `src/codegen/typeof-delete.ts:700,1023` — `typeof` → `"bigint"` via TS
  type flags (static) and `__typeof_bigint` (dynamic).
- `src/codegen/index.ts:8121-8135` — standalone `$BigInt`
  `(struct (field i64))` carrier type; `index.ts:8242` native `__box_bigint`
  (struct.new); `index.ts:8304-8311` native `__to_bigint` (ref.test +
  struct.get); `index.ts:8350-8357` native `__bigint_ctor`;
  `index.ts:8525-8540` native `__typeof_bigint` (`ref.test $BigInt`).
- `src/codegen/index.ts:8476-8492` — native `__is_truthy` bigint arm
  (`struct.get` + `i64.eqz`; `0n` falsy).

**Runtime (JS-host mode):** `__box_bigint` (identity over the
JS-BigInt-integration boundary), `__to_bigint`, `__bigint_ctor` host bodies in
`src/runtime.ts`; registered at `src/codegen/index.ts:7835` ff.

### Constraint matrix (acceptance check)

| Constraint | Status | Evidence |
|---|---|---|
| GC/host and standalone lower identically at the brand boundary | HOLDS | brand ValType identical in both modes; only the frontier instruction pair differs (`__box_bigint` host import vs native `struct.new $BigInt`) — type-coercion.ts branches on `funcMap` presence, not on a different ValType |
| Native `i64` annotation keeps raw-i64 perf | HOLDS | flag unset ⇒ every path byte-identical to pre-brand output; CI-guarded by `tests/issue-1644.test.ts` |
| `typeof 1n === "bigint"` | HOLDS both modes | typeof-delete.ts:700/1023 + native `__typeof_bigint` |
| mixed-arithmetic TypeError | HOLDS | binary-ops.ts:1116-1131 (`1n + 1` throws a real TypeError instance) |
| `asIntN`/`asUintN` | HOLDS (host); standalone via E1 carrier | #1644 Slice C note + calls.ts:7910ff |
| standalone pure-Wasm story, honest range | HOLDS, i64-only | `$BigInt` struct carrier; >64-bit out of scope (documented in #1644 Slice E spec) |

### Known residual divergence (recorded, not a blocker)

`compileBinaryOp` keys its BigInt dispatch off **TS checker types**
(`isBigIntType(leftTsType)`, binary-ops.ts:955), not off the compiled
`InnerResult` brand — a leftover option-(b)-style consultation that predates
the brand. It works because the checker reliably types bigint
literals/annotations; the failure mode is `any`-typed bigint values falling
into numeric dispatch (the dynamic strict-eq path already covers `any`
equality with its bigint arm). Tracked as re-sized slice F below; low
priority, do NOT bundle into unrelated PRs.

### Re-sized #1644 residual slices (unblocked by this ratification)

A–D and E1/E4 are MERGED. Open, independently claimable:

- **E2′ — native dynamic `BigInt(string)` parse (standalone).** Replace the
  SyntaxError stub in native `__bigint_ctor`
  (index.ts:8412 "Cannot convert string to a BigInt in standalone mode") with
  an i16-array digit parser (decimal/0x/0o/0b, optional `-`, whitespace trim,
  SyntaxError on malformed) reusing the #1685/#1335 native string↔number
  machinery. ~80-120 LOC. feasibility: medium, dev-claimable.
- **E3′ — native standalone `BigInt.prototype.toString(radix)`.**
  `bigint_toString`/`bigint_toString_radix` are host-import-only today
  (calls.ts:6823-6831 funcMap lookups). Generalise the native
  integer→string-radix routine to an i64 entry point; keep the radix∉[2,36]
  RangeError. ~60-80 LOC. feasibility: medium, dev-claimable.
- **F — brand-driven operator dispatch unification.** Migrate
  binary-ops.ts:955 dispatch from `isBigIntType(tsType)` to the operand
  `InnerResult` brand per the #1644 §6 single-source-of-truth intent.
  Touches the hot dispatch path; senior-dev, low priority.
- Host-class wrapper items (`is-a-constructor`, wrapper-object) remain with
  #1568 — out of #1644 scope.

Consistency note for #1852 (per-backend value representation): the
`$BigInt` struct vs JS-host boxed-bigint pair is a worked instance of the
per-backend representation table #1852 will specify; the brand ValType is the
backend-independent layer. #1852's spec must keep that split.

## #1919 attribution — i64/extern.convert_any async-gen bucket: RULED OUT as BigInt representation confusion

**Verdict: NOT this representation surface. It is a stale function index from
the late-import shift class (#1923 / #1109 / #1384 lineage) in the
nested-async destructured-param path. `__box_bigint` and its i64 param are
innocent bystanders.**

Evidence (reproduced on main @ 8ba0a82b6, standalone target):

1. Compiled the representative test
   (`language/statements/async-generator/dstr/obj-ptrn-prop-ary-trailing-comma.js`,
   wrapped via `wrapTest`); instantiation fails with exactly the bucket
   signature: `Compiling function "f" failed: call[0] expected type i64,
   found extern.convert_any of type (ref extern)`.
2. WAT (binaryen `wasm-dis`) shows the failing instruction is the
   **destructuring null/undefined TypeError throw** in `f`'s param prologue —
   `buildDestructureNullThrow` (src/codegen/destructuring-params.ts:247-252)
   emitting `pushMsg(); call <idx>; throw` where `<idx>` should be
   `__new_TypeError(externref)→externref`. The encoded index is **exactly one
   slot low** and lands on `__box_bigint(i64)→externref`, the defined function
   emitted immediately before `__new_TypeError` by the standalone union-helper
   block. No BigInt value, literal, annotation, or coercion exists anywhere in
   the test.
3. Minimal repro (no test262 harness): a **nested** `async function*` with a
   destructured parameter under `--target standalone`. Top-level async
   generators refuse loudly (#680); nested ones slip past the gate and
   compile. A nested `async function` (non-generator) with a destructured
   param produces the same class with a different bystander signature
   (`call[0] expected type i32`) — proving the "expected i64" is whatever
   function happens to sit at the stale index, not an i64 ABI.
4. Instrumented trace of the compile: the throws bake
   `call funcIdx=49` while `numImportFuncs=14`; four late imports then land
   (`__array_from_iter_n`, `__get_undefined` during `f`'s own param
   destructuring; `Promise_resolve`, `Promise_reject` later) each followed by
   a `flushLateImportShifts`. The baked calls end at 52 while
   `__new_TypeError` ends at 53 — **exactly one of the four +1 repairs missed
   the throw's instruction arrays** (detached-subtree window: the arrays are
   built before being appended to any container the shift walker visits).
   This is precisely the #1923 index-shift class; #1923's emit-time total
   index validation would have caught it at compile time.

Consequence for #1919: the ~230-row bucket belongs to the
late-import-shift fix lane (likely shared root with the ~150-row
`if[0] expected i32, found call` async-gen sibling bucket — same nested-async
destructure window, boolean-position variant). It does NOT gate on, and is
not fixed by, any #1644 BigInt slice. The repro recipe above (nested async
fn/gen + destructured param, standalone) is the regression test seed.
