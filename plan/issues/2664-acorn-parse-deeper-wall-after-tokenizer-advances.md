---
id: 2664
title: "acorn parse() still hangs at a DEEPER wall after the tokenizer advances (#2656 fixed nextToken) — 8th dogfood blocker"
status: done
completed: 2026-06-26
assignee: ttraenkler/dev-acorn
sprint: 66
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2656, 2659, 2608, 2582]
depends_on: [2656]
origin: "Surfaced by dev-2046 while fixing #2656 (PR #2055): with the ++this.field write-drop fixed, the acorn tokenizer's nextToken() now advances across successive calls (step2 → pos=5 label=name, previously an infinite hang), but full parse(\"var x = 1;\") still does not return — it hits a NEW, distinct wall deeper in the parser."
---

# #2664 — acorn `parse()` hits a deeper wall after the tokenizer advances (8th dogfood blocker)

## Context

#2656 (PR #2055) fixed `compileMemberIncDec` silently dropping `++this.field` /
`this.field--` writes on `any`/`externref` fnctor receivers. That was the
tokenizer-advance freeze: acorn's `skipSpace`/`readWord1` `while (this.pos < len)
{ ++this.pos }` loops never advanced → the **2nd** `nextToken()` hung forever
(blocker #7).

**Verified post-#2656 (full compiled acorn, current main):**
- `new Parser({ecmaVersion:2020}, "var x = 1;").nextToken(); nextToken()` now
  returns `pos=5 end=5 label=name` — the tokenizer advances across successive
  `nextToken()` calls. (probe `.tmp/acorn-verify.mts` in the
  `worktree-agent-…`/`probe-2038-acorn` worktrees.)
- BUT full `parse("var x = 1;")` STILL does not return within the watchdog
  budget — it hits a **new, distinct wall** deeper in the parser. This is NOT
  the `++this.pos` freeze (resolved) and NOT the switch-on-externref identity
  (refuted in #2656 — direct `===` RESULT=111, switch dispatch RESULT=1001).

## What we know / don't know

- **Tokenizer advance: FIXED** (nextToken #2 returns, pos progresses).
- **Where parse() now stops: NOT YET LOCALIZED.** The next investigation pass
  must pin it with the same verify-first, watchdog-bounded probe method used for
  #2656 (incremental `stepN` / piece-isolation probes; full-acorn compile is
  ~100-180s so the fix loop runs inside it).

## Candidate next-wall locations (to confirm — do NOT assume)

`parseTopLevel`'s `while (this.type !== types$1.eof)` loop calls
`parseStatement` repeatedly. With the tokenizer now advancing, suspects for the
remaining non-termination:
- a different `++this.x` / `this.x--` site on a field NOT covered by the #2656
  arm (e.g. element-access `this.arr[i]++`, or a receiver shape that still
  resolves to neither a static struct nor a boxable externref);
- `parseVarStatement` / `eat` / `expect` not consuming a token (a `this.next()`
  not firing, mirroring the #2659 read/write-asymmetry class but on a different
  field such as `this.type`, `this.start`, `this.end`, `this.lastTokEnd`);
- the eof token's `this.type === types$1.eof` guard never tripping at true
  end-of-input (the eof token identity at EOF — distinct from the mid-stream
  token identity that #2656 proved holds).

## Acceptance

- Localize (verify-first) the exact construct where compiled-acorn `parse("var x
  = 1;")` now fails to terminate, with a reduced repro where practical.
- Fix it (or carve a precise sub-issue if it splits further).
- Compiled-acorn `parse("var x = 1;")` returns a `Program` AST → the #1712
  differential-AST gate becomes runnable on the first fixture.
- Full merge_group / test262 (any codegen change here is broad-impact).

## Notes

- 7 prior dogfood blockers cleared: #1712 b1-3, #2582, #2608, #2659 (#2655 slug),
  #2656.
- Method that worked for #2656: incremental `stepN` count probes (which call N
  hangs) + piece-isolation probes (which sub-function hangs) + WAT decode of the
  pinned function, all under a watchdog so the tight Wasm loop is observable.
  Reuse it here.

## Localization 2026-06-25 (dev-2046, verify-first) — 8th wall PINNED to finishToken's this.type write

Investigated on top of the #2656 fix (== current main + PR #2055). Full-acorn
compile ~80-140s; probes in `worktree-agent-…/.tmp/`.

**The tokenizer-advance (#2656) is FIXED** but full `parse("var x = 1;")` still
hangs at a DEEPER, distinct wall — localized step by step:

1. `tokenStream` probe on `"var x = 1;"`: `0:var@3 1:name@5 2:=@7 3:num@9
   4:num@10 5:num@10 …` — tokenization advances through var/name/=/num, then
   **freezes re-producing `num` with pos frozen** after the number.
2. `"1;"` probe: `0:num@1/end1 1:num@2/end1 2:num@2/end1 …` — after the num
   token, the 2nd `nextToken()` ADVANCES pos (1→2, the now-fixed `++this.pos`
   in `getTokenFromCode` `case 59 ';'`) **but `this.type` stays `num` instead of
   becoming `semi`**.
3. Direct `p.finishToken(types$1.semi)` on a fresh full-acorn Parser:
   `before=eof after=eof` — the `this.type = type` write does NOT change
   `this.type`. (Caveat: host-direct call may exercise a different
   `__current_this` path than the in-Wasm call — the WAT below is the solid
   evidence.)

**Root cause (WAT-pinned).** Parser struct = `$__anon_5` = **typeidx 44**;
`type` is field **11** (`(mut externref)`), `pos` field 8, `value` field 12.
`finishToken`'s `this.type = type` store (acorn-full.wat:9544-9561):

```wat
global.get 1588            ;; __current_this  (the receiver)
... local.set 69
local.get 69
any.convert_extern
local.tee 72
ref.test (ref 44)          ;; is __current_this the Parser struct $__anon_5?
(if (then
  local.get 72  ref.cast (ref 44)  local.get 71  struct.set 44 11   ;; → SLOT ✓
) (else
  local.get 69  global.get 539  local.get 71  call 40               ;; __extern_set → SIDECAR
))
```

The #2659 symmetric `struct.set` dispatch arm IS present and correct. The write
is lost ⇒ at runtime **`ref.test (ref 44)` FAILS** for the genuine Parser
instance at this write point, so it takes the `else` → `__extern_set` → sidecar,
while the READ side (`while (this.type !== types$1.eof)` / `this.type !== eof`)
uses `struct.get` on the slot → never sees the write → infinite loop.

**This is NOT a missing dispatch arm (it's there) and NOT the
`compileMemberIncDec` ++/-- lane (this is a plain `=` store).** It is the deeper
`__current_this` representation / `ref.test` machinery: WHY does
`__current_this` (global 1588) fail `ref.test (ref 44)` for the real Parser at
the `finishToken` write, when the member-READ side resolves the same receiver as
struct 44? Candidates:
- `__current_this` holds the receiver as a re-wrapped externref whose
  `any.convert_extern` does not recover the original WasmGC struct identity
  (so `ref.test (ref 44)` is false);
- a struct-subtype / `ref.test` exactness mismatch that only surfaces at acorn's
  full type-table scale.

**Routing:** deep struct-dispatch / `__current_this`-representation internals —
#2659-owner (sendev) territory, not the `compileMemberIncDec` extern-arm lane.
Hand off with this pinned shape.

**Probe artifacts** (`worktree-agent-…/.tmp/`): `probe-8th.mts` (tokenStream +
oneStmt), `post-num.mts` (the num→stuck transition), `ft-acorn.mts` (direct
finishToken before=eof after=eof), `acorn-full.wat` (9 MB; finishToken store at
:9544). `type-write.mts` / `type-collision.mts` are reduced repros that PASS
(isolated `this.type = type` works) — proving the bug is specific to the
full-acorn `__current_this` write path, not the generic externref `=` store.

## ROOT CAUSE FOUND (2026-06-25, sd-2038) — dual Parser struct types + compile-order-frozen write dispatch

NOT a `__current_this` representation bug (the global roundtrip is lossless) and
NOT the `ref.test`-exactness theory. The real cause: **the Parser fnctor gets
TWO distinct WasmGC struct types, and finishToken's `this.type =` write dispatch
was baked (frozen) with only the FIRST one as a candidate because it compiled
before the second was registered.**

### Evidence (full-acorn WAT + traced `findAlternateStructsForField`)

- Two Parser struct types exist, BOTH with `$type` at field 11, `$pos` at 8,
  `$value` at 12:
  - `$__anon_5` (37 fields, anonymous-shape; WAT flat type **44**)
  - `$__fnctor_Parser` (29 fields, the constructor type; WAT flat type **90**)
- The instance is created as **type 90**: `$__fnctor_Parser_new … struct.new 90`
  (`struct.new 44` count = 0 — type 44 is never instantiated as a Parser).
- READ side (`this.type !== eof`) uses `struct.get 90 11` ✓ (matches instance).
- WRITE site (finishToken `$__closure_8`, acorn-full.wat ~9388):
  ```wat
  global.get 1586            ;; $__current_this (the Parser instance, type 90)
  … local.set 69
  local.get 69  any.convert_extern  local.tee 72
  ref.test (ref 44)          ;; tests __anon_5 — FAILS, instance is 90
  (if (then … struct.set 44 11)   ;; slot write — never taken
      (else local.get 69 … call 40))  ;; __extern_set → SIDECAR — TAKEN, write lost
  ```
  There is **no `ref.test 90` arm** — the dispatch tested only type 44.
- `findAlternateStructsForField("type")` is COMPILE-ORDER-DEPENDENT: traced during
  the acorn compile it returns `[__anon_5]` early, `[__anon_5, __fnctor_Parser]`
  later (as `ctx.structFields` grows). finishToken is a lifted closure compiled
  BEFORE `$__fnctor_Parser` is registered, so its baked dispatch only knew
  `__anon_5` (44). The instance's real type (90) was added to the candidate set
  AFTER the dispatch was already emitted inline.

### Net mechanism
finishToken write tests type 44 only → instance is type 90 → `ref.test` false →
`__extern_set` sidecar. The read (`struct.get 90 11`) reads the SLOT → never sees
the sidecar value → `while (this.type !== eof)` never terminates.

### Why reduced repros PASS
A small fnctor produces a SINGLE struct type, so the write candidate == instance
type, and the single `ref.test` arm matches. The bug needs TWO struct shapes for
the same fnctor (acorn's Parser has both an anon shape and the fnctor shape) AND
the closure to compile before the second is registered.

### Fix directions (broad-impact — `emitAlternateStructSetDispatch` is core any-receiver-write machinery)
1. **Defer/finalize the write-dispatch candidate enumeration** (preferred,
   mirrors `fillClosedMethodDispatch` / `fillExternGetIdxVecArms`): reserve the
   `emitAlternateStructSetDispatch` arms and FILL them at finalize when the full
   struct-type table is known, so every candidate type (incl. late-registered
   fnctor structs) gets a `ref.test` arm. Closures compiled early no longer
   freeze an incomplete candidate set.
2. **Unify the dual Parser struct types** — make the fnctor instance and the
   anon-shape resolve to one struct type (root-cause the `__anon_5` vs
   `__fnctor_Parser` split). Larger blast radius (touches anon-struct hashing /
   fnctor struct collection).
3. **Register fnctor struct types BEFORE closure-body compilation** — a
   compile-order fix so `findAlternateStructsForField` sees all Parser shapes
   when the closure write compiles. Narrowest if the ordering is movable.

Validate via the FULL merge_group floor (every `any`-receiver member write is
affected). Direction (1) is the established late-fill pattern and lowest-risk.

## FIX LANDED (2026-06-25, sd-2038) — deferred-fill member-set dispatcher (Option 1)

Implemented the approved Option 1: the inline symmetric struct.set write dispatch
(`emitAlternateStructSetDispatch`) now routes every `any`-receiver `obj.<name>=v`
write through a shared, FINALIZE-FILLED dispatcher
`__set_member_<name>(recv: externref, val: externref)` — mirroring
`fillClosedMethodDispatch` (#2151) / `fillExternGetIdxVecArms` (#2190).

**Files:**
- `src/codegen/member-set-dispatch.ts` (NEW) — `reserveMemberSetDispatch(ctx,
  propName, strict)` reserves the dispatcher (placeholder body) + registers all
  fill-body deps at reserve time (the strict `__extern_set_strict` /  non-strict
  `__extern_set` fallback import, the prop-name string constant, union box/unbox
  helpers) so the fill only READS funcMap; `fillMemberSetDispatch(ctx)` SPLICES
  the complete `ref.test`/`struct.set` candidate chain at finalize when the full
  struct-type table is known. STRICT (`obj.x=v`) and NON-strict
  (`obj.x+=v`/`obj.x++`) are distinct dispatcher variants (different terminal
  else-arm), keyed `<name>` vs `nonstrict_<name>`.
- `src/codegen/property-access.ts` — `emitAlternateStructSetDispatch` now takes
  `(recvExtLocal, valExtLocal, propName, strict)` and emits `local.get recv;
  local.get val; call <dispatcher>` instead of the inline chain.
- `src/codegen/expressions/{assignment,unary-updates}.ts` — the 3 call sites pass
  the externref receiver + strictness; the inline `externSetFallback` is gone
  (it's the dispatcher's terminal arm), with a bare-write fallback only if the
  dispatcher can't be reserved.
- `src/codegen/index.ts` — `fillMemberSetDispatch(ctx)` wired right after
  `fillClosedMethodDispatch(ctx)` in the finalize block (runs in ALL modes).

**Verified (WAT, current main + fix):** `$__set_member_type` dispatcher now
carries the COMPLETE chain `ref.test 44 → struct.set 44 11` else `ref.test 90 →
struct.set 90 11` else 165/204/230… and is called from 19 sites (every
`this.type=` write). The instance is type 90, so `ref.test 90` now succeeds and
the write hits the slot. Inline `struct.set _ 11` dropped 40→2 (the 2 are the
dispatcher's own arm + the statically-typed `$__sset_type` accessor). Acorn WAT
shrank 9.06 MB → 8.64 MB (shared dispatchers vs inlined chains).

**Tests:** `tests/issue-2664-member-set-dispatch-deferred-fill.test.ts` (5/5):
closure `this.field=v` round-trips + terminates; the write compiles to a shared
`__set_member_<name>` dispatcher; strict/non-strict variants coexist; sidecar-
only props round-trip; the #2657 immutable-wrapper guard is preserved. Existing
member-write suites green: `issue-2659` (4/4), `issue-2656` (6/6),
`define-property-patterns`. (The `compound-assignment-property` /
`object-define-property` failures are the PRE-EXISTING `./helpers.js`
module-resolution harness issue, identical on clean main.) tsc + prettier +
biome(error-level) clean.

### Status: write-fix landed; acorn parse() hits a DISTINCT 9th wall (separate issue)
The #2664 type-write asymmetry is FIXED (WAT-proven complete chain; reduced repro
round-trips). However full `parse("var x = 1;")` still does NOT return — it blocks
synchronously at a NEW, DEEPER wall beyond the type-write (the wasm call blocks
the JS event loop, so the loop is past tokenization). This is the next dogfood
blocker, NOT a regression of this fix. File a 9th-wall follow-up and re-localize
on the new main (verify-first). 

### Read-side latent pattern (noted, not fixed here — not needed for #2664)
The member-READ multi-struct dispatch (`findAlternateStructsForField` at
property-access.ts:1400/1678/4872) has the SAME inline compile-order enumeration,
but reads happen to compile late enough today (the `this.type` read in
`parseTopLevel` resolved to type 90 correctly). If a future early-compiled read
freezes an incomplete candidate set, apply the same deferred-fill treatment
(`__get_member_<name>` dispatcher). Out of scope for #2664 (the write fix alone
resolves the type-write asymmetry).

## RESOLVED (2026-06-26, dev-acorn) — under-applied dynamic method dispatch returned null

Re-probed on current main (#2664 write-fix #2064, #2674 #2072/#2075 read-fix all
merged). `parse("")`/`parse(";")` returned a Program AST but `parse("x")`/
`parse("var x = 1;")` still hung — a **distinct** wall past the type-write /
read-dispatch classes (verify-first: pos advances, token identity matches —
NOT the #2664/#2656/#2659 mechanisms).

### Root cause (verify-first, instrumented acorn + WAT + host-bridge trace)

The hot loop was `parseTopLevel`'s `while (this.type !== eof)` re-parsing the same
statement forever. Numeric-coded source instrumentation pinned it: `parseStatement`
reached `expr = this.parseExpression()` every iteration, but `parseExpression`'s
**body never ran** — so `next()` was never called, the token never advanced, and
the loop spun. The host method-call bridge (`__extern_method_call`) was invoked for
`"parseExpression"` 4749×/window but **returned null**, while the SAME bridge ran
`"parseStatement"`.

The asymmetry is **arity**, not name resolution:
- `_wrapWasmClosureUnknownArity` (src/runtime.ts) selected the wasm dispatcher by
  the JS caller's `args.length`: `__call_fn_method_<args.length>`.
- `__call_fn_method_N` (`emitClosureMethodCallExportN`, src/codegen/index.ts:3681)
  **only dispatches closures of arity ≤ N** — a closure whose declared arity
  EXCEEDS N is omitted and the dispatcher falls through to `ref.null.extern`
  (null), passing each matched closure exactly its OWN arity (index.ts:3777).
- `this.parseExpression()` (acorn calls it with **0 args**; declared **2 params**)
  → `args.length=0` → `__call_fn_method_0` → the arity-2 `parseExpression`
  closure is OMITTED → returns null → body never runs.
- `this.parseStatement(a,b,c)` (3 args, 3 params) → `__call_fn_method_3` → matched
  → runs. (This is why `parse("")`/`parse(";")` — which never call a method with
  fewer args than its arity — worked, but `parse("x")` did not.)

### Fix (src/runtime.ts — `_wrapWasmClosureUnknownArity`)

For the METHOD path the bridge now dispatches at the **max available
`__call_fn_method_N`** (which includes every closure of arity ≤ N), padding the
missing args with `undefined` (JS missing-argument semantics). Each closure still
receives exactly its own declared arity (extra padding is dropped at the wasm
dispatch arm), so over-dispatching is safe. The free-function / extracted-method
(`const f = o.m; f()`) path is UNCHANGED (keeps `args.length`-based dispatch so the
low-arity-generator semantics noted at `_wrapForHost` hold). Broad-impact: this is
general dynamic-method dispatch, validated through the full merge_group floor.

### Verified
- `tests/issue-2664-arity-dispatch.test.ts` (5/5): under-applied 2-param-via-0-arg
  method runs (not null); deep under-applied chain; arity-matched control;
  over-applied still gets only declared arity; parser-loop-shape terminates.
- Reduced repro reproduces the bug: returns **null** on clean main, correct value
  with the fix (control arity-matched case passes both ways).
- Compiled acorn: the HANG is GONE. `parse("1")` / `parse("1;")` now return a
  real `Program` AST (bodyLen 1) — the #1712 differential gate is runnable for
  numeric/empty statements.
- `issue-2664-member-set-dispatch-deferred-fill` (write-side), `issue-2659`,
  `issue-2656`, `class-methods`, `generators` families: **no new failures** — the
  2/17 pre-existing `string_constants` instantiation fails are IDENTICAL on clean
  origin/main (harness limitation, not this change). tsc clean.

### Remaining: 10th wall carved as #2681
`parse("x")` / `parse("var x = 1;")` (the IDENTIFIER path, now reachable since
`parseExpression` runs) THROW a `WebAssembly.Exception` — acorn's `unexpected()`
fires on a valid `name` token. A DISTINCT mechanism (throw, not hang). Tracked as
**#2681** (10th dogfood blocker) with the raise-site localization + method.
