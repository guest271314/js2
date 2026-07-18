---
id: 3388
title: "standalone: async-gen `yield*` over non-literal sources in NESTED/method producers — runtime delegation with §27.6.3.7 GetIterator error semantics (~600 rows)"
status: in-progress
assignee: ttraenkler/fable-dev-2
sprint: current
created: 2026-07-17
updated: 2026-07-18
priority: high
horizon: l
feasibility: hard
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: async-generators, yield-star, iterator-protocol
goal: standalone-mode
umbrella: 3178
related: [3132, 3387, 3389, 2906, 2865, 3075]
origin: "2026-07-17 fable-3178 umbrella decomposition — the yield-star cohort of the standalone host_import_leak baseline (#3132 S3, re-grounded with the nesting-seam finding)."
---

# #3388 — async-gen `yield*` delegation for nested + method producers

## Problem

~600 official-scope `host_import_leak` rows carry `__gen_yield_star`
(917 total across combos; the pure combo
`__create_async_generator,__gen_create_buffer,__gen_next,__gen_yield_star,__get_caught_exception`
alone is 544). Concentrated in:

- `{expressions,statements}/class/elements` — `yield-star-getiter-*`,
  `yield-star-next-*` private/RS async-gen METHOD files (200-row combo),
- `{expressions,statements}/class/async-gen-method[-static]` (~262 across
  combos — `yield-star-getiter-sync-not-callable-*-throw`, abrupt-path tests),
- `expressions/object/method-definition` (~65).

These are the #3132 S3 banked slice, re-grounded: #3132 closed after S1
(array-literal unroll) + S2 (methods receiver-threading); general `yield*`
never landed for the shapes below.

## Probe matrix (2026-07-17, current main, `--target standalone`)

| shape                                                    | module scope | wrapped / method    |
| -------------------------------------------------------- | ------------ | ------------------- |
| `async function* g() { yield* arr; }` (array ident)      | HOST-FREE    | **LEAKS** (wrapped) |
| `async function* g() { yield* customAsyncIterableObj; }` | HOST-FREE    | **LEAKS** (wrapped) |
| class `async *m() { yield* … }` (the corpus files)       | —            | **LEAKS**           |

Same seam as #3387: `analyzeAsyncGen` (`src/codegen/async-cps.ts:2240`)
returns null for any `yield*` whose operand is not an ARRAY LITERAL
(the S1 gate at ~2266: `if (!ts.isArrayLiteralExpression(src)) return null`),
and the nested-declaration / class-method / object-literal lanes
(`nested-declarations.ts:678/:1104`, `class-bodies.ts:2354` region,
`literals.ts:2974-2982`) all consult that analyzer via
`isAsyncGenDriveCandidate` (async-frame.ts:2073). At module scope some OTHER
arm admits these host-free — #3387 step 1 locates and validates that arm;
coordinate with whoever lands #3387 first and reuse the documented finding
from umbrella #3178.

## Implementation Plan

### Slice 1 — runtime delegation loop (the #3132 S3 design, now actionable)

Extend `analyzeAsyncGen` with a DELEGATION segment kind for `yield* <expr>`
over an arbitrary operand (identifier, call, member, string), lowered as a
runtime CFG loop — the producer-side DUAL of the `planForAwaitAsyncCfg`
consumer (async-cps.ts:1907):

- **head state**: evaluate operand once; GetIterator per §27.6.3.7 —
  try `Symbol.asyncIterator`, fall back to `Symbol.iterator` wrapped in the
  AsyncFromSync equivalent (reuse the existing consumer machinery in
  `iterator-native.ts` — the ITER_KIND dispatch — rather than a parallel
  GetIterator).
- **loop**: `inner.next()` → await (carrier `$Promise` assimilation, #2865) →
  read `{done, value}` from the `$IteratorResult` struct → if `done` exit with
  the result VALUE as the yield\*'s completion value → else `settleYield value`
  (the outer's pending `next()` promise fulfills `{value, done:false}`) →
  back-edge on outer resume.
- Slice 1 forwards `next()` only. Outer `.return()`/`.throw()` forwarding into
  the delegate (§27.6.3.7 steps 7.b/7.c) is #3389's completion machinery —
  keep those legacy where they cannot be expressed (correct-or-legacy), but
  note that many corpus files here only need the GetIterator ERROR paths (see
  edge cases), which slice 1 fully covers.

### Slice 2 — the method lanes

The class-method (`class-bodies.ts`, after the #3132 S2 receiver-threading
gate) and object-literal (`literals.ts:2974`) lanes admit the widened bodies
automatically once `analyzeAsyncGen` accepts them — the gate is shared. Verify
the S2 exclusions (super/arguments/static-this, `methodBodyRefsShadowedOuterLocal`
#3312 guard, stem dedup) still bail correctly, and run the private-name RS
file family (`same-line-async-gen-rs-*`) — several are already host-free on
main, so measure-first to avoid re-fixing landed rows (the promoted baseline
lags; see #3380).

## Edge cases (these ARE the corpus tests)

- `GetMethod(obj, @@asyncIterator)` returns null/undefined → fall to sync;
  both absent → TypeError at delegation start (getiter-\*-not-callable files:
  boolean/number/string/symbol/object variants).
- `@@asyncIterator` getter throws → propagate (getiter-\*-get-abrupt).
- iterator object not an object / `next` not callable → TypeError
  (yield-star-next-not-callable-\*).
- `next()` result not an object / `done`/`value` getter throws → propagate
  (next-call-{done,value}-get-abrupt, next-call-returns-abrupt).
- All of these must surface through the OUTER driven `next()` promise
  REJECTION (the native `__exn` tag path, `ensureExnTag` in
  `src/codegen/registry/imports.ts`) — never a trap.
- The implicit-await distinction (#3120): delegation does NOT re-await inner
  values on the modeled lane — keep the S1 mode routing
  (`yieldOperandIsPromiseTyped`) consistent.

## Test plan

- Executed probes (wrapped shape) for: value forwarding order, done-value as
  completion value, each abrupt GetIterator path asserting TypeError delivery
  via rejection.
- Construct-sample the `yield-star-*` file family across
  class/elements + async-gen-method dirs; zero pass→fail on the #3132 S1/S2
  suites (`tests/issue-3132*.test.ts`) and the driven-consumer scans.
- Mix-safety: module with one delegating gen + one legacy-only gen keeps
  carrier off coherently (pre-pass ⊆ emit).

## Regression risks

- The delegation loop shares frame/state numbering with #3387's for-await
  states — if both land concurrently, coordinate the CFG segment-kind
  enum/state-allocation in `analyzeAsyncGen` (same function, guaranteed
  conflict; sequence the PRs, second re-merges first).
- `__gen_yield_star` import retirement must not orphan the HOST-lane eager
  buffer which still uses it (host lane byte-identical — SHA probe).

---

## Concrete implementation plan (fable-dev-2, 2026-07-18) — resume-ready

**Branch**: `issue-3388-asyncgen-yieldstar-delegation` (worktree
`/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/.claude/worktrees/agent-a843226f60c86c747`).
**Base**: origin/main. **Predecessor**: #3387 (PR #3322, fable-dev-3) lands
first; re-merge before enqueue. Per fable-dev-3, #3387 only touches
`asyncGenBodyHasPatternLocals` + a new `forAwaitHeadPatternAdmissible` — DISJOINT
from the functions below, so the async-cps.ts merge is textual-adjacency only.
Cite #3387's issue-file "Implementation notes": the module-scope host-free arm
is the **lead-statement path**, not `planForAwaitAsyncCfg`'s CFG arms.

### Root-cause / seam (verified)
`analyzeAsyncGen` (async-cps.ts:~2296) rejects any `yield*` whose operand is not
a driven-async-gen CALL (#2570, `delegate`) or an ARRAY LITERAL (#3132 S1) — the
gate at **async-cps.ts:2343** `if (src === undefined || !ts.isArrayLiteralExpression(src)) return null;`.
That single `return null` propagates through `isBoundedAsyncGenBody` /
`isAsyncGenDriveCandidate` (async-frame.ts:2073) so nested/method async-gens with
`yield* <identifier|member|non-drivable-call|string>` demote to the legacy #680
host-buffer lane (the `__gen_yield_star` leak, ~600 rows).

### Reusable machinery (do NOT rebuild)
- **GetIterator**: `ensureAsyncIterator(ctx, fctx)` (statements/destructuring.ts:407)
  → standalone `__iterator` (native, USER arm handles custom iterables via
  `ensureNativeIteratorRuntime`). This is the sync-backed GetAsyncIterator the
  `planForAwaitCfg` CONSUMER (async-cps.ts:1630) already uses.
- **IteratorStep+Value**: `__iterator_next(iter) -> (i32 done, externref value)`
  (iterator-native.ts:474, USER arm = custom `.next()`).
- **The CONSUMER dual to copy**: `planForAwaitCfg` (async-cps.ts:1630) — same
  GetIterator + sync-step + per-element await. #3388 is its PRODUCER dual:
  replace "run body" with "settleYield(value)" + back-edge (the #2570 pump's
  `settleYield ... resumeState: pump` shape, async-cps.ts:2618).

### Design — new RUNTIME-DELEGATION segment (non-call yield*)
1. **`AsyncGenYield`** (async-cps.ts:~2150): add
   `readonly rtDelegate?: ts.Expression;` — the paren-stripped arbitrary operand.
   Mutually exclusive with `delegate`/`awaited`/`plain`. (Distinct from #2570's
   `delegate?: ts.CallExpression`, which stays for driven-gen calls.)
2. **`analyzeAsyncGen` yield\* arm** (async-cps.ts:2310-2363): AFTER the #2570
   call-delegate check and the #3132 array-literal arm, replace the
   `!ts.isArrayLiteralExpression → return null` reject with: paren-strip the
   operand; if it is any expression (identifier/member/call/string/element-
   access), push `{ leads, awaited:null, plain:null, rtDelegate: src }` and
   `continue`. Keep rejecting only genuinely-unhandled shapes (spread — none
   here). Guard: skip when the operand `containsAwaitOrYield` (nested suspend in
   the operand expr — bank as follow-up).
3. **`planAsyncGenCfg`** (async-cps.ts:2496 loop): add a `y.rtDelegate !== undefined`
   branch BEFORE the `y.delegate` branch. Emit the 5-state loop (dual of
   planForAwaitCfg + #2570 back-edge):
   - `init(k)`  : `[leads]` → `iter := GetAsyncIterator(operand)` (compile the
     operand expr, coerce externref, `call ensureAsyncIterator`, store the
     PERSISTED spill slot) → `goto pump`.
   - `pump(k+1)`: `{done,value} = __iterator_next(iter)` (transient locals) →
     `condGoto(done, after, awaitStep)`.
   - `awaitStep(k+2)`: `suspend(await value, resume→yieldStep)` — the
     AsyncFromSync §27.1.4.4 per-element await (only on the not-done path).
   - `yieldStep(k+3)`: `settleYield(<awaited value from SENT>, fromSent:true,
     resumeState: pump)` — the BACK-EDGE (next outer kick re-pumps).
   - `after(k+4)`: next segment's first state (completion value discarded —
     statement position only; `analyzeAsyncGen` only accepts `yield*` as a
     top-level ExpressionStatement, so `yield*` is never in value position).
   `id += 4` (5 states, same accounting as #2570's 4-state `id += 4`).
4. **Frame spill** (async-frame.ts `computeAsyncGenSpills`/`computeAsyncSpills`,
   + `listTopLevelYieldStarCalls` sibling): number a per-rtDelegate spill
   `__yieldstar_rtiter_<i>` exactly like `__yieldstar_iter_<i>` (#2570) /
   `FORAWAIT_ITER_SPILL`. Add a `listTopLevelRtDelegateYieldStars(fn)` walker
   (mirror `listTopLevelYieldStarCalls`, async-cps.ts:2210) so the spill layout
   and the CFG planner number them identically. This is the ONLY async-frame.ts
   touch — a NEW spill name, no renumber of existing states (disjoint from #3387).

### §27.6.3.7 error semantics (the corpus tests — edge cases §"Edge cases")
- GetIterator not-callable / getter-throws → the native `__iterator` USER arm
  already throws a TypeError; it surfaces through the outer driven `next()`
  promise REJECTION via the exn tag (ensureExnTag). Verify `__iterator`'s
  not-an-object / not-callable arm throws (may need an explicit TypeError arm —
  CHECK `buildIteratorBody` USER arm; if it traps instead of throwing, add the
  throw). This is the largest corpus slice.
- `.next()` not callable / result not object / done|value getter throws →
  `__iterator_next` USER arm propagation → same rejection path.

### Slices / checklist
- [ ] S1a: `AsyncGenYield.rtDelegate` field + `analyzeAsyncGen` gate widening.
- [ ] S1b: `planAsyncGenCfg` 5-state runtime-delegation loop.
- [ ] S1c: frame spill numbering (`__yieldstar_rtiter_<i>` +
      `listTopLevelRtDelegateYieldStars`).
- [ ] S1d: verify GetIterator/next error paths reject (not trap); add TypeError
      arm to `__iterator` USER path if it traps.
- [ ] S2: method/object-literal lanes (shared gate — should admit
      automatically once analyzeAsyncGen accepts; verify the #3132 S2
      receiver-threading + #3312 `methodBodyRefsShadowedOuterLocal` guards still
      bail correctly; measure-first on already-host-free `same-line-async-gen-rs-*`).
- [ ] Tests: tests/issue-3388-*.test.ts — value forwarding order, done exits,
      each abrupt GetIterator path → TypeError via rejection; zero pass→fail on
      tests/issue-3132*.test.ts + tests/issue-2570-*.test.ts + driven-consumer scans.
- [ ] Re-merge #3387 (or origin/main once #3322 lands) before enqueue.

### Deferred (correct-or-legacy, NOT this slice)
- Outer `.return()`/`.throw()` forwarding into the delegate (§27.6.3.7
  steps 7.b/7.c) → **#3389** completion machinery.
- yield* in VALUE position (`x = yield* g`) — analyzeAsyncGen only accepts
  statement-position yields.
- Nested await/yield INSIDE the yield* operand expression.
- Genuine @@asyncIterator (async-native, not sync-backed) await-the-result-promise
  model — slice 1 uses the sync-step + await-value (AsyncFromSync) model that the
  reusable `__iterator`/`__iterator_next` provide (the dominant test262 shape).

### Regression-risk notes
- `__gen_yield_star` host import must stay for the HOST lane eager buffer
  (host bytes unchanged — SHA-probe a host-mode async-gen `yield*` before/after).
- Mix-safety: a module with one delegating gen + one legacy-only gen keeps the
  carrier decision coherent (pre-pass ⊆ emit — the shared gate propagation
  above guarantees it).
