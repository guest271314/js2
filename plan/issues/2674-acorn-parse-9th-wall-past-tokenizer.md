---
id: 2674
title: "acorn parse() 9th wall PAST tokenization (after #2664 type-write fix) — parseTopLevel/parseStatement array-push loop"
status: done
assignee: ttraenkler/sd-2674c
sprint: 69
created: 2026-06-25
updated: 2026-07-03
completed: 2026-06-28
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2664, 2659, 2656, 2655, 2608, 2582]
depends_on: [2664]
origin: "Surfaced by sd-2038 fixing #2664 (PR #2064): the 8th-wall type-write asymmetry (finishToken's this.type= leaking to the sidecar) is FIXED via the deferred-fill __set_member_<name> dispatcher (WAT-proven 44→90 complete chain, instance type 90 now hits the slot). But full parse(\"var x = 1;\") STILL does not return — it blocks SYNCHRONOUSLY at a NEW, distinct wall PAST tokenization."
---

# #2674 — acorn `parse()` 9th wall past tokenization

## Context (the acorn dogfood chain, layer by layer toward the AST)

Prior dogfood blockers cleared: #1712 b1-3, #2582, #2608, #2655/#2659
(member-write struct-slot), #2656 (`++this.field` write-drop), #2664 (the 8th
wall — `this.type =` write leaking to the sidecar via a compile-order-frozen
single-candidate dispatch; fixed by the deferred-fill `__set_member_<name>`
dispatcher in PR #2064).

## What we know (verify-first, sd-2038)

- The #2664 **type-write asymmetry is FIXED** (must re-confirm on NEW main once
  #2064 merges): WAT-proven `$__set_member_type` now carries the COMPLETE
  candidate chain (`ref.test 44 → struct.set 44 11` else `ref.test 90 → struct.set
  90 11` else 165/204/230…), called from 19 sites; the Parser instance is type 90,
  so the write now hits the slot. Reduced repro round-trips.
- BUT full `parse("var x = 1;")` STILL does not return. The wasm `parse` call
  **blocks the JS event loop SYNCHRONOUSLY** (a `setInterval` watchdog never
  fired), so the non-termination is in a TIGHT in-Wasm loop PAST tokenization
  (the type-write fix moved the wall deeper — the tokenizer now produces `semi`
  etc.). This is NOT the #2664 type-write and NOT a regression.

## Blocker 0 — PROBE HARNESS LIMITATION (solve first)

The in-Wasm-method runtime probe is currently blocked:
- `wrapExports` (src/runtime.ts:12902) marshals a struct RETURN to a plain JS
  object of FIELD values — it does NOT bind the struct's prototype METHODS as
  callable. So `tokenizer("1;").nextToken()` fails (`nextToken is not a
  function`): the returned Parser exposes `pos`/`type`/`value`… fields but no
  callable methods (methods are in-Wasm dynamic dispatch, not struct fields).
- The top-level `parse` EXPORT is directly callable (the harness uses it), but it
  blocks synchronously, so a same-thread watchdog can't bound it or snapshot a
  mid-hang host-call signature.

**Fix the harness first (durable, helps all future acorn-chain localization):**
- (a) Run the wasm `parse`/method call in a **Worker thread** with a watchdog
  that terminates the worker after N ms — bounds the synchronous loop AND lets a
  host-import call-counter snapshot the loop signature before kill; OR
- (b) Extend `wrapExports` / the dogfood harness to expose CALLABLE in-Wasm
  methods on a returned struct (a method-dispatch bridge over `__call_fn_method_N`
  / the closed-method dispatcher), so `tokenizer(src).nextToken()` /
  `.getToken()` drive the in-Wasm tokenizer step-by-step.

Bank whichever lands as a reusable dogfood-probe utility.

## Localization plan (after #2064 merges — re-probe on NEW main, verify-first)

1. Confirm the #2664 type-write fix is in (sibling PRs move the path).
2. With the harness fix, drive the tokenizer to EOF on `"var x = 1;"` and confirm
   `this.type` now reaches `eof` (the #2664 symptom was `num`/`semi` frozen).
3. If tokenization completes, the 9th wall is in the PARSER (parseTopLevel /
   parseStatement / parseVarStatement / eat / expect / next). Use the #2656/#2664
   method: incremental `stepN` count probes + piece-isolation + WAT decode of the
   pinned function under a watchdog.
4. Candidate suspects (do NOT assume — verify): a `this.next()`/`eat`/`expect`
   not consuming a token (read/write-asymmetry on a DIFFERENT field —
   `this.start`/`this.end`/`this.lastTokEnd`/`this.lastTokStart` — possibly the
   SAME dual-struct-type or sidecar class #2664 fixed for `this.type`, now needed
   for another field); a token-type singleton `===` identity at a deeper switch;
   or the eof-token guard never tripping at true end-of-input.

## Read-side latent note (from #2664, not yet needed)

The member-READ multi-struct dispatch (`findAlternateStructsForField` inline at
property-access.ts:1400/1678/4872) has the SAME compile-order enumeration as the
write had pre-#2664. Reads happen to compile late enough today, but if a deeper
wall turns out to be an early-frozen READ candidate set, apply the same
deferred-fill treatment (a `__get_member_<name>` dispatcher mirroring #2664's
`__set_member_<name>`).

## Acceptance

- Localize (verify-first, watchdog-bounded) the exact construct where
  compiled-acorn `parse("var x = 1;")` now fails to terminate, with a reduced
  repro where practical.
- Fix it (or carve a precise sub-issue if it splits further).
- Compiled-acorn `parse("var x = 1;")` returns a `Program` AST → the #1712
  differential-AST gate becomes runnable on the first fixture.
- Full merge_group / test262 (any codegen change here is broad-impact).

## BLOCKER-0 RESOLVED (2026-06-25, sd-2038) — worker-thread watchdog probe harness landed

Built the reusable dogfood probe harness (the BLOCKER-0 the same-thread watchdog
could not solve):
- `tests/dogfood/probe-worker.mjs` — compiles + instantiates + runs an acorn
  entry point INSIDE a worker thread (the parent can terminate it on a hang; a
  synchronous Wasm loop blocks the event loop so setTimeout can't). It wraps every
  host import with a **SharedArrayBuffer**-backed call counter — the import
  closures run DURING the in-Wasm loop, so even though the worker's own JS timers
  are starved, the PARENT reads the live SAB counts and reports the loop's
  host-call signature before terminating.
- `tests/dogfood/probe-driver.mjs` — parent: spawns the worker (propagating the
  tsx loader flags from `process.execArgv` so the worker can import the .ts
  compiler), arms the watchdog only for the RUN phase (not the ~100s compile), and
  on a hang prints the top host-call signature. Reusable `probe({source, call,
  args, watchdogMs})` export + a CLI that drives the PINNED acorn entry.
  Usage: `npx tsx tests/dogfood/probe-driver.mjs 'var x = 1;' parse 20000`.

Validated: a trivial `export function parse(s){…}` returns `{status:"ok", result:
{type:"Program", bodyLen:0}}`; acorn `parse("var x = 1;")` returns
`{status:"hang", signature:[…]}` with the loop fingerprint.

## 9th WALL LOCALIZED (2026-06-25, sd-2038) — parseTopLevel/parseStatement array-push loop

Ran the harness against **merged-main WITH the #2664 type-write fix** (confirmed
`fillMemberSetDispatch` present). `parse("var x = 1;")` STILL hangs (the #2664 fix
moved the wall deeper, as expected — NOT a regression). The host-call signature
over the bounded hang window:

| host import | calls (~) |
|---|---:|
| `__js_array_push` | 166,229 |
| `__js_array_new` | 124,671 |
| `__extern_method_call` | 124,650 |
| `__box_number` | 62,403 |
| `__register_fnctor_instance` | 20,857 |
| `__host_compare` | 20,812 |
| `__box_boolean` | 20,802 |

**Reading:** a tight loop that, each iteration, calls a method via
`__extern_method_call` (124k) which `__js_array_new` + `__js_array_push`es (166k)
and boxes numbers (62k) — i.e. the parser is **re-running a statement-parse that
appends to an array forever without consuming input**. In acorn's
`parseTopLevel`, `while (this.type !== eof) { node.body.push(this.parseStatement(…)) }`
appends to `body`; if `parseStatement` (→ `parseVarStatement` → `expect`/`eat` →
`this.next()`) fails to advance the token, the loop appends forever — matching the
`__js_array_push`-dominated signature. (`__extern_method_call` 124k ≈ the
any-receiver method dispatch for `this.parseX()` / `this.next()`; `__box_number`
the numeric field math.)

**Next (re-localize on merged-main, verify-first):** narrow within the parser —
incremental probes on `parseTopLevel` / `parseStatement` / `parseVarStatement` /
`eat` / `expect` / `next`. Prime suspect (do NOT assume — verify with the same
WAT + harness method that cracked #2664): a `this.next()` / `eat` / `expect` whose
field WRITE (e.g. `this.start`/`this.end`/`this.lastTokStart`/`this.lastTokEnd`)
does NOT advance — possibly the SAME dual-struct-type / sidecar class #2664 fixed
for `this.type`, now needed for another Parser field, OR a token-type `===`
identity at a deeper switch that never matches so `next()` is never called. The
#2664 `__set_member_<name>` dispatcher already covers ALL field writes generically,
so if it IS another field-write asymmetry it may already be fixed by #2664 for that
field too — re-probe to see WHICH field's read/write now diverges (or whether it's
a token-identity / control-flow loop instead).

## BISECT NARROWED (2026-06-25, sd-2038) — empty input PARSES; wall is in statement-parse

Decisive datapoint via the harness on merged-main (with #2664): **`parse("")`
returns `{type:"Program", bodyLen:0}` in 19ms** — a valid, EMPTY Program AST. So
the full entry chain WORKS for empty input: `Parser.parse` → `new this(...).parse()`
→ `parseTopLevel` correctly sees `this.type === eof` immediately and returns the
Program. (This also means the harness end-to-end is sound and the AST marshalling
works — the #1712 differential gate is RUNNABLE the moment a non-empty statement
parses.)

Therefore the 9th wall is **specifically in the statement-parse path**
(`parseStatement` / `parseVarStatement` and the `next`/`eat`/`expect` it drives),
NOT in `parseTopLevel`'s loop/eof-guard or the entry machinery — those are proven
working by the empty-input pass. For `var x = 1;` the parser enters
`parseStatement`, fails to consume the `var` token (the `__js_array_push` 166k
loop = `parseTopLevel` re-appending a never-advancing statement), and spins.

**Next probe (verify-first):** bisect statement shapes — `parse(";")` (empty
statement, exercises `parseStatement`'s `semi` case → `this.next()`), `parse("1")`
(bare expression-statement), `parse("1;")` — to pin whether `next()`/`eat()` after
the FIRST token advances. Then WAT-decode `parseStatement`/`next` and check the
specific field read/write (`this.start`/`this.end`/`this.lastTokStart`/
`this.lastTokEnd`) or the token-type `switch` dispatch, the same way #2664's
`this.type` was cracked. (A single-compile multi-input probe variant of the
harness would avoid the per-input recompile — a worthwhile harness follow-up.)

## HANDOFF (2026-06-25, sd-2038) — two landed fixes; residual typeof-led loop pinned

Worked the 9th wall to TWO distinct, landed root causes; both are NECESSARY but
NEITHER is SUFFICIENT alone. `parse("")` and `parse(";")` return a valid empty
Program AST; `parse("x")`/`parse("1")` (any expression statement) STILL hang on a
RESIDUAL cause. NOT yet the #1712 AST milestone — `parse()` does not return for a
non-empty statement.

### Probe harness (landed, #2069) — use this to continue
- `npx tsx tests/dogfood/probe-driver.mjs '<input>' parse <watchdogMs>` — single
  input, prints `{status: ok|hang, signature, result}`. Worker-thread watchdog +
  SharedArrayBuffer host-call counter (the in-Wasm loop is synchronous and starves
  same-thread timers; the SAB lets the parent read the live host-call signature
  before terminating).
- `bisect({source, call, inputs, perInputWatchdogMs})` (export in probe-driver) —
  ONE compile, N inputs in one worker, per-input watchdog, first-hang wins. Use
  for fast statement-shape bisects (`["", ";", "x", "1", "1;", "var x = 1;"]`).
- For the EXACT field/key under a hang: wrap `io.env.__extern_get` with a
  key-histogram + a call CAP that throws (see `.tmp/keys-probe2.mjs` pattern) —
  names the property being hammered.

### Fix 1 (LANDED, #2072 / tracked #2677) — chained this-assignment field collection
`compileNewFunctionDeclaration.collectThisAssignments` (new-super.ts) only
recorded the OUTERMOST LHS of a ctor `this`-assignment, dropping inner chained
targets (`this.start = this.end = this.pos` → `end` lost). `$__fnctor_Parser` was
missing end/endLoc/lastTokEnd/lastTokStartLoc/awaitPos/awaitIdentPos. Fixed via
`collectAssignmentChain` (walks the full `=` chain). The struct now has the full
35-field set.

### Fix 2 (LANDED, #2075) — read-side __get_member_<name> deferred-fill dispatcher
The member-READ multi-struct dispatch (`findAlternateStructsForField` chain at
property-access.ts:1386/1684/4896) was frozen inline at compile time, like #2664's
write side. A reader compiled before `$__fnctor_Parser` registered only tested the
earlier struct type → `__extern_get` → `undefined` on the real instance.
`src/codegen/member-get-dispatch.ts` (`__get_member_<name>(recv)->externref`,
filled at finalize with the complete candidate set) now backs each read site's
terminal. Frozen single-candidate read sites in compiled-acorn: **9 → 1**.

### RESIDUAL (still open) — typeof-led loop, NOT a struct-slot read
After both fixes, `parse("x")` still hangs. The signature SHIFTED from
`__extern_get`-led to **`__typeof_number`-led**:
`__typeof_number ≈115k, __extern_get ≈118k, __get_undefined ≈98k, __host_eq` present.
`__typeof_number` is compiler-emitted (NOT acorn source `typeof`) — for a value
type-tag check. Hypothesis (VERIFY, don't assume — one hypothesis was already
disproven this session): a `typeof x === "..."` / ToNumber-or-ToPrimitive value
classification in a loop (candidate: `parseExprOp` operator-precedence
`this.type.binop` read + comparison, or a boxed-value `===`/`!==` that never
satisfies the loop-break), OR the 1 remaining frozen read. It is NO LONGER the
struct-read freeze (that's fixed). 

### Next step (fresh agent, on merged #2072+#2075)
1. Re-bisect `["x","1","1;"]` on merged main (confirm still hangs + fresh signature).
2. Capture the dominant `__typeof_number` / `__host_eq` CALL-SITE: instrument those
   host imports (key/arg histogram, CAP-throw) OR add a per-closure hit counter to
   find the hot function, then WAT-decode it.
3. Likely loci: `parseExprOp` (`this.type.binop` precedence loop), `parseMaybeUnary`
   postfix `while`, or a token-type `===` identity (the #2656-noted switch-on-
   externref class) that never matches so `next()` is never called.

## #2075 RE-PARK FIX (2026-06-25, sd-2674b) — late-import index-shift hardening of the read dispatcher

#2075 (the read-side `__get_member_<name>` deferred-fill dispatcher) was green at
PR-level but **re-parked by the auto-park bot** on a REAL `merge_group` test262
regression: net **-2** (2 js-host `pass → compile_error`), the exact failure
```
language/expressions/class/elements/regular-definitions-private-names.js
language/expressions/class/elements/wrapped-in-sc-private-names.js
  L1:1 Binary emit error: RangeError: Codegen error: local index out of range —
  1 (valid: [0, 1)) at function '__module_init'. This is the late-import
  index-shift class (#2043)
```
(report: net_per_test -2, "Regressions with wasm-hash change: 2" — deterministic,
not drift; bucket `37609ba477f88b4a`).

### Diagnosis (verify-first)
- The failing `merge_group` ran on a **batched speculative tree** (`max_entries_to_build>1`):
  #2075 AND #2063 shared the identical merged SHA `562d2cde`. On EVERY local tree
  I could build — clean upstream/main, #2075-on-main, the exact #2075+#2063 merge
  tree, and sequential-in-one-process (mimicking a shard worker) — both targets
  **PASS** in gc and standalone. So the trigger is the **#2075 × another
  import-adding PR interaction** in the batch, a #2043 late-import-index-shift
  collision, NOT a #2075-alone defect.
- **Root cause** (read against the WRITE-side sibling that does NOT regress):
  `reserveMemberGetDispatch` calls `ensureLateImport(__extern_get)` +
  `addUnionImportsViaRegistry`, which stage a `pendingLateImportShift`. The three
  READ call sites (property-access.ts ~1420/1719/4961) then bake the returned
  `funcIdx` into a **DETACHED** `buildFallback` terminal array AND immediately run
  a `coercionInstrs(…, fctx)` (which can allocate locals + add MORE late imports)
  — all across a still-dangling pending shift. The WRITE site (1303) survives
  because it pushes straight into `fctx.body`, which the body-level batched flush
  always reaches; the detached READ arrays are fragile when another import-adding
  pass interleaves before the deferred flush.

### Fix (durable, #2043 class)
`reserveMemberGetDispatch` now takes an optional `fctx` and calls
`flushLateImportShifts(ctx, fctx)` after registering its imports (ensure→flush
discipline, matching `buildVecFromExternref`/`emitUndefined`). All three READ call
sites pass their `fctx`. The dispatcher's imports settle against the current body
BEFORE the caller bakes the funcIdx / runs the follow-on coercion — resilient
regardless of which import-adding PR gets batched alongside.

### Validation (local; merge_group is the real floor since the bug is batch-only)
- typecheck clean; #2674 dispatcher tests 3/3; #2664 (write-side) + #2563
  (privatefield-global-shift, the late-import-shift gate) pass.
- 141 read-path test262 files (property-accessors / getOwnPropertyDescriptor /
  for-in / class-elements) → **0 new compile_errors** with the fix (the 2 `let`
  for-in CEs pre-exist on clean main).
- The 2 regressed private-field tests PASS (gc + standalone).
- 9 vitest failures in getters-setters/etc. are **identical on clean upstream/main**
  — pre-existing harness issues, not from this change.

## TYPEOF-RESIDUAL ROOT-CAUSE (2026-06-25, sd-2674b) — token-type singleton identity break in `canInsertSemicolon`

Worked the residual on the **fixed+merged #2075 base** (my #2043 hardening landed).
`parse("x")` STILL hangs. Localized end-to-end with single-compile SAB cap-throw
probes (built `.tmp/bisect-*`, `.tmp/keyhist-*`, `.tmp/methhist-*`, `.tmp/typetrace-*`,
`.tmp/eqtrace-*` — single acorn compile, per-import histogram + cap-throw; the
`bisect()` the prior handoff referenced was never actually landed in
`probe-driver.mjs`, only `probe()`).

### Localization chain (all verified, on merged #2075)
1. **bisect** `["x","1","1;","var x=1;"]` → first hang `parse("x")`, signature
   `__extern_get 114k, __typeof_number 111k, __get_undefined 94k, __host_eq 91k,
   __js_array_push/new/__extern_method_call 61k each, __is_truthy 56k`.
2. **`__extern_get` key histogram** (CAP 200k): `type 48600, options 43746,
   value 24300, ecmaVersion 19447, locations/ranges/start/lastTokEnd ~9720,
   input/startLoc/body/lastTokEndLoc ~4860`. Parser-instance fields read via the
   sidecar.
3. **`__extern_method_call` NAME histogram** (CAP 120k): `isContextual 21812,
   isUsingKeyword 10906, then parseStatement / parseExpression /
   parseExpressionStatement / semicolon / eat / insertSemicolon /
   canInsertSemicolon / unexpected / finishNode / startNode / push ALL ~5453` =
   ONE per top-level loop iteration. ⇒ the hot loop is `parseTopLevel`'s
   `while (this.type !== eof) body.push(parseStatement())`, ~5453 spins.
4. **`this.type` value trace**: reads back `"name"` every iteration (+ occasional
   `undefined`) — STUCK on the `x` identifier token, never advances to `eof`.
5. **`__host_eq` operand trace** (the decider): the comparisons are
   `this.type ("name") === types$1.eof` shown as **`name === {}`** — the RHS
   singleton `types$1.eof` reads back as a **FIELD-LESS object `{}`** (its
   `.label` is gone). So the identity/contents of the token-type singleton read
   via the module-global `types$1.eof` member access is broken → the comparison
   never matches → `canInsertSemicolon` (`this.type === eof || this.type ===
   braceR || lineBreak.test(...)`) never returns true → ASI never fires →
   `parseStatement`→`semicolon`→`unexpected` loops without advancing.
   - SECONDARY: ~4 of the sampled `__host_eq` calls returned **`-> 1` (true)
     while JS `===` is FALSE** — a strict-equality correctness wrongness on these
     externref operands (re-boxed wrapper mis-compare). Possibly intersects the
     JS-host externref `===` path in `binary-ops.ts`.

### Root cause (pinned, not yet fixed)
Acorn's token-type singletons live in a **module-level object literal**
`var types$1 = { eof: new TokenType("eof"), name: new TokenType("name"), … }`
(~50 entries; `TokenType` is `var TokenType = function TokenType(label,conf){…}`
with 11 fields). At acorn scale, reading a singleton via the `types$1.<name>`
member access returns a field-less / non-identical object, so
`this.type === types$1.eof` (a TokenType externref identity compare in
`canInsertSemicolon`) never holds. `this.type` itself reads correctly ("name");
it is the **`types$1.<name>` holder-member read** (and/or its externref identity)
that breaks.

### NOT reproducible in isolation (the hard part)
Every minimal repro PASSES on the fixed base — all via the real probe harness
(full import object): `types.eof.label` read; two-reads identity; round-trip
`this.type = types.eof` then `=== types.eof`; compare-in-a-separate-method
(`isEof()`); named-fn-expr Parser + holder singletons + `next()`/`run()` loop.
The break needs the FULL acorn type-table scale (~50 token types ⇒ many struct
shapes registered ⇒ the read-dispatch candidate enumeration or externref
identity for the holder-member singleton read only diverges at scale — the
multi-shape class #2664/#2075 addressed for `this.type`, now for the
`types$1.<name>` SINGLETON read on the holder object).

### SEPARATE bug found en route (carve to its own issue — NOT on acorn path)
A **function-DECLARATION used as a constructor** with prototype methods drops
method dispatch: `function P(){ this.n=0 } P.prototype.run=function(){…};
new P().run()` → runtime **"run is not a function"**. The function-EXPRESSION
forms (`var P = function(){…}` and named `var P = function P(){…}`) BOTH work.
Acorn uses only named function expressions, so this is NOT the acorn wall — but
it is a real codegen correctness gap worth its own issue.

### DECISIVE finding — the singletons read back as EMPTY objects (`__host_eq` operand dump)
Describing both `__host_eq` operands during the hang (constructor + own-keys +
`.label`):
```
A{ ctor=undefined keys=[label,keyword,beforeExpr,startsExpr] label="name" }   // this.type / this.value — a PROPER TokenType
  ===
B{ ctor=undefined keys=[]                                   label=<none>  }   // types$1.<name> read — an EMPTY {} (NO own keys)
  -> 0   (and one sampled -> 1 — a spurious eqref TRUE on two distinct empties)
```
So operand B — the **`types$1.<name>` module-level singleton read** — comes back
as an object with **ZERO own properties** (no `label`/`keyword`/…). The
TokenType instances stored in the `var types$1 = { eof: new TokenType("eof"), … }`
holder are EMPTY when read at acorn scale. `this.type` (A) is a full TokenType;
the holder-member read (B) is `{}`. They can never be `===`, so the
`switch (this.type) { case types$1.name: … }` in `parseExprAtom` (the
#2656 switch-on-externref class) NEVER matches `name` → the ident path that calls
`this.next()` is never taken → `this.type` stuck on `name` → `parseTopLevel`
spins. (The `__host_eq -> 1` on two empties is a SECONDARY eqref false-positive.)

### NOT reproducible in isolation even faithfully
`types.eof.label` + identity on a module-level object literal of `new
TokenType(...)` (incl. the faithful 11-field TokenType + `binop()`/`kw()` helper
constructors + num/name/eof/semi/plusMin/_in entries) returns 11 (correct) —
the empty-object behaviour only appears at FULL acorn scale (~50 token types,
`keywords`/`keywordTypes` loops, `Object.defineProperties(Parser.prototype,…)`,
spreads). Strongly suggests a **struct-shape collision / wrong-candidate
resolution at scale**: the `types$1` holder or the TokenType struct gets read
through a DIFFERENT (empty) struct shape than the one the instances were
constructed into — the multi-shape value-representation family of #2664/#2075,
now for module-level class-instance singletons in an object literal.

### Next step (continue here — fixed #2075 base)
Find why `types$1.<name>` resolves to an EMPTY struct at scale: (1) dump the
struct types registered for the `types$1` object literal and the TokenType
instances; (2) check whether the object-literal property read for `types$1.eof`
picks a wrong/empty struct candidate (the `findAlternateStructsForField` /
`__get_member` candidate set for `eof`/`name`/… on the holder), OR whether the
`new TokenType()` results stored into the holder literal lose their fields
(construction-vs-storage). Then apply the matching dispatch/representation fix
(same family as #2664/#2075). ALSO carve: (a) the function-declaration-constructor
method-dispatch bug above; (b) the `__host_eq` eqref false-positive on distinct
empty structs. Sync with sd-2679 (#2679) before touching shared read/box/identity
paths. STILL NOT the #1712 milestone — `parse()` does not yet return for a
non-empty statement.

## DECISIVE ROOT-CAUSE — `this.<field>` read routes through delete-aware plain `__extern_get`, breaking token-type identity (2026-06-26, sd-2674c)

Worked on the fixed+merged #2075 base (re-merged `upstream/main`, which has
#2075/#2079). `parse("x")` STILL hangs. Localized via 8 full-acorn instrumented
compiles (~290s each on this box) + WAT dump + runtime diag exports. The prior
"types$1 singletons read back EMPTY" framing was a HOST-MARSHALLING artifact, not
the mechanism. The real chain is now PINNED end-to-end:

### What is actually true (verified, not hypothesised)
1. **The holder + its values are intact.** A diagnostic export appended to the
   real acorn source (`.tmp/diag.mjs`, full scale) reads
   `types$1.eof.label="eof"`, `types$1.name.label="name"`, and confirms identity
   is preserved across repeated reads: `eof===eof: true`, `name===name: true`,
   `held(name)===freshread(name): true`. So the stored token-type structs are
   correct and the `===` OPERATOR matches them correctly **in a freshly-compiled
   function**.
2. **A FakeP class at full acorn scale also works** (`.tmp/diag2.mjs`, named
   function-expression ctor): `switch=1/2 op=1/2` — both a `switch(this.type)` and
   the `===` operator match token types correctly. So the bug is **NOT** a generic
   switch/`===`/representation defect — it does not reproduce through a freshly
   compiled class even at full scale.
3. **There is now ONE Parser struct type** (`$__fnctor_Parser`, type idx 90) — the
   #2075 dual-Parser shape is resolved. **There are NO `__get_member_<name>`
   dispatchers in the compiled acorn WAT at all** (`grep '(func $__get_member'` →
   none). So the #2075 read dispatcher is **never reserved** for the parser-method
   reads — they take a different path.
4. **`this.type` is read via `__extern_get` ~48.6k×** (the cap-throw key
   histogram's top key is `type`; also `options`, `value`, `start`, `lastTokEnd`…
   — all Parser instance fields). So parser-method `this.<field>` reads compile to
   the **host sidecar `__extern_get`**, returning a host-proxy/externref value —
   NOT `struct.get` on type 90, NOT the #2075 dispatcher.
5. **Acorn uses `delete`** (4×, incl. `delete this.undefinedExports[name]`), so
   `moduleUsesDelete` is TRUE.
6. **`__host_eq` smoking gun** (`.tmp/eqtrace2*`): during the hang, the dominant
   comparison is `{label="name" nkeys=10} === {label=U nkeys=0} -> 1` (TRUE) fired
   ~4k× — i.e. a proper name-token compared against an empty-marshalling proxy
   returns spurious TRUE. host_eq canonicalizes both operands through
   `_hostEqComparableValue`→`_unwrapForHost` (the #1712 proxy-unwrap), which
   **mis-resolves at full acorn scale** so the switch matches the WRONG case.

### The mechanism (pinned)
`tryEmitDeleteAwareDynamicGet` (property-access.ts ~2137-2197) fires for every
`any`/`unknown`-typed receiver read **when `moduleUsesDelete`** (true for acorn).
It emits a **plain `__extern_get(recv, "name")`** — deliberately, for
delete-tombstone awareness — and does **NOT** try `struct.get` on the receiver's
WasmGC struct, nor route through the #2075 `__get_member` dispatcher. The lifted
acorn parser methods (`pp$N.parseExprAtom = function(){…}`) have a `this` that the
compiler types as `any`/externref (NOT resolved to `$__fnctor_Parser`), so
`this.type` takes this path → returns a **host sidecar/proxy** value that diverges
in representation from the `struct.set`-written raw struct.

Then in `parseExprAtom`'s `switch (this.type) { case types$1.name: … }`
(strict-per-case → `emitSwitchStrictEq`, JS-host branch → `__host_eq`), both
operands are host proxies; `__host_eq`'s `_unwrapForHost` collapses distinct
case-label proxies onto one struct at scale → `this.type === types$1.<firstCase>`
spuriously returns 1 → the wrong case runs → `this.next()` is never called →
`this.type` stays `name` → `parseTopLevel`'s `while (this.type !== eof)` spins
(~5453 iterations bounded; the `__js_array_push`/`__extern_method_call` ~160k
signature is the per-iteration statement re-parse).

### Why prior fixes / my attempt did not land it
- #2664 (write dispatcher) + #2075 (read dispatcher) operate in
  `emitNullGuardedStructGet`/`emitExternrefToStructGet`. The acorn parser reads
  **bypass both** because `moduleUsesDelete` routes them to the plain
  `__extern_get` in `tryEmitDeleteAwareDynamicGet` instead.
- I tried adding a WasmGC `ref.eq` identity fast-path to `emitSwitchStrictEq`'s
  JS-host branch (mirroring the `===` operator + the standalone branch). It is a
  correct alignment (all 13 `tests/issue-2063-switch-strict-equality.test.ts`
  pass) BUT it is **bypassed here**: the operands are host PROXIES, not WasmGC
  eqrefs, so `ref.test eq` is false and the compare still falls to the broken
  `__host_eq`. Reverted (symptom-patch, not root; adds `typeof_bigint` overhead to
  every strict switch with no headline benefit). Re-confirmed: with that change
  `parse("x")` still hangs and `__host_eq` is still called 239k× (proves the
  ref.eq branch is never taken).

### Fix direction for the next focused attempt (ranked)
1. **(Cleanest) Resolve the lifted parser-method `this` to `$__fnctor_Parser`** so
   `this.<field>` reads use the static `struct.get` arm (`compileInstanceMember`)
   directly — raw struct, identity-preserving, no proxy. Touches method-lifting /
   `this`-type resolution for prototype-assigned function expressions.
2. **Route `tryEmitDeleteAwareDynamicGet` through `struct.get` / the #2075
   `__get_member` dispatcher FIRST** when the receiver matches a known WasmGC
   struct candidate (returning the raw struct), falling to the tombstone-aware
   `__extern_get` only for genuinely dynamic/tombstoned props. Must preserve the
   delete-tombstone semantics that path exists for (#2179) — design carefully.
3. **Make `_unwrapForHost`/`_hostProxyReverse` collision-free at scale** (the
   host-proxy canonicalization layer). Narrowest blast radius but addresses the
   symptom (host_eq spurious match) rather than the representation divergence.

All three are broad-impact value-representation changes → validate on the FULL
`merge_group` floor, not a scoped sweep.

### Carve-out bugs CONFIRMED live this session (own issues)
- **(a) function-DECLARATION constructor drops prototype-method dispatch.** Hit
  directly: a probe `function FakeP(){…}; FakeP.prototype.setName=…; new
  FakeP().setName()` throws **"setName is not a function"** at runtime. The
  **named function-EXPRESSION** form (`var FakeP = function FakeP(){…}`) works.
  Acorn uses only named function expressions, so NOT on the acorn path — but a
  real codegen gap.
- **(b) `conf.startsExpr` not applied during inlined construction.** `name: new
  TokenType("name", startsExpr)` (with `var startsExpr = {startsExpr:true}`) reads
  back `startsExpr=false` (should be true) — the conf-object property read fails
  during construction. A real read-dispatch correctness gap at scale (does not
  itself cause the loop, but same family).

### Reusable probes banked (`.tmp/`, paths point at this worktree)
- `dump-wat.mjs` — compile acorn with `emitWat`, dump struct types + holder/
  TokenType candidates (writes `.tmp/acorn.wat`, ~8.7MB).
- `diag.mjs` + `diag-worker.mjs` — append a `_diag` export to real acorn,
  read token singletons directly (field fidelity + identity).
- `diag2.mjs` + `diag2-worker.mjs` — FakeP class at acorn scale, switch vs `===`.
- `eqtrace2.mjs` + `eqtrace2-worker.mjs` — `__host_eq` operand histogram +
  same-label-zero / spurious-true detector, cap-throw bounded.
- `sw-repro.mjs` — small-scale switch-vs-`===` (passes; isolates the scale).
- All single-compile, worker-thread + SAB, bounded. NOTE: each full-acorn compile
  is ~290s on this box — reuse one compile, do not recompile per input.

## RESOLVED BY #2085 — the 9th-wall HANG is fixed (re-verified 2026-06-26, sd-2674c)

PR #2085 (`fix(#2664): dispatch under-applied dynamic method calls at max arity`)
fixed the 9th-wall HANG via a DIFFERENT mechanism than this issue's comparison
analysis: the host method-call bridge dispatched by the CALLER's `args.length`, so
`this.parseExpression()` (0 args, 2 params) routed to `__call_fn_method_0` which
omitted the arity-2 closure → null → `parseTopLevel` never advanced. Fixed by
dispatching at max `__call_fn_method_N`.

Re-verified on `upstream/main` WITH #2085 (`.tmp/diff-probe.mjs`, #1712 differential
vs node-acorn oracle):

| input | compiled result |
|---|---|
| `""` / `";"` | Program returned; DIVERGES only by an extra `$.sourceFile` field |
| `"1"` / `"1;"` / `"true;"` | Program returned; DIVERGES: `$.body[0].expression` is `null` (Literal not attached¹) + extra `sourceFile` |
| `"1 + 2 * 3;"` | THROWS `WebAssembly.Exception` (binary-expression wall) |
| `"x"` / `"var x = 1;"` | THROWS `WebAssembly.Exception` (#2681 — `unexpected()` on `name` token) |

The HANG is gone. **#1712 is NOT yet met**: numeric statements return a partial AST
that diverges, and binary/identifier statements throw. So this issue's
non-termination is RESOLVED; the remaining work splits into #2681 (identifier
throw) + a binary-expression wall + the `expression:null`/`sourceFile` AST diffs.

¹ `expression: null` may be a host AST-marshalling depth artifact (nested WasmGC
node not deep-marshalled through `wrapExports` + `JSON.stringify`) rather than a
real codegen defect — needs confirmation (read `.expression.type` via a direct
struct walk, not host JSON).

### This issue's comparison analysis directly explains #2681
The `## DECISIVE ROOT-CAUSE` section above (the `this.<field>` read routing through
the delete-aware plain `__extern_get` → host-proxy representation → JS-host
`__host_eq` mis-canonicalization at scale → `switch(this.type){case types$1.name}`
never matches) is exactly why, post-#2085, the identifier path reaches
`unexpected()` and THROWS (#2681) instead of matching the `name` case. The 3 ranked
fix directions + the banked `.tmp` probes apply to #2681. Recommend porting this
analysis to #2681 and closing #2674 as resolved-by-#2085.

## CLOSED — re-verified on current `origin/main` (2026-06-28, dev-acorn)

Re-ran the dogfood probe against current `origin/main` (HEAD #2201, post-#2731;
single-compile multi-input worker, `.tmp/verify-driver.mjs`). The 9th-wall HANG is
gone — nothing blocks the event loop:

| input | result on current main |
|---|---|
| `""` / `";"` | Program returned (bodyLen 0 / 1 EmptyStatement) |
| `"1"` / `"1;"` / `"true;"` | Program returned — ExpressionStatement with a **Literal** `expression` (the #2687 `expression:null` symptom is no longer observed via the host marshalling either) |
| `"x"` / `"var x = 1;"` / `"foo(bar);"` | THROW (→ #2681) |
| `"1 + 2 * 3;"` | THROW (→ #2686) |

Acorn now compiles in ~40s (not the ~290s noted earlier this chain). The
non-termination this issue tracked is **RESOLVED** (by #2085). The remaining
throws are tracked separately by #2681 (identifier/var path) and #2686 (binary
path); their root cause is sharpened in those issues (Parser is NOT reconstructed
as a `__fnctor_Parser` struct on current main — see #2681). Marking `done`.
