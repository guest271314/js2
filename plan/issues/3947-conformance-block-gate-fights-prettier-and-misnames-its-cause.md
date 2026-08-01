---
id: 3947
title: "sync-conformance-numbers fights prettier over CLAUDE.md, and its failure message names a cause that never happened"
status: ready
created: 2026-07-31
priority: medium
feasibility: easy
horizon: s
task_type: ci
area: ci
goal: ci-hardening
sprint: current
related: [3612, 3915, 3880, 3902]
---

# #3947 — two gates undo each other, and the error blames the wrong thing

Two defects in `scripts/sync-conformance-numbers.mjs`. The second is the expensive one.

Full diagnosis, measurements and both-directions verification are in the `#3915` addendum
(PR #3923) — **read that rather than re-deriving it**. This issue is scoped to the **fix**.

## 1. The message names a plausible cause that is not the actual one

```
[sync-conformance] --check failed: 1 file(s) would change. Run `pnpm run sync:conformance` and commit the result.
[sync-conformance] DRIFT  CLAUDE.md
```

`DRIFT` under a script called **sync-conformance-numbers** reads as _"your conformance
number is stale"_. So triage goes after the figure — and the figure is fine. The actual
diff is **two blank lines**:

```diff
 <!-- AUTO:conformance-start -->
-
 **test262 conformance**: 29,846 / 43,099 (69.2 %)
-
 <!-- AUTO:conformance-end -->
```

**Cost, measured on 2026-07-31:** ~50 minutes for one agent, plus a wasted cycle for
another, plus **a second CI round-trip on a third branch** — all on a two-blank-line diff,
because the message sent everyone after a number that never moved. The number was
byte-identical on the branch, on `origin/main`, and after the sync.

Worse, the remedy the message prescribes **does not work**: `pnpm run sync:conformance`
rewrites the _number_, not the whitespace, so it reports a drift it cannot repair. An
instruction that cannot fix the thing it names is worse than no instruction.

Same family as the `Newly trapping:` wording corrected in #3902.

**Fix:** print the **actual diff**, and say **"generated block differs"** rather than
anything implying the number. A three-line diff would have collapsed both investigations
to seconds.

## 2. Prettier and the sync script mutually undo each other

`sync-conformance-numbers.mjs` regenerates the block **without** blank lines around the
bolded line. **Prettier adds them back.** Verified in both directions: prettier re-adds
exactly the two lines the sync script removes.

**There is no deadlock, and the post-sync form is the correct one** — two independent
proofs:

- _Mechanistic:_ `format:check` is scoped to
  `prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`. **`CLAUDE.md` is in
  none of those globs, so CI never prettier-checks it.** The prettier runs that broke this
  were entirely self-inflicted — a check CI does not run, breaking one it does.
- _Empirical:_ `origin/main`'s own `CLAUDE.md` carries those two lines and main is green,
  so prettier demonstrably does not gate that file.

**Fix:** make them stop disagreeing — either emit prettier-stable output from the sync
script, or add the block/file to `.prettierignore`. Preferring the former: an ignore
entry silently permits future drift elsewhere in the file.

## Why it recurs (and why "just don't run prettier there" is not the fix)

Running prettier over a markdown file you just edited is the obvious, correct-feeling
thing to do. It caught the **same author on two separate branches in one session**, the
second time **after a peer had explicitly warned them about it**, and after they had
predicted their branch was safe on the reasoning _"my edits don't touch the conformance
block"_ — true, and irrelevant: **prettier touched it, not the edit.**

A trap that catches a forewarned, specifically-attentive person twice is not an attention
problem. Fix the tools so they agree.

## Second file, and the damage is worse than whitespace (observed 2026-08-01, #3915)

`CLAUDE.md` is not the only file this hits, and the `CLAUDE.md` case is the **mild** one.

While adding a section to `docs/ci-policy.md`, a run of `prettier --write` on that file
produced **6 unrelated changes** to pre-existing prose. Five were cosmetic
(`*you*` → `_you_`). The sixth **corrupted a code span**:

```diff
-    (`tests/test262-slow-tests.json` / `-standalone.json`). **All of `src/**`
-    stays both-lane** — `target: "standalone"` is a flag through the same
+    (`tests/test262-slow-tests.json` / `-standalone.json`). **All of `src/**`stays both-lane** —`target: "standalone"` is a flag through the same
```

Three words lost their separating spaces and two inline-code spans were re-delimited
around the wrong text. That is **content damage**, not formatting: a reader now sees
`` `src/**`stays `` and `` —`target: "standalone"` `` as code.

Three things make this worth recording next to the `CLAUDE.md` case rather than separately:

1. **`docs/ci-policy.md` is NOT in the prettier gate.** `format:check` covers only
   `'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`. So prettier has **no authority**
   over this file and running it there is pure, unreviewed damage.
2. **`origin/main`'s own copy is already prettier-dirty, and `main` is green** — which is
   the positive proof that it is ungated. The same reasoning that made the `CLAUDE.md`
   post-sync form safe to commit shows the prettier-formatted form here is simply wrong.
3. It is the **same underscore-emphasis mangling** as `7327b3ac` ("backtick `merge_group`
   so prettier stops corrupting the emphasis run") — third occurrence, second file.

**Mitigation that generalises past both files:** the hazard is not "remember which files
are gated", it is that `prettier --write <path>` **silently rewrites everything in the
file, not just what you touched**. So: never run it on a markdown file that
`format:check` does not cover, and after any prettier run on a doc, read
`git diff --numstat` — a purely additive edit that reports deletions has been rewritten
underneath you. On #3915 the fix was to extract the added section, `git checkout HEAD --`
the file, and re-insert; the resulting diff was **62 added, 0 deleted**.

The cheap structural fix is to make the ungated files ungated _loudly_: add `docs/**` and
`CLAUDE.md` to `.prettierignore`, so `prettier --write` on them is a no-op instead of a
silent rewrite. That closes the whole class without asking anyone to remember a list.

## Acceptance

- [ ] A `--check` failure prints the actual diff and does not imply the conformance
      number changed when it did not.
- [ ] The prescribed remedy in the message actually repairs the failure it reports.
- [ ] Running `prettier --write CLAUDE.md` followed by `sync:conformance:check` exits 0
      (i.e. the two agree), by whichever of the two mechanisms above is chosen.
- [ ] `prettier --write docs/ci-policy.md` produces **no** diff — i.e. the files prettier
      has no authority over are ignored explicitly rather than merely unchecked. Verify by
      running it on a clean tree and asserting `git diff --numstat` is empty; the current
      behaviour rewrites 6 lines and breaks a code span.

## Not this issue

- **#3612** is `baseline-summary-sync` clobbering fresher conformance docs — a
  read-then-write race on the **number**. Same file family, different defect.
- **#3915 / PR #3923** carries the diagnosis and the evidence tables. This issue owns the
  fix only.
