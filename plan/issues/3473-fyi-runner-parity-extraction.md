---
id: 3473
title: Extract fyi-runner parity plumbing from stale #3415
status: in-progress
sprint: current
priority: medium
horizon: m
assignee: ttraenkler/extract-3415-agent
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/call-receiver-method.ts
---

## Problem

PR #3415 ("Fix Test262 FYI runner parity gaps", branch `codex/fyi-runner-parity`)
went 28 commits behind main, DIRTY, and failing its own gates. Most of its
compiler changes already landed via cleaner PRs and must not be
re-introduced:

- `src/codegen/declarations/param-return-inference.ts` — superseded by #3419.
- async-completion-marker / `generators-native-consumer.ts` (async drain) /
  standalone stdout sink — superseded by #3416.
- `plan/issues/3468/3469/3470/3471-*.md` — those ids already exist on main
  with different content (renumbered).
- `src/codegen/declarations.ts` overlap — main's version wins.

This issue tracks re-extracting the genuinely-novel remainder onto a clean
branch off current `origin/main`, verified via `git merge-file` 3-way merge
(base = PR #3415's merge-base with main, mine = current main, other = PR
#3415 head) so that #3419/#3416's independent main-side changes to
`scripts/test262-worker.mjs` are preserved alongside #3415's own additions.

## What was extracted (confirmed novel — zero independent main changes to
the same symbols since the #3415 merge-base `2cfd9c605f`):

- `scripts/compiler-pool.ts` — pin test262 worker fork `TZ` to UTC
  (`TEST262_TZ` diagnostic override), so Date verdicts don't depend on the
  developer machine's local timezone.
- `scripts/run-test262-fyi.mjs`, `tests/test262-fyi-runner.test.ts` — fyi
  runner parity updates.
- `scripts/test262-worker.mjs` — realm-canary runtime-intrinsic-surface
  coverage: `snapshotRuntimeIntrinsicSurface`/`runtimeIntrinsicCanarySnapshot`
  (generator/async-generator INSTANCE vs FUNCTION prototypes tracked
  separately, `%RegExpStringIteratorPrototype%`,
  `Array.prototype[Symbol.unscopables]` as its own intrinsic root). Merged
  via `git merge-file` 3-way against main's independent #3470/#3469 additions
  to the same file (`_FN_SUBPROP_ROOTS` restore, `drainAndCaptureNativeStdout`)
  — both sets of changes coexist cleanly, verified 0 conflict markers.
- `tests/issue-3426-realm-canary.test.ts` — new destructive-case fixtures for
  the above (`GeneratorPrototype`/`AsyncGeneratorPrototype`/
  `AsyncIteratorPrototype`/`RegExpStringIteratorPrototype`).
- `src/codegen/iter-hof-native.ts` — `ensureHostIteratorHelperBridge`: exposes
  the existing native iterator-helper steppers (`__j2w_iter_helper_open/next/
  close`) as host-lane exports so JS-host `%Iterator.prototype%` helpers can
  drive an opaque native-generator Wasm frame.
- `src/codegen/expressions/call-receiver-method.ts` — routes ES2025 Iterator
  helper method names on a statically-typed Generator receiver through the
  dynamic bridge above (previously only next/return/throw were recognized;
  helper names like `.map()`/`.take()` fell through to the generic
  not-a-method-error path). Confirmed via `git grep NATIVE_ITER_HOF_METHODS`
  that main's generator arm doesn't already do this.
- `src/codegen/generators-native-consumer.ts` — preserve the completed-result
  `undefined` sentinel on a direct native-result f64 `.value` read instead of
  returning the raw NaN carrier, for dynamically-consumed
  (non-statically-numeric) call sites.
- `src/codegen/statements/destructuring.ts` — externalize an anyref/eqref
  destructuring source (e.g. an Iterator-helper `.next()` IteratorResult
  read through the host bridge above) through the existing externref
  fallback path instead of the (invalid, no concrete type index) typed-struct
  path.
- `src/codegen/typeof-delete.ts` — switch `delete`'s spec error throws
  (super-reference, strict non-configurable property) from the old bare
  string-exception-tag pattern to the shared `buildThrowJsErrorInstrs`
  branded-Error constructor (`js-errors.ts`, already used throughout the
  codegen — `array-methods.ts`, `dataview-native.ts`, `disposable-runtime.ts`
  etc.) so `error instanceof TypeError`/`ReferenceError` checks in the
  literal upstream `propertyHelper.js` observe the correct brand. Confirmed
  main's current `typeof-delete.ts` still uses the old bare-string pattern.
- `src/runtime.ts` — the JS-host runtime support for the above: legacy
  RegExp `[Symbol.replace]` flag-read shim (for host engines still reading
  `rx.global`/`rx.unicode` directly instead of `Get(rx, "flags")`), the
  `__j2w_iter_helper_*` bridge consumer in `_iteratorRecordForHost`,
  `Object.create`'s receiver-aware `set` trap fix (child assignments through
  a mirrored prototype now create real own properties instead of mutating
  the prototype's opaque sidecar — fixes `Reflect.ownKeys` under the literal
  Test262 harness), and `__gen_result_value`/`__gen_result_value_f64`
  presence-not-value IteratorResult reads (so Iterator-helper exhaustion's
  deliberate `value: undefined` doesn't get misread as the Wasm-struct
  shape-miss `null` sentinel).

## Explicitly dropped (superseded, verified against current main)

- `src/codegen/declarations/param-return-inference.ts`,
  `src/codegen/declarations.ts` — main's #3419 version (85/-27,
  narrower/gated body-usage inference) wins; #3415's version is the older,
  unsound (pre-#3471-gate) f64 narrowing that #3419 replaced.
- Async-completion-marker plumbing in `scripts/test262-worker.mjs`
  (`drainAndCaptureNativeStdout`, the `(#3469)` async-drain comment block) —
  already on main via #3416, in a *different* region of the same file;
  preserved untouched by the 3-way merge above.
- `plan/issues/3468-strict-delete-branded-typeerror.md`,
  `plan/issues/3469-object-create-host-prototype-receiver.md`,
  `plan/issues/3470-host-iterator-helper-native-generator-bridge.md`,
  `plan/issues/3471-original-harness-final-residual-parity.md` — these ids
  are already taken on main by unrelated content (#3419 used id 3471 for a
  different fix; #3416 used id 3469 for the async-completion marker). Not
  re-created; the corresponding behavior is described in this issue file
  instead.
- `package.json`'s `build:test262-bundles`/`scripts/runtime-bundle.mjs`
  wiring — not referenced by anything in the extracted file set (checked:
  `grep -n "runtime-bundle\|build:test262-bundles"` across all extracted
  files returns nothing); dropped as dead plumbing for a different,
  unextracted part of #3415.

## Resume state (if this session runs out of budget before completing)

- **Worktree**: `/workspace/.claude/worktrees/issue-3473-fyi-runner-parity`
- **Branch**: `issue-3473-fyi-runner-parity` (pushed to `fork`/`origin`
  remote — i.e. `ttraenkler/js2` — as a live sync point)
- **Reference branches used for the extraction** (local only, not pushed):
  `pr3415-head` = `upstream/codex/fyi-runner-parity`
  (`8a511726e12a1dd939d46283b41b692d69fd40df` parent chain); merge-base with
  `upstream/main` = `2cfd9c605f081a764f43673cdc047a6aaabfe90b`.
- **Done**: all file extraction above is complete and staged/committed as a
  WIP checkpoint commit on the branch.
- **Still to do**:
  1. Run `pnpm exec tsc --noEmit`, `pnpm run lint` (biome), `pnpm run
     format:check` (prettier) on the branch and fix any errors.
  2. Run `npx vitest run tests/test262-fyi-runner.test.ts
     tests/issue-3426-realm-canary.test.ts` (and spot-check a couple of
     `tests/issue-30*.test.ts` that exercise the generator/iterator-helper
     bridge, e.g. any test with `NATIVE_ITER_HOF_METHODS`/generator `.map()`
     in its name) to confirm the extracted code actually works end to end
     — it has NOT been test-executed yet, only diffed/reasoned about.
  3. `git merge origin/main` again right before opening the PR (catch up
     with anything that landed after this branch was cut).
  4. Open PR: `gh pr create -R loopdive/js2 --head ttraenkler:issue-3473-fyi-runner-parity
     --title "test(test262): extract fyi-runner parity plumbing from #3415
     (rest superseded by #3419/#3416)"` with a body listing the extracted
     vs. dropped items above.
  5. Close #3415 with a comment: superseded — param-inference landed via
     #3419, async-completion via #3416; runner-parity plumbing re-extracted
     clean in the new PR (#3473-branch's PR number). #3415 is the team's own
     codex branch (not an external contributor's), safe to close.
  6. Flip this issue's `status:` to `done` with `completed:` once the PR is
     opened (self-merge path per team protocol), then follow the normal
     dev-self-merge CI-wait / stand-down flow.
  7. `node scripts/claim-issue.mjs --release 3473 ttraenkler/extract-3415-agent`
     if handing off, or `--complete` once merged.
