# opus-sa-assertfail — standalone `assertion_fail` triage (paused 2026-07-25)

Lane: standalone `assertion_fail` bucket (12,038) after the #3592
de-vacuification. **Paused mid-flight by the lead (box oversubscribed).**
Everything below is measured, not inferred.

## 1. Data used

| Artifact                                                                                                   | What it is                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `/workspace/.claude/worktrees/agent-aeb44e25b6597e676/.tmp/standalone-baseline.jsonl`                      | PRE-#3592 standalone (27,709 pass)  |
| `/workspace/.claude/worktrees/agent-aeb44e25b6597e676/.tmp/mg3601/test262-standalone-results-merged.jsonl` | POST-#3592 standalone (22,621 pass) |
| `/workspace/.claude/worktrees/agent-a9035bbe084665a85/.tmp/flipped.jsonl`                                  | the 5,114 `pass`→`fail` flips       |

Status deltas across the two: `pass` 27,709 → 22,621 · `fail` 13,236 → 18,325 ·
`compile_error` 7,003 → 7,002. **5,114 tests flipped `pass`→`fail`** — that is
the de-vacuification yield and the whole prioritised subset.

## 2. Taxonomy of the 5,114 newly-revealed failures

By `error_category`: `assertion_fail` 4,496 · `other` 371 · `type_error` 179 ·
`illegal_cast` 43 · `null_deref` 21 · `range_error` 3 · `oob` 1.

By normalised message (top clusters):

|   Count | Normalised message                                                                  |
| ------: | ----------------------------------------------------------------------------------- |
|     938 | `Expected a TypeError to be thrown but no exception was thrown at all`              |
| **924** | **`Expected a undefined but got a different error constructor with the same name`** |
|     386 | `Expected a undefined to be thrown but no exception was thrown at all`              |
|     222 | `Expected SameValue(«"S"», «"S"») to be true`                                       |
|     213 | `Expected a RangeError to be thrown but no exception was thrown at all`             |
|     181 | `Expected SameValue(«N», «N») to be true`                                           |
|     166 | `Expected a SyntaxError to be thrown but no exception was thrown at all`            |
|     162 | `Expected SameValue(«undefined», «N») to be true`                                   |
|     134 | `Expected SameValue(«null», «[object Object]») to be true`                          |
|     131 | `Expected SameValue(«undefined», «"S"») to be true`                                 |
|     107 | `Expected SameValue(«NaN», «undefined») to be true`                                 |
|     104 | `TypeError: Cannot access property on null or undefined`                            |
|     101 | `Expected a ReferenceError to be thrown but no exception was thrown at all`         |
|      75 | `Array.prototype.map is not yet callable as a value in --target standalone`         |

The `…to be thrown but no exception was thrown at all` family (938 + 386 + 213 +
166 + 101 ≈ 1,804) is **heterogeneous** — each is a separate missing-throw
semantic gap. Not a single-fix cluster.

## 3. ROOT CAUSE FOUND + FIXED (the 924 cluster) — see #3614

Split of the 924 by the constructor passed to `assert.throws`:
**854 `Test262Error`**, 33 `DummyError+TypeError`, 14 `DummyError`, 9
`ExpectedError`, 5 `MyError`, 5 `Test262Error+TypeError`, 3 `CustomError`,
1 `StopReverse`.

Upstream `harness/assert.js` runs `thrown.constructor !== expectedErrorConstructor`
for **every** caught value. Measured in standalone (probe below):

- `thrown.constructor` on a `new Test262Error(...)` value → **`undefined`**
- `expectedErrorConstructor.name` (read off a **parameter**) → **`undefined`**
  → both names compare equal → the "same name" branch → that exact message.
- `Test262Error === Test262Error` and identity **through a parameter** → already
  TRUE (the cached closure singleton), so only the back-pointer was missing.

Why: `emitStandaloneTest262Error` (#2902) lowers `new Test262Error(msg)` to an
`$Error_struct` with `$name = "Test262Error"`. `fillExternGetErrorProps`
(`src/codegen/registry/error-types.ts`) answers `.constructor` only for genuine
builtin errors — its `Error`-tag arm is explicitly `$name === "Error"`-guarded,
so Test262Error fell through to the miss.

**Fix (implemented, branch `issue-3614-standalone-test262error-ctor-identity`):**
in `fillExternGetErrorProps`, add a `userCtorArms` block ahead of the builtin
`ctorArms` that, when `$name` matches a `USER_ERROR_CTOR_IDENTITY_NAMES` entry
(today just `Test262Error`), returns `ctx.funcClosureGlobals.get(name)` — the
SAME `__fn_closure_<Name>` global the bare identifier resolves to, so `===`
holds by `ref.eq`. It only **reads** the global (never materialises it), which
avoids minting a `ref.func` trampoline at finalize — the late-funcidx-shift
hazard this file already documents.

**Measured, via the CI-equivalent pool path:** probe `.tmp/probes/ctor2.js`
BITS `231 → 245` — bit 2 (`thrown.constructor === undefined`) cleared, bit 16
(`thrown.constructor === expected`) set. `tsc --noEmit` clean.

## 4. How to reproduce locally (this cost ~1h to discover — do not redo it)

`runTest262File` (`tests/test262-runner.ts`) is **NOT** the CI path and gives
misleading results: it renders thrown payloads via `originalHarnessThrownText`,
which does not use `tryNativeExnRender`, so every standalone Test262Error shows
as `uncaught Wasm-GC exception (non-stringifiable payload)` instead of its real
message. The CI shard path is
`assembleOriginalHarness` → `CompilerPool(n, "unified")` → `scripts/test262-worker.mjs`.

Working reproduction harness: `.tmp/run-pool.mts` in worktree
`/workspace/.claude/worktrees/agent-a9035bbe084665a85`. Prerequisites (the
worker imports two generated bundles that are not in the tree):

```
npx esbuild scripts/compiler-bundle-entry.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen \
  --external:@typescript/native-preview '--external:@typescript/native-preview/*'
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
```

Probe idiom: a `.js` file with a test262 frontmatter block that accumulates
`bits` and ends with `throw new Test262Error("BITS=" + bits)` — the thrown
message is what the runner records, so it is the only reliable output channel.
Probes live in `.tmp/probes/`.

Note: the standalone lane is ALWAYS `oracle_lane: "honest"`; the #3461 fast
native-harness oracle is host-lane-only, so it is not a factor here.

## 5. Remaining work in this lane (not started)

1. Land #3614 and measure the real delta on a full standalone shard run.
2. `expectedErrorConstructor.name` on a compiled closure read **through a
   parameter** is still `undefined` (a static `Test262Error.name` read works).
   This is the standalone twin of #3429 (host), whose
   `maybeStampCompiledFunctionArgName` is gated `if (ctx.standalone) return false`.
   Fixing it does not flip tests by itself but repairs many failure MESSAGES,
   which currently mislabel clusters.
3. The 70 non-Test262Error members of the 924 (`DummyError`, `MyError`,
   `ExpectedError`, `CustomError`, `StopReverse`) are plain fnctor instances,
   not `$Error_struct`s — they need the general fnctor `.constructor`
   back-pointer. This is the standalone counterpart of open issue **#3486**.
4. `SameValue` clusters (222 + 181 + 162 + 134 + 131 + 107 + …) are untriaged;
   they need per-cluster repros — the bucket label is a symptom, not a cause.
5. The ~1,804 "no exception was thrown at all" family is heterogeneous —
   triage by which operation failed to throw, not by directory.

## 6. State

- **#3614 is DONE**: branch `issue-3614-standalone-test262error-ctor-identity`,
  **PR https://github.com/loopdive/js2/pull/3607**, all required checks green.
  Issue file `status: done`, `tests/issue-3614.test.ts` (7 cases) green.
  `auto-enqueue` owns the merge — nothing further needed.

---

# 7. #3615 handoff — top-level bare property read (drained mid-task)

**Status: solved and implemented, NOT measured, NOT PR'd.** Read this whole
section before touching the issue — several of its stated premises did not
survive an A/B, and the fix is already written.

## 7.1 Where the code is

- Branch **`issue-3615-accessor-statement-position`**, worktree
  `/workspace/.claude/worktrees/agent-a9035bbe084665a85`, based on
  `upstream/main` @ `9dc512509`.
- Fix: **one arm** in `src/codegen/declarations.ts`, in the
  `ts.isExpressionStatement(stmt)` branch of `collectDeclarations`, immediately
  after the `#2992` `isDeleteExpression` arm.
- Test: `tests/issue-3615.test.ts` (13 cases, written, **not yet run**).

## 7.2 The issue's "Where to look" is WRONG — do not start there

`plan/issues/3615-*.md` says the drop is "inside the property-read lowering".
It is not. **The property-read lowering is fine.** Measured A/B (probe
`.tmp/probe-3615.mts` vs `.tmp/probe-3615b.mts`), standalone, hit-counter
control:

| read site                              | pre-fix | post-fix |
| -------------------------------------- | ------- | -------- |
| inside a function body                 | hit=1   | hit=1    |
| inside a top-level `try`/block         | hit=1   | hit=1    |
| inside a function VALUE via a callback | hit=1   | hit=1    |
| **immediate module top level**         | **0**   | **1**    |

The real defect is that `collectDeclarations` builds `ctx.moduleInitStatements`
from an **allow-list** of expression-statement shapes — call, `new`, `++`/`--`,
`delete` (#2992), assignment, `throw` (#3592) — and a bare
`PropertyAccessExpression` / `ElementAccessExpression` matched **nothing**, so
the whole statement was dropped from `__module_init`. Identical class of bug to
#2992 and #3592, same file, same allow-list.

## 7.3 The fix (already applied on the branch)

```ts
if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
  ctx.moduleInitStatements.push(stmt);
  continue;
}
```

Placed after the `isDeleteExpression` arm. The enclosing loop already unwraps
parentheses and `void`, so `void o.p;` and `(o.p);` ride along for free.

Kept **unconditional**, matching the #2992/#3592 arms: whether the base is
nullish and whether the property is an accessor are runtime facts (the receiver
is routinely `any`), so any static narrowing reintroduces the same silent drop
for whatever it mispredicts.

Verified working on all five top-level forms (object-literal getter, element
access, `void`, class accessor, `Object.defineProperty` accessor) with a clean
0→1 A/B on the hit counter, plus a nullish-base TypeError case.

## 7.4 TWO PREMISES THAT DID NOT SURVIVE MEASUREMENT

**(a) The "false FAILs" direction does not exist.** Both the issue and the
dispatch brief predicted that
`assert.throws(TypeError, function () { obj.prop; })` was broken and was
"probably the larger direction". **It was never broken** — the read is inside a
function body, which always worked. Confirmed by an explicit pre-fix control
(`CB` rows above: hit=1 with the fix disabled). There is only ONE direction
here: vacuous passes removed. Do not budget for the other.

**(b) The corpus impact is ~34 files, not "pervasive".** An **exhaustive**
parse-only scan of all 48k test262 `test/` + `harness/` files
(`.tmp/scan-3615.mjs`, ~1 min, no compiles) found **34** files with an immediate
top-level bare property/element-read statement. List:
`.tmp/pop-3615.txt`. The bulk are `language/import/import-defer/**` (19),
plus `staging/sm`, `module-code`, and a handful of `language/**` one-offs.
`built-ins/**/prop-desc.js` and the `return-abrupt-from-*` family — both named
in the issue as the expected bulk — do **not** match: they use
`verifyProperty(...)` and `assert.throws(...)`, which are CALL statements and
were always collected.

So the expected conformance delta is small and bounded, and the population is
small enough for an **exhaustive** A/B rather than a sample.

## 7.5 What is left to do

1. **Run the A/B.** Harness is written: `.tmp/ab-3615.mts` (CI-equivalent path:
   `assembleOriginalHarness` → `CompilerPool(2, "unified")` →
   `scripts/test262-worker.mjs`), driver `.tmp/run-ab.sh` runs 4 arms
   (standalone/host × fix-off/fix-on) over the 34-file population and writes
   `.tmp/ab-{sa,host}-{off,on}.json`. **I was killed mid-run; no arm completed,
   no result files exist.** To toggle arms, re-add the temporary switch
   `!process.env.JS2WASM_DISABLE_3615 &&` to the new arm's condition and rebuild
   `scripts/compiler-bundle.mjs` (see §7.6). **The switch is NOT in the
   committed code — do not ship it.**
2. **Report the directions separately.** Only the vacuous-pass direction is
   real (§7.4a). Any pass→fail flip must be declared through the named
   machine-checked `standalone-devacuification-allow` in
   `plan/issues/3592-*.md` (`count:` + a `tests:` list of exact paths), never
   quietly absorbed.
3. **Both lanes.** This one really is dual-lane — `collectDeclarations` is
   lane-independent and the arm is ungated, so the JS-host lane (30,405/43,098,
   separate required gate) changes too. The A/B driver already covers both.
4. **Run `tests/issue-3615.test.ts`** — written but never executed. It is
   standalone-only; I did not get the host-lane invocation working outside the
   pool (plain `compile()` + `importObject` reported hit=0 even for the
   consumed-read control, so host module-init needs the runner's
   `deferTopLevelInit`/`setExports` wiring — see memory
   `project_wrapforhost_setexports_harness`). Either wire that up or leave the
   vitest coverage standalone and let CI's host gates cover the other lane.
5. **Retire the harness lane's `it.fails` entries.** F1–F3 in
   `tests/test262-harness-truth-table.test.ts` (on branch
   `origin/issue-3613-harness-vacuity-tests`, **PR #3609**) go red when this
   lands — vitest reports "expected test to fail". Dropping them is part of
   #3615's acceptance criteria. **#3609 has not merged** (BLOCKED, failing
   `quality` as of 2026-07-25 ~14:00Z), so whoever finishes #3615 must
   coordinate landing order with its owner or the second PR to land breaks.

## 7.6 Local rebuild note

`scripts/test262-worker.mjs` imports two generated bundles that are NOT in the
tree; regenerate after ANY `src/` change or the pool silently runs stale code:

```bash
npx esbuild scripts/compiler-bundle-entry.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen \
  --external:@typescript/native-preview '--external:@typescript/native-preview/*'
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
```

## 7.7 Claim

Released: `node scripts/claim-issue.mjs --release 3615 ttraenkler/opus-3615`.
