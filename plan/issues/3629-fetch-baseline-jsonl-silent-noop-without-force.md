---
id: 3629
title: "fetch-baseline-jsonl.mjs is a silent no-op without --force — exits 0, prints nothing, leaves a week-stale cache"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: s
complexity: S
feasibility: easy
task_type: ci
area: ci, tooling
language_feature: n/a
goal: test-infrastructure
related: [3628, 1528]
origin: "2026-07-25: the lead and multiple dev lanes were instructed to 'fetch fresh' with the bare command and silently received a 7-day-stale baseline."
---

# #3629 — `fetch-baseline-jsonl.mjs` silently serves a stale cache

## Problem

`node scripts/fetch-baseline-jsonl.mjs` is **cache-aware and no-ops if a cache
file exists**, regardless of its age. It then **exits 0 and prints nothing**.

The failure mode is the dangerous one: it is indistinguishable from a
successful fresh fetch.

Observed 2026-07-25:

```
$ node scripts/fetch-baseline-jsonl.mjs
EXIT=0                                    # no output at all
$ ls -la .test262-cache/test262-current.jsonl
Jul 18 10:03                              # SEVEN DAYS OLD
# contents: pass 25,545  — while main was at 30,931
```

Only `--force` refetches:

```
$ node scripts/fetch-baseline-jsonl.mjs --force
[fetch-baseline-jsonl] downloaded ... (66,854,653 bytes, 47,874 entries).
# contents: pass 30,931 / fail 14,814 / compile_error 657
```

That is a **5,386-test difference** — an entire session's landed work invisible.

## Why it matters

The baseline JSONL is the **authoritative input** for regression triage, trap
censuses, edition/bucket analysis, and de-vacuification sizing. Analysis run on
the stale cache is silently wrong in a way that looks perfectly healthy, and the
error scales with cache age.

Concretely, on 2026-07-25 several dev lanes were told to "fetch fresh" with the
bare command as part of their briefs. Any that did received a 7-day-old file.
One lane independently hit the sibling case: the local standalone cache was a
snapshot from a run where the lane was compile-erroring wholesale
(`compile_error 43,469 / pass 4,508`), so **every "pass" in it was a negative
test** — an input that would have yielded a confident _"standalone lane: 0 %
vacuous, all clean"_ from any detector without a vacuity guard.

This is the same shape as the other silent-zero defects found the same day: a
tool returning a benign-looking answer that is not a measurement.

## Proposed fix (weigh these)

1. **Always report what it did**, even on the cache-hit path — one line naming
   the path, the byte count, the entry count, and **the cache's age**. Silence
   is what makes this invisible.
2. **Warn or refuse on a stale cache.** A cache older than N hours (or older
   than the current `origin/main` baseline SHA) should either refetch
   automatically or print a loud warning. Prefer comparing the cached
   `baseline_sha` against the current one over a wall-clock heuristic.
3. **Make the default safe.** Callers overwhelmingly want current data;
   consider inverting so freshness is the default and `--cached`/`--offline` is
   the opt-in. Keep the graceful-fallback semantics for the genuinely offline
   case (exit 1 only when upstream is unreachable AND no cache exists).
4. Update the standing instructions and `CLAUDE.md` so the documented incantation
   is the one that actually fetches.

## Acceptance

- [ ] A cache-hit run prints what it served and how old it is.
- [ ] A stale cache cannot be served silently — refetch or warn loudly.
- [ ] A test pins the behaviour: with a stale cache present, the command either
      refetches or emits a warning; it must not exit 0 silently.
- [ ] Docs/briefs updated to the correct incantation.
