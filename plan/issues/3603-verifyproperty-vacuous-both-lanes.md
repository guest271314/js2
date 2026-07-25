---
id: 3603
title: "verifyProperty is vacuous on BOTH lanes — two distinct root causes (standalone: object literals have no runtime own-property table; host: uncurried __push is a silent no-op)"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
assignee: ttraenkler/senior-dev-vp
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, runtime, test262-harness
goal: standalone-mode
related: [2984, 2896, 2860, 3592, 1472, 2177]
origin: "senior-dev root-cause investigation, TaskList task #11 (2026-07-25)"
---

# #3603 — `verifyProperty` is vacuous on BOTH lanes (two distinct root causes)

> **This issue is a ROOT CAUSE + MEASUREMENT deliverable.** No compiler change
> is proposed here. Everything below is measured on `origin/main` @
> `ab69ad9d20ceec` with local-vs-local A/B; nothing is extrapolated from a
> cluster label. Denominators are given for every number.

## TL;DR

`verifyProperty(obj, name, desc)` from test262's `propertyHelper.js` fails to
verify anything on **both** the standalone lane **and** the JS-host lane — for
**two completely different reasons**:

| lane           | do the four descriptor-field checks RUN? | is a detected mismatch REPORTED? | net effect                     |
| -------------- | ---------------------------------------- | -------------------------------- | ------------------------------ |
| **standalone** | **NO** — all four guards are false       | (never reached)                  | silent pass                    |
| **host**       | yes                                      | **NO** — `__push` is a no-op     | silent pass                    |

The handed-down lead ("`__push`/`__join` swallow the terminal assert") is
**CORRECT — for the host lane** and **REFUTED for standalone**, where `__push`
is never reached at all. The two must not be conflated: fixing either one alone
leaves the other lane vacuous, and fixing the standalone one *first* turns the
host-lane defect into a live Wasm **trap** rather than a silent pass.

## Symptom (A/B wrong-expectation control, `tests/test262-runner.ts` verdicts)

Each row feeds `verifyProperty` a deliberately WRONG expectation. A correct
implementation must FAIL every one of them.

| probe (`.tmp/vp/probe.mts`)                                       | expect | host          | standalone    |
| ----------------------------------------------------------------- | ------ | ------------- | ------------- |
| `verifyProperty(Math.abs,"name",{value:"abs",…})` — **correct**   | pass   | pass          | pass          |
| `…{value:"SHOULD_NOT_MATCH",…}`                                   | fail   | (see note)    | **pass** ✗    |
| `…{value:"abs", writable:TRUE,…}`                                 | fail   | (see note)    | **pass** ✗    |
| `…{value:"abs", enumerable:TRUE,…}`                               | fail   | (see note)    | **pass** ✗    |
| `…{value:"abs", …, configurable:FALSE}`                           | fail   | (see note)    | **pass** ✗    |
| `verifyProperty(Math.abs,"no_such_prop_zz",{value:1})`            | fail   | fail          | fail ✓ (a1)   |
| `var o={a:1}; verifyProperty(o,"a",{value:1,…})` — **correct**    | pass   | pass          | **fail** ✗    |
| `var o={a:1}; verifyProperty(o,"a",{value:42,…})`                 | fail   | **pass** ✗    | fail          |
| `var o={a:1}; verifyProperty(o,"a",{value:1,writable:FALSE,…})`   | fail   | **pass** ✗    | fail          |
| `var o={a:1}; verifyProperty(o,"a",{value:1,…,enumerable:FALSE})` | fail   | **pass** ✗    | fail          |
| `var o={a:1}; verifyProperty(o,"a",{value:1,…,configurable:F})`   | fail   | **pass** ✗    | fail          |
| `var o={a:1}; verifyProperty(o,"a",{value:42})` (value-only)      | fail   | **pass** ✗    | fail          |
| `assert(false,"sanity")`                                          | fail   | fail ✓        | fail ✓        |
| `assert.sameValue(1,2,"sanity")`                                  | fail   | fail ✓        | fail ✓        |

> **note** — the four `Math.abs`/`"name"` host rows report `fail` in that run,
> but the failure is `"obj should have an own property name"`, i.e. the **a1
> gate**, not the descriptor check. That is a *probe artifact*: on the host lane
> `Math` is the real host object, `verifyProperty` without `{restore:true}` is
> destructive (`isConfigurable` does `delete obj[name]`), and the earlier
> *correct* case in the same process permanently deleted `Math.abs.name`. The
> five `{a:1}` rows use a fresh literal per case and are the clean host
> evidence. Do not read the `Math.abs` host column as a working host lane.

Standalone: **vacuous past the a1 gate** exactly as reported. Host: vacuous
whenever the a1 gate is reachable, i.e. the far more common case.

## Root cause A — standalone: object literals have NO runtime own-property table

### The predicate

`src/codegen/object-runtime.ts:2630-2677`, `emitHasOwn` (the wasm-native
`__hasOwnProperty` / `__object_hasOwn`):

```
if (__builtinfn_get_meta(obj, key) != null) return 1;   // #2896 builtin-fn arm
any = any.convert_extern(obj)
if (!ref.test $Object) return 0;                        // ← NOT an $Object → false, silently
e = __obj_find(cast<$Object>(any), key)
return e != null
```

A receiver that is not an `$Object` answers **false** — it does not throw, it
does not fall back. A plain object literal lowers to a **typed WasmGC struct**,
not an `$Object`, so every runtime own-property query on it reports *zero own
properties*. This is the "plain object literal → false → lowers to a typed
struct" row already documented in the header of
`src/codegen/builtin-ctor-own-props.ts` (#2984); that issue closed the
*builtin-ctor carrier* row and left this one open.

### Why that makes `verifyProperty` vacuous

Every one of the four checks in `verifyProperty` is guarded by an own-property
query **on `desc`**, and `desc` is a plain object literal at essentially every
call site (see census: 6,308 / 6,470):

```js
if (__hasOwnProperty(desc, 'value'))        { …push failure… }   // false
if (__hasOwnProperty(desc, 'enumerable') …) { …push failure… }   // false
if (__hasOwnProperty(desc, 'writable') …)   { …push failure… }   // false
if (__hasOwnProperty(desc, 'configurable')…){ …push failure… }   // false
if (failures.length) { assert(false, __join(failures, '; ')); }  // failures === []
return true;
```

All four guards are false ⇒ `failures` stays empty ⇒ **`verifyProperty` returns
`true` for any expectation whatsoever.**

The a1 gate (`assert(__hasOwnProperty(obj, name), …)`) survives only because in
the *passing* population `obj` is typically a builtin function value, which the
`__builtinfn_get_meta` arm answers correctly. When `obj` is itself a plain
object literal the a1 gate is false and a **correct** descriptor FAILS — the
"opposite symptom" noted in `plan/agent-context/dev-floor-truth.md`. Same root
cause, both directions.

### It is not `hasOwnProperty`-specific — the whole runtime MOP is blind

`.tmp/vp/inner3.mts`, standalone, all queries made through **untyped**
(`any`-param) helpers so nothing is folded at compile time. Counts are own
properties found; the object has exactly one (`a`), or for the builtins the
named key:

| construction of the receiver          | `hasOwnProperty` | `gOPD` | `getOwnPropertyNames` | `Object.keys` | `for-in` |
| ------------------------------------- | ---------------- | ------ | --------------------- | ------------- | -------- |
| `{a:1}` literal                       | **false**        | undef  | **0**                 | **0**         | **0**    |
| `{}` then `o.a = 1` (static key)      | **false**        | undef  | **0**                 | **0**         | **0**    |
| `{}` then `o["a"] = 1` (computed key) | true             | ok     | 1                     | 1             | 1        |
| `{}` then `Object.defineProperty(…)`  | **false**        | undef  | **0**                 | **0**         | **0**    |
| `new Object()` then `o.a = 1`         | true             | ok     | 1                     | 1             | 1        |
| `Object.create(null)` then `o.a = 1`  | true             | ok     | 1                     | 1             | 1        |
| `JSON.parse('{"a":1}')`               | true             | ok     | 1                     | 1             | 1        |
| `{...{a:1}}` (spread)                 | true             | ok     | 1                     | 1             | 1        |
| `Object.assign({}, {a:1})`            | **false**        | THREW  | **0**                 | **0**         | **0**    |
| literal passed through an any-param   | **false**        | undef  | **0**                 | **0**         | **0**    |
| `Math` (namespace), key `"abs"`       | **false**        | undef  | **0**                 | **0**         | **0**    |
| `Math.abs` (builtin fn), key `"name"` | true             | ok     | THREW                 | 0             | 0        |

Three things fall out of this table:

1. **The hole is the OBJECT-LITERAL representation, not one predicate.**
   `hasOwnProperty`, `getOwnPropertyDescriptor`, `getOwnPropertyNames`,
   `Object.keys` and `for-in` all report "no own properties" together.
2. **A promotion path to `$Object` already exists.** A single **computed-key**
   write (`o["a"] = 1`) flips the same object into a fully queryable `$Object`;
   so do `new Object()`, `Object.create`, `JSON.parse` and spread. Only the
   literal / static-key-assignment path stays a blind typed struct.
3. **`Object.defineProperty` does NOT promote** (row 4). That is a second,
   independently reportable defect: on standalone you cannot even opt into a
   queryable object by defining a property on it.

> **Trap for the next agent — do not use `Object.keys(desc)` as a yardstick.**
> Measured on a *directly named module global* `Object.keys(DESC).length === 4`
> (compile-time fold, correct); measured on the **same object** through an
> `any` parameter it is **0**. A detector that compares "checks performed"
> against `Object.keys(desc).length` therefore computes `0 < 0 === false` and
> **never fires** — a null result that looks like a clean bill of health. This
> was caught before the sample run, not after.

## Root cause B — host: the uncurried `__push` is a silent no-op

`propertyHelper.js` accumulates failures through the uncurryThis idiom
`var __push = Function.prototype.call.bind(Array.prototype.push);`. Measured
through `runTest262File` (so the host lane gets its real import object) —
`.tmp/vp/uncurry.mts`:

| probe                                                        | host                          | standalone                    |
| ------------------------------------------------------------ | ----------------------------- | ----------------------------- |
| `var a=[]; __push(a,"x"); a.length === 1`                    | **fail** (`«0»` vs `«1»`)     | **fail** (null-deref trap)    |
| `var a=[]; __push(a,"x"); a[0] === "boom"`                   | **fail** (`«undefined»`)      | **fail** (null-deref trap)    |
| `var a=[]; __push(a,"x"); __join(a,";") === "boom"`          | **fail** (`«""»`)             | **fail** (null-deref trap)    |
| `var a=[]; a.push("x"); a.length === 1` (native control)     | pass ✓                        | pass ✓                        |
| `__join(["a","b"],";") === "a;b"`                            | pass ✓                        | **fail** (null-deref trap)    |
| `__hasOwnProperty({a:1},"a") === true`                       | pass ✓                        | **fail**                      |
| `__hasOwnProperty({value:1,…},"value") === true`             | pass ✓                        | **fail**                      |
| `Object.prototype.hasOwnProperty.call(o,"a")` via any-param  | pass ✓                        | **fail**                      |
| `Object.keys(o).length` via any-param                        | pass ✓                        | **fail**                      |
| `for (k in o)` count via any-param                           | pass ✓                        | **fail**                      |

Three independent observations (`.length`, `[0]`, `__join`) agree that the
uncurried push **genuinely does not append** on the host lane — it is not a
stale-length artifact, and the native `arr.push` control passes. So on the host
lane `verifyProperty` runs its checks, detects the mismatch, `__push`es the
message into a black hole, sees `failures.length === 0`, and returns `true`.

On standalone the same two helpers **trap** (`RuntimeError: dereferencing a null
pointer`) rather than no-op. They are currently unreachable there because root
cause A short-circuits first — **so root cause A is masking root cause B on
standalone.** Repairing A without B converts every honest standalone flip into
an invalid-Wasm trap: the exact failure class that blocked the #3592 arity
widening.

## Census — the exposed population (EXACT, not sampled)

`.tmp/vp/census.mjs` over all 53,273 `.js` files under `test262/test`:

| quantity                                                                   | count      |
| -------------------------------------------------------------------------- | ---------- |
| non-`_FIXTURE` files with `includes: [propertyHelper.js]`                  | **5,206**  |
| files calling `verifyProperty(`                                            | **5,067**  |
| files calling `verifyPrimordial(Callable)?Property(` (aliases)             | 8          |
| files calling `verifyCallableProperty(`                                    | 0          |
| files using ONLY the deprecated `verifyWritable`/… helpers                 | 166        |
| **`verifyProperty` call sites**                                            | **6,470**  |
| …whose `desc` argument is an object literal                                | 6,310      |
| …object literal WITH ≥1 checkable field (`value`/`writable`/`enum`/`conf`) | **6,308**  |
| …object literal that is `{}` (detector's only static false-positive)       | 2          |
| …object literal with only `get`/`set`                                      | 0          |
| …`desc` is literally `undefined` (early-returns before any check)          | 25         |
| …`desc` is an identifier / other expression                                | 135        |
| files with ≥1 checkable-field object-literal call site                     | **4,984**  |

**97.5 % of `verifyProperty` call sites (6,308 / 6,470) pass a plain object
literal carrying at least one checkable field** — i.e. the exposed population is
essentially the whole population, and the detector's static false-positive
surface is **2 call sites out of 6,470**.

> **`5,067` is an UPPER BOUND on the exposed file count, not an exact one — do
> not scale off it.** The census matches `\bverifyProperty\s*\(` textually, and
> the arm-B survivors proved two distinct contamination sources: (a) **comment-only
> matches** — `// TODO: Convert to verifyProperty() format.` matches the regex
> (2 of the 3 survivors); and (b) **calls that never execute** — e.g.
> `built-ins/WeakRef/prototype/constructor.js` guards its call behind
> `if (WeakRef.prototype.hasOwnProperty('constructor'))`, which is itself false
> on standalone *for root cause A*. The effective-rate figure below (158 / 158 of
> *executed* calls) is unaffected by this, because it is derived from actual
> execution, not from the census. Scaling 5,067 as if it were exact is precisely
> the over-count failure mode the project's MEASURE-NEVER-EXTRAPOLATE rule exists
> to prevent.

## Measurement — local-vs-local A/B with a calibrated vacuity detector

**Method.** Same runner, same sample, same process kind; the ONLY difference is
the harness. Arm A = stock upstream `propertyHelper.js`. Arm B = the same file
with two detectors spliced in:

- `__vpChecks === 0` → **NO_CHECKS**: not one descriptor-field check ran
  (standalone's failure mode).
- `__vpFailMsg !== ""` → **SWALLOWED**: a check ran, found a mismatch, and the
  `__push`/`__join` accumulate-and-report path lost it (host's failure mode).
  The five `__push(failures, …)` sites are rewritten to set a plain module
  variable, bypassing both broken helpers.

Neither detector queries `desc` at runtime (see the trap note above). The
instrumented harness is written into a **private copy** of this worktree's
`test262/harness` (the worktree normally symlinks the shared tree), so no other
agent's run is perturbed, and the symlink is restored on every exit path.
**Nothing is committed to compiler or runner code.**

### Calibration (mandatory before any number is reported)

| control                                                             | lane       | arm A | arm B    | verdict                       |
| ------------------------------------------------------------------- | ---------- | ----- | -------- | ----------------------------- |
| `verifyProperty(Math.abs,"name",{CORRECT})`                         | standalone | pass  | **fail** | positive control FIRES ✓      |
| `verifyProperty(Math.abs,"name",{CORRECT})`                         | host       | pass  | pass     | negative control silent ✓     |
| `var o={a:1}; verifyProperty(o,"a",{value:42,…})` (WRONG)           | host       | pass  | **fail** | host positive control FIRES ✓ |

The detector is proven to fire on a known-vacuous pass and proven not to fire on
a genuinely-checking pass. A third control (`{}` + `Object.defineProperty`,
correct descriptor) fires SWALLOWED on the host lane — that is **not** a clean
negative control (that construction path is itself suspect, see the
`Object.defineProperty` row of the boundary table) and it is excluded from the
calibration; it is recorded here as a separate observation.

### Result — standalone lane

Sample: **600** files drawn uniformly (mulberry32, seed `20260725`) from the
5,067-file `verifyProperty` population.

| arm A status    | n       |
| --------------- | ------- |
| pass            | **161** |
| fail            | 381     |
| skip            | 53      |
| compile_error   | 5       |

Arm B was then run over exactly those **161 passing** files (same runner, same
order, only the harness differs):

| arm B status | n       |
| ------------ | ------- |
| **fail**     | **158** |
| pass         | 3       |
| compile_error | 0      |

**158 of 161 previously-passing files (98.1 %) flip to fail under the vacuity
detector.** Zero compile errors, so the instrumentation did not break the build.

The three survivors execute **no `verifyProperty` call at all** — verified by
reading them:

| file                                                          | why it survives                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `built-ins/Object/prototype/propertyIsEnumerable/S15.2.4.7_A2_T2.js` | `verifyProperty()` appears only in a `// TODO:` comment (census regex false positive) |
| `built-ins/Object/prototype/toLocaleString/S15.2.4.3_A8.js`   | same — comment-only mention                                     |
| `built-ins/WeakRef/prototype/constructor.js`                  | the call is inside `if (WeakRef.prototype.hasOwnProperty('constructor'))`, which is itself false on standalone for the same root cause |

So **every sampled standalone `verifyProperty` pass that actually executes a
`verifyProperty` call is vacuous: 158 / 158.**

Only 5 of the 158 render the detector's message (`…NO_CHECKS`) — all of them
async tests, whose failure surfaces through the `Test262:AsyncTestFailure`
channel; the other 153 collapse onto the opaque
`uncaught Wasm-GC exception (non-stringifiable payload)` label (#2862). **Every
message that IS legible says `NO_CHECKS`; not one says `SWALLOWED`** — which is
exactly root cause A and confirms `__push` is never reached on standalone.

### Attribution control (arm A2) — the flips ARE the detector

"The instrumented harness fails 158 tests" is not by itself evidence that the
detector fired; the instrumentation could simply have broken something. So a
third arm was run over the same 161 files: **arm A2 = every structural edit of
arm B (the `__vpChecks` counter, `__vpPush` replacing all five
`__push(failures, …)` sites, the module-level `__vpFailMsg`) with the two
detector `throw`s REMOVED.**

| arm                                        | pass    | fail    |
| ------------------------------------------ | ------- | ------- |
| A — stock harness                          | **161** | 0       |
| A2 — instrumented structure, no throws     | **161** | 0       |
| B — instrumented structure + detectors     | 3       | **158** |

Arm A2 reproduces arm A exactly (161 / 161). The 158 flips are therefore
attributable **solely to the detector firing**, not to the instrumentation
perturbing compilation or behaviour.

> **Do NOT scale 158/161 to the 1,190-pass figure or to any corpus number.**
> This is a 600-file uniform sample of the 5,067-file population, reported as
> `158 vacuous / 161 sampled-passing`. The memory rule on cluster-label
> over-counting (100–600×) applies to this agent's own numbers too. A
> full-corpus number requires a full-corpus run.

### Result — host lane: mechanism CONFIRMED, magnitude **NOT MEASURED**

The host lane's failure mode is confirmed three ways — the five `{a:1}`
wrong-expectation rows in the symptom table all report `pass`; the three
independent `__push` observations (`.length`, `[0]`, `__join`) all miss the
pushed element while the native `arr.push` control passes; and the calibrated
detector fires `VACUOUS_VERIFYPROPERTY_SWALLOWED` on the host positive control.

**The corpus magnitude on the host lane is reported below only if it was
measured; it is never estimated.** The detector is already calibrated for the
host lane (the `posthost` control above), so completing it is three commands:

```bash
VP_LANE=host npx tsx plan/probes/3603/ab.mts armA 600 20260725
VP_LANE=host npx tsx plan/probes/3603/ab.mts armA2   # attribution control
VP_LANE=host npx tsx plan/probes/3603/ab.mts armB
```

**There is deliberately NO host magnitude number anywhere in this issue — do not
substitute a guess for it, and do not treat any partial run as one.** An arm-A
host run was started and abandoned at ~350/600 for two independent reasons, both
disqualifying: (a) the box was at load ~19 on 8 cores with 13 foreign sweep
processes, 2.4× the concurrency ceiling; and (b) the branch was committed to
twice while it was in flight, so its provenance would have been "started on
`a727b1b9`, finished on `476cd651`", which cannot be reported alongside the
standalone numbers' clean single-SHA provenance. **No partial output was kept.**
Arm A alone would not have yielded a vacuity count in any case — that needs all
three arms (A, A2, B) in one clean window.

The relevant point for planning is qualitative and already established: **the
host lane is affected too, so this is a lane-parity item, not a standalone-only
one.** The headline conformance figure is inflated over the `verifyProperty`
population by an amount that must be measured before it is quoted. Note this
specifically corrects the assumption that the public host number was untouched
by the vacuity work: that was true of the **arity** bug (host received the
equivalent fix at #2623 P-7) but is **not** true of `verifyProperty`.

## Measured NON-findings (do not re-derive)

- **`transformVerifyPropertyCalls` in `tests/test262-runner.ts:1410` is NOT the
  cause.** That legacy source-rewrite (which converts `verifyProperty(…{value:X}…)`
  into `assert_sameValue` and *strips* descriptor-only calls) belongs to the
  retired rewritten-harness path. `runTest262File` and `scripts/test262-worker.mjs`
  both go through `assembleOriginalHarness` / `originalHarness: true` and compile
  the **untouched upstream `propertyHelper.js`**. The vacuity is a compiler
  defect, not a runner transform.
- **It is not the `__apply_closure` arity bug (#3592 RC2).** Already refuted by
  the previous session with the widening ON and OFF; re-confirmed here by
  mechanism — the guards are false before any harness call arity is reached.
- **It is not string-specific**, and `assert(false, …)` was never vacuous.

## Tractable next slice (recommended split)

The full fix is `horizon: xl` and must NOT be attempted as one PR. Ordered so
that no step makes the tree worse:

1. **S1 — `uncurryThis` repair, host + standalone** (`horizon: m`, do this
   FIRST). Make `Function.prototype.call.bind(F)` produce a callable that
   actually forwards `(thisArg, …args)` to `F`: host lane currently no-ops for
   `Array.prototype.push`, standalone lane traps for both `push` and `join`.
   This is independently valuable (it un-vacuums the *host* lane's
   `verifyProperty` on its own), it is a prerequisite for S2 not producing
   traps, and it has a clean unit test surface — the ten rows of the root-cause-B
   table are the acceptance criteria.

   **S1 is also the only slice that can prove itself today.** The host lane's
   vacuity is entirely S1's fault, and the detector in `plan/probes/3603/ab.mts`
   is *already calibrated for the host lane* (the `posthost` control) — so S1
   lands with a real before/after vacuity count from the same harness, measured
   in one clean window. S2 has no such measurement available until S1 is in,
   because until then every standalone flip is a trap rather than a verdict. So
   the ordering is not merely "S2 is risky first"; it is "S1 is the slice that
   can be measured first."
2. **S2 — promote object literals to a runtime-queryable representation on
   standalone** (`horizon: l`/`xl`). The promotion machinery already exists —
   a computed-key write produces a real `$Object`. The slice is to trigger it
   when a typed-struct object escapes into an `any`/untyped context (the
   `verifyProperty(obj, name, desc)` situation), or to give the typed-struct
   representation an own-key table that `__obj_find` can consult. Start with the
   narrow, high-leverage case: **an object literal passed as an argument to a
   function with an untyped parameter.**
3. **S3 — `Object.defineProperty` must promote too** (`horizon: s`/`m`). Row 4
   of the boundary table; small and self-contained.
4. **S4 — re-measure and land the honest floor.** Expect the standalone floor to
   go **DOWN**: the arm-B number below is the size of the correction. Follow the
   landing recipe in `.claude/memory/reference_f1_honest_floor_deinflation_landing_recipe.md`.

**Expect genuine flips, not a pass-preserving cleanup.** `__builtinfn_gopd`
already returns a wrong `value` for `Math.abs.name` (measured: the descriptor is
non-undefined and `writable === false` is correct, but `value === "abs"` is
**false**), so the `name`/`length` family will flip to honest FAIL once the
guards start firing.

**Both lanes are affected, so this is a lane-parity item, not a standalone-only
one.** The host lane's `verifyProperty` population is 5,067 files; its vacuity
inflates the headline conformance number by an amount nobody has measured yet.
Quantifying that (arm A + arm B on the host lane, same method) is the natural
companion slice and is cheap now that the detector is calibrated.

## Reproduction

Every script that produced a number above is committed at
**`plan/probes/3603/`** (with `plan/probes/3603/NOTES.txt` giving the run order
and the safety notes) and the raw per-file verdicts at
**`plan/probes/3603/results/`**. `plan/` is outside the `format:check` / `lint`
globs (`src/ tests/ scripts/`) so nothing there is executed or checked by CI.

- `census.mjs` — the exact static census (no compiler involved).
- `probe.mts` — the A/B wrong-expectation control through `runTest262File`.
- `inner.mts` / `inner2.mts` — fine-grained numeric observation channel into the
  compiled harness (one observation per exported call).
- `inner3.mts` — the fix-boundary table (object construction shapes).
- `uncurry.mts` — the two-lane `uncurryThis` check.
- `ab.mts` — the calibrated A/B vacuity measurement (`calibrate` / `armA` /
  `armA2` / `armB`).

`ab.mts` swaps **this worktree's** `test262/harness` symlink for a private real
copy while it runs and restores the symlink on every exit path, so a concurrent
agent's test262 run is never perturbed. **No committed compiler or runner code
is touched, and there is no committed force-disable switch.**

### Observation-channel gotchas (cost real time; documented so they don't again)

1. **`export` is required.** A plain top-level `function probeQ()` is not
   auto-exported; the accessor silently reads back `NaN`/undefined and looks
   like a harness bug.
2. **A `number` JSDoc annotation is required** on the exported accessor's
   parameter (`/** @param {number} i */`), or the compile fails with
   "implicit 'any' type".
3. **Do not compare an untyped export parameter against a numeric literal
   directly.** `p(i)` with `if (i === 0)` never matches on standalone (the boxed
   `any` strict-eq path); coerce first — `var j = i + 0;` — then branch on `j`.
   Without this every observation reports "branch not taken" and the whole probe
   reads as a total failure.
4. **A Wasm trap is not catchable by the compiled `try/catch`.** It surfaces at
   the JS boundary as `RuntimeError`, so it must be caught around the *accessor
   call*, not only inside the probe body.
5. **The host lane needs a real import object** (`buildImports` + sandbox);
   `WebAssembly.instantiate(binary, {})` only works for standalone, where
   `result.imports` is `[]`. Use `runTest262File` for host-lane probes.
6. **`verifyProperty` is destructive** (`isConfigurable` does `delete
   obj[name]`, `isWritable` writes) and the host lane shares real host builtins
   across in-process runs. Probing `Math.abs` twice in one process without
   `{restore:true}` contaminates the second probe. Use a fresh subject per case.
