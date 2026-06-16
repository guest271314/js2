---
id: 1852
title: "Make dynamic-value representation explicitly per-backend (typed refs / i31ref on WasmGC; f64-value + i32-tag on linear)"
status: done
completed: 2026-06-10
sprint: Backlog
created: 2026-06-04
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
model: fable
task_type: feature
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1168, 1713, 1714, 1851]
---
# #1852 — Per-backend value representation for the dynamic residue

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R5** (P2).

## Problem

A uniform tagged value word (NaN-boxing, small-int tagging) is the right
tool **only for the genuinely dynamic residue** (`any`, reflective access,
heterogeneous unions). For typed code we already specialize on the static
type and keep the f64 fast path unboxed (`coerceType`: `__box_number`,
`extern.convert_any`, emitting `f64.const 0/NaN` directly for null/undefined
in f64 context). The gap: the **dynamic-residue representation is not chosen
per backend**, even though the right choice differs:

- **WasmGC backend:** real `ref` types + `ref.cast`/`br_on_cast` let the
  engine's type info replace a hand-carried tag for proven-monomorphic
  values; `i31ref` gives small-int-in-a-reference *for free*; fall back to a
  boxed `anyref` + tag only on the truly dynamic path.
- **Linear backend:** a value-`f64` + type-`i32` parallel-locals scheme is
  the natural dynamic representation; a uniform tagged word is the fallback.

A single cross-backend representation forces one backend onto the other's
worst case.

## Recommendation

Make the dynamic-value lowering a **per-backend decision at the
`BackendEmitter` seam** (depends on #1851). Hold the line that the boxed/
tagged form is **interchange only**: unbox at the static-type boundary for
the whole typed region (we can do at compile time what a runtime does per
loop iteration). On the GC backend, resist "make everything a reference."

## Acceptance criteria

- [ ] The IR `IrType` `union`/`boxed` lowering dispatches to a per-backend
      representation via the trait (GC: typed ref / `i31ref` / boxed
      `anyref`; linear: f64-value + i32-tag).
- [ ] Typed mainline stays unboxed on both backends (no regression in
      emitted-Wasm size/op-count for typed numeric kernels).
- [ ] `i31ref` used for small-int dynamic values on the GC backend.
- [ ] Cross-backend differential test (#1854) confirms identical observable
      behavior across the two representations.

## Implementation Plan — per-backend dynamic-value representation (RATIFIED, sd-fable-arch, 2026-06-10)

### 0. Scope and relationship to #1851 / #1924

This spec fixes the **representation** (what a dynamic-residue value *is* on
each backend). #1851 specs the **seam mechanics** (the declared type-converter
and legalization step that *consult* this decision) and is deliberately
written second, against the fixed targets below. Consistency with #1924: the
BigInt `bigint`-branded i64 ValType is backend-independent metadata; this
table maps it to a concrete carrier per backend (§4). Nothing here changes
the typed mainline — `IrType {kind:"val"}` lowering stays untouched on every
backend (§3).

Current reality this spec starts from (verified on main, 2026-06-10):

- IR `box`/`unbox`/`tag.test` lower to **inline WasmGC ops via `pushRaw`**
  (`src/ir/lower.ts:897-967`: `struct.new`/`struct.get` against
  `resolveUnion`), even though the trait already declares optional
  `emitBox`/`emitUnbox`/`emitTagLoad`/`emitNull`/`emitToExternref`/
  `emitFromExternref` (`src/ir/backend/emitter.ts:148-153`). This is a
  legalization leak in the sense of #1851.
- The IR union registry is V1-scoped to homogeneous scalar widths
  (`src/ir/nodes.ts:60-68`); ref-bearing/heterogeneous unions fall back to
  `dynamic` upstream, i.e. the legacy externref path.
- The legacy GC backend already owns a complete **anyref-domain typed-struct
  dynamic family** in standalone mode: `$box_number(f64)` / `$box_boolean(i32)`
  / `$BigInt(i64)` (`src/codegen/index.ts:8121` ff) / NativeString
  (`ctx.anyStrTypeIdx`) / `$Object` open-hash-map (object-runtime.ts), with
  `ref.test` dispatch in `__is_truthy` / `__typeof_*` / dynamic strict-eq
  (`src/codegen/index.ts:8420-8560`, `src/codegen/binary-ops.ts:1777-1850`).
- The linear backend's only emitter coverage is the #1714 vec proof
  (`src/ir/backend/linear-emitter.ts`); refs are stored as i32 handles
  (`linearStride`, linear-emitter.ts:42-55). The bytecode VM models refs as
  `f64(heapIndex)` handles (emitter.ts:176).

### 1. Normative representation table

"Dynamic residue" = values the middle-end cannot give a single `val`-kind
IrType: `any`, heterogeneous/ref-bearing unions, reflective access results.

| Backend | Typed mainline (compute) | Dynamic residue | Small int (dyn) | Interchange / boundary |
|---|---|---|---|---|
| **WasmGC** (host & standalone) | unboxed scalars (f64/i32/i64), typed `ref` structs | **anyref-domain typed heap structs** dispatched by `ref.test`/`br_on_cast`: `$box_number`, `$box_boolean`, `$BigInt`, NativeString, `$Object`, closure supertypes — i.e. the existing standalone family, promoted to *the* GC dynamic representation | `i31ref` arm before the box tests (slice G3) | `externref` is **interchange only**, at the host frontier (`extern.convert_any`/`any.convert_extern`); never a compute representation |
| **Linear** | unboxed scalars | **parallel value+tag**: a raw **64-bit value slot** + **i32 tag**. SSA values = two parallel locals (`$v: i64`, `$t: i32`); stored cells = 16-byte `[tag:u32][pad:u32][val:8B]` in linear memory | none needed — integers ride as f64 bits under `TAG_NUMBER`; no pointer/bit tagging in v1 | `i32` pointer/handle |
| **Bytecode VM** | f64 | `f64(heapIndex)` handles (existing; emitter.ts:176) | n/a | n/a — declared legal as-is, out of scope here |

**GC notes.**
- *Resist make-everything-a-reference*: the struct family applies **only** to
  the dynamic residue. A `number` variable stays a bare `f64` local; boxing
  happens at the assignment into a dynamic position, and the whole typed
  region unboxes **once** at its entry (compile-time, not per-op).
- Host mode today boxes through the host (`__box_number` → JS heap number,
  one host call per crossing). The representation decision is the same in
  both modes; what differs is **frontier placement** — host mode crosses the
  frontier often because much of the runtime lives in host imports. As
  native helpers become available in host mode too, in-module dynamic values
  use the struct family and convert to externref once at a genuine host call.
  No slice in this issue forces that migration; the decision just makes it
  legal and gives it one name.
- The host engine may itself hand back `i31ref`-backed externrefs for small
  ints (observed: `src/codegen/binary-ops.ts:2047`, the `0 == -0` i31 hazard;
  `src/codegen/map-runtime.ts:188-205` already handles i31 in ref-identity).
  Equality/dispatch code must therefore compare **unboxed values**, never raw
  refs, for numeric tags — this is already the rule in the dynamic strict-eq
  helper and stays a hard invariant for G3.

**Linear notes.**
- The value slot is **raw 64 bits**, NOT semantically f64. This is required
  by #1924: a branded-bigint dynamic value stores its i64 **losslessly**
  (`TAG_BIGINT`, value = the i64); an f64 stores its bits
  (`i64.reinterpret_f64` / `f64.reinterpret_i64` at box/unbox). A
  NaN-boxed single-word compaction is a *later, optional* optimization —
  v1 specifies the explicit two-word form because it is debuggable and has
  no bit-stealing hazards.
- Tag enum (u32, frozen order — append-only):
  `0 undefined · 1 null · 2 boolean (val=0/1) · 3 number (f64 bits) ·
  4 string (i32 handle) · 5 object (i32 ptr) · 6 closure (i32 ptr) ·
  7 bigint (i64) · 8 funcref (i32 table idx)`.
- Parallel locals for SSA values; the 16-byte cell only when a dynamic value
  is **stored** (array element, object field, capture). Alignment keeps the
  val slot 8-aligned.

### 2. The seam this spec requires (input to #1851)

One declared **DynamicRep handle** per backend, produced by the resolver and
consumed by trait methods — generalizing `IrUnionLowering`
(`src/ir/backend/handles.ts:29-38`):

- **GC handle** (exists): `{ typeIdx, tagFieldIdx, valFieldIdx, tagFor }` —
  unified with the standalone box-struct registry (G2) so legacy codegen and
  IR resolve the *same* struct per member type.
- **Linear handle** (new): `{ cell: { size: 16, tagOffset: 0, valOffset: 8 },
  tagFor(member): number }` plus the parallel-locals convention (the lowerer
  allocates `$t` alongside `$v`; the handle does not name locals).

Trait surface: promote `emitBox` / `emitUnbox` / `emitTagLoad` from optional
(`emitter.ts:148-150`) to **required for the union group**, add
`emitTagTest(layout, member, out)` (today's inline
`struct.get $tag; i32.const; i32.eq`, lower.ts:945-967), and route the three
`pushRaw` sites (lower.ts:897-967) through them (G1). `emitNull` /
`emitToExternref` / `emitFromExternref` stay declared for the ref-coercion
group (#1713 migration order). The "what value type does IrType X become on
backend Y" function — `union`→`(ref $union…)` on GC vs `(i64,i32)` pair on
linear, `boxed`→struct ref vs i32 ptr — is the **declared type-converter**
that #1851 owns; this table is its contract.

### 3. Typed-mainline-unboxed invariant (guard)

`{kind:"val"}` lowering is untouched by every slice below; no new boxing on
any typed path. Guard: an instruction-count snapshot test on a typed numeric
kernel (pick two `playground/examples/` numeric files), asserting the emitted
op count and section sizes are unchanged by G1–G4 PRs. The #1854 differential
harness then asserts cross-backend behavioral equality on the dynamic cases.

### 4. BigInt brand interaction (#1924 — keep consistent)

Per #1924's ratified invariant, the brand never changes compute ops; it
selects the **carrier at the dynamic frontier**:

| Backend | branded `i64` in dynamic position |
|---|---|
| GC | `$BigInt (struct (field i64))` — landed (`src/codegen/index.ts:8121-8135`) |
| Linear | `TAG_BIGINT` + i64 in the raw value slot (lossless; no f64 round-trip) |

The #1854 differential suite for this issue MUST include bigint rows
(`1n+2n`, `typeof 1n`, `0n` truthiness, `1n+1` TypeError, `BigInt("10")===10n`)
— they exercise exactly the tag/carrier split.

### 5. Slices (migration path from externref-everywhere)

- **G1 — route IR box/unbox/tag.test through the trait.** Replace the three
  inline `pushRaw` blocks (lower.ts:897-967) with `emitBox`/`emitUnbox`/
  `emitTagLoad`+`emitTagTest`; implement them in `WasmGcEmitter`
  byte-identically (existing struct ops). No behavior change; closes the
  union-group legalization leak. ~80 LOC. medium, dev-claimable.
- **G2 — one GC box-struct registry.** The standalone family
  (`$box_number`/`$box_boolean`/`$BigInt`/NativeString/`$Object`) is
  registered by legacy codegen (`index.ts:8121` ff); `IrBoxedLowering` /
  `resolveBoxed` registers separate single-field boxes. Unify behind one
  resolver so `ref.test` dispatch (typeof/truthiness/equality, #1888's
  open-any dispatch) sees ONE type per member in a module regardless of
  which path allocated it. medium-hard; coordinate with #1888.
- **G3 — `i31ref` small-int arm (GC).** In dynamic positions, box i32-domain
  small ints as `i31ref` (free allocation) and add the `ref.test i31` arm
  ahead of the `$box_number` test in typeof/truthiness/equality. Hazards to
  encode in tests: `0 === -0` (i31 zero vs boxed -0.0), NaN, the 31-bit
  range cutoff (fall back to `$box_number` outside). hard, senior-dev;
  gated on the #1854 differential harness.
- **G4 — linear dynamic cell.** Implement §1's value+tag scheme in
  `LinearEmitter`: `emitBox`/`emitUnbox`/`emitTagLoad`/`emitTagTest` over
  parallel locals + the 16-byte stored cell; extends the #1714 follow-up
  scope. hard; blocked by G1 (trait surface) and #1851 (type-converter).
- **G5 — differential gates (#1854).** Dynamic-residue rows (number/string/
  bool/null/undefined/object/closure/bigint round-trips, typeof, truthiness,
  `===`) running WasmGC vs linear vs bytecode. Blocks G3/G4 merges.

Existing issues that become slices / consumers of this decision:
#1168 (IrType overlay → lets the tagged-unions pass actively rewrite
externref unions into G1's representation), #1713/#1714/#1715 (trait
migration the slices ride on), #1888 (open-any dispatch = G2's `$Object` +
closure arms), #1471 (no-JS-host boxing — the G2 family's origin), #1854
(G5). #1851 consumes §2 as its type-converter contract.

### 6. Acceptance criteria mapping

- "per-backend representation via the trait" → G1 (GC) + G4 (linear).
- "typed mainline stays unboxed" → §3 guard, asserted on every slice PR.
- "i31ref for small-int dynamic values on GC" → G3.
- "cross-backend differential test confirms identical behavior" → G5 rows
  above; #1854 harness is the vehicle.
