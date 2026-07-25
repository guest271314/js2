---
id: 3627
title: "Goal-aware sprint model: schedule a goal into the rolling window and expand it to its actionable members"
status: ready
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: planning
language_feature: n/a
goal: maintainability
sprint: current
---

# Goal-aware sprint model

**Stakeholder ask:** _"Change the sprint model to allow referencing goals in
addition to issues. If a goal is added to a sprint, all its issues will be
worked on in the priority given. Issues in the sprint that are entailed by a
goal should reference it as a parent. I wonder if a goal should be an issue
itself or separate?"_

**Answer to the literal question, up front: a goal stays SEPARATE from an
issue, and `goal:` already _is_ the parent link being asked for — 3,056 of
3,178 issues (96 %) carry it today. No new parent field is needed.** What is
missing is the other direction: a goal cannot currently be _scheduled_. This
issue adds that.

---

## Measured baseline (2026-07-25, `origin/main` @ `07c8d239`)

Every number below was measured over the real corpus, not estimated.

| Measurement                                         |                                 Value |
| --------------------------------------------------- | -------------------------------------: |
| issue files (`plan/issues/^\d+[a-z]?-.+\.md$`)      |                                 3,178 |
| carry `goal:`                                       |                        3,056 (96.2 %) |
| carry `parent:`                                     |                                   381 |
| carry `umbrella:`                                   |                                   142 |
| carry `depends_on:`                                 |                                   423 |
| goal files in `plan/goals/` (excl. `goal-graph.md`) |                                    29 |
| **`goal:` values with NO matching goal file**       | **512 refs across 63 distinct names** |
| goal files with zero member issues                  |                  1 (`full-conformance`) |
| `sprint: current` issues                            |     190 (ready 152, in-progress 16, in-review 5, done 14, wont-fix 2, blocked 1) |
| **actionable (`ready`/`in-progress`) `current`**    |                             **168** |
| actionable issues NOT `sprint: current`             | 185 (backlog 161, **numbered/frozen 19**, unset 5) |
| current-actionable missing `priority:`              |                          **0 / 168** |
| current-actionable missing `horizon:`               |                     **35 / 168 (21 %)** |

### Expansion scale — the number that decides the design

Net-new tasks added to the (already 168-item) TaskList by putting one goal in
the window:

| goal                | members | net-new, **actionable-only** | net-new, **all members** |
| ------------------- | ------: | ---------------------------: | -----------------------: |
| `spec-completeness` |     371 |                       **24** |                  **364** |
| `standalone-mode`   |     338 |                           17 |                      305 |
| `platform`          |     113 |                           15 |                      111 |
| `test262-conformance` |   128 |                            7 |                      104 |
| `test-infrastructure` |   123 |                            6 |                      123 |

**All-members expansion of a single goal is a 15× blow-up** (364 vs 24), and
~85 % of what it adds is already `done` — tasks the reconciler would have to
immediately flip back to `completed`. Two goals would take the queue from 168
to ~840. This is measured, not extrapolated.

---

## Decisions

### D1 — A goal stays a FILE, not an issue

**Decision: goals remain `plan/goals/<slug>.md`. They do not become issues.**

Evidence:

1. **The link already exists.** 96 % of issues carry `goal:`. The stakeholder's
   "issues should reference their goal as a parent" is already satisfied;
   converting goals to issues means rewriting 3,056 frontmatter fields to gain
   nothing new.
2. **Different shape.** Goals form a DAG with inter-goal dependencies
   (`plan/goals/goal-graph.md`, 203 lines of ASCII DAG + a status summary
   table). Issue `depends_on:` is a flat id list.
3. **Different lifetime and different vocabulary.** A goal's status vocabulary is
   `Active` / `Activatable` / `Blocked` / `Partially activatable` — orthogonal
   to the issue lifecycle `ready → in-progress → done` that
   `reconcile-tasklist.mjs`, `freeze-sprint.mjs` and the #3474 done-status gate
   all reason over. A goal never reaches `done` in the issue sense.

**Honest counter-argument, and why it does not win.** Goals-as-issues would
inherit three real benefits: atomic id allocation via `claim-issue.mjs
--allocate`, the `check:issue-ids:against-main` CI gate, and the
`issue-assignments` claim lock. The measured 512 dangling `goal:` refs are
_exactly_ the failure mode those mechanisms prevent — string slugs have no
allocator and no gate. This is a genuine point in favour of the other design.
It is answered more cheaply by **D6's `check:goal-refs` gate**, which buys the
same referential integrity for one CI check instead of a 3,056-row migration.

#### Correction to the premise this issue was scoped with

The scoping brief claimed umbrella issues "drift because a long-lived container
is forced through a work-unit lifecycle," citing #2860 and #3029.

- **The drift is real and roughly 3×, but the sample is small.** Open issues
  that are the target of ≥1 `parent:`/`umbrella:` ("containers") are flagged
  `merged-but-open` by `reconcile-tasklist.mjs` at **8/37 = 21.6 %**, versus
  **27/371 = 7.3 %** for open leaf issues. n = 37 containers; treat as
  directional.
- **The cited example is half wrong: #2860 IS flagged; #3029 is NOT.**
- **The mechanism is not the lifecycle — it is a reconciler heuristic bug.**
  `reconcile-tasklist.mjs:228` runs `title.matchAll(/#(\d+[a-z]?)/gi)` over
  merged-PR titles and treats every captured id as "fixed by a merged PR".
  Confirmed by primary source: merged PR **#3501** is titled
  `fix(#3535): standalone lane defers top-level init so (start) throws render real signatures (#2860 F3)`.
  That PR implements **#3535**; it merely _mentions_ #2860 as context — and the
  container gets falsely flagged. A container is mentioned by every child's PR,
  so it false-flags by construction.
- **Therefore this bug SURVIVES D1 and is out of scope here.** Keeping goals as
  files does not fix it: the 142 `umbrella:` members and their 13 container
  issues remain issues either way. Do not read D1 as a fix for container drift.
  File separately against `reconcile-tasklist.mjs` (suggested narrowing: only
  credit the id in the PR title's **leading** `type(scope):` position).

### D2 — Goal frontmatter (new; goal files currently have none)

Goal files today open directly with `# Goal: <slug>` and carry metadata as prose
bullets (`- **Status**: Active`). **They have no YAML frontmatter at all** — this
decision introduces one. The prose body and the
`<!-- AUTOGENERATED:GOAL-ISSUES-START -->` table are untouched.

```yaml
---
goal: standalone-mode # MUST equal the filename without .md
title: "All features work without a JS host runtime"
state: active # active | activatable | blocked | achieved  (goal vocabulary, NOT issue status)
sprint: current # ONLY `current` or absent. A numbered sprint is REJECTED (see D6).
priority: high # default supplied to members that omit priority; also orders goals vs each other
horizon: l # default supplied to members that omit horizon
depends_on: [iterator-protocol, generator-model] # goal slugs, mirrors goal-graph.md
aliases: [standalone, standalone-wasm, standalone-gap, host-independence] # legacy goal: values that resolve here
---
```

Two fields carry the design weight:

- **`sprint: current`** is the entire scheduling surface. Absent ⇒ the goal is
  not in the window.
- **`aliases:`** is what makes the feature work against the real corpus. #2860
  itself is tagged `goal: standalone` — a dangling name. 43 of the 168
  current-actionable issues point at names with no goal file. Without aliases,
  putting `standalone-mode` in the window silently misses the 101 issues tagged
  `standalone`.

The deliberately distinct key names (`goal:` not `id:`, `state:` not `status:`)
make a goal file structurally unmistakable for an issue file to any future
frontmatter reader.

### D3 — Precedence: the issue wins on `priority`, the goal supplies defaults

**Decision: an issue's own `priority:`/`horizon:` always wins. The goal's value
is used only when the issue omits the field.**

This is settled by measurement, not taste: **0 of 168** current-actionable
issues omit `priority:`. If the goal won, adding one goal to the window would
silently override 168 individually curated priorities and reshuffle the whole
dispatch order. Goal-wins is destructive by measurement; issue-wins is a no-op
on today's corpus and therefore safe.

Goal-level `priority:` is still load-bearing in two places:

1. **Ordering goals against each other** when several are `current`.
2. **Bulk-created members** — a census that creates 30 issues in one pass can
   omit `priority:` and inherit it.

Goal-level `horizon:` is immediately live: **35 of 168 (21 %)** current-actionable
issues omit `horizon:` and today silently default to `m` in `normHorizon()`
(`sync-current-tasklist.mjs:127`), which mis-sizes them for
`budget-status.mjs --pick`. Goal default beats a blanket `m`.

### D4 — Expansion rule: ACTIONABLE members only (the decision that matters)

**Decision: a `sprint: current` goal expands to its members whose `status` is
`ready` or `in-progress` — the same actionable filter issues already pass. It
does NOT pull in `backlog`, `blocked`, `in-review`, `done` or `wont-fix`
members.**

The governing principle, stated so nobody "fixes" this later:

> **`sprint:` is the axis a goal speaks to. `status:` is the axis an issue
> speaks to.** Putting a goal in the window is a statement about _selection_,
> so it substitutes for `sprint: current`. It is not a statement about whether
> a given work unit is triaged and dispatchable — that remains the issue's own
> `status:`, and goal membership must not override it.

Measured consequence at real scale: the TaskList already holds **168**
actionable items. Actionable-only expansion of `spec-completeness` adds **24**
(→ 192, +14 %). All-members expansion adds **364** (→ 532, +217 %), of which
306 are already `done`. Adding a second goal under all-members takes it past
800. The over-provisioned-queue model only means something while the queue is
readable; all-members expansion destroys that on the first use.

**Additional exclusion — frozen sprints.** A member is skipped if its `sprint:`
is a **numbered** value. Measured: 19 actionable issues currently sit in numbered
sprints. A numbered sprint is a _retrospective record_ (`SCHEMA.md`); pulling
one of its issues back into the live window corrupts that record. Eligible
member `sprint:` values are therefore: `current`, `Backlog`, or unset.

**No cap.** An earlier draft proposed truncating expansion at ~25 members per
goal. Rejected on measurement: the largest net-new is 24, so a cap of 25 binds
on nothing — dead code that reads as a safety guarantee it does not provide.
Worse, truncating by priority-then-id would permanently starve low-priority
members, directly contradicting the stakeholder's "all its issues will be worked
on in the priority given." Instead emit a **loud warning** when one goal
contributes > 40 net-new tasks, and let the operator decide.

### D5 — The `es5-complete` contract (its first real use)

**Verified at time of writing: no `plan/goals/es5*.md` exists, and the string
`es5-complete` appears nowhere under `plan/`.** The census agent's output has
not landed, so this is stated as a contract, not an inference about another
agent's work.

D4 has a sharp edge for a brand-new goal: if `es5-complete`'s members are
bulk-created as `status: backlog`, **actionable-only expansion surfaces zero of
them** and the feature is a no-op on its first real use.

> **Contract:** goal expansion only surfaces `ready`/`in-progress` members.
> Therefore bulk-created goal members MUST be created with `status: ready` if
> they are intended to be worked in the window. A member deliberately parked as
> `backlog` stays out until the goal owner promotes it to `ready`.

Document this in `SCHEMA.md` next to the goal frontmatter block, and have
`check:goal-refs` **warn** (not fail) when a `sprint: current` goal expands to
zero members — that is the exact symptom of a violated contract, and it should
be visible rather than silent.

### D6 — Freeze, reconciler, and referential integrity

**Freeze exclusion is already structural — pin it, do not add mechanism.**
`freeze-sprint.mjs:99-101` (`listIssues()`) globs only
`plan/issues/^\d+[a-z]?-.+\.md$`. Goal files live in `plan/goals/` and can never
match, so a goal is already unreachable by the `sprint: current → sprint: N`
re-tag at line 177. The risk is a future well-meaning edit that widens the glob.
Mitigate with a comment at the glob **and** a regression test (see the plan).

**A goal is never re-tagged, but it IS recorded.** `freeze-sprint.mjs` should
append a "Goals in this window" section to `sprints/N.md`, listing each
`sprint: current` goal — a read-only record. The goal's own `sprint: current`
persists across the freeze, because a goal outlives a budget window by design.

**Never materialize a task for the goal itself.**
`reconcile-tasklist.mjs:149-151` (`targetIssueId()`) resolves a task to an issue
via the first `#\d+[a-z]?` in its subject. A goal has no numeric id, so a
goal-level task would resolve to `null`, be invisible to the reconciler, and
never be completed — a permanently stale queue entry. Goals expand to member
tasks and are otherwise not represented in the TaskList. **This is a hard
non-goal.**

**Referential integrity: baseline-then-ratchet, not a day-one hard gate.** A
strict `check:goal-refs` cannot land against 512 existing violations. Follow the
established shape of `scripts/ir-fallback-baseline.json`: snapshot today's
violations, fail only on **growth**, auto-bank decreases. The 63 dangling names
split three ways, and the triage is a **separate follow-up issue**, not part of
this implementation:

| bucket                      | examples                                                          | resolution                     |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| alias of an existing goal   | `standalone` (101), `host-independence` (37), `standalone-gap` (10) | add to that goal's `aliases:`  |
| needs a new goal file       | `test262-conformance` (128), `acorn-dogfood` (30)                  | create `plan/goals/<slug>.md`  |
| junk / typo                 | `real-world-compat,` (2+1), `performance,` (1), `native-messaging,` (1) | fix the issue frontmatter |

---

## Implementation Plan

### Root cause

`scripts/sync-current-tasklist.mjs` is the only path from planning artifacts to
the live TaskList, and it reads exclusively from `plan/issues/*.md`
(`ISSUES_DIR`, line 61). `plan/goals/` is never opened, so a goal has no way to
express "schedule me." Everything else in this plan is plumbing around that one
gap.

### Changes

**File: `plan/issues/SCHEMA.md`**

- New section **"Goal Files"** after "Relationship Fields", documenting the D2
  frontmatter block, the D3 precedence rule, the D4 expansion rule, and the D5
  contract verbatim.
- Amend the `goal` bullet under "Relationship Fields": a value may match a goal
  filename **or** an entry in some goal's `aliases:`.
- Amend the `umbrella` documentation per the migration section below.

**File: `plan/goals/<slug>.md` (all 29)**

- Prepend the D2 frontmatter block. Populate `goal`, `title`, `state`,
  `depends_on` from the existing prose bullets and the `goal-graph.md` "Goal
  Status Summary" table — this is transcription, not new judgement.
- Set `sprint: current` on **no goal** in this PR. Scheduling a goal is an
  operator act; landing the mechanism must be a behavioural no-op (see
  Acceptance).

**File: `scripts/goal-model.mjs` (NEW, ~70 lines)**

Single shared reader so the two consumers cannot disagree about membership.

- `parseGoalFrontmatter(text)` — same regex shape as
  `sync-current-tasklist.mjs:82`, plus flow-list parsing for `depends_on` /
  `aliases` (`[a, b]` and `- item` block form; `sync-goal-issue-tables.mjs:83-88`
  already has the block-form logic to copy).
- `normalizeGoalRef(v)` — **the normalizer both consumers must share**:
  `String(v ?? "").trim().replace(/,$/, "").toLowerCase()`. Today
  `sync-current-tasklist.mjs` does not read `goal:` at all, while
  `sync-goal-issue-tables.mjs:120` groups on the **raw, case-sensitive,
  comma-inclusive** value. If the new expansion normalizes and the table
  generator does not, the two will disagree about membership for values like
  `real-world-compat,` — the goal page will show an issue the queue does not.
  **Update `sync-goal-issue-tables.mjs` to call `normalizeGoalRef` too**, in the
  same PR.
- `loadGoals(goalsDir)` → `Map<slug, goal>`; skips `goal-graph.md`.
- `currentGoals(goals)` → goals with `sprint === "current"`.
- `goalIndex(goals)` → `Map<ref, slug>` covering the canonical slug **and every
  alias**, all passed through `normalizeGoalRef`. Throws on an alias claimed by
  two goals (a silent-misrouting hazard).

**File: `scripts/sync-current-tasklist.mjs`**

- `readIssue()` (line 101-122): add `goal: normalizeGoalRef(fm.goal)` to the
  returned object.
- New `expandedByGoal(issue, idx, goals)` helper, immediately after
  `normHorizon()` (line 133). Returns the goal slug or `null`:
  - `null` unless `idx` maps `issue.goal` to a `sprint: current` goal;
  - `null` if the issue's own `sprint` is a **numbered** value
    (`/^\d+$/` — the frozen-record guard from D4);
  - otherwise the slug. (`sprint: current` members return the slug too; they are
    already in the queue, so this is purely informational for the subject tag.)
- Full-scan selection (line 266-270): replace
  `.filter(i => i.sprint === "current")` with
  `.filter(i => i.sprint === "current" || i.viaGoal)`, where `viaGoal` is set
  from `expandedByGoal` during the map.
- `syncIssue()` (line 205): `if (issue.sprint !== "current") return;` becomes
  `if (issue.sprint !== "current" && !issue.viaGoal) return;`. **Line 206's
  `ACTIONABLE` check is deliberately left untouched** — that is D4's whole
  point. Add a comment saying so.
- `subjectFor()` (line 189-195): append `[G:<slug>]` after the horizon tag when
  `issue.viaGoal` is set.
- **Defaults from the goal (D3):** in `readIssue()`, when `fm.priority` is
  absent and the issue resolves to a goal, use the goal's `priority`; same for
  `horizon`. The issue's own value always wins. Note `normHorizon()` currently
  collapses "absent" and "m" — thread the raw value through so "absent" is
  distinguishable.
- **`--goal <slug>` fast path**, mirroring `--issue` (line 51-54, 257-264):
  syncs only that goal's members.
- **Warn** when one goal contributes > 40 net-new tasks (D4), and when a
  `sprint: current` goal expands to **zero** members (D5).

**File: `.claude/hooks/post-file-edit` (or wherever `--issue` is invoked)**

- **This is the bug that would make the feature look broken.** The hook calls
  `sync-current-tasklist.mjs --issue <path>`. A `plan/goals/*.md` path matches no
  entry in `issueFiles()` (line 96-99, which requires `^\d+[a-z]?-`), so
  `issues` resolves to `[]` (line 264) and **editing a goal to add
  `sprint: current` silently syncs nothing.** Route paths under `plan/goals/` to
  `--goal <slug>` (or, simplest, to a full scan).

**File: `scripts/freeze-sprint.mjs`**

- Comment at `listIssues()` (line 99-101): _"This glob deliberately excludes
  `plan/goals/*.md`. A goal is never re-tagged to a numbered sprint (#3627 D6) —
  it outlives the budget window. Widening this glob would corrupt goal
  scheduling."_
- After the "Rolled forward" section (line 205-211), append a read-only
  **"## Goals in this window"** list from `currentGoals()`. No writes to goal
  files.

**File: `scripts/check-goal-refs.mjs` (NEW) + `package.json` script `check:goal-refs`**

- Fails on: a goal file whose `goal:` ≠ its filename; a **numbered** `sprint:` on
  a goal (only `current` or absent is legal — D2); an alias claimed by two goals;
  an alias colliding with a real goal slug.
- Baseline-ratchets dangling `goal:` refs against
  `scripts/goal-ref-baseline.json` (seeded at 512): fail on growth,
  `--update-on-decrease` banks improvement. Mirrors `check:ir-fallbacks`.
- Warns (does not fail) when a `sprint: current` goal expands to zero members.
- Wire into the `quality` CI job.

**File: `tests/planning-scripts.test.ts` (or nearest existing home)**

1. `freeze-sprint.mjs --force --dry-run` over a fixture containing a
   `sprint: current` goal file ⇒ the goal file is **not** in `toFreeze` and is
   unmodified. _This is the regression test that pins D6._
2. Goal `sprint: current` + member `status: backlog` ⇒ no task (D4).
3. Goal `sprint: current` + member `status: ready`, `sprint: Backlog` ⇒ task
   created, subject carries `[G:<slug>]`.
4. Goal `sprint: current` + member `status: ready`, `sprint: 68` ⇒ **no** task
   (frozen-record guard).
5. Member reached via `aliases:` ⇒ task created (the #2860 `goal: standalone`
   case).
6. Member with its own `priority: low` under a `priority: high` goal ⇒ subject
   tag is `[P3]` (D3 issue-wins).
7. Member with no `horizon:` under a `horizon: l` goal ⇒ subject tag is `[L]`.
8. No task is ever created whose subject lacks a `#<id>` reference (pins the D6
   non-goal — otherwise `reconcile-tasklist.mjs` can never complete it).

### Edge cases

- **Issue already `sprint: current` AND a member of a `current` goal** — no
  duplicate: `syncIssue()` is keyed by issue id (line 248) and idempotent. Only
  the subject gains `[G:<slug>]`.
- **First run reports a large "updated" count.** Adding the `[G:…]` tag changes
  `subjectFor()` output for every issue that is both `current` and a `current`
  goal member, so the sync rewrites those task files. Expected, not a bug —
  call it out in the PR description. (Zero if this PR schedules no goal, per the
  no-op Acceptance criterion.)
- **Removing `sprint: current` from a goal orphans its expanded tasks.** The
  script only upserts; it never deletes. This is pre-existing behaviour for
  issues, but one goal edit can now orphan ~24 tasks at once. **Accepted for
  this issue** (`reconcile-tasklist.mjs` still closes them as their issues
  complete); note it in the script header and file `--prune` as a follow-up.
- **Alias claimed by two goals** — hard error in `goalIndex()`. Silent
  misrouting of ~100 issues is the worst available failure.
- **Trailing-comma / case-variant `goal:` values** — handled by
  `normalizeGoalRef`, and only correct because both consumers share it.
- **Goal file with no `## Issues` section** — `sync-goal-issue-tables.mjs:169`
  `continue`s. Expansion must not depend on the table; it is generated output.
- **A member's `status` flips to `done` while its goal stays `current`** — the
  existing `skipped_done` path (line 206-209) and the reconciler handle it
  unchanged.

### Migration: `umbrella:` → `parent:`

**Measured: all 142 `umbrella:` values are numeric issue ids** — the identical
shape and meaning as `parent:` (issue → issue containment). It is **never** a
goal reference, so the brief's "redundant with `goal:` in some cases" does not
hold. Only 3 issues carry both fields. This is a pure mechanical rename across
13 container issues.

| container | members | container | members |
| --------- | ------: | --------- | ------: |
| **#2860** |  **79** | #3178     |       8 |
| #1781     |      19 | #3182     |       6 |
| #1712     |      11 | #3185     |       6 |
| #2039     |       5 | others (6) | 1 each |

Three phases, no big bang:

1. **Readers accept both.** Any consumer of `parent:` also reads `umbrella:`.
   Zero file churn. (`sync-current-tasklist.mjs` reads neither today, so this is
   a no-op there.)
2. **Writers emit `parent:`.** Update `SCHEMA.md` and `/create-issue` to
   document `parent:` only and mark `umbrella:` deprecated. New issues stop
   producing it. Migrate the 142 files opportunistically — whenever an issue is
   touched for other reasons, drop `umbrella: N` in favour of `parent: N`. For
   the 3 issues carrying both, keep `parent:` and delete `umbrella:` only if the
   two agree; otherwise flag for manual triage.
3. **Drop `umbrella:`** from readers and `SCHEMA.md` once the count reaches
   zero.

**What happens to #2860 specifically:** nothing structural. It remains issue
#2860, `status: in-progress`, `sprint: current`, an ordinary XL epic. Its 79
`umbrella: 2860` children become `parent: 2860` in phase 2. Its own
`goal: standalone` is a dangling ref and is fixed by adding `standalone` to
`standalone-mode`'s `aliases:` (D2) — which is also what makes it and its
children reachable when `standalone-mode` is scheduled.

### Explicitly out of scope

- **The `reconcile-tasklist.mjs` merged-PR title-scan bug** (D1). Real,
  measured, confirmed by PR #3501 — and unaffected by this design. Separate
  issue.
- **Triaging the 63 dangling goal names.** This issue ships the gate and the
  baseline; the triage is a follow-up.
- **`--prune` for orphaned tasks.** Follow-up.
- **Scheduling any goal.** Landing the mechanism must change no behaviour.

## Acceptance criteria

1. Adding `sprint: current` to a goal file surfaces exactly its `ready` /
   `in-progress` members — measured against `spec-completeness` this is **24**
   net-new tasks, not 364.
2. Editing a goal file **through the hook** syncs the queue (the `--issue`
   fast-path gap is closed).
3. `freeze-sprint.mjs --force` never modifies a goal file, and `sprints/N.md`
   records the window's goals — pinned by test 1.
4. No task exists whose subject lacks a `#<id>`; `reconcile-tasklist.mjs`
   reports no new unresolvable tasks.
5. `check:goal-refs` passes at the 512 baseline and fails when a PR adds a
   dangling `goal:` value.
6. An issue's own `priority:` is never overridden by its goal's.
7. **This PR is a behavioural no-op**: with no goal carrying `sprint: current`,
   `sync-current-tasklist.mjs --dry-run` reports zero created and zero updated.
