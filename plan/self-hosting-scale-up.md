# Stdlib self-hosting scale-up plan (battle-plan slice 9)

**Date:** 2026-07-11 · **Author:** fable-selfhost (senior-dev) · **Gate:** #3141 pilot — **GO**
**Pilot evidence:** nine Math helpers converted to TS source compiled through our own
IR pipeline; 36,477-case bit-exact sweep, zero mismatches; byte-inert for non-users;
standalone + wasi green; **zero dialect gaps**; 3.3× body compression measured
(316 hand lines → ~95 TS-source lines); one-time driver `src/codegen/stdlib-selfhost.ts`
(161 lines) amortizes over every future family. See
`plan/issues/3141-self-hosted-stdlib-pilot-math-helpers.md` §Result.

## The mechanism (what the pilot banked, reusable as-is)

1. Builtin = ordinary TS function in the IR-claimable subset, stored as source in
   `src/stdlib/<family>.ts` with a descriptor (`name`, `callees`, `source`).
2. `stdlib-selfhost.ts` memoizes a context-free `IrFunction` per builtin (symbolic
   refs, #1131 §1.2) and lowers it per compilation against the live ctx.
3. **Composition rule (the key scaling property):** self-hosted code calls ANY
   registered helper by funcMap name via `calleeTypes` — hand-written or
   self-hosted — so every family converts LEAF-FIRST, incrementally, no big-bang.
   Precision-sensitive or rep-heavy kernels can stay hand-written indefinitely
   (the escape hatch works in both directions, exactly porffor's model inverted).
4. Per-slice gates (unchanged): equivalence probe vs a JS port of the deleted hand
   algorithm (bit-exact, `.tmp/probe-3141.mts` is the template), byte-inertness
   SHA check for non-users, LOC-budget, full CI + `merge_group` net ≥ 0.

## Ranked target list (by leverage = deletable-lines ÷ precursor-cost)

| # | Family (file, current LOC) | Est. TS source | Est. net | Expressible today? | Precursors / risk |
| - | --- | ---: | ---: | --- | --- |
| 1 | **math cores** — `math-helpers.ts` remainder: sin/cos/exp/log/atan/tan/atan2/pow/log2/log10 (~1,050 of 1,394) | ~320 | **−0.8k** | **YES — proven dialect, zero precursors** (loops, f64 compares, 2-param callees all exercised by pilot) | Lowest risk in the whole program. atan2/pow are 2-param — `calleeTypes` already supports arity ≥ 2. Math_random stays (WASI import plumbing). Dispatchable NOW. |
| 2 | **parse/format** — `parse-number-native.ts` (1,838) + `number-format-native.ts` (1,712) | ~700 | **−2.8k** | MOSTLY — numeric scanning loops are pure i32/f64; needs char-code access on the string rep | Precursor A (string intrinsics: `__str_char_code_at`-style callees — the `__str_*` helpers EXIST, just declare their sigs in `calleeTypes`). Medium-low risk. |
| 3 | **string methods** — `string-ops.ts` (3,495) + parts of `native-strings.ts` (7,433; keep the i16-array core kernels hand-written) | ~1.6k | **−6–7k** | PARTIAL — method bodies (indexOf/split/pad/trim logic) express as loops over char codes; the rep kernels (alloc, copy-tree, flatten) stay hand-written as callees | Precursor A + driver-resolver widening (Precursor C). IrType.string exists; leaf-first: express methods as calls into the retained `__str_` kernels. Medium risk. |
| 4 | **array methods** — `array-methods.ts` (9,565) | ~1.2–1.5k | **−8k** | PARTIAL — per-element loops + callback invocation express today (IR has vec get/set/len, closure.call); the dynamic boxed-any element rep and growth semantics need intrinsic callees | Precursor B (`__vec_len` / element get-set / `__arr_push` declared as typed callees — most exist as helpers already, e.g. `ensureVecElemSet`) + Precursor C. Porffor benchmark: all of Array in 1,038 TS lines. Medium-high risk, HIGHEST single payoff. |
| 5 | **dataview/typed-array** — `dataview-native.ts` (3,866) | ~900 | **−2.9k** | MOSTLY — byte-shuffling loops are i32 arithmetic; needs u8-array load/store intrinsic callees + i64 for the 64-bit views | Precursor B variant (u8 element access); i64 ops partially in IR union. Medium risk. |
| 6 | **json codec** — `json-codec-native.ts` (2,859) | ~800 | **−2k** | PARTIAL — scanner/printer loops fine; value construction touches the dynamic rep | Needs 3 + 4 landed first (strings + arrays). Medium risk. |
| 7 | **map/iterator** — `map-runtime.ts` (2,103) + `iterator-native.ts` (2,354) | ~1.1k | **−3.3k** | PARTIAL — hash/probe loops fine; struct-field access on the runtime structs needs typed struct intrinsics | Precursor D (`__struct_get`-style typed intrinsics, battle-plan §4). Medium-high. |
| 8 | **object runtime** — `object-runtime.ts` (10,092) | ~2k | **−8k** | NOT YET — dynamic property model is rep-entangled (tag-5 classifier, descriptors, prototype chain) | Precursor D at full strength; convert LAST, after intrinsic vocabulary is proven on 3–7. Highest risk. |
| — | `generators-native.ts` (4,696), `regexp-standalone.ts`/`native-regex` | — | — | DEFER — control-flow transformation machinery, not stdlib-shaped source | Not self-hosting candidates in this program. |

**Cumulative (1–8): ≈ −34–37k net** from the files above alone; with the long tail of
smaller emission files (58 files total in the ~76k bucket) the battle plan's **−45–55k**
holds at the measured 3.3× floor (porffor's 5–8× on large families is upside).

## Precursors (dispatch as their own small issues, in this order)

- **A. String char-code callees** (S): declare existing `__str_*` helper signatures as
  `calleeTypes` entries usable from stdlib source. No new Wasm — pure driver/descriptor
  plumbing. Unblocks 2, 3.
- **B. Array/vec element callees** (S/M): same pattern for vec len/get/set/push
  (helpers exist: `ensureVecElemSet` etc.). Unblocks 4, 5.
- **C. Driver-resolver widening** (S): `stdlib-selfhost.ts` currently throws on
  globals/named-types/objects (deliberate pilot scope-guard). Delegate to
  integration.ts's `makeResolver` (export it) for families that need string/vec/ref
  types. Unblocks 3–7.
- **D. Typed struct intrinsics** (M/L — battle-plan §4's "main deliverable"):
  `__struct_get`/`__tag_of`-style intrinsic functions from-ast lowers as IR nodes.
  Only needed from family 7 on — do NOT front-load it.
- **QoL (optional):** `NaN`/`Infinity` identifiers in from-ast (pilot workarounds are
  fine: `x !== x`, `0/0`, `> 1.7976931348623157e308`).

## Sequencing rule

One family per PR, leaf-first within the family, each PR: convert + probe bit-exact +
delete + measure. Family 1 (math cores) is dispatchable **today** with zero precursors —
it is the natural next-window opener and turns the pilot's +72 net into a clean negative.

## Backend caveat

IR loop/try lowering is WasmGC-`Instr[]`-only until the #1584 a1..a6 trait migration;
self-hosted bodies with loops serve the WasmGC backend today. The linear backend does
not consume these emission files at all currently, so nothing regresses — but the
"one source, both backends" dividend for loop-bearing builtins arrives with #1584.
