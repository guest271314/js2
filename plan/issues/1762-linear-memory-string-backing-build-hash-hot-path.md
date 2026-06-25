---
id: 1762
title: "perf(strings): linear-memory string backing for the build/hash hot path — drop the WasmGC (array i16) GC barrier"
status: wont-fix
needs_arch_spec: false
created: 2026-05-31
updated: 2026-06-26
slice0_verdict: "2026-06-26 (sd-typedarray): NO-GO. Warm wasmtime/Cranelift measurement — the (array i16) representation is ~3-10% of the hash-loop cost once the descriptor is hoisted; the dominant 1.66-1.8x is per-iter struct.get reloads + flatten call + f64 |0 emulation (all codegen on the existing rep). LinearString keeps a GC descriptor so it wouldn't fix the dominant cost. Linear approach SUPERSEDED. Redirect = codegen hoist + i32-hash-path (see ## Slice 0 — EXECUTED)."
arch_spec_landed: "2026-06-26 (sd-typedarray): ## Implementation Plan settles representation (LinearString GC descriptor + linear char data), boundary, alloc/lifetime, host interop. KEPT as the design-exploration record (#2086); the approach it specs was then measured NO-GO in Slice 0."
priority: high
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
language_feature: strings
goal: spec-completeness
sprint: 66
related: [1746, 1580, 679, 682, 1714]
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): GENUINELY OPEN — stays ready. CORRECTION: #1762 is NOT gated on #1760 (the #1760 warm-runtime bench lane is the measurement harness, in-flight PR/owner sdev-strback, and only validates the perf win — it does not block design). #1762 is gated ONLY on a missing architect `## Implementation Plan` settling the backing-store representation + the WasmGC↔linear-memory boundary. NO dev should claim this until an architect spec lands — route through /architect-spec first. NEEDS-ARCH-SPEC, do NOT mark done."
---
# #1762 — linear-memory string backing for the build/hash hot path

Carved out of the #1746 umbrella as **lever #6 (linear-memory backing for char
data)**, which the native differential added by PR #997 identified as the
**strategic representation-level ceiling** for both the build and hash loops.

> **This likely needs an architect spec before dev dispatch.** The backing-store
> representation choice is a *strategic, dual-backend* decision, not a localized
> patch — route through `/architect-spec` (or set `status: needs-arch-spec`)
> first so the representation and its interop boundary are designed before code.

## Why this is the ceiling (from #1746's native differential)

The native differential disassembled both hot loops against V8 TurboFan. Even
after lever #1 (i32 hash path) and even *if* lever #3 (#1761 presize) lands, the
WasmGC `(array i16)` representation itself imposes a per-iteration floor that
Cranelift cannot optimize away:

**Hash loop (per `charCodeAt` iteration)** carries:
- a **GC read barrier** on `array.get` of the `(ref (array i16))`;
- **two un-hoistable WasmGC struct-field reloads** — `length` and `offset`
  reloaded every iteration because Cranelift can't prove the WasmGC ref is
  loop-invariant (the ref is opaque to it);
- an **array bounds check** + two element-address overflow traps.

Of ~50 native insns/iter, only `ldrh` + `madd` is real work; the rest is the
above representation tax.

**Build loop (per append)** carries a **GC write barrier on every `array.set`**
into the buffer (60,000 barriered stores), on top of the per-append machinery.

A flat **linear-memory** byte/`i16` buffer makes:
- appends → raw `i32.store16` (no GC write barrier);
- reads → raw `i32.load16_u` (no GC read barrier, no opaque-ref struct reloads);
exactly what V8's **sequential-string backing store** is. That is the ceiling for
**both** loops — the `(array i16)` representation is itself the thing standing
between us and V8 once #1761 removes the reallocs/cap-check.

## Framing — the dual-backend decision

This mirrors the established dual-backend pattern in the codebase and must be
designed the same way (keep WasmGC for the general object model; route the *hot
string path* through linear memory):

- **#679** — dual string backend (WasmGC i16 array vs `wasm:js-string`).
- **#682** — dual RegExp backend.
- **#1714** — linear-memory IR backend.

i.e. add a **linear-memory string representation** as an alternative backing for
the build/hash hot path under `--target wasi --nativeStrings`, without disturbing
the WasmGC object model elsewhere. The architect spec must define: the
backing-store layout (ptr/len/cap in linear memory), the `String`↔linear-memory
boundary (where a linear-memory string is created, consumed, and converted to/from
the WasmGC `$NativeString` when it escapes the hot path), allocation/lifetime
(bump vs freelist; interaction with GC of the surrounding object), and the
interop story with the JS-host string path.

## Scope / guard

- Confined to the hot string build/read path; the general WasmGC object model and
  the JS-host string backend stay as-is.
- The linear-memory-backed string must be **observably identical** to the WasmGC
  `(array i16)` string for every operation that can reach it (length, indexing,
  charCodeAt, concat, comparison, escape to host) — full result parity, no
  behaviour change.
- Gate behind the representation/target choice the architect spec settles; no new
  host import without a standalone fallback (project dual-mode rule).

## Acceptance

- An architect implementation spec in this issue file (`## Implementation Plan`)
  settling the backing-store representation and the WasmGC↔linear-memory boundary
  **before** dev dispatch.
- A linear-memory string builder/reader prototype for the build/hash hot path,
  measured via the **#1760** in-process bench: a warm drop on **both** the build
  loop and the hash loop beyond what #1761 alone achieves, with honest provenance
  (drop exceeds combined std; no gaming the #1580 30 ms gate).
- Native re-diff (per #1746's method) showing the build-loop `array.set` GC write
  barrier and the hash-loop GC read barrier + struct-field reloads are gone for
  the linear-memory path.
- Result-parity regression tests across both string backends and representative
  inputs; zero test262 regressions.
- Refresh the committed benchmark JSON and keep the #1580 staleness gate green.

## Implementation Plan (architect spec, 2026-06-26, sd-typedarray)

> Verified against current `main` (6d1b24089581). All file:line anchors below
> were re-checked on this tree — they drift, re-grep before coding.

### Ground truth — the current native-string representation (`registry/types.ts:307` `registerNativeStringTypes`)

| type | idx field | layout | role |
| --- | --- | --- | --- |
| `__str_data` | `ctx.nativeStrDataTypeIdx` | `(array (mut i16))` | the WTF-16 char backing array |
| `AnyString` | `ctx.anyStrTypeIdx` | `struct { len:i32 }` (super=-1) | **universal string handle** — every helper signature is `ref $AnyString` |
| `NativeString` (flat) | `ctx.nativeStrTypeIdx` | `struct { len:i32, off:i32, data: ref $__str_data }` (super=AnyString) | flat leaf; `off` enables O(1) substring views |
| `ConsString` (rope) | `ctx.consStrTypeIdx` | `struct { len:i32, left: ref $AnyString, right: ref $AnyString }` (super=AnyString) | O(1) concat node |

- **Build hot path** (`a + b`, `native-strings.ts:1363` `__str_concat`): `len ≥ 64`
  → `struct.new $ConsString(len, a, b)` (rope; 2 ref fields = GC alloc + write
  barriers). `len < 64` → flatten both + copy into a fresh `__str_data` via
  `array.set` (the per-store **GC write barrier** the #1746 differential measured).
  Rope→flat happens in `__str_copy_tree` (`native-strings.ts:285`), an `array.set`
  loop over the leaves.
- **Hash/read hot path** (`charCodeAt(i)` in a loop): the receiver is flattened
  (`__str_flatten`) to a `NativeString`, then each read is
  `array.get $__str_data (data, off+i)` — **GC read barrier** + the three
  un-hoistable opaque-ref **struct-field reloads** (`len`/`off`/`data`) per
  iteration (Cranelift can't prove the `ref` loop-invariant). This is the floor
  #1746 identified.

### Where linear memory exists today (the gate)

- **No linear memory in default WasmGC mode** — `WasmModule.memories` starts `[]`
  (`src/ir/types.ts:467`); the ONLY `mod.memories.push()` is WASI-gated
  (`index.ts:5973`, `min:3` pages, exported `"memory"`). Reserved low region:
  `memory[0..7]` iovec, `memory[8..11]` nwritten (`index.ts:6563`).
- **The linear backend** (`src/codegen-linear/`) already has the allocator we
  reuse the *design* of: `__heap_ptr` global (`HEAP_START=1024`), `__malloc(size)`
  8-byte-aligned bump + on-demand `memory.grow` (`codegen-linear/runtime.ts:52-164`),
  and a linear string layout `[hdr 8B][len u32][utf8…]` (`runtime.ts:1071`).
- **⇒ Representation gate:** the linear-memory string backing is enabled only when
  a linear memory is present — **`ctx.wasi` today** (WASI auto-enables
  `nativeStrings`; matches the issue's `--target wasi --nativeStrings` scope).
  Default-browser WasmGC keeps `NativeString`/`ConsString` unchanged (no memory to
  point into). A future `--target standalone` memory would widen the gate; out of
  scope here.

### D1 — Representation: a new `LinearString` subtype of `$AnyString`; char data in linear memory, descriptor stays GC

Add a 4th string type, registered **up-front and append-only** in
`registerNativeStringTypes` (so its type index never shifts — the
`project_type_index_shift_and_deadelim` discipline; the new type goes LAST so the
existing `anyStr`/`nativeStr`/`consStr` indices are unchanged):

```
LinearString  struct { len:i32, ptr:i32, off:i32 }   (super = AnyString)
```

- `ptr` = **byte offset into the WASI linear memory** of the WTF-16 char data
  (`len` i16 code units at `ptr + off*2 ..`); `off` preserves the substring-view
  semantics `NativeString.off` has.
- The **descriptor is a GC struct** (so a `LinearString` IS a `ref $AnyString` and
  flows through every existing consumer unchanged as the universal handle), but the
  **char bytes live in linear memory** — so hot reads/writes touch raw memory with
  **no GC barrier** and a **transparent i32 base pointer** Cranelift can hoist.
- This is exactly V8's sequential-string model (small GC-traced header + pointer
  to an off-heap backing store) — the ceiling the issue targets, reached without
  abandoning the `ref $AnyString` invariant.

**Why a GC descriptor, not a pure i32 handle:** every string helper signature is
`ref $AnyString` (`native-strings.ts:228`); a pure-i32 handle would force a
representation flag through hundreds of call sites and break `ref.test`-based
dispatch. Keeping the descriptor GC-managed confines the change to (a) the type
table, (b) the create sites, (c) the hot read/build fast paths, and (d) a single
new arm in the universal consumers.

### D2 — The WasmGC↔linear boundary (create / read / build / escape)

- **Create** (WASI only): (i) a string **literal** materialized in WASI mode
  bump-allocates `len*2` bytes, stores the i16 units with `i32.store16`, and
  `struct.new $LinearString(len, ptr, 0)` instead of the current
  `array.new_fixed`+`NativeString` (`native-strings.ts:362`
  `compileNativeStringLiteral`); (ii) the **flatten** sink and the **builder**
  (D4) produce `LinearString` directly.
- **Read fast path** (the hash-loop win): `charCodeAt`/index/`[i]` on a value
  statically known (or `ref.test`-proven) to be `LinearString` lowers to
  `i32.load16_u (memBase + (ptr + (off+i)*2))` — base pointer loaded **once**,
  hoistable; no `array.get`, no struct-field reload. Add this arm at the
  `charCodeAt` lowering (`binary-ops.ts:1578` region + the string-method path) and
  in `__str_flatten` (a `LinearString` input flattens to itself, O(1)).
- **Build fast path** (the build-loop win): see D4.
- **Escape / universal consumers** — `__str_flatten` (`native-strings.ts`),
  `__str_concat` (`:1363`), `__str_eq`/compare, `__str_copy_tree` (`:285`), and any
  `struct.get $NativeString data` site must gain a **`ref.test $LinearString`
  arm**. Because WASI has **no JS host**, the only "escape" is to these in-module
  helpers — there is NO `wasm:js-string`/externref conversion to design (that is
  the non-`nativeStrings` host backend, which never creates a `LinearString`). A
  `LinearString` reaching a helper that genuinely needs an `(array i16)` (rare —
  e.g. a path not yet given a linear arm) converts via a one-shot
  `__str_lin_to_flat` (copy `len` i16 from memory into a fresh `__str_data`) —
  **refuse-loud / convert, never read the wrong field**. Inventory of `struct.get`
  sites keyed on `nativeStrTypeIdx` data/off must be enumerated in Slice 1 (grep
  `struct.get .* nativeStrTypeIdx`) and each given a `ref.test` dispatch or routed
  through the shared accessor.

### D3 — Allocation / lifetime (bump now, arena later)

- Reuse the WASI memory. Add a `__str_heap_ptr` bump global initialized **past the
  reserved iovec/nwritten scratch** (`memory[0..11]`) — e.g. start at a page
  boundary (`65536`) to keep fd_write scratch and the string heap disjoint; grow
  via `memory.grow` on exhaustion (mirror `codegen-linear/runtime.ts:83-142`
  `__malloc`, 2-byte alignment is enough for i16 data).
- **GC interaction / lifetime tradeoff (the honest cost):** char bytes are **not
  GC-traced**; the bump allocator **never frees**, so a collected `LinearString`
  descriptor leaves its char bytes resident. For the hot path (build a big string,
  hash it, drop it) and for benchmark/short-lived WASI programs the leak is bounded
  by total string bytes and is dwarfed by the per-iteration barrier win. **Slice 1
  ships bump-only and documents this.** A follow-on (separate issue) adds a
  string-arena reset at statement/region boundaries or a size-classed freelist;
  pure-Wasm has no finalization hook to tie char-data lifetime to the GC descriptor,
  so the arena/region approach (not refcounting) is the right long-term answer.
- **Builder presize couples to #1761:** the build loop bump-allocates ONE buffer
  sized from the presized capacity (#1761) and appends in place with `i32.store16`
  (no per-append alloc, no per-store GC write barrier) → one allocation per built
  string, not per append. This is where the "60,000 barriered stores → 0" win lands.

### D4 — Slicing (each a full-gate PR; measure on #1760 before widening)

- **Slice 0 (measure-first, no land):** prototype the `LinearString` read arm for
  `charCodeAt` only; run the #1760 warm bench (`scripts/generate-wasmtime-hot-runtime.mjs`,
  the `warm(__n)` string-hash program) and a native re-diff (per #1746) to CONFIRM
  the GC read barrier + 3 struct reloads are gone and the warm hash-loop drop
  exceeds combined std. Go/no-go gate before committing the type-table change.
- **Slice 1 (read path):** register `LinearString` (append-only); create it for
  string literals + the flatten sink under `ctx.wasi`; `charCodeAt`/index fast
  path; `ref.test` arms in `__str_flatten`/`__str_eq` + the enumerated `struct.get`
  consumers; `__str_lin_to_flat` escape. **Acceptance:** hash-loop warm drop on
  #1760; full result-parity (length/index/charCodeAt/compare/concat/substring/
  for-of) vs the WasmGC backend across representative inputs; zero test262
  regressions (WASI + default both green — default is byte-unchanged since the new
  type is unreachable without a memory).
- **Slice 2 (build path):** presized linear builder (`i32.store16` appends) for the
  `s += c` and `Array.prototype.join` hot paths (couple to #1761); `__str_concat`
  short-string arm builds a `LinearString`. **Acceptance:** build-loop warm drop;
  native re-diff shows the `array.set` write barrier gone; parity + zero regressions.
- **Slice 3 (consolidation):** rope-flatten sink emits `LinearString`; sweep
  remaining `struct.get $NativeString` consumers; refresh committed benchmark JSON;
  keep the #1580 30 ms staleness gate honest (no gaming).

### Risks / guards

- **R1 — type-index shift.** Register `LinearString` LAST in
  `registerNativeStringTypes` (append-only) so `anyStr`/`nativeStr`/`consStr`
  indices are byte-identical; default-mode binaries must be **byte-unchanged**
  (the type is registered but unreachable without a memory — verify with a
  host-mode WAT identity guard on a string program).
- **R2 — missed consumer reads the wrong field.** A `LinearString` whose `ptr` is
  mis-read as a `ref $__str_data` is a hard trap. Gate EVERY `data`-field read
  behind `ref.test $LinearString` first, OR route all char access through one
  shared `emitStrCharAt(ctx, …)` accessor that branches on the subtype. Enumerate
  the `struct.get …nativeStrTypeIdx` sites in Slice 1; none may read `data`/`off`
  without the dispatch.
- **R3 — fd_write scratch collision.** The string heap must start past
  `memory[0..11]`; pick a page boundary and assert disjointness.
- **R4 — dual-mode parity (the #679/#682 invariant).** A `LinearString` must be
  **observably identical** to a `NativeString` for every op that can reach it.
  Slice 1's parity suite runs the SAME programs through both backends and diffs
  results (length, index, charCodeAt, ===, <, concat, substring, escape-to-host).
  No behaviour change; perf-only.
- **R5 — leak/lifetime.** Documented bump-only tradeoff (D3); ship behind the WASI
  gate, carve the arena/freelist follow-on as a separate issue, do not block Slice 1
  on it.

### Dispatch readiness

This settles the representation (`LinearString` GC descriptor + linear char data),
the boundary (create/read/build/escape with `ref.test` dispatch; no host-string
interop needed under WASI), allocation/lifetime (bump-now/arena-later), and the
JS-host interop story (untouched — gated to the no-host WASI lane). Slice 0
(measure-first) is the recommended dev entry; it de-risks the whole feature before
the type-table change lands. Dev task #3 (the prototype) can proceed from Slice 0.

## Slice 0 — EXECUTED (2026-06-26, sd-typedarray) — VERDICT: NO-GO for the linear representation

The measure-first gate ran. **Decision: NO-GO** — the linear-memory string
representation is NOT the hash/build hot-path win #1746 hypothesized. The full
read/build/consolidation impl (dev task #3) is CANCELLED. `status` set to
`wont-fix` (linear-representation approach superseded). The redirect below is the
real lever.

### Measurement (warm, wasmtime/Cranelift 44.0 — the WASI engine #1762 targets and #1746's own engine; two-point method t(2N)−t(N) to cancel startup+compile; stable across runs)

Three hand-WAT variants isolating EXACTLY the representation variable (a 1024-elem
buffer, identical hash arithmetic, differing only in the char-read + whether the
descriptor fields are hoisted) — `.tmp/measure.py` + `.tmp/{lin,gc_hoist,gc_reload}.wat`:

| variant | char read | ns/read |
| --- | --- | --- |
| linear (`i32.load16_u`, hoisted base) | linear memory | **0.82–1.01** |
| WasmGC `array.get_u`, descriptor **hoisted** into locals | (array i16) | **1.03–1.11** |
| WasmGC `array.get_u`, struct fields **reloaded** per iter | (array i16) | **1.70–2.00** |

### The decisive findings (these REFUTE the issue's central hypothesis)

1. **The `(array i16)` REPRESENTATION is NOT the per-iteration floor.** Once the
   descriptor fields are hoisted, `array.get_u` ≈ `i32.load16_u` within **~1.03–1.30x
   (3–30%, noise-dependent; typically ~3–10%)**. Cranelift optimizes the array
   read barrier / bounds check well. The representation is a **minor** cost.
2. **The DOMINANT cost (1.66–1.8x) is per-iteration `struct.get` RELOADS** of
   len/off/data. The real compiler `$hashStr` loop (`string-ops.ts:2230`) is heavier
   still: a `call __str_flatten` PER `charCodeAt` + **4** `struct.get` reloads +
   the f64 `|0` emulation (div/floor/mul/sub by 2³²). **All are CODEGEN issues on
   the EXISTING representation, not the representation.**
3. **Self-defeating:** #1762's own `LinearString` keeps a **GC descriptor**
   {len, ptr, off}, so a linear read path would suffer the SAME reload tax unless
   the descriptor is hoisted — i.e. it does NOT even address the dominant cost.
4. **The build-loop "GC write barrier on every `array.set`" premise is incorrect:**
   `array.set` of an **i16 (non-reference)** element carries no tracing write
   barrier (barriers are reference-only). The build cost is ConsString rope alloc
   (`__str_concat`, `native-strings.ts:1363`) + flatten, not array.set barriers.

(Caveat: the compiler's own `warm` output couldn't be warm-measured directly — it
hashes a constant literal each rep, so Cranelift LICM-hoists the whole hash and the
two-point loop reads ~0. The verdict rests on the clean gc_hoist-vs-lin comparison,
which is unaffected.)

### Redirect — the real win is CODEGEN on the existing WasmGC rep (not a representation change)

Carved/dispatched separately (the linear substrate is dead). **NB: verify-first
revealed these are multi-part optimizations with soundness constraints — they are
the right direction but warrant a proper spec, NOT quick one-liners:**

- **(a) Hoist the per-`charCodeAt` flatten + descriptor reads out of the loop**
  (loop-invariant-code-motion on the string-read). The `call __str_flatten` + 4
  `struct.get` per char are the 1.66–1.8x. Non-trivial: the lowering is
  expression-local; it needs to recognize a loop-invariant string receiver and
  hoist.
- **(b) Finish the i32-hash-path (#1105).** `binary-ops.ts:1578` excludes
  `charCodeAt` from the i32-pure leaf — **soundly**, because OOB `charCodeAt`
  returns NaN which poisons `(a + charCodeAt)|0` to 0, whereas an i32 leaf
  returning 0 gives `a`. So (b) needs THREE coupled parts: (i) prove `charCodeAt(i)`
  in-bounds (the for-header `i < s.length` gives it, but the bound is `s.length`,
  not a literal — extends the #2055 relational i32 path), (ii) an i32 `charCodeAt`
  arm (array.get_u, no NaN branch) gated on that proof, (iii) infer the hash
  accumulator `h` as an i32 local (it's `let h = 0`/`number` → f64 today) so the
  whole `(h*31 + c)|0` collapses to i32 and the f64 `|0` emulation disappears.

Both are broad-impact string codegen → must floor-validate through merge_group (the
#2078 regression class). Recommend routing through `/architect-spec` before code.

## Notes

- Strategic follow-up to #1761 (presize). #1761 removes the reallocs + cap-check
  on the existing WasmGC buffer; #1762 removes the GC barrier / opaque-ref tax by
  changing the backing store itself — the representation-level ceiling for V8
  parity on both loops.
- **Likely routes to `/architect-spec` before any dev work** — the representation
  choice is strategic, not a localized codegen patch.
