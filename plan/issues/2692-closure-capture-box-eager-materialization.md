---
id: 2692
title: "Closure-capture ref-cell box must be materialized eagerly at declaration, not lazily at first call site"
status: done
assignee: sd-dstr
completed: 2026-06-26
created: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures
goal: correctness
sprint: 66
related: [2669, 1177, 1556]
---
# #2692 — Closure-capture ref-cell box: eager materialization at declaration

## Problem

A mutable closure-captured variable (a variable written by a nested
`function` declaration) is wrapped in a ref-cell box (`struct (field $value
(mut T))`) so writes propagate across the scope boundary. Today that box is
materialized **lazily, at the FIRST capturing call site** —
`src/codegen/expressions/calls.ts` ~L12330–12354 (the `nestedFuncCaptures`
mutable-capture branch). The call site emits:

```wasm
local.get <outerLocalIdx>          ;; current value of the captured var
struct.new <refCellTypeIdx>        ;; box it
local.tee <__boxed_name>           ;; stash the box in a new outer local
```

and then **mutates compile-time state** that outlives the buffer it emitted
into: `fctx.localMap.set(name, boxedLocalIdx)` (re-aim every later read/write
to go through the box) and `fctx.boxedCaptures.set(name, …)`.

### Root cause (the buffer/state split)

The compile-time re-aim (`localMap` / `boxedCaptures`) is **global to the
function context**, but the runtime box-creation instructions
(`struct.new` + `local.tee`) are emitted into **whatever body buffer is active
at that call site**. When the first capturing call site sits inside a
**conditionally-executed buffer** — a destructuring default's then-branch
(`emitDefaultValueCheck` / `emitNestedBindingDefault` in
`src/codegen/statements/destructuring.ts`), or any `if` / ternary / `&&` arm —
and that branch does **not** run at runtime, the box is never created. The
`__boxed_name` local stays `ref.null`, yet every later read of the captured
var was statically re-aimed to `struct.get` on that null box → null deref →
the read yields the sNaN→`NaN` sentinel. Wrong result.

This is **not destructuring-specific**. Minimal repro, no destructuring at all,
returns `NaN` instead of `0`:

```ts
export function test(): number {
  var c = 0;
  function k() { c += 1; }   // c is captured-mutable → boxed
  if (c > 100) { k(); }      // only call site to k, in a not-taken branch
  return c;                  // statically re-aimed to struct.get on a box
                             // that was never struct.new'd → NaN
}
```

The standard test262 destructuring template
(`var initCount = 0; function counter(){ initCount += 1 }`, then a default-init
arm calls `counter()`) is the **largest single surface** of this defect —
sd-2669 attributes a large fraction of the 1499 `/dstr/` non-passes to it (full
diagnosis: `plan/issues/2669-…md` → "Verify-first investigation"). The
destructuring binding/default/rest/elision lowering itself is already correct;
the failures come from this closure-box bug.

## Acceptance criteria

- The repro above returns `0`.
- The captured-counter destructuring template
  (`var initCount=0; function counter(){initCount+=1}; let [a=counter()]=[1];
  assert.sameValue(initCount,0)`) passes.
- No net regression in the test262 `merge_group` floor; the closure / TDZ /
  for-of-destructure clusters in particular must not regress (see
  Validation — this is the exact machinery that produced 100+ regressions in
  #1177 Stage 1 and net −25 in PR#166).

## Implementation Plan

### Strategy: materialize the box EAGERLY during function-declaration hoisting

Move the `local.get; struct.new; local.set` box creation out of the call site
and into the **function-declaration hoisting pass**, where it lands in an
**unconditional, function-top body buffer**. The call site then only consumes
the already-existing box (the existing already-boxed branch handles that with
no `struct.new`).

#### Why hoisting is the correct (and only safe) locus

`hoistFunctionDeclarations` (`src/codegen/statements/nested-declarations.ts`
L1157) runs at function-body entry, **after** `hoistVarDeclarations` and
`hoistLetConstWithTdz` (see `src/codegen/function-body.ts` L1122–1128), so:

1. **All capturable slots already exist.** `var`/`let`/`const`/param slots and
   TDZ flags are allocated before function-decl hoisting, so
   `cap.outerLocalIdx` is valid and the box's initial `local.get` reads a real
   slot.
2. **The active buffer is the function-top `fctx.body`, unconditionally.**
   Hoisting **recurses into `if` / `try` / loop / `switch` blocks**
   (nested-declarations.ts L1310–1361) to lift function declarations to
   function scope, but it does **not** swap `fctx.body` while doing so — there
   is no `pushBody`/branch buffer in the hoist walk. So a `function k(){…}`
   that is *textually* inside `if (cond) { … }` still gets its box emitted into
   the **top-level** function buffer. This is precisely what fixes the bug: the
   box-creation can never land in a conditionally-skipped buffer again.
3. **Function-declaration semantics match.** JS hoists function declarations to
   the top of the enclosing function scope, so a box created at function-top is
   live before any textual use of the name — exactly the binding the nested
   function shares.

This is a **declaration-side** mirror of the existing call-site machinery; it
does **not** widen the *set* of boxed variables (same `mutable && valType &&
!alreadyBoxed` predicate the call site uses) — it only changes *when* and
*into which buffer* the box is created.

#### Exact insertion point

In `hoistFunctionDeclarations`
(`src/codegen/statements/nested-declarations.ts`), inside the per-statement
loop, **after** the successful `compileNestedFunctionDeclaration(...)` call
(L1285) and its success check (the `else if (reservedEntry)` arm completes
around L1304) — i.e. only on the path where `ctx.nestedFuncCaptures.get(
funcName)` is populated and the hoist did **not** roll back (L1288–1301 deletes
`nestedFuncCaptures` on failure). Emit there, NOT inside
`compileNestedFunctionDeclaration` itself, because:

- the rollback path truncates `ctx.mod.functions` and deletes
  `nestedFuncCaptures` but does **not** rewind `fctx.body`; emitting from
  inside the compile helper would orphan box-init instructions in `fctx.body`
  if the body later errored;
- at the L764 `nestedFuncCaptures.set` site, `ctx.currentFunc` has already been
  swapped to `liftedFctx` (L736) — emitting there is error-prone.

Pseudocode for the new emit (factor into a helper, e.g.
`emitEagerCaptureBoxes(ctx, fctx, funcName)`):

```ts
const caps = ctx.nestedFuncCaptures.get(funcName);
if (caps) {
  for (const cap of caps) {
    if (!cap.mutable || !cap.valType) continue;        // match call-site predicate
    if (fctx.boxedCaptures?.has(cap.name)) continue;   // dedup: already boxed by a sibling
    // Don't re-box an outer slot that is itself already the canonical cell
    // (#2623 alreadyBoxed) — those thread through unchanged.
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
    const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
      kind: "ref", typeIdx: refCellTypeIdx,
    });
    fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
    fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
    fctx.body.push({ op: "local.set", index: boxedLocalIdx });   // set, not tee — nothing on stack needed
    fctx.localMap.set(cap.name, boxedLocalIdx);
    if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
    fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
  }
}
```

Notes:
- Use `local.set` (not `local.tee`) — the eager site does not need the box on
  the stack (unlike the call site, which needs it as the prepended call arg).
- The `__boxed_<name>` naming convention is **load-bearing** — the call-site
  narrow guard (calls.ts L12309–12314) recognizes a deliberately-boxed slot by
  *both* its ref-cell type **and** the `__boxed_` name prefix. Preserve it.
- Keep `boxedCaptures` and `localMap` writes **in lockstep** with the
  `__boxed_` naming — this paired invariant is what makes the call-site guard
  safe (PR#166 broke it by using a type-only guard).

#### Keep the call site working (re-aim, no re-creation)

No structural change is required at calls.ts L12316–12354. After eager
boxing, `fctx.boxedCaptures.has(cap.name)` is already true at the call site, so
control flows into the **already-boxed branch** (L12316–12329): it emits
`local.get <fctx.localMap.get(cap.name)>` (the eager box) and passes it as the
prepended ref-cell arg. The `struct.new` branch (L12330–12354) is simply no
longer reached for eagerly-boxed names. Verify (read-time) that the
already-boxed branch's `currentLocalIdx = fctx.localMap.get(cap.name) ??
cap.outerLocalIdx` resolves to the eager box index.

### Why prior attempts regressed, and why this one differs

- **#1177 Stage 1 (PR#125, 100+ regressions; #1245):** changed the call-site
  *value source* to `localMap.get(name) ?? outerLocalIdx`, i.e. it boxed the
  *already-re-aimed* slot. That re-sourcing unmasked systematic spec bugs
  (notably #1258 — `compileForOfAssignDestructuringExternref` writing past the
  box — and #1259) and depended on "wrong-slot" main behavior some async tests
  relied on. **This change does not touch the call-site value source** — it
  boxes `cap.outerLocalIdx` (the canonical declaration slot) once, at
  function-top, then the call site reads the box. The #1258/#1259 blockers are
  already **done** (box-aware for-of-assign writes landed), removing the two
  largest Stage-1 regression clusters.
- **PR#166 (net −25, 33 wasm-change regressions):** widened the
  already-boxed detection to a **type-only** guard, so a coincidentally
  same-ref-cell-typed local was mistaken for a box. **This change keeps the
  narrow two-signal guard** (`__boxed_` name + matching ref-cell type) and
  always writes `boxedCaptures` + `localMap` + the `__boxed_` name together, so
  the guard's invariant holds.
- **#1205 value force-box (48+ for-await regressions):** force-boxed the
  *value* whenever a TDZ flag was present — boxing variables the call-site path
  would not have boxed, and tripping the direct-`local.set` write paths in
  loops. **This change boxes exactly the call-site predicate set**
  (`mutable && valType && !alreadyBoxed`), no TDZ-driven widening. It does not
  change the lifted function signature (mutable captures already take ref-cell
  params, nested-declarations.ts L611–625), so callee shape is unchanged.

### Required companion audit — non-box-aware write paths

Eager boxing means `boxedCaptures` / `localMap` re-aim is set **earlier** (from
function-top) than today's lazy first-call-site re-aim. Any outer-scope write
path that resolves a target via `fctx.localMap.get(name)` and then does a plain
`emitCoercedLocalSet` **without** checking `fctx.boxedCaptures` will now write
an `externref`/`f64` into a ref-cell-typed box slot → `externref→ref` coercion
trap (the exact #1205/#1258 failure mode). The externref and vec for-of-assign
paths are already box-aware (#1258 / #1510 — loops.ts L1985), but the
implementer MUST audit and, if needed, make box-aware:

- `compileForOfAssignDestructuring` object-pattern write,
  `src/codegen/statements/loops.ts` ~L1695–1716 (raw `localMap.get` +
  `emitCoercedLocalSet`, no `boxedCaptures` check).
- Any other `localMap.get(name)` + `emitCoercedLocalSet`/`local.set` site that
  can target a captured-mutable name (grep `emitCoercedLocalSet` in loops.ts /
  destructuring.ts / assignment.ts). Where the name is in `boxedCaptures`, the
  write must go through `local.get <box>; <value>; struct.set <refCellTypeIdx>
  0` instead of a direct slot set.

Pattern to follow: the existing box-aware branch at loops.ts L1985–1995
(`const boxedCap = fctx.boxedCaptures?.get(name); if (boxedCap) { … struct.set
… }`).

### Wasm IR pattern (eager box at function-top)

```wasm
;; emitted once, at function-top, for `var c=0; function k(){c+=1}`
local.get $c               ;; outer slot current value (hoisted default 0.0)
struct.new $ref_cell_f64   ;; box
local.set $__boxed_c       ;; stash box; localMap[c] re-aimed to $__boxed_c

;; later: `c = 0`  (assignment routes through boxedCaptures)
local.get $__boxed_c
f64.const 0
struct.set $ref_cell_f64 0

;; later: `if (c>100) { k() }`  (call-site already-boxed branch)
local.get $__boxed_c       ;; pass existing box as prepended capture arg
call $k

;; later: `return c`  (read routes through box)
local.get $__boxed_c
struct.get $ref_cell_f64 0
```

## Edge cases (each needs a targeted probe before the floor run)

1. **Multiple nested functions capturing the same var.** First hoisted decl
   boxes it; the `boxedCaptures.has(name)` dedup skips the rest. Both call sites
   pass the same box. (Hoist processes siblings in order.)
2. **`let`/`const` TDZ capture (box before declaration).** A `function k`
   hoisted above a later `let c` gets its box at function-top, reading the
   pre-init slot (garbage). Correctness relies on (a) the TDZ-flag mechanism
   (#1205) still guarding *reads* before the `let` init throws ReferenceError,
   and (b) the `let c = …` init routing its store through `boxedCaptures`
   (struct.set), not a raw slot set. Verify the existing TDZ-flag box plumbing
   (`tdzFlagLocals` / `boxedTdzFlags`, calls.ts L12379+) is unaffected — the
   eager *value* box is orthogonal to the i32 *flag* box. Do NOT eager-box the
   flag.
3. **Captured function params.** Param slot holds its value at entry, before
   the function-top box-init runs, so the box captures the entry value and all
   later param reads/writes route through it — correct closure semantics.
4. **`for (let i…)` loop variable captured by a closure (per-iteration box).**
   Function *declarations* are hoisted out of loop blocks to function scope, so
   this path boxes the **function-scope** binding once — NOT per iteration. The
   per-iteration box concern (closures.ts L1699–1705, and loops.ts L651–759
   for-let per-iter boxing) belongs to the **arrow/closure-value** path, which
   is out of scope here. Confirm the eager nested-decl box does not collide
   with the loop's own per-iteration `boxedCaptures` save/restore
   (loops.ts L463–487 / L1010–1016): if a name is already in `boxedCaptures`
   from the loop machinery, the dedup must skip it (it will — `boxedCaptures.has`).
5. **`alreadyBoxed` (#2623) capture.** When the outer slot is itself the
   canonical cell (outer fn materialized as a closure value threading a boxed
   param), `cap.alreadyBoxed`/outer `boxedCaptures` is set — do NOT re-box
   (would create a cell-of-cell). The dedup `boxedCaptures.has(name)` covers
   the outer-boxed case; also skip when the nested-capture entry's
   `alreadyBoxed` is true.
6. **Buffer-swap discipline (#2563).** The eager emit pushes directly into
   `fctx.body` during the hoist walk, where `fctx.body` is the stable
   function-top buffer (no `pushBody`/`popBody` active). Do NOT introduce a
   buffer swap here; if any future refactor wraps the hoist emit in a saved
   buffer, it MUST use `pushBody`/`popBody` (per #2563 brand-check-swap
   discipline), never a manual `fctx.body =` save/restore.
7. **Generator / async nested declarations.** These still register
   `nestedFuncCaptures` for their captures; confirm the eager box for a
   captured-mutable var used by a nested generator/async fn does not interfere
   with the generator state-struct / CPS lowering (the box lives in the OUTER
   fctx, the generator body reads it via the ref-cell param — same as today's
   lazy box, just earlier).
8. **Hoist rollback.** If `compileNestedFunctionDeclaration` errors and rolls
   back (deletes `nestedFuncCaptures`), the eager emit must be skipped — gate it
   on the success path so no orphan box-init lands in `fctx.body`.

## Validation plan (MANDATORY — high regression risk)

This touches broad closure codegen and is the exact machinery behind the
#1177/#PR166/#1205 regressions. PR-level scoped checks are **insufficient**.

1. **Targeted probes** (fresh single-file processes, both strict modes) BEFORE
   any floor run: the repro above; the captured-counter destructuring template;
   each edge case 1–8.
2. **Full `merge_group` floor** — broad-impact change; run the standalone floor
   + full test262 sharded validation, NOT a scoped sweep (per
   `project_broad_impact_validate_full_ci`).
3. **Paired baseline-vs-branch per-test diff** — fetch the baseline jsonl
   (`scripts/fetch-baseline-jsonl.mjs`) and diff branch vs baseline per test
   path. Inspect every `pass→fail` flip individually; the acceptance bar is
   **net positive with zero unexplained regression** in the closure / TDZ /
   `for-of`-destructure / for-await buckets. A single-bucket regression >50 or
   net <0 is an escalation, not a merge.
4. Confirm the expected large **improvement** in the `/dstr/` cluster
   (captured-counter template) materializes — that is the value signal.

## Implementation note — first floor attempt regressed, fix applied (sd-dstr, 2026-06-26)

PR #2102's first `merge_group` floor run **regressed -133 net** (189 pass→other,
56 improvements). Root cause pinned via the merged-report jsonl diff + WAT of a
failing case (`Reflect/apply/arguments-list-is-not-array-like`):

- The regressions were **all `let`/`const` captures** (the entire for-await-of
  async-dstr cluster uses `let x`/`let iterCount`; the scattered Promise/module
  cases likewise). Validation error: `ref.is_null expected reference type, found
  local.get of type f64`.
- Mechanism: eager-boxing a `let`/`const` captured var at function-top **races
  the variable's own block-scoped declaration**. The `let count` decl, compiled
  later, re-allocates the value slot (block-scope shadow / type reset) and resets
  `localMap[count]` to a fresh **f64** local — but `boxedCaptures[count]` stays
  set from the eager pass. The var-decl box-write path (`boxedForInit`) then runs
  `local.get <fresh f64>; ref.is_null` → invalid Wasm. (`var` decls and params
  have no such re-declaration, so they were fine — and the captured-counter dstr
  win, all `var`-based, held: 56 improvements.)
- **Fix:** `emitEagerCaptureBoxes` now **skips TDZ-flagged (`let`/`const`)
  captures** (`if (cap.hasTdzFlag) continue;`). Those fall back to the existing
  lazy call-site boxing (pre-#2692 behaviour — correct for the non-conditional
  cases that dominate; the conditional-branch `let`-counter residual is a small
  follow-up, noted in code). `var`/param captures keep eager boxing → the #2669
  win.
- **Post-fix local re-verification** (fresh single-file, the exact regressed
  files): for-await-of cluster + the 6 runnable non-for-await regressions all
  flip back to pass; new `tests/issue-2692-closure-box-eager.test.ts` 12/12 still
  green; tsc clean. Re-validated on the full floor before re-enqueue.

## References (read before implementing)

- `src/codegen/expressions/calls.ts` L12316–12354 — lazy box (current) + narrow
  already-boxed guard.
- `src/codegen/statements/nested-declarations.ts` L764 (`nestedFuncCaptures.set`),
  L1157+ (`hoistFunctionDeclarations`, insertion locus), L611–625 (lifted
  mutable-capture param types), L278–358 (capture detection / `alreadyBoxed`).
- `src/codegen/function-body.ts` L1122–1128 — hoist ordering (var → let/const →
  function).
- `src/codegen/closures.ts` L1699–1707 — per-iteration vs force-box caution
  (out-of-scope arrow path, but read for the per-iter reasoning).
- `src/codegen/statements/loops.ts` L1695–1716 (non-box-aware object-pattern
  write — companion audit), L1985–1995 (#1510 box-aware vec pattern to mirror).
- `plan/issues/2669-…md` — root-cause diagnosis; `plan/issues/1245-…md`,
  `1258-…md`, `1259-…md` — prior regression analysis + the now-done box-aware
  write fixes that unblock this.
