---
id: 2674
title: "acorn parse() 9th wall PAST tokenization (after #2664 type-write fix) — parseTopLevel/parseStatement array-push loop"
status: in-progress
assignee: ttraenkler/sd-2038
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
