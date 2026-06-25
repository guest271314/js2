---
id: 2659
title: "compiled-acorn parse() infinite-loops: in-Wasm member WRITE on an any-typed fnctor receiver goes to __extern_set (sidecar) while the matching READ uses typed struct.get (slot) — read/write storage divergence (6th dogfood blocker)"
status: done
assignee: ttraenkler/sendev
created: 2026-06-25
completed: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen
language_feature: closures, member-access, wasmgc-struct
goal: self-hosting-dogfood
origin: "2026-06-25 sd — verify-first deep-trace of the remaining acorn parse() loop on current main (after #1712 b1-3, #2582, #2608 landed). Pinned to a member read/write struct-dispatch asymmetry. Renumbered #2655→#2657→#2659 (the #2655 id was won on main by 2655-direct-wasi-p1-readsync-writesync, and #2657 was simultaneously won by 2657-raw-wasi-p1-fd-import-variant, both while this PR was in flight; #2656 = the parseStatement-switch follow-on)."
related: [2608, 2582, 1712, 2656, 983d, 1269]
depends_on: []
---

# #2657 — in-Wasm member WRITE bypasses the typed struct slot that the READ uses (acorn parse-loop, 6th blocker)

> Renumbered from #2655 (id collision: `2655-direct-wasi-p1-readsync-writesync`
> landed on main first and won #2655; the parseStatement-switch follow-on this
> surfaces is tracked as #2656). The original PR #2038 carries the #2655 slug.

## TL;DR (root cause)

For an `any`/`externref`-typed receiver, the compiler's **member READ** path
emits a **typed `struct.get` inline-cache** (multi-struct `ref.test` dispatch via
`findAlternateStructsForField`, `property-access.ts:4767`), but the **member
WRITE** path (`compilePropertyAssignmentExternSet` / `compileExternSetFallback`
in `expressions/assignment.ts`) emits **only `__extern_set`** — it has **no
matching `struct.set` dispatch**.

When the runtime receiver is a typed WasmGC struct (acorn's Parser fnctor
instance, struct `$__anon_5`, with `pos` at field slot 8):
- `this.pos` READ → `struct.get $__anon_5 8` → reads the struct **slot**.
- `this.pos += inc` WRITE → `__extern_set(this,"pos",…)` → `_safeSet` writes to
  the **sidecar** map (a JS-side property table), because JS cannot `struct.set`
  a WasmGC field (`runtime.ts:3902-3905` — "native property assignment silently
  fails for non-struct fields… Always write to sidecar").

The struct slot and the sidecar are **two different storages for the same
property**. Writes update the sidecar; reads return the slot (frozen at its ctor
value 0). So in acorn's `readWord1`:

```js
while (this.pos < this.input.length) {   // reads slot 8 -> always 0
  ...
  this.pos += 1;                          // writes sidecar -> slot stays 0
}
```

`this.pos` never advances as seen by the loop condition → **infinite loop**.
This is the single remaining compiled-acorn `parse()` blocker.

## Verified state (current main, this analysis)

acorn 8.16.0 compiles → ~650 KB valid Wasm, instantiates, exposes a callable
`parse`. `parse("var x = 1;")` loops forever in `parseTopLevel`'s
`while (this.type !== eof)` — downstream of the tokenizer never advancing past
the first token.

## Deep-trace evidence (per-process, watchdog-bounded — NOT in-process loops)

All probes compile the pinned acorn, instrument the source in-memory, run
`parse()` under a host-call budget so the tight Wasm loop throws instead of
hanging. (`.tmp/trace-*.mjs` in the worktree.)

**1. The tokenizer reads the same word forever, `pos` never advances:**
```
NEXTTOK pos=0 len=10 cur=eof
READWORD1 enter pos=0 len=10
FINISHTOK label=name val= pos=0      <- "var" tokenized as empty `name`, pos still 0
```

**2. `this.pos` advances in `fullCharCodeAt` but is stale-0 in `readWord1` —
same object, same frame:**
```
FCC arg_pos=0 this_pos=0 code=118   (v)   <- fullCharCodeAt's this.pos read is LIVE
INC before=0 after=0                       <- readWord1's this.pos += 1 reads back 0
FCC arg_pos=1 this_pos=1 code=97    (a)   <- next call: this.pos IS 1
INC before=0 after=0
FCC arg_pos=2 this_pos=2 code=114   (r)   <- this.pos IS 2
```

**3. Same object (identity preserved), `pos` stale but a sibling field fresh:**
A `this.__probe` field added in the ctor tracks 100→101→102→103→104 across BOTH
functions, proving it's one object. Yet in the SAME `console.log`:
```
INC inc=1 pos=0 qpos=1               <- this.pos += 1 stale; this.qpos += 1 fresh
INC inc=1 pos=0 qpos=2
INC inc=1 pos=0 qpos=3
```
`pos` is a field the compiler put in the typed struct shape `$__anon_5`; `qpos`
/`__probe` are dynamic-only (sidecar), so their read+write both hit the sidecar
and stay consistent.

**4. Host-call counts during the loop confirm read=slot, write=sidecar:**
Over ~60 000 host calls in the parse loop, `__extern_get("pos")` fired only **8**
times total (essentially zero vs thousands of loop iterations) while
`__extern_set("pos")` fired **3** times. The hot `this.pos` reads do NOT go
through `__extern_get` — they're served by `struct.get`; the writes go through
`__extern_set` → sidecar.

## WAT evidence (decoded `readWord1` = `$__closure_322`)

**READ of `this.pos` (loop condition) — typed multi-struct dispatch:**
```wat
global.get 1587            ;; __current_this
any.convert_extern
local.tee 20
ref.test (ref 44)          ;; is this the Parser struct shape?
(if (then
  local.get 20
  ref.cast (ref 44)
  struct.get 44 8          ;; <- reads pos from SLOT 8
  ...))
;; else ref.test (ref 90) struct.get 90 8 ...
;; else fallback: global.get 532 ("pos") + call 4 (__extern_get)
```

**WRITE of `this.pos += inc` (compound assignment) — dynamic only:**
```wat
local.set 29               ;; pobj = this
global.get 532             ;; key "pos"
local.set 30               ;; pkey
local.get 29  local.get 30
call 4                     ;; __extern_get(this,"pos")   (reads CURRENT)
call 26                    ;; __unbox_number
... f64.add (inc) ...
local.get 29  local.get 30  local.get 32
call 57                    ;; __extern_set(this,"pos",new)  <- writes SIDECAR, not slot 8
```
`call 4` = `__extern_get`, `call 57` = `__extern_set` (verified by import-order
index mapping). The write never touches `struct.set … 8`.

**The receiver struct `$__anon_5` IS the genuine Parser fnctor instance** (NOT a
false ref.test match) — its field list is exactly acorn's Parser ctor fields:
```
(type $__anon_5 (struct
  (field $options …) (field $sourceFile …) … (field $input (mut externref))
  (field $containsEsc (mut i32)) (field $pos (mut externref))    ;; <- field index 8
  (field $lineStart (mut f64)) (field $curLine (mut f64)) (field $type …) …))
```
`findAlternateStructsForField(ctx,"pos",-1)` returns exactly
`__anon_5(typeIdx=48, field=8, externref)`. So the READ correctly resolves the
real slot; the WRITE simply fails to use it.

## Why it's `pos`-specific (and survives a global `.pos`→`.xpos` rename)

`pos` (and the other ctor-assigned fields: `input`, `type`, `start`, …) are part
of the inferred typed struct shape `$__anon_5`, so their reads take the
`struct.get` fast path. `qpos`/`__probe`, added only dynamically, are NOT in the
shape, so they always use `__extern_get`/`__extern_set` (both sidecar) and stay
consistent. Renaming `.pos`→`.xpos` globally keeps the same shape (the field is
just renamed in `$__anon_5`), so the divergence persists — it is NOT a magic
property name, it's the read/write path asymmetry.

## Minimal repro

`.tmp/` in the worktree. The acorn-faithful repro is the dogfood harness itself
(`pnpm run dogfood:acorn` hangs at `parse()`); the reduced traces above isolate
the mechanism. A pure-unit repro requires a **fnctor instance whose typed struct
shape contains the mutated field AND whose method runs in-Wasm via
`__current_this`** — plain `class`/top-level-`any` reproductions do NOT trip it
(they take the symmetric class-struct write path: `struct.set` on both sides;
verified `.tmp/probe-anyrw.ts`, `.tmp/probe-fnctor-inst.ts` both advance
correctly). The trigger is specifically: **(a)** receiver statically `any`/
`externref` (so the read uses `findAlternateStructsForField` dispatch rather than
a known-typed `struct.get`), **(b)** runtime value is a typed WasmGC struct
carrying the field as a real slot, **(c)** the field is written via a compiled
in-Wasm `+=`/`=` (→ `__extern_set` → sidecar). The regression-pin should be a
fnctor with a `prototype` method that mutates a ctor-initialized field in a loop
and is invoked in-Wasm (mirroring `readWord1`); building reliable in-Wasm fnctor
prototype-method dispatch in a unit test is the test-authoring task.

## Fix direction

Make the **member-WRITE path symmetric with the READ path**: for an
`any`/`externref` receiver, before falling back to `__extern_set`, emit a
`struct.set` multi-struct dispatch over `findAlternateStructsForField(propName)`
— exactly mirroring the read's `ref.test … struct.set … else __extern_set`
chain. Touch points:

- `expressions/assignment.ts`:
  - `compilePropertyAssignmentExternSet` (~2662) — dot `this.pos = …`.
  - `compileExternSetFallback` (~3375) — element `this["pos"] = …`.
  - (The compound `+=` lowers the store through the same property-store path, so
    fixing the store covers `+=`/`++`/`--` too. Verify the compound path's
    read+write both resolve to the same struct slot once the write is fixed.)
- Reuse/extract a `struct.set` analogue of the read's dispatch. The read builds
  the chain inline at `property-access.ts:4767` and via
  `emitNullGuardedStructGet` (1252) — factor a shared
  `emitAlternateStructSetDispatch(ctx, fctx, objTmp, propName, valLocal)` that
  emits, for each candidate `{structTypeIdx, fieldIdx, fieldType}`:
  `ref.test → ref.cast → (coerce value to fieldType) → struct.set`, with the
  final `else` arm the existing `__extern_set`/`_safeSet` fallback (still needed
  for genuine host externrefs and dynamic-only props).
- **Value coercion is load-bearing:** `$__anon_5.pos` is `externref` (because the
  ctor's chained `this.pos = this.lineStart = 0` boxed it), so the boxed f64
  value already matches; but other candidates may type the field `f64`/`i32` —
  coerce the value to the candidate's `fieldType` before `struct.set` (the read
  side does the inverse coercion in `coercionInstrs`).

### Downstream-effect checks (do these before claiming green)

- **Stack balance / validation:** the new `ref.test`/`ref.cast`/`struct.set`
  chain must leave the stack exactly as `__extern_set` did (assignment is an
  expression returning the RHS value — preserve the `local.get valLocal` tail).
- **Index shifting:** `__extern_set` is a late import; if the struct path no
  longer needs it in some functions, do NOT drop the import (other sites use it)
  — keep `ensureLateImport`/`flushLateImportShifts` ordering intact; the struct
  arm needs no new import.
- **Sidecar interaction (#983d / #1269):** the existing read fast-path means a
  prior sidecar write to the same key would already be invisible to the read —
  so writing the slot is the *consistent* fix, not a new divergence. But verify
  no path relies on the write hitting the sidecar (e.g. host live-mirror in
  #983d). Gate the struct-set arm on the SAME candidate set the read uses so
  read and write are always symmetric.
- **Standalone vs JS-host:** in standalone there is no `__extern_set` host
  import; confirm the struct-set arm is the primary path there and the fallback
  is the standalone `_safeSet`-equivalent (or absent).

## Acceptance

- Compiled-acorn `parse("var x = 1;")` terminates and returns a Program AST
  (loop exits — `this.pos`/`this.type` advance to eof). Then the #1712
  differential-AST harness: structurally-equal AST vs node-acorn for the
  representative fixture.
- A regression test pinning the in-Wasm fnctor-method field-mutation loop
  (read+write must agree on the slot).
- No test262 / equivalence regression (this changes a hot member-write path —
  validate the FULL merge_group / local-ci, not a scoped sweep, per
  `project_broad_impact_validate_full_ci`).

## Notes / prior-attempt guard

- This is **NOT #2628** (re-grounded as host-side-only; the in-Wasm acorn
  `new this(...).parse()` shape already works — verified). #2628's residual is a
  host-facing `Object.create(proto)` identity fix, unrelated to this in-Wasm
  read/write storage divergence.
- This is **NOT #2608** (empty-`this.input` via `new this(...)` arg loss — DONE).
  Here `this.input` is correctly populated (length 10); the loss is `this.pos`'s
  write not reaching the read's slot.
- This is the **inverse** of #983d: #983d is host-write→struct-slot-read
  (live-mirror); #2657 is in-Wasm-write→sidecar vs in-Wasm-read→slot. The shared
  lesson is the **read/write storage must agree**; the symmetric struct-dispatch
  on the write side closes both for the in-Wasm case.
- Do NOT "fix" by disabling the read fast-path (forcing reads through
  `__extern_get`) — that would re-slow every typed-shape read and re-introduce
  the box/unbox roundtrip #1269 removed. Fix the WRITE to match the READ.

## Resolution (2026-06-25, sendev)

Added a symmetric **`struct.set` multi-struct dispatch** on the member-WRITE
path, mirroring the read's `struct.get` dispatch. New shared helper
`emitAlternateStructSetDispatch` in `src/codegen/property-access.ts` (next to
`findAlternateStructsForField`): for each struct candidate that owns `propName`,
emit `ref.test → ref.cast → (coerce externref→fieldType) → struct.set`, with the
existing `__extern_set`/`__extern_set_strict` sequence as the terminal else-arm.

Wired into the two externref/any member-write fallbacks in
`src/codegen/expressions/assignment.ts`:
- `compilePropertyAssignmentExternSet` — plain `this.x = v` (and the #2017
  accessor fallback; accessors yield no struct candidate, so the strict-throw
  path is preserved).
- The Path-B externref compound-assignment write-back (`this.pos += inc`).

**Verified:** compiled-acorn `parse("var x = 1;")` now advances PAST the
`readWord1` `this.pos`-non-advance loop — the tokenizer produces the `var` token
(`pos=0 → 3`) and dispatches into `parseStatement`. (Trace: `INCR before=0
after=1 / before=1 after=2 / before=2 after=3` — the increment now persists to
the slot the loop condition reads.)

Regression test: `tests/issue-2657-member-write-struct-slot.test.ts` (3/3) —
the `this.pos += 1` fnctor-prototype-method loop terminates; a plain `this.x = v`
write is visible to the struct.get fast-path read; and a dynamic sidecar-only
property still round-trips via the `__extern_set` fallback.

No regressions in the relevant suites (object-methods, #2608 fnctor-static,
class-static-prototype, define-property, computed-props, hasownproperty all
green; the anon-struct / prototype-chain / compound-assignment-property
failures are PRE-EXISTING test-harness wiring issues identical on clean main —
missing `tests/helpers.ts`, `__register_prototype`/`string_constants` import
stubs — unrelated to this change). `tsc --noEmit` clean. **Broad-impact change
to a hot member-write path — full merge_group / test262 validation required (per
`project_broad_impact_validate_full_ci`); not scope-swept locally.**

### Next acorn blocker (SEPARATE — surfaced by this fix, NOT a regression)

With `pos` advancing, `parse()` now loops one layer deeper: `parseStatement`
re-enters forever with `this.type=var, pos=3` and **`next()` is never called**.
Root cause is a **distinct** defect: `parseStatement`'s `switch (starttype)`
compares `this.type` (an externref to the `var` TokenType singleton) against
`types$1._var` etc. by `===` identity, and NO case matches → it never dispatches
to `parseVarStatement` and the outer `parseTopLevel` loop spins. This is a
**token-type singleton identity / `switch`-on-externref** blocker, the natural
7th dogfood wall — now tracked as **#2656**
(`2656-acorn-parsestatement-switch-externref-token-type-identity.md`,
`depends_on: [2655]` → effectively this PR). Re-probe on the new main once this
lands (per `feedback_reground_spec_against_current_main`). It is masked until
this fix lands because acorn never reached `parseStatement` before.
