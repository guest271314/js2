---
id: 2045
title: "linear Uint8Array (WASI): silent-corruption holes — name-keyed buffer registry, no bounds checks — plus escape-analysis demotion gaps (#1886 follow-up)"
status: done
completed: 2026-06-25
sprint: 66
created: 2026-06-10
updated: 2026-06-25
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, wasi
language_feature: typed-arrays, linear-memory
goal: standalone-mode
assignee: ttraenkler/sd-2651
related: [1886, 817]
residual_note: "2026-06-25 (sd-2651): all SILENT-CORRUPTION holes closed — A.1/A.2 (landed), C.8 (landed), B.3/B.4 escape-demotion (landed #1991), and the C.7-successor readSync/writeSync explicit offset/length clamp (this PR). C.5 (loop-arena rewind) re-verified RESOLVED on current main by intervening work; C.7's process.stdin.read clamp OBSOLETED (#2633 removed that hallucinated API; errno already handled on the #2655 path). ONLY C.6 remains — a correctness-NEUTRAL doc/gating item (gate the all-target while-loop restructure on ctx.wasi OR document it), NOT a soundness bug; the issue itself rates it low priority. Closing the soundness issue; C.6 tracked as a low-pri doc follow-up."
origin: "2026-06-10 sprint-61 code review of merged PR #1288 (#1886 Slice C): two pre-existing Slice-B silent-corruption routes were materially widened to function parameters, and the new interprocedural escape analysis has two fail-closed demotion gaps that break previously-valid WASI programs."
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): GENUINELY OPEN — stays in-progress. Part A (A.1/A.2 silent-corruption) landed; C.8 (compound/inc-dec) landed (cs-2164); B.3/B.4 escape-demotion landed PR #1991 (commit a49198bbf). REMAINING dev-claimable residual = ONLY Part C C.5-C.7: loop-arena rewind ordering (loops.ts:70/773/1024), all-target while-loop restructure gate, process.stdin.read offset clamp + fd_read errno. Do NOT reground B.3/B.4 — they merged. Dispatch C.5-C.7."

# #2045 — Linear Uint8Array soundness holes (#1886 follow-up)

## Problem

The #1886 Slice-C signature rewrite (params become `(ptr, len)` pairs) is
well-engineered on the happy path, but review of merged PR #1288 found two
**silent-corruption** routes and two **fail-closed regression** gaps. The
corruption routes must be fixed before the linear path widens further
(Slice D subarray views would compound the aliasing surface).

### A. Silent corruption (fix first)

1. **Name-keyed, scope-blind buffer registry** —
   `src/codegen/linear-uint8-signatures.ts:113`: `fctx.linearU8Buffers` is
   keyed by identifier **text**, with no block-scope save/restore (contrast
   `localMap`'s #817 shadow handling). With Slice C registering *params*,
   shadowing is now easy: a linear param `buf` plus an inner-block
   `const buf = <GC Uint8Array>` makes
   `tryEmitLinearU8ElementGet/Set/Length`
   (`src/codegen/linear-uint8-codegen.ts:148/184/224`) address the wrong
   buffer in **both** shadowing directions — silent wrong reads/writes.
   Fix: key by symbol (or scope-push/pop the registry like `localMap`).
2. **No bounds checks on linear element access** —
   `linear-uint8-codegen.ts:151-156, 195-207`: `b[i]` / `b[i] = v` lower to
   raw `i32.load8_u`/`i32.store8` at `ptr + trunc(i)`. The GC path
   bounds-checks and traps; the linear path silently reads/writes arbitrary
   linear memory (iovec scratch at 0..11, string-literal data). With Slice C,
   an OOB index inside a helper corrupts the **caller's** memory. Fix: emit
   `i32.ge_u len → trap/throw RangeError-equivalent` matching GC-path
   semantics; measure perf, consider eliding only when the index is provably
   in-range.

### B. Escape-analysis demotion gaps (fail-closed, but regress valid programs)

3. **Untracked arguments at rewritten call sites** —
   `src/codegen/linear-uint8-analysis.ts:207` +
   `src/codegen/expressions/calls.ts:8955-8965`: a helper param stays
   linear-safe even when a call site passes an untracked `Uint8Array`
   (function result, `new Uint8Array(arrayBuffer)` view, conditional
   `f(c ? a : b)`). Codegen then hits the
   "linear Uint8Array helper argument is not backed by linear memory"
   `reportError` — previously-compiling valid WASI programs now fail. Fix:
   demote param safety when any call-site arg is not a provably
   linear-backed identifier.
4. **Function-value escapes of rewritten helpers** — only direct-identifier
   calls (`calls.ts:8886`) thread `(ptr,len)`; `const g = fill`,
   `fill.call(...)`, `arr.map(fill)` lower against the source-level GC
   signature → mismatch. Fix: demote a function's `linearParams` when its
   name appears in any non-direct-call position.

### C. Smaller correctness items

5. Loop-arena rewind vs `var b = new Uint8Array(n)` declared in a loop but
   read **after** it (`loops.ts:70/773/1024` resets) — stale/corrupt reads.
6. Unconditional `while`-loop restructure on **all targets**
   (`src/codegen/statements/loops.ts:59-140`) — semantically equivalent
   (verified) but contradicts the PR's "non-WASI byte-identical" claim; gate
   it on `ctx.wasi` or document the all-target change.
7. `process.stdin.read(b, off)`: no `off ≤ len` clamp (negative → huge u32)
   and `fd_read` errno dropped (`linear-uint8-codegen.ts:273-290`).
8. Compound element writes (`b[i] += 1`, `b[i]++`) have no linear lowering
   and no GC fallback once a buffer is linear — likely compile error on
   valid code; add a targeted test.

## Acceptance criteria

- Shadowing test (param `buf` + inner `const buf`) reads/writes the correct
  buffers in both directions.
- OOB linear access traps (or throws) exactly like the GC path; no silent
  write outside the arena allocation.
- The three untracked-argument shapes and the three function-value-escape
  shapes either work or demote the helper to GC representation — no
  compile errors on valid programs, no signature mismatches.
- `real-world-wasi.test.ts` and `tests/issue-1886*.test.ts` stay green;
  new regression tests for findings 1, 2, 3, 4, 8.

## Partial resolution (2026-06-12) — silent-corruption routes A.1 + A.2 landed

The two **silent-corruption** routes (Part A, "fix first") are fixed. The
escape-analysis demotion gaps (Part B) and the smaller correctness items
(Part C) remain — the issue stays **in-progress**.

### A.1 — scope-blind buffer registry → symbol-keyed

`fctx.linearU8Buffers` was keyed by identifier **text**
(`linear-uint8-signatures.ts`), so a linear param `buf` plus an inner-block
`const buf = new Uint8Array(...)` (distinct symbol, same name) collided — the
inner registration overwrote the param's `(ptr,len)` entry, and element access
addressed the wrong buffer in **both** shadowing directions (verified: the
param's trailing `write(buf)` emitted the inner buffer's bytes).

Fix: key the registry by the binding's `ts.Symbol`. `registerLinearU8Buffer`
now takes a symbol; `getLinearU8Buffer(ctx, fctx, node)` resolves the symbol
via `ctx.checker.getSymbolAtLocation(node)`. Param registration
(`function-body.ts`) and `new Uint8Array(...)` registration
(`linear-uint8-codegen.ts`) both pass the symbol; a binding with no resolvable
symbol simply isn't registered (falls to the GC path — sound).

### A.2 — no bounds check on linear element access → trap like GC

`b[i]` / `b[i] = v` lowered to a raw `i32.load8_u`/`i32.store8` at
`ptr + trunc(i)` with no bounds check; an OOB index silently read/wrote
arbitrary linear memory (iovec scratch at 0..11, string-literal data, and —
under Slice C — a caller's buffer). The GC array path traps.

Fix: `emitLinearU8BoundsCheck` emits `idx (u32) >= len → unreachable` before
every linear element get/set, matching the GC trap. The index is compared
unsigned so a negative (huge-u32) index also traps. The store path checks
**before** evaluating the value, matching the GC `array.set` trap order. Index
exprs are stored once so a side-effecting index runs once. The guard is
unconditional (one compare + branch per access); eliding it for provably
in-range constant indices is a possible later perf tweak, not a soundness need.

Covered (`tests/issue-2045-linear-u8-soundness.test.ts`, 6 green): OOB read
traps, OOB write traps, negative-index traps, in-bounds access unchanged
(read-back), inner-block same-name shadow (param not corrupted), outer local
keeps its buffer after a same-name inner const. Regression-clean across
`tests/issue-1886*.test.ts` (16 green), `linear-*` (22 green), and the WASI
I/O suites; tsc + biome + prettier clean. (`real-world-wasi.test.ts` and the
`issue-1886-slice-b` escaping test have two pre-existing host-import-allowlist
failures unrelated to this change — verified identical on main.)

### Remaining (issue stays open)

- **B.3 / B.4** escape-analysis demotion gaps (untracked call-site args;
  function-value escapes of rewritten helpers) — these are fail-closed
  `reportError`s on otherwise-valid WASI programs, a larger interprocedural
  change split out from the corruption fixes.
- **C.5–C.7** loop-arena rewind ordering, the all-target while-loop
  restructure gate, `process.stdin.read` offset clamp + errno.

## C.8 — compound element write + `++`/`--` on a linear buffer (LANDED 2026-06-18, cs-2164)

**Done — another silent-corruption route.** `b[i] op= rhs` (`+=`, `-=`, `*=`,
`&=`, …) and `b[i]++` / `++b[i]` / `b[i]--` on a linear-backed `Uint8Array`
(WASI) **silently failed to update linear memory**: `b[0] = 5; b[0] += 1`
read back `5`, and the `++`/`--` forms threw a `WebAssembly.Exception` at
runtime.

**Root cause.** The plain `b[i] = v` write goes through
`compileElementAssignment`, which tries `tryEmitLinearU8ElementSet` first — but
the *compound* and *update* forms have separate lowerings that had no linear
path: `compileElementCompoundAssignment` (assignment.ts) compiled
`target.expression` as a value (materialising the GC vec) and wrote the result
through the externref/GC path — never touching linear memory; `compileMemberIncDec`
(unary-updates.ts) required a `ref`/`ref_null` array and hit
`compileExpression`'s `(ptr,len)` shape → runtime throw.

**Fix** (`linear-uint8-codegen.ts` + the two call sites). Two new emitters do a
bounds-checked read-modify-write at a single `addr = ptr + trunc(i)` (index
evaluated once), mirroring the existing get/set:
- `tryEmitLinearU8ElementCompound` — `i32.load8_u` → f64, run the caller's
  compound op (a closure over `emitCompoundOp` + the rhs, threaded to dodge the
  assignment.ts↔linear-uint8-codegen.ts import cycle), `i32.store8` the low
  byte; leaves the (untruncated) f64 result for the expression value. Wired at
  the top of `compileElementCompoundAssignment`.
- `tryEmitLinearU8ElementUpdate` — `load → ±1 → store`, leaving the **new**
  value (prefix) or **old** value (postfix) per §13.4. Wired into
  `compileMemberIncDec` (the live `++`/`--` dispatch) **before** its
  `compileExpression(operand.expression)`, plus defensive guards in the
  `compilePrefix/PostfixIncrementElement` handlers (reached via the alt postfix
  dispatch). Both fall through to the GC path for any non-linear element target.

The store truncates to the byte, so `200 += 100 → 44` and `255++ → 0` wrap
correctly (matching JS `Uint8Array` semantics).

**Validation.** New `tests/issue-2045-linear-u8-compound.test.ts` (11, WASI run
via the `runWasiMain` fd_write harness): `+=`/`-=`/`*=`/`&=`, byte-wrap on
compound, `++`/`++`-prefix/`--`, postfix-returns-old, prefix-returns-new, and
`255++`→0 wrap. The 14 #2045/#1886-slice-b and 150 linear/WASI suite cases stay
green. tsc + prettier + biome(error) + coercion-sites + any-box + stack-balance
gates clean.

**Still open:** B.3/B.4 (escape-analysis demotion) and C.5–C.7 (loop-arena
rewind ordering, all-target while-loop gate, `process.stdin.read` clamp/errno).
**#2045 stays in-progress.**

---

## Implementation Plan (2026-06-23, architect) — B.3/B.4 escape-analysis demotion

### Re-probe against current main (`b4ed81215`)

Confirmed the two Part-B gaps still reproduce on current main, `--target wasi`
(`.tmp/` battery). These are **fail-closed regressions on valid WASI programs**
— the param-rewrite analysis (`linear-uint8-analysis.ts`) over-trusts a
linear-safe param and never demotes it when a *call site* hands it a buffer the
analysis cannot prove is linear-backed:

| Probe | Shape | Result on main |
|---|---|---|
| **B.3a** | `f(make())` where `make(): Uint8Array { return new Uint8Array(4) }` | `Codegen error: linear Uint8Array helper argument is not backed by linear memory (#1886)` |
| **B.3b** | `const a = new Uint8Array(buf); f(a)` (view over an ArrayBuffer) | same `not backed by linear memory` error |
| **B.3c** | `f(c ? a : b)` (conditional arg) | same `not backed by linear memory` error |
| **B.4** | `const g = fill; g(a, 5)` (function-value escape, indirect call) | **no `.wasm` emitted** — the indirect call lowers against the source-level GC signature while the body was rewritten to `(ptr,len)` → silent emit/validation failure, no binary |

All four are valid programs that compiled before #1886 Slice C widened the
rewrite to params. None is a soundness hole (they fail closed), but each
*regresses a previously-compiling WASI program*, so the acceptance criterion is:
**either compile correctly OR demote the helper to the GC representation — never
a `reportError` / missing binary on valid code.**

### Root cause

`buildLinearU8Analysis` (`src/codegen/linear-uint8-analysis.ts`) seeds every
top-level helper's `Uint8Array` param as linear-safe (Pass 1, `if (pSym &&
rewriteParams) safe.add(pSym)`), then Pass 2 only demotes a *buffer binding*
that flows into a disqualifying position (`isAllowedUse`). It never runs the
**inverse** check: a linear param stays safe even when a call site passes it an
argument that is **not** a provably-linear-backed identifier. Two missing
demotion directions:

- **B.3** — `isAllowedUse`'s call-arg arm (`linear-uint8-analysis.ts`
  ~line 381) verifies the *callee param* is currently safe, but does NOT verify
  the *argument expression* is itself a linear-backed buffer. The actual
  `(ptr,len)` thread happens later in `calls.ts` (~line 12085, the `reportError`
  site), which requires the arg to be a tracked linear identifier; a `make()`
  result / `new Uint8Array(buffer)` view / conditional is untracked → hard error.
- **B.4** — `linearParams` is consumed only by the *direct-identifier* call path
  (`calls.ts:~8886` threads `(ptr,len)`); an indirect call through a function
  value (`const g = fill; g(...)`, `fill.call(...)`, `arr.map(fill)`) lowers the
  callee against its source GC signature → arity/type mismatch → invalid/missing
  binary. The function's name escaping by value is never detected.

### Changes

**File: `src/codegen/linear-uint8-analysis.ts`** (single file for both slices —
they share the fixpoint loop; sequence B.4 first since it's the simpler, then
B.3 on top, OR land both in one PR — see decomposition).

**Slice B.4 — demote a helper whose function-value escapes (function-name
non-direct-call use).**
- Add a scan (folds into the existing Pass-1 `collect` or a dedicated walk
  before the `linearParams` freeze, ~line 244): for every `ts.Identifier` whose
  symbol is a key of `fnParamSyms` (a tracked helper), classify its use. A use is
  a *direct call callee* iff `ts.isCallExpression(parent) && parent.expression
  === id` (the form `calls.ts` threads). **Any other use of the function name** —
  `const g = fill`, `fill.call(...)` (property-access parent), `arr.map(fill)`
  (call-arg parent), `[fill]`, `return fill`, `typeof fill` — marks the function
  symbol as *escaped*.
- At the `linearParams` freeze (~line 244–251), skip (`continue`) any `fnSym` in
  the escaped set. With no `linearParams` entry, the helper keeps its source GC
  signature end-to-end; `calls.ts` lowers every call (direct or indirect) against
  the GC ABI — consistent, valid Wasm. The body's `b[i]` lowers via the GC array
  path (already the fallback when the param isn't registered as a linear buffer).
- **Edge case:** a recursive helper calls itself directly — that's a
  direct-call callee use, NOT an escape; do not demote on self-recursion.
- **Edge case:** the function is both directly called AND escapes (`g = fill;
  fill(a); g(b)`) — escape wins, demote (conservative, correct).

**Slice B.3 — demote a param that receives a non-linear-backed argument.**
- Extend the fixpoint loop (`while (changed)`, ~line 219–242) with a second
  classifier that walks every **direct user call** (`resolveDirectCallee`
  resolves a tracked helper). For each arg index `i` that the callee currently
  lists as safe, check the **argument expression**: it is linear-backed iff it is
  a `ts.Identifier` whose symbol is currently in `safe` (a tracked linear
  local/param). **Anything else** — a call result (`make()`), `new
  Uint8Array(arrayBuffer)` view, a `ConditionalExpression`, an element/property
  access, a literal — means the param cannot be proven linear-backed → remove the
  callee's param symbol from `safe` and set `changed = true`.
- Because this lives in the existing fixpoint, the demotion **cascades**: a
  demoted param that itself flowed into a deeper helper re-examines that edge on
  the next pass (monotone — only ever demotes — so it still terminates).
- After demotion, the callee param uses the GC array representation; `calls.ts`
  lowers the call against the GC signature, and the untracked arg is passed as a
  plain GC `Uint8Array` — no `not backed by linear memory` error.
- **Distinguish the two `new Uint8Array` forms:** `new Uint8Array(n)` (length
  ctor) over a local IS linear-backable (already seeded safe in Pass 1); `new
  Uint8Array(buffer)` (view ctor) is NOT — gate on whether the sole arg types as
  a `number`/length vs an `ArrayBuffer`/`Uint8Array` (reuse the existing
  `isNewUint8Array` predicate's arg inspection, or add `isLengthCtor`).

### Wasm IR / behavioral note
No new Wasm patterns — both slices are pure **analysis demotion** that route the
affected helpers/params back to the already-correct GC `array.get`/`array.set`
lowering. The win is removing a `reportError`/invalid-emit on valid code, not new
codegen. Net effect: programs that previously errored now compile (slower GC
path for that one helper) and run correctly.

### Lane / blast-radius
- **WASI/linear lane only.** Gated entirely inside `linear-uint8-analysis.ts`,
  reached only on `--target wasi` (the linear-Uint8 path). The WasmGC/host lane
  never builds this analysis. **Not** a value-rep / standalone-floor change → a
  scoped WASI compile+run sweep is sufficient validation; not merge_group-broad.
- No overlap with the #1917 coercion cascade (string-ops/coercion/value-rep).
  Disjoint file (`linear-uint8-analysis.ts`) — safe to run concurrently.

### Decomposition into landable dev slices
- **Slice B.4** (function-value escape demotion) — smaller, self-contained, no
  fixpoint interaction. ~30–50 lines in one file. Land first.
- **Slice B.3** (untracked-arg param demotion) — folds into the fixpoint loop;
  depends on nothing from B.4 but both touch the same freeze block, so if landed
  separately, B.3 should rebase on B.4 (trivial). **Recommended: one PR for both**
  (same file, same review surface, ~80 lines total).

### Acceptance probe (per slice)
- **B.4:** `const g = fill; const a = new Uint8Array(4); g(a, 5); a[0]` →
  compiles to a valid `.wasm`, runs under the `runWasiMain` fd_write harness,
  prints `5`. Also `fill.call(null, a, 5)` and `[fill]` compile (helper demoted).
- **B.3:** all three shapes compile + run:
  `function make(): Uint8Array { return new Uint8Array(4) } fill(make(), 7)` → no
  `not backed` error, prints `7`; `const a = new Uint8Array(buf); fill(a, 9)`;
  `fill(c ? a : b, 3)`.
- **Regression:** `tests/issue-1886*.test.ts` (16), `tests/issue-2045-*` (the
  soundness + compound suites), `linear-*` (22), `real-world-wasi.test.ts` stay
  green; a pure-linear helper (`fill(localBuf, v)` with `localBuf = new
  Uint8Array(n)`) STILL takes the fast `(ptr,len)` path (no over-demotion).
- New test: `tests/issue-2045-escape-demotion.test.ts` — B.3 ×3 shapes + B.4 ×2
  shapes compile+run, plus a fast-path no-regression assertion.

### Out of scope (this plan covers B.3/B.4 only)
- **C.5** (loop-arena rewind vs `var b = new Uint8Array(n)` read after the loop)
  — confirmed still broken on main (`.tmp/p_c5` fails to emit). Separate slice:
  a `var`-in-loop linear buffer read after the loop reads a rewound arena. Likely
  needs the loop-arena reset (`loops.ts:70/773/1024`) to skip buffers whose live
  range extends past the loop — its own analysis edge, route as a follow-up
  slice after B.3/B.4.
- **C.6** (all-target while-loop restructure gate) — a correctness-neutral
  documentation/gating item, not a bug; low priority.
- **C.7** (`process.stdin.read` offset clamp + `fd_read` errno) — independent
  I/O-correctness slice.

---

## B.3 / B.4 — escape-analysis demotion (LANDED 2026-06-24, agent-acafb1)

**Done — both fail-closed regressions on valid WASI programs are fixed.** All
four architect probes now compile to valid `.wasm` and run correctly under
`--target wasi`, and a pure-linear helper still keeps the fast `(ptr,len)` path
(verified via `analyzeLinearUint8` output: `fill`'s `linearParams[0]` retained on
the fast-path probe, dropped on the demoted ones).

| Probe | Shape | Before | After |
|---|---|---|---|
| **B.4** | `const g = fill; g(a, 5)` | runtime null-pointer deref | runs → `5` |
| **B.3a** | `fill(make(), 7)` | `not backed by linear memory` CE | runs → `7` |
| **B.3b** | `const a = new Uint8Array(buf); fill(a, 9)` | `not backed` CE | runs → `9` |
| **B.3c** | `fill(c ? a : b, 3)` | `not backed` CE | runs → `3` |

**Fix** (all in `src/codegen/linear-uint8-analysis.ts`, WASI/linear lane only):

- **B.4 — function-value escape demotion (`demoteEscapedHelpers`, Pass 1b).**
  A new walk runs after `collect` and before the fixpoint: any `ts.Identifier`
  that references a tracked helper (a key of `fnParamSyms`) and is NOT in
  direct-callee position (`isDirectCalleePosition`) marks the helper escaped, so
  ALL its params are removed from `safe`. With no `linearParams` entry the helper
  keeps its source GC signature end-to-end and `calls.ts` lowers every call (direct
  or indirect) against the GC ABI. Self-recursion `f(...)` inside `f` is a
  direct-callee position → correctly NOT an escape (regression test covers it).

- **B.3 — untracked-arg param demotion (`demoteUntrackedArgs`, in the fixpoint).**
  After each fixpoint pass, walk every direct user call; for each arg index the
  callee still lists as safe, the argument must itself be a `ts.Identifier` whose
  symbol is currently in `safe`. Anything else (a call result `make()`, a
  conditional, an element/property access, a literal) demotes that callee param and
  sets `changed = true`, so the demotion cascades (monotone → terminates).

- **B.3b — view-ctor seeding gate (`isLengthCtorUint8Array`).** `new
  Uint8Array(buffer)` (view ctor) was seeded as a linear local just like `new
  Uint8Array(n)` (length ctor), then hit `not backed`. The seed in `collect` now
  gates on `isLengthCtorUint8Array`, which is **fail-OPEN, exclusion-based**: a
  single arg is treated as a length unless its type is *provably* a view source
  (`ArrayBuffer`/`SharedArrayBuffer`/`ArrayBufferLike` or a `*Array` typed-array),
  or the ctor has >1 arg (`(buffer, offset, len)`). Fail-open preserves the
  permissive pre-#2045 default for a length arg whose type doesn't fully resolve
  (e.g. `new Uint8Array(msg.length)` under the analysis unit-test's `noLib`
  program — the native-messaging-host fixture), so #1886's existing classifications
  are unchanged.

**Validation.** New `tests/issue-2045-escape-demotion.test.ts` (8, WASI run): B.4
×4 (value-alias, `.call`, array-literal escape, self-recursion-NOT-escape), B.3 ×3
(function-result, view-ctor, conditional), plus a fast-path no-over-demotion
assertion. Regression-clean: `tests/issue-1886*.test.ts` (16), `issue-2045-*`
soundness + compound (25), `linear-*` + WASI suites (39). tsc + prettier +
biome(error) + stack-balance + any-box + coercion-sites gates clean.
(`typed-array-basic.test.ts` and `issue-1655` subarray have pre-existing failures
— a `string_constants` harness-import issue — verified byte-identical on
origin/main, unrelated to this change.)

**Still open:** C.5–C.7 (loop-arena rewind ordering, all-target while-loop gate,
`process.stdin.read` clamp/errno). **#2045 stays in-progress.**

## C.5–C.7 RE-GROUND (2026-06-25, sd-2651, `main` 6a36af19c)

Re-probed all three on **current** main (per-process WASI run via the `runWasiMain`
fd_write harness). Two of the three are already resolved/obsoleted by intervening
work; one is a **live silent-corruption hole** that moved onto the new #2655 IO path.

- **C.5 (loop-arena rewind ordering) — RESOLVED on current main.** The architect's
  2026-06-23 probe (`fails to emit`) was on `b4ed81215`. Re-ran the exact shapes:
  `var b = new Uint8Array(n)` declared in a loop + read after; outer buffer surviving
  a loop that does its own linear allocs; capture-into-outer-let then read after. All
  emit and run correctly (`linearU8ArenaResetInstrs` rewinds to the per-loop mark at
  iteration END, and buffers allocated *before* the loop sit below the mark so the
  rewind never clobbers them). No fix needed.
- **C.7's `process.stdin.read(buf, off)` — OBSOLETED.** That API was a hallucinated
  non-Node primitive; #2633 removed its lowering and replaced it with a clear compile
  error pointing at `node:fs readSync(0, buf, { offset, length })`. The `fd_read`
  **errno** half of C.7 is also already handled on the #2655 path
  (`emitFdReadRuntime`: errno != 0 → 0 bytes).
- **C.7's offset/length clamp — LIVE SILENT-CORRUPTION HOLE (the real residual).**
  The concern migrated to the #2655 `readSync`/`writeSync(fd, buf, { offset, length })`
  path (`node-fs-api.ts:emitNodeFsOffsetLength`, ~:434). When `length` is ABSENT it
  defaults to `bufLen - offset` (sound — "impossible by construction"), but an
  **explicit** `offset`/`length` is only `i32.trunc_sat_f64_s`'d with **NO clamp
  against `bufLen`**. Verified OOB on current main:
  - `writeSync(1, b/*len 4*/, {offset:0, length:64})` → **writes 64 bytes** (60 bytes
    of arbitrary linear memory past the buffer — OOB read / info leak).
  - `writeSync(1, b/*len 4*/, {offset:100, length:4})` → writes 4 bytes from `ptr+100`
    (OOB read past the buffer).
  - readSync is worse: an unclamped `offset`/`length` writes the syscall result OOB
    into linear memory past the destination buffer (silent corruption, the A.2 class).

  This is the same silent-corruption class as A.2 (which clamped element access);
  the fix is the C.7 successor.

### Fix (C.7 successor) — clamp offset/length in `emitNodeFsOffsetLength`

Clamp centrally in `emitNodeFsOffsetLength` (one site covers all 4 paths:
readSync/writeSync × linear/GC, since each calls it with its `bufLen` local):
`offset = min(max(offset,0), bufLen)`; `length = min(max(length,0), bufLen - offset)`.
This guarantees `offset + length <= bufLen` for the explicit case too, matching the
absent-length branch's existing soundness invariant. **Clamp (fail-soft), not throw**
— matches the surrounding code's style (the errno→0 handling, the permissive
`trunc_sat`, the default-length branch) and the issue's acceptance criterion ("no
silent write outside the arena allocation"); Node throws `ERR_OUT_OF_RANGE`, but a
WASI soundness fix that must not regress valid programs clamps. Host/GC mode is
untouched (this path is WASI-only).

- **C.6 (all-target while-loop restructure gate) — DEFER.** Correctness-neutral
  documentation/gating item (the issue itself rates it low priority); not a
  soundness bug. Out of scope for this soundness slice.

## C.7-successor — readSync/writeSync offset/length clamp (LANDED 2026-06-25, sd-2651)

**Done — the last silent-corruption hole in the #2045 family is closed.** Fixed
the missing bounds clamp on an EXPLICIT `offset`/`length` for node:fs
`readSync`/`writeSync(fd, buf, { offset, length })` (the #2655 direct-WASI path).

### Fix

`src/codegen/node-fs-api.ts`:
- New `emitClampI32(fctx, valLocal, hiLocal)` — clamps an i32 local in place to
  `[0, hi]` via signed `select` (`val = min(max(val,0), hi)`).
- `emitNodeFsOffsetLength` now clamps an EXPLICIT offset into `[0, bufLen]` and an
  EXPLICIT length into `[0, bufLen - offset]` (remaining capacity computed from the
  already-clamped offset). The absent-length default branch (`bufLen - offset`) was
  already sound and is unchanged; the clamp only guards user-supplied values. One
  site covers all four paths (readSync/writeSync × linear-backed/GC), since each
  passes its own `bufLen` local. WASI-only; host/gc mode untouched.

### Validation

- `tests/issue-2045-readsync-writesync-clamp.test.ts` (10, WASI run via the
  fd_read/fd_write mock): writeSync over-length / over-offset / offset+length>bufLen
  / negative-offset / negative-length all clamp; in-range slice + no-options whole
  buffer unchanged; readSync over-length does NOT write past the dest buffer;
  readSync into an explicit offset places bytes correctly; readSync over-offset
  reads 0.
- Regression-clean: `issue-2045-*` (soundness/compound/escape-demotion), node:fs
  `#2631`/`#2633`/`#2639` (47 total), `#2655` direct-WASI incl. wasmtime runs +
  `#1886-slice-b` (14). tsc + prettier + biome(error) clean.
- Before fix (verified on current main): `writeSync(1, b/*4*/, {length:64})` wrote
  64 bytes (60 OOB); after: 4. `writeSync(1, b/*4*/, {offset:100,length:4})` wrote
  4 OOB bytes; after: 0.

**Issue closed.** All silent-corruption routes (A.1, A.2, C.8, C.7-successor) and
both escape-demotion regressions (B.3/B.4) are fixed. C.5 resolved by intervening
work; C.7-stdin obsoleted. Only C.6 (a correctness-neutral doc/gating item)
remains as a low-priority follow-up — see `residual_note` in frontmatter.
