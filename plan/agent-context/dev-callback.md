# dev-callback — session context (handoff at hard model cutover, 2026-07-02)

Successor: pick up from here. This dev ran a long session across the standalone
`__make_callback` leak-front, #2878 invalid-Wasm, and #2913 report dedup.

## IN FLIGHT — #2429 (this branch: `issue-2921-standalone-make-callback-leak`)

**Docs-only PR #2429** on loopdive/js2 — the make-callback sole-leak analysis +
the spun-out dispatch fix.

- **Make-callback analysis file re-id: 2921 → 2931 → 2937 → 2940** (collided
  three times on main: 2921=drain-microtasks PR #2425,
  2931=live-binding-reassigned-function-decl, 2937=acorn-hash-poison — the
  last re-id done by successor dev-f2 on 2026-07-02).
  Current file: `plan/issues/2940-standalone-make-callback-harness-wrapper-vacuous.md`
  (frontmatter `id: 2940`, provenance note in place). This re-id is COMMITTED on
  the branch (commit `8beb4c2cb`), and `origin/main` was merged in (commit
  `7b231e37b`).
- **NOT PUSHED at suspend** — branch is ~56 commits ahead of
  `origin/issue-2921-standalone-make-callback-leak` (the main-merge + re-id).
  The suspend commit (this file) is being pushed now, which carries all of it.
- **BLOCKER — unresolved 2923 dup-id.** The branch has TWO `id: 2923` files:
  - `plan/issues/2939-any-closure-param-dispatch-arity-coercion.md` (then id 2923; MINE — the
    dispatch-arity fix spun out of the make-callback analysis)
  - `plan/issues/2923-eval-constant-string-compile-away-broaden.md` (from main —
    landed via docs commit `3ff19e4e1`, a parallel session)
    → `check:issue-ids:against-main` will REJECT #2429 until resolved.
    **Escalated to tech-lead, awaiting decision** (per the standing "escalate before
    re-idding 2923" rule — the coherence tension: merged PR #2441 references
    #2923 = dispatch-arity = MINE, but main's 2923 file is now eval). Options I laid
    out: (a) re-id my 2923-dispatch to a fresh `--allocate` id + update the #2940
    cross-refs; (b) make eval yield on main (needs a main-side change). **I did NOT
    re-id 2923** (respected the explicit instruction). Successor: get the tech-lead
    call, then execute. If (a): `claim-issue.mjs --allocate`, rename
    `2923-any-closure-*` → `<newid>-*`, update id + the `#2923` refs in that file
    AND in `2940-*.md`, and repoint PR #2429's body.
- `hold` label status on #2429: it CARRIED a `hold` label earlier (shepherd was
  diagnosing) — do NOT touch it; the shepherd owns it.
- **#2923 dispatch issue is the real lever** for the BigInt shim work: dynamic
  dispatch of an any-typed closure param `fn(...)` only invokes when call-arity
  AND arg type-kinds exactly match the callback params
  (`src/codegen/expressions/calls-closures.ts` L688 exact-arity `continue` +
  L693-698 kind check). Must honor JS arity (undefined-fill/drop) + coerce kinds.

## KEY FINDING — #2940 (was #2921): vacuous-pass / inject-throw discipline

The standalone `env::__make_callback` sole-leak (1,364 passes) is NOT flippable
by TypedArray HOF native bodies (sub-front 4 of #2903 yields **0**). All 601
TypedArray sole-leak files leak from the test262 **harness wrapper**
`testWithBigIntTypedArrayConstructors(function(TA){…})` via the graceful-fallback
path (`calls.ts:13393`), not any HOF. **These are VACUOUS passes**: injecting
`throw new Error('X')` as the wrapper body's first statement never fires — the
test body is dead code. A shim-only "fix" removes the import but leaves the body
vacuous → **dishonest host-free vacuous passes**. **Durable rule (now project
policy): a leak-elim change must PROVE bodies execute (inject-throw / sentinel),
not merely that the import disappears.** The genuine fix is #2923 (dispatch
arity/kind), then BigInt TypedArray semantics — measurement gated. See
`plan/issues/2940-standalone-make-callback-harness-wrapper-vacuous.md`.

## DONE THIS SESSION (merged / handed off)

- **#2878 Class A — MERGED (PR #2435, `fix(#2878)`).** Object-destructuring
  default value-present arm now coerces to the binding LOCAL's actual type
  (`getLocalType`) not `targetType`, at all 3 value-arm sites in
  `src/codegen/statements/destructuring.ts` (`emitDefaultValueCheck`). Delta on
  the targeted population (`local.set expected f64/i32, found ref`, 42 tests):
  0→18 genuine PASS, +11 honest FAIL, 40→11 CE. Byte-inert gc. Test:
  `tests/issue-2878-dstr-default-valuerep.test.ts`.
- **#2878 is 3 classes** (issue file has the full map): A = dstr value-rep
  (landed, mine, PR #2435); C = eqref-coercion (landed via dev-2878 PR #2431);
  **B = `__str_flatten` null-deref on `new String(...).split/replace(RegExp)`**,
  filed as a FRESH issue **#2935**
  (`plan/issues/2935-strflatten-regexparg-null-deref.md`, priority medium,
  horizon m) — String-wrapper `[[StringData]]` not unwrapped to `$AnyString`
  before `__str_flatten`. (#2878 was marked `done` by dev-2878's built-ins-only
  re-measurement that MISSED the language/dstr Class-A cluster — flagged for retro
  as a cross-session dispatch collision.)
- **#2913 report double-count — Fix Direction 1 DONE + verified, handed to
  dev-f1.** Branch `issue-2913-report-dedup` (PUSHED), claim RELEASED. Defensive
  dedup by `record.file` (worst-status precedence
  `compile_error>fail>timeout/crash>pass>skip`) in
  `scripts/build-test262-report.mjs` + `scripts/generate-editions.ts`; verified
  vs baseline (48142→48088, dropped exactly the documented 54). Test
  `tests/issue-2913-report-dedup.test.ts` (3/3). Fix Direction 2 (source
  retry/module-code double-WRITE) documented as now-non-urgent follow-up in the
  issue file. dev-f1 can PR the branch as-is or adopt.

## Claims to reconcile

- `#2913` — RELEASED (dev-f1 owns).
- `#2878` — was mine; merged (Class A). Claim may still be held under
  dev-callback; safe to release.
- `#2921` — released earlier in session.
- `#2940`/`#2935`/`#2923` — reserved via `--allocate`; not separately claim-locked.

## RESOLVED (successor dev-f2, 2026-07-02)

The 2923 dup-id blocker above is resolved per tech-lead decision: the
dispatch-arity issue was re-id'd **2923 → #2939** (fresh `--allocate`),
file now `plan/issues/2939-any-closure-param-dispatch-arity-coercion.md`
with a provenance note (merged PR #2441 cites #2923 = this issue at its
merge time; main's 2923 is now the eval compile-away issue). #2940's
`blocked_on`/`related` updated to #2939.
