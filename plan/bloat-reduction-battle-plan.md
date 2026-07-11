# Codebase Bloat-Reduction Battle Plan

**Date:** 2026-07-11 · **Author:** architect (fable) · **Baseline:** `origin/main` @ `026f40f771`
**Evidence:** live `wc -l`/grep sweeps of our `src/`; shallow clone + measurement of
`CanadaHonk/porffor` @ HEAD (v0.61.13, 2026-07-11); `plan/log/3090-phase0-legacy-delete-list.md`
(reachability audit, 2026-07-10); `scripts/ir-fallback-baseline.json`; issues #2855/#3090/#2967.

---

## 0. Executive summary

- **Our `src/`: 320,251 raw lines (~211k code-only). Porffor: ~34.8k raw hand-written
  (~25.9k code-only).** That is an **8.1× code-only gap**, not the ~10× raw framing —
  and one framing correction: **porffor is at ~61% test262 (v0.61.13; its version
  minor IS its pass rate), we are at 76.0%** (32,761/43,106). Porffor's win is
  *size-per-conformance-point* (~425 code lines/point vs our ~2,780), not pass rate.
- The gap decomposes into five causes (§3). Two are **deliberate architecture we keep**
  (WasmGC typed-rep substrate, dual-mode + dual-backend ≈ 50k). Three are **addressable
  bloat ≈ 140k raw**, reducible by **~90–115k net**:
  1. **Dual frontend** — ~60k fn-lines of legacy direct-AST handlers the IR supersedes
     (#3090: net −40–55k, gated G1–G4).
  2. **Hand-assembled stdlib** — ~76k fn-lines of per-builtin `Instr[]`-building TS that
     porffor writes as ~14k of *self-hosted TS source* (net −45–55k, high risk, pilot first).
  3. **Retired engines / dead code** — CPS async engine (#2967, −3k) + knip-confirmed
     unreferenced set (−2.1k, zero risk, dispatchable today).
- **Self-hosting recommendation: YES — incremental, pilot-first (#3141).** It is the only
  lever that touches the stdlib mass, it serves *both* backends through the IR, and it
  compounds with the frontend retirement. Details + risk mitigation in §4.
- **End state:** ~160–180k raw (~110–120k code) at ≥76% — a **4–5× multiple of porffor**
  that is honestly attributable to WasmGC + dual-mode + dual-backend + 15 extra
  conformance points. Parity with porffor's 26k is NOT reachable without abandoning
  deliberate architecture (per CLAUDE.md both backends stay); this plan does not chase it.

---

## 1. Measured state (ours), classified

Raw `wc -l`, `origin/main` @ `026f40f771` (2026-07-11). Code-only ≈ 211k (34% of raw
lines are comments/blanks — porffor's ratio is ~22%; comment density is NOT a target).

| Area | Raw LOC | Bucket | Disposition |
| --- | ---: | --- | --- |
| `src/codegen/` total | 238,357 | mixed (split below) | — |
| — legacy direct-AST frontend (35 files: `expressions/calls.ts` 18.3k, `expressions/assignment.ts` 7.4k, `statements/loops.ts` 6.5k, `expressions/new-super.ts` 5.8k, `binary-ops.ts` 4.5k, `literals.ts` 4.3k, …) | ~80k file-lines (**59,976 legacy-only fn-lines**, audited) | (b) legacy frontend | **DELETE** per #3090, gated G1–G4 |
| — stdlib behavior emission (58 files: `object-runtime.ts` 10.1k, `array-methods.ts` 9.6k, `property-access.ts` 8.5k, `native-strings.ts` 7.4k, `object-ops.ts` 4.7k, `generators-native.ts` 4.7k, `dataview-native.ts` 3.9k, `native-regex.ts` 3.6k, `string-ops.ts` 3.5k, `regexp-standalone.ts` 2.9k, `json-codec-native.ts` 2.9k, `iterator-native.ts` 2.4k, `map-runtime.ts` 2.1k, `parse-number-native.ts` 1.8k, `number-format-native.ts` 1.7k, `math-helpers.ts` 1.7k, `number-ryu.ts` 1.6k, …) | ~76k fn-lines (46,979 legacy-reachable + 29,032 shared, audited) | (a) hand-written per-builtin | **CONVERT to self-hosted TS** (long-term, §4) |
| — substrate/orchestrator (`index.ts` 15.4k, coercion-engine, js-tag/value-tags, `type-coercion.ts` 3.5k, `stack-balance.ts` 2.8k, `any-helpers.ts` 2.7k, `context/` 3.5k, `regex/` 2.6k, `registry/` 1.6k, …) | ~35k | (f) irreducible-by-design | KEEP (cost of WasmGC typed rep) |
| — async engines (`async-scheduler.ts` 4.3k, `async-cps.ts` 2.6k, `async-frame.ts` 2.2k) | ~9k | (a/b) | CPS lane (−~3k) dies via **#2967** (in flight) |
| `src/ir/` | 33,258 | (c) IR path | KEEP — **grows** +15–25k as it absorbs the frontend |
| `src/codegen-linear/` | 10,536 | (d) dual backend | KEEP — **policy: both backends stay** (CLAUDE.md / codegen-axes north star: WasmGC-vs-linear is a backend fork *below* the IR) |
| `src/runtime.ts` | 16,038 | host-side JS glue (import object, instantiation, marshalling, WASI polyfill, eval shim) | AUDIT — partially reducible (fast-path glue duplicating standalone-native impls); est. −3–6k |
| `src/compiler*` + `src/emit/` + `src/checker/` + `src/link/` + root misc | ~22k | (f) irreducible | KEEP |

**God-file note (bucket e):** the god-files are not a separate lever — `calls.ts` (18.3k;
16.2k legacy-only fn-lines) and `assignment.ts` are ~90% bucket (b); `property-access.ts`
is bucket (a); `index.ts` stays but carries ~1.4k *unreferenced* lines (superseded
`collect*Imports` family) deletable in the Phase-2 slice.

---

## 2. Porffor teardown (measured, not summarized)

Shallow clone @ HEAD 2026-07-11, v0.61.13 → **~61% test262** (README: version minor =
rounded pass %). All three hypotheses **confirmed**:

| Component | Raw LOC | Code-only | What it is |
| --- | ---: | ---: | --- |
| Compiler core (`codegen.js` 7,622, `2c.js` 1,101, `wrap.js` 648, `assemble.js` 525, `precompile.js` 307, `opt.js`/`pgo.js`/`cyclone.js`, …) | ~12.1k | **9,995** | ONE lowering path: AST→Wasm directly. No IR, no dual frontend. |
| Builtins glue (`builtins.js`) | 1,563 | 1,228 | Import defs + porffor-intrinsic wiring |
| **Self-hosted stdlib** (`compiler/builtins/*.ts` 16.4k, 37 files + `temporal.js` 3.1k) | ~19.4k | **14,106** | Builtins written in a TS subset **porffor compiles itself** at build time (`precompile.js` — 307 lines — emits `builtins_precompiled.js`). E.g. `array.ts` = **1,038 lines for all of Array**; `string.ts` 2,178; `regexp.ts` 1,563; `date.ts` 1,876. |
| Generated artifact (`builtins_precompiled.js`) | 6,018 | 6,016 | Build output, not source |
| Runtime host glue (`runtime/`) | 797 | 593 | One mode; near-zero host surface |
| **Total hand-written** | **~34.8k** | **~25.9k** | |

**(i) Self-hosted stdlib — CONFIRMED.** Builtins are ~source-data. The dialect has typed
intrinsics (`Porffor.malloc()`, `Porffor.type(x)`, `Porffor.fastOr`) plus an **inline-wasm
escape hatch** — `` Porffor.wasm`local.get ${x}` `` (used 239× in `string.ts` alone) — so
hot/rep-touching paths never force the dialect to grow. The per-builtin marginal compiler
cost is ~zero.

**(ii) Single lowering path — CONFIRMED.** One 7.6k `codegen.js`. Our equivalent spend is
legacy frontend (~80k) + IR (~33k) + the coordination between them.

**(iii) Linear-memory only + uniform value rep — CONFIRMED.** Every porffor value is an
`(f64 value, i32 type-tag)` **pair** — locals, params, returns, always two slots
(`codegen.js:110-153`). No WasmGC, no per-type struct rep, no coercion matrix, no
brand/tag machinery. This is where much of our substrate cost (~35k) goes — and it is
also why porffor plateaus: dynamic-object semantics through a flat pair rep is their
long tail, whereas our typed rep is why we hold 76%.

---

## 3. Gap attribution: where the 8.1× lives

| Cause | Our cost (raw) | Porffor's cost | Addressable? |
| --- | ---: | ---: | --- |
| 1. Dual frontend (legacy + IR both alive) | ~80k legacy + 33k IR | 7.6k single path | **YES: −40–55k net** (#3090; IR keeps growing, legacy dies) |
| 2. Hand-assembled stdlib (`Instr[]`-building TS per builtin) | ~76k fn-lines | 14.1k self-hosted TS + 1.2k glue | **YES: −45–55k net** (self-hosting, §4) |
| 3. Retired/dead engines (CPS async lane, unreferenced fns) | ~5k | 0 | **YES: −5k** (#2967 + #3090 P2) |
| 4. WasmGC typed-rep substrate (coercion engine, tag-5 any, brands, registry) | ~35k | ~0 (uniform pair rep) | NO — deliberate; buys perf + 15 conformance points |
| 5. Dual-mode (JS-host + standalone: dual string/regexp backends, host-import gates, `runtime.ts` 16k) + dual backend (`codegen-linear` 10.5k) | ~30k | 0.8k (one mode) | MOSTLY NO (policy) — except `runtime.ts` audit (−3–6k) |
| 6. Comment/doc density (34% vs 22%) | ~109k raw | ~9k raw | NOT a target (docs are an asset; code-only is the honest metric) |

**Total addressable: ~90–115k net.** Trajectory: 320k → ~205–230k raw near-term
(levers 1+3), → ~160–180k raw with self-hosting scaled (lever 2).

---

## 4. The strategic question: self-host the stdlib?

**Recommendation: YES — adopt the porffor model incrementally, pilot-first. Do not big-bang.**

### Why yes

1. **We control the source dialect.** The killer objection — "our IR can't compile
   arbitrary JS yet" — is exactly the problem porffor solved by *writing builtins in the
   subset their compiler supports*, with an inline escape hatch for the rest. Our IR
   already claims a real subset (22 ir-owned kinds; `body-shape-rejected` down to 15 on
   the corpus; #2857/#2858/#2859 done). Builtin sources can be written to fit the
   claimable dialect **today**, and every dialect gap we hit is a gap #2855 wants closed
   anyway — the work compounds instead of competing.
2. **Double win with the dual backend.** Self-hosted builtins lower through the IR and
   the `BackendEmitter` fork — so **one TS source serves both WasmGC and linear
   backends**. Today `codegen-linear` re-implements its own runtime (3.6k) and has large
   stdlib gaps; hand-emission can never serve both. This is the only lever that makes
   the linear backend's stdlib cheaper too.
3. **The arithmetic is proven at scale.** Porffor covers Array in 1,038 lines of TS;
   our `array-methods.ts` is 9,565 lines of `Instr[]` assembly (+2k `array-object-proto.ts`).
   A 5–8× per-family compression is the measured norm, not a hope.
4. **Enablers already exist.** Build-time precompilation needs (a) a compile step
   (porffor's is 307 lines) and (b) module linking — we have `src/link/` (core-wasm
   linking, #2527). The `#1917` byte-SHA neutrality pattern gives us the A/B gate.

### Risks and mitigations

- **Intrinsics design is harder for us than porffor.** Their escape hatch is trivial
  because their rep is a flat `(f64,i32)` pair; ours is typed WasmGC structs. Mitigation:
  do **not** copy the raw inline-`wasm` template-string escape — define **typed intrinsic
  functions** (`__struct_get`, `__tag_of`, `__vec_len`, `__ref_test_*`) that `from-ast.ts`
  lowers as IR nodes; the backend fork keeps them portable. This is the pilot's main
  deliverable.
- **Perf regression vs hand-tuned emission.** Hand-written `Instr[]` is effectively
  hand-scheduled. Mitigation: per-family A/B on the equivalence suite + benchmark
  sidebar; binaryen `-O` closes most gaps; keep hand-emission for proven hot paths
  (the escape hatch works both directions).
- **Bootstrap stability.** A compiler bug now corrupts the stdlib. Mitigation:
  precompile at *build* time and commit/verify the artifact hash (porffor commits
  `builtins_precompiled.js`); CI compiles it fresh and diffs.
- **It is the highest-variance lever.** Mitigation: **#3141 pilot on the smallest pure
  family (`math-helpers.ts`, 1.7k)** — minimal intrinsics surface (f64 math, no object
  graph), fully covered by test262 Math tests. Scale-up decision is made on pilot data,
  not on this plan.

### Verdict vs "just keep migrating IR"

They are not alternatives — **IR migration deletes the frontend (~55k); self-hosting
deletes the stdlib (~50k). Neither touches the other's mass.** Run both: gate-clearing
slices for #3090 are medium-risk and mostly enabler-work right now, so the pilot fits
in parallel without contention (different files, different gates).

---

## 5. Sequenced slice list

Every deletion slice ships under the standing gates: LOC-budget gate (#3131 —
deletions are free, growth needs `loc-budget-allow`), equivalence suite, full CI +
`merge_group` (standalone floor ONLY runs there), test262 baseline net ≥ 0, and — where
a slice claims byte-inertness — the #1917 byte-SHA neutrality proof. Ordered by
(lines-deleted ÷ risk); IDs marked NEW were allocated via `claim-issue.mjs --allocate`.

| # | Slice | Issue | Net LOC | Risk | Dispatchable |
| - | --- | --- | ---: | --- | --- |
| 1 | **knip wiring + delete unreferenced set** (superseded `collect*Imports` family in `index.ts` ~1.4k, `regex/vm.ts` 245, unary-update strays) | #3090 Phase 2 (`ready`) | **−2.1k** | none (knip-confirmed, zero capability change) | **NOW** — dev, S/M |
| 2 | **CPS async engine retirement** (delete `emitAsyncStateMachine`/`splitBodyAtAwait`/`asyncCpsActive` plumbing after measured A/B) | #2967 (`in-progress`, fable-2967) | **−3k** | medium (behavior-observable; full-corpus A/B specified) | in flight — do not reassign |
| 3 | **`body-shape-rejected` → 0** (last unintended IR bucket, 15 remaining; spec banked) | #2856 (`blocked` — verify assignee liveness + blocker `#2135` ordering) | ~0 (enabler for #4/#6) | medium | **NOW** if assignee stale — senior |
| 4 | **IR-first default flip** — make `JS2WASM_IR_FIRST=1` (#2138, done as flag) the default; clears **G1** (legacy stops compiling claimed functions) | **#3143 (NEW)** | ~0 (enabler; unlocks −60k) | medium (full-corpus A/B on merge_group) | after #3 |
| 5 | **Self-hosting pilot: `math-helpers.ts` as compiled TS builtin** — typed-intrinsics dialect + build-time precompile via `src/link/`; measured A/B | **#3141 (NEW)** | **−1.5k now; proves −45–55k** | high (contained) | **NOW** — senior, L |
| 6 | **Module-level (top-level statement) IR adoption**; clears **G3** | **#3142 (NEW)** | ~0 (enabler) | medium | NOW (parallel with #4) |
| 7 | **Legacy handler deletion, wave 1** — ir-owned-kind files: `typeof-delete.ts` 1.4k, `statements/control-flow.ts` 1.3k, `expressions/unary-updates.ts` 1.7k, `expressions.ts` 1.2k, `identifiers.ts` 1.5k, `literals.ts` 3.4k | #3090 Phase 3a | **−10k** | medium | after #4 + #6 (G1+G3) + per-kind G2 |
| 8 | **Legacy handler deletion, wave 2** — the big files largest-first: `calls.ts` 16.2k → `assignment.ts` 6.9k → `loops.ts` 5.6k → `new-super.ts` 5.2k → `binary-ops.ts` 4.2k → `builtins.ts` 3.5k | #3090 Phase 3b (one slice per file) | **−30–38k** | med-high | gated: G2 closure per kind (#2855 STRICT_IR_REASONS) + G4 (IR entry into runtime emission per family) |
| 9 | **Stdlib self-hosting scale-up** — per family, biggest-first once #3141 passes: `array-methods` 9.6k, `object-runtime` 10.1k, `native-strings`+`string-ops` 10.9k, `dataview-native` 3.9k, `json-codec-native` 2.9k, `map-runtime` 2.1k, `parse-number`/`number-format` 3.5k | allocate per family at dispatch | **−40–50k** | high (per-family gated) | after #3141 verdict |
| 10 | **`runtime.ts` host-glue audit** — classify the 16k into API surface vs per-builtin fast-path glue duplicating standalone-native impls; propose demotions | allocate at dispatch | **−3–6k** (post-audit) | low (audit only) | NOW — dev, S |

**Near-term bankable (slices 1–2): −5k this week with zero pass-rate exposure.**
**This quarter (slices 3–7 + pilot): −15–20k plus both big levers unlocked.**
**Full plan: −90–115k net → src/ ≈ 160–180k raw at ≥76%.**

### What we will NOT do (explicit non-goals)

- **No backend deletion.** `codegen-linear/` and the WasmGC backend are alternatives by
  policy (CLAUDE.md; codegen-axes north star). Deletion lives in the legacy-vs-IR
  *frontend* split only.
- **No comment-stripping or mechanical golf.** Code-only LOC is the tracked metric.
- **No pass-rate trades.** Every slice is byte-inert or measured net-non-negative on
  full CI + `merge_group`. A slice that regresses conformance to delete lines is a
  rejected slice.
- **No 1×-porffor target.** The honest floor for this architecture is a 4–5× multiple;
  the difference is bought deliberately (WasmGC, dual-mode, dual-backend, +15 points).

## 6. Measurement cadence

- Re-run `node scripts/audit-legacy-reachability.mjs` after every wave-1/2 slice; the
  legacy-only fn-line count is the burn-down metric (start: 59,976).
- Track `src/` code-only LOC in the weekly status alongside test262 %: the plan's
  scoreboard is the pair **(code LOC ↓, pass % ≥ 76.0)**.
- `scripts/ir-fallback-baseline.json` unintended-bucket sum is the leading indicator
  for wave-2 readiness (currently 15, all `body-shape-rejected`).
