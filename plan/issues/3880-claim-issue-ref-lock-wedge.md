---
id: 3880
title: "claim-issue.mjs wedges 10min+ under concurrency and reports success on silent failure"
status: done
completed: 2026-07-31
created: 2026-07-31
priority: high
feasibility: medium
horizon: m
task_type: bugfix
area: ci
goal: ci-hardening
sprint: current
assignee: ttraenkler/dev-claim-reliability
related: [2531, 3079, 3636, 3879]
---

# #3880 — the advisory lock is the fleet's biggest tax, and it fails silently

## The sharpest finding: the READ path could go stale, and that is duplicate dispatch

Below, this issue used to say the stale-read hazard was hypothetical — _"it
assumes a wedge can lose a write but never return a stale read. Nothing
currently guarantees that."_ It is not hypothetical. One command demonstrates it
on the pre-fix script:

```console
$ CLAIM_ASSIGN_REMOTE=no-such-remote node scripts/claim-issue.mjs --check 3661
#3661 is UNASSIGNED.
$ echo $?
0
```

No pipe, no `tail`, no swallowed status. The read **failed**, and the tool
answered **"nobody holds this"** with a clean exit 0. Two agents reading that
answer both start the same issue — which is precisely the duplicate dispatch the
lock exists to prevent. The same mechanism on the write side:

```console
$ CLAIM_ASSIGN_REMOTE=no-such-remote node scripts/claim-issue.mjs --release 3661 alice
#3661 is not currently claimed — nothing to release.
$ echo $?
0
```

Root cause of both: `remoteAssignSha()` returned `""` when `git ls-remote`
**failed** and `""` when the ref **did not exist**, and every reader treated `""`
as "no claims". That single conflation explains the stale locks on #3661/#3685,
the false "nothing to release", and the false "UNASSIGNED".

## Measured, 2026-07-30/31

- **Four agents** lost time to it. One spent **~50 minutes** unable to claim a single
  issue across four attempts (280 s foreground timeouts; one earlier attempt ran
  **10 minutes at 0:00 CPU** before being killed).
- **`--allocate` wedged for three agents.** In at least one case it **threw with
  empty stdout while the caller reported success** — reserving nothing. That is the
  #2531 collision hazard in reverse: a half-reserved id would be green at PR time and
  fail only in the `merge_group`.
- **Two claim releases reported success and silently failed**, leaving stale locks on
  **#3661** and **#3685** that had to be cleared by hand via the contents API.
- **#3420's claim ref is permanently out of sync** — the work merged (PR #3864) while
  the record still shows a different agent's stale entry.

## Fifth occurrence — first on `--release`, and the strongest single argument for priority

2026-07-31, one agent handing #2916 back to the queue. **Three release attempts,
zero effect** — `2916.json` still read `status: in-progress` afterwards.

| #   | attempt                                                                                                | outcome                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `--release 2916`                                                                                       | **Node crash** mid-run. The caller nearly recorded success: the shell reported `EXIT=0`, which was `tail`'s status from a pipe, not the script's. |
| 2   | `--release 2916`                                                                                       | **exit 1**, cause captured verbatim: `error: cannot lock ref 'refs/claim-issue/base': is at 9619a610… but expected c5faa81c…`                     |
| 3   | `--release 2916` after manually force-updating the mirror (`+issue-assignments:refs/claim-issue/base`) | **wedged >560 s**, killed                                                                                                                         |

Three firsts in this one episode:

1. **First failure observed on `--release`.** Prior evidence covered `claim` and
   `--allocate`; this extends the fault to a **third entry point**, so it is the
   shared-ref layer rather than any one code path.
2. **First verbatim capture of the lock error**, naming
   `refs/claim-issue/base` — the shared mirror every agent fetches into — as the
   contended resource.
3. **First case where a manual mirror force-update did not rescue the retry.**
   That workaround had previously worked; here the retry wedged anyway.

### Why this is the argument for prioritising, not just more evidence

**This issue's own acceptance criterion says "a failed release/allocate can never
be mistaken for success by its caller." Occurrence 1 is exactly that failure,
and it was caught only because the caller read the record back instead of
trusting the exit code.** Had it not been, #2916 would now sit falsely claimed by
a departed agent.

So the tool built to prevent stranding **nearly caused a stranding, then wedged
while trying to undo it.** The eventual mitigation was to bypass the tool
entirely: a `Claim status: STALE` note written into the issue file, because
hand-editing a shared ref that other lanes read trades a bookkeeping problem for
a corruption risk. **When the claim ref cannot be corrected, the durable record
has to carry the truth instead** — which means the claim ref is currently not
authoritative for anything.

**Note on occurrence 1's near-miss** (this is a caller-side hazard worth fixing
in the docs as well as the tool): `cmd | tail -2; echo $?` reports the _pipe's_
last stage, so a crashed script reads as success. Use `cmd > file 2>&1; echo $?`,
`${PIPESTATUS[0]}`, or run bare — and verify the **effect** (read the record
back), not the exit code. Two agents hit this same trap within an hour on
2026-07-31, one of whom had it written in their own memory at the time; vigilance
did not prevent it, so the rule needs to be mechanical.

## Root cause — CORRECTED

The recorded root cause was _"the script has no retry on this."_ That is wrong,
and getting it wrong inverts the fix. **Retry was the amplifier, not the missing
piece.**

### Where the time actually went

`GIT_TRACE2_PERF` decomposition of ONE `git fetch +issue-assignments:…` in the
working repo:

| phase                                                                 | wall                    |
| --------------------------------------------------------------------- | ----------------------- |
| remote ref advertisement                                              | 0.6 s                   |
| `git rev-list --objects --stdin --not --all --quiet --alternate-refs` | **47.8 s**              |
| `git-remote-https` child (total)                                      | 77.8 s                  |
| **whole fetch**                                                       | **120 s**, at 6-7 % CPU |

Repeat measurements of the same command: **210 s / 127 s / 120 s / 65 s**. The
CPU figure is the tell — the process is _waiting_, not computing. The dominant
cost is git's connectivity check, which walks **all 6,680 local refs** in this
repo; it has nothing to do with the assignment ref's own size.

Now apply `MAX_RETRIES = 6`, with a fresh `ls-remote` + `fetch` on **every**
attempt: 390-1260 s. That is exactly the reported ">560 s", "600 s timeout" and
"10 minutes at 0:00 CPU". **Adding retries around a two-minute call is what
produced the ten-minute wedge.**

### The lock race, reproduced — and it is not the ref the issue named

Captured live:

```
error: cannot lock ref 'refs/remotes/origin/issue-assignments':
       is at 66960042… but expected 63b1549…
```

The contended ref is `refs/remotes/origin/issue-assignments` — which **nothing
asked for**. `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*` makes
git _opportunistically_ update the matching remote-tracking ref alongside the
requested refspec, and concurrent agents collide on that. `refs/claim-issue/base`
(the shared mirror, quoted in occurrence 2 above) is a second, independent
contention point.

**And the fetch that printed that error SUCCEEDED at its actual job**: the
requested destination ref was created at the new tip. git still exited 1. The old
`fetchAssign()` used a throwing helper, so a fetch that worked crashed the script
— the "succeeds as failure" half, in one line of code.

### The push's exit status is not evidence either

A push can land server-side and still report failure or time out. Two ids
(#3890, #3891) are permanent holes in the sequence because agents re-allocated
after an "apparent" failure whose reservation had already been written.

### Why records were anonymous

Bare `--allocate` wrote `assignee: ""` and nothing else, so the ref could not
attribute ownership at all. Verified on the live ref: `3889`, `3890` and `3891`
all carry `assignee: ""`.

## Fix — as implemented

1. **Tri-state reads.** `present` / `absent` / `failed`. A failed read is a hard,
   non-zero, legible error and never falls through to "unassigned". An
   unreadable ref is NOT an empty one.
2. **A dedicated bare cache repo** at `<git-common-dir>/claim-issue-cache.git`
   holds every assignment-ref operation, addressed **by URL**. A URL has no
   configured refmap, so the opportunistic remote-tracking update — and therefore
   the lock race — is structurally impossible. Each invocation also fetches into
   its own private ref, so two processes never contend on one mirror. Because the
   cache holds a handful of refs instead of 6,680, the connectivity check is
   trivial.
3. **Verify by effect, never by exit code.** After every push, regardless of what
   git reported, the ref is re-read and the entry compared byte-for-byte with
   what we intended to write. A push that reported failure but landed is reported
   as SUCCESS on the evidence of the ref; a push that reported success but did
   not land is retried.
4. **UNKNOWN is a first-class outcome (exit 7).** When the effect genuinely
   cannot be established, the tool says so and tells the caller to re-read the
   record rather than guessing in either direction. Blind retries after an
   unverified outcome are what burned #3890/#3891.
5. **Unscanned ids are refused before they are burned.** `--no-pr-scan` and a
   degraded open-PR scan both now exit non-zero _before_ reserving, unless
   `--allow-unscanned` is passed; the reservation records the choice in
   `pr_scan`, and a non-`ok` value prints an unmissable warning.
6. **Attribution.** Every record carries `requested_by`, never empty
   (`--by` / assignee / `$CLAIM_ASSIGNEE` / git identity / a traceable
   `unattributed:<host>:<pid>`). Bare `--allocate` still works — CLAUDE.md
   documents it.
7. **git's stderr is captured and surfaced**, not routed to `/dev/null`. This is
   the direct cause of the "produced no output at all" reports.
8. **The last line of output is always a verdict**: `claim-issue: OK — …`,
   `claim-issue: REFUSED — …` or `claim-issue: FAILED — …`. That survives a
   caller's `2>&1 | tail -4`, so a failure is legible even when the caller's pipe
   discipline is wrong. stdout stays clean so `NEW=$(… --allocate)` still works.
9. **Every network call is bounded** and SIGKILLed; a push _timeout_ routes to
   verification rather than to "failed".
10. **`git fetch <remote> main` → explicit refspec.** The old form ran under a
    15 s SIGKILL against a ~48 s connectivity check, so it **never completed** and
    the id scan silently ran against a stale main. It now uses
    `+refs/heads/main:refs/remotes/<remote>/main` with `--refmap=`, a budget that
    can finish, and a loud warning (with the local-vs-remote shas) when it cannot.

Two defects were found _by the new tests_ rather than by the field reports, and
both are now fixed:

- **Cache creation raced.** Building the cache in place let one process `rm -rf`
  a directory another was mid-initialising. It is now built in a private
  directory and moved in with one atomic `rename`.
- **Second-resolution timestamps are not a unique fingerprint.** Six allocators
  racing inside one second wrote byte-identical records, every loser's
  verification matched the _winner's_ entry, and all six reported success on the
  same id. Records now carry a per-invocation `write_id`.

### Exit codes

| code | meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | ok / free                                                                                    |
| 2    | usage error                                                                                  |
| 3    | already claimed by someone else (a legitimate refusal)                                       |
| 4    | already done/wont-fix on main (a legitimate refusal)                                         |
| 5    | gave up after retries under contention — **nothing was written**                             |
| 6    | infrastructure failure, ref unreadable/unwritable — **nothing was written**, safe to re-run  |
| 7    | **UNKNOWN** — the write may or may not have landed. Do NOT retry blindly; re-read the record |

## Test Results

`tests/issue-3880.test.ts` — 17 tests, hermetic (two local bare repos plus a
working clone; no network). Assertions read the **assignment ref itself**, not
stdout, because trusting the report instead of the record is the bug under test.

Every guard was kill-switch verified — reverted, confirmed red, restored:

| guard reverted                                                 | tests that went red                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| tri-state read → return `""` on failure                        | all 3 "a failed operation must never look like success"                            |
| `settle()` → trust `push.ok`                                   | "recovers when the push lands but git reports failure", "reports UNKNOWN (exit 7)" |
| `guardScanCoverage()` → no-op                                  | "refuses `--no-pr-scan` before reserving"                                          |
| `requesterId()` → `""`                                         | both "reservations are attributable" tests                                         |
| `emitMarker()` → no-op                                         | all 6 verdict-marker assertions                                                    |
| _(found during development)_ per-invocation `write_id` removed | "six concurrent allocators" — all six got the same id                              |
| _(found during development)_ in-place cache init               | "six concurrent allocators" — `unable to write symref for HEAD`                    |

Measured against the live remote, same repo, same operation:

| operation                    | before            | after                         |
| ---------------------------- | ----------------- | ----------------------------- |
| fetch the assignment ref     | 65-210 s          | **1.18 s cold / 0.50 s warm** |
| `--check <id>`               | (the fetch above) | **1.1-1.6 s**                 |
| `--list` (654 active claims) | **50 s**          | **2.3 s**                     |

`--list` was still spawning one `git cat-file` per entry — the #3079 batching had
only ever been applied to the id scan. Both now share one batched reader.

Portability: the suite also passes with `GIT_DIR` and `GIT_INDEX_FILE` exported,
which is how a git hook invokes it. That matters — see below.

## A hazard this issue's own fix work uncovered

While developing the tests, the husky pre-commit hook ran them with `GIT_DIR`
exported. With `GIT_DIR` set, **`git init --bare <path>` does not initialise
`<path>`** — it re-initialises `$GIT_DIR` and writes `core.bare=true` into it.
Because this repo sets `extensions.worktreeConfig`, that landed in the shared
`/workspace/.git/config` and broke every worktree in the container with
`fatal: this operation must be run in a work tree` until it was reverted.

`claim-issue.mjs` had the same latent exposure: it shells out to git constantly
and deliberately sets `GIT_INDEX_FILE` for its commit-tree plumbing. Invoked from
a hook, an inherited `GIT_INDEX_FILE` would have made `read-tree`/`update-index`
clobber the invoking repo's real index, and an inherited `GIT_DIR` would have
aimed cache-repo commands at the wrong repository. All git calls in both the
script and the tests now run under a sanitised environment, with `GIT_INDEX_FILE`
re-added only where it is intended.

## Explicitly NOT fixed here

- **#3636** — "`--allocate` hands out already-taken ids **even with the full PR
  scan**". Separate `ready` issue, separate mechanism. Fresh evidence for it: the
  #3889 collision's reservation record reads **`pr_scan: "ok"`**, so a _complete_
  scan handed out a colliding id (this is #3636's case 4). Note that the `"off"`
  record is **#3891**, not #3889 — an early reading of this session attributed
  3891's value to 3889 and concluded `--no-pr-scan` was the mechanism; the ref
  itself contradicts that.
- **`tests/issue-2943.test.ts > falls back to REST pagination for >100-file PRs`
  is RED on `origin/main`** — verified by running it against main's own copy of
  the script, so it predates this change. It expects the union of the GraphQL
  first page and the REST tail (`[9997, 9998]`) and gets only `[9997]`: the
  first-page ids are dropped when the REST fallback engages. That is a plausible
  contributing mechanism for #3636 and should be triaged there.

## Why priority high

The lock is **advisory**. A standing instruction now says an advisory lock that
cannot be acquired in a few minutes must not stop work — verify the record's `status`
directly and proceed. But that is a workaround: the lock exists to prevent duplicate
dispatch, and while it is wedged the fleet is running without that protection.
The workaround's sharp edge — that it is only safe while the _reader_ path is
sound — is now confirmed rather than suspected (see the top of this file), which
is why the read path was fixed first.

## Acceptance

- [x] Concurrent claims from 4+ agents succeed within seconds, or fail fast with a
      non-zero exit and a legible error. _(six concurrent allocators, 820 ms,
      six distinct ids, asserted against the ref)_
- [x] A failed release/allocate can never be mistaken for success by its caller.
- [x] A successful one can never be reported as failure.
- [x] `--allocate` either reserves an id or exits non-zero — never both nothing and 0.
- [x] A reservation whose open-PR scan did not run is never handed out as clean.
- [x] Reservations carry the requesting agent.
