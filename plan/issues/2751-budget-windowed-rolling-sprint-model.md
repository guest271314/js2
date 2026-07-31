---
id: 2751
title: "Budget-windowed rolling sprint model: sprint:current queue + budget-triggered freeze + auto-sync to TaskList"
status: done
sprint: 69
created: 2026-06-27
updated: 2026-07-03
completed: 2026-06-27
priority: high
horizon: l
feasibility: medium
reasoning_effort: medium
task_type: feature
area: process
language_feature: none
goal: maintainability
---

# #2751 — Budget-windowed rolling sprint model

## Problem

Sprints are sized to ~1 week of **token budget** (not calendar time), and that
budget is typically burned in **< 2 days**. The defect is not cadence/ceremony —
it is that a **fixed, pre-scoped task list** and **budget burn** never line up,
because per-issue token cost is high-variance and not estimable in advance:

- list bigger than the budget buys → **strand mid-sprint** (sprint left unfinished)
- list smaller → **run out of tasks early** (idle budget; today band-aided by the
  ES3/ES5 autofill)
- sprints also get **closed early** for exogenous reasons

All three are symptoms of batching a stochastic quantity into a fixed box.

## Model (the fix)

Stop defining a sprint as a fixed list ≈ one budget. Decouple the two clocks:

1. **Rolling priority queue, tagged `sprint: current`.**
   The TaskList is kept long and **over-provisioned** (always more queued than any
   budget could consume), **priority-ordered only** — no per-sprint scoping. Every
   actionable issue in the live window carries `sprint: current` (a new symbolic
   sprint value). Priority order, not membership, decides what gets worked.

2. **Budget-triggered freeze → numbered sprint.**
   When **either** the weekly token budget reaches **≥ 99%** **or** the time left
   in the window is **≤ 1 hour** (budget is primary; the time floor is the fallback
   so a slow week still rolls over):
   - compute the **lowest free sprint index** N (smallest N ≥ 0 with no issue
     carrying `sprint: N` and no `plan/issues/sprints/N.md`; currently **68**),
   - re-tag every issue that is `sprint: current` **AND `status: done`** to
     `sprint: N` (freezes the completed work into the window's record),
   - leave every **not-done** `sprint: current` issue as `sprint: current` (it
     rolls forward into the next window — stranding is now structurally
     impossible),
   - stamp `plan/issues/sprints/N.md` as the **retrospective** record of the
     window (date range, budget spent, frozen issues, conformance delta). The
     sprint number is thus a _retrospective window label_, assigned at rollover,
     never a prospective commitment.

3. **Auto-sync `sprint: current` → team TaskList.**
   When an issue is assigned `sprint: current`, **or** updated while already
   `sprint: current`, it is automatically synced into the **team `js2wasm`**
   TaskList: create the task if missing (keyed by `#<id>` in the subject), update
   subject/priority if the issue's frontmatter changed, preserve `owner`/`status`.
   This is the **forward** counterpart to the existing reverse sync in
   `scripts/reconcile-tasklist.mjs` (which marks tasks `completed` when their issue
   is `done`). Together they keep issue-frontmatter (source of truth) and the
   TaskList in lockstep in both directions.

### 4. Budget-aware pull-time scheduling (IMPLEMENTED)

Each issue carries a `horizon:` cost class (`xl`/`l`/`m`/`s`, default `m`) — the
expected token/work cost, distinct from `priority` (importance). The agent about
to claim work runs `scripts/budget-status.mjs --pick`, which reports the
**remaining token budget**, the **parallelism** (active agents), the **per-agent
share** (≈ remaining ÷ agents), and the largest horizon it should pull, plus the
best-fit claimable tasks. Rules realised:

- **Long-horizon tasks preferentially at the START of a window** — a fresh window
  has a large per-agent share, so `xl`/`l` fit and are surfaced first (big rocks
  first).
- **No oversized starts late** — as the window drains or parallelism rises, the
  share shrinks and only smaller horizons are recommended; an `xl` that no longer
  fits is deferred to the next window's start rather than started and stranded.
- **`s` is always-available tail filler** so the last slice of budget neither
  strands a big item nor sits idle.
  `sync-current-tasklist.mjs` surfaces the class as a `[XL]`/`[L]`/`[M]`/`[S]` tag.
  Only rough size classes are needed, not accurate per-issue estimates.

## Implementation surface

- **Schema** (`plan/issues/SCHEMA.md`): add `current` as a valid `sprint:` value
  ("the live in-flight window"); document the `current` → numbered-N freeze
  transition. Update any sprint-value validation / lint to accept `current`.
- **Forward-sync script** — new `scripts/sync-current-tasklist.mjs` (or extend
  `reconcile-tasklist.mjs` into a bidirectional pass): scan
  `plan/issues/*.md` for `sprint: current` with actionable `status`
  (`ready`/`in-progress`/`blocked`), upsert into the team `js2wasm` task store
  ordered by issue `priority`. Idempotent; preserves owner/status.
- **Freeze script** — new `scripts/freeze-sprint.mjs`: implements rule 2 (compute
  lowest-free N, re-tag done `current` issues → N, generate `sprints/N.md`). Reuse
  `check-sprint-closed.mjs` / `sprint-stats.*` for the retro doc content.
- **Pull-time budget helper** — new `scripts/budget-status.mjs`: implements rule 4
  (remaining budget + parallelism → per-agent share → recommended max horizon +
  best-fit `--pick`). Reads `JS2WASM_BUDGET_REMAINING_PCT`/`JS2WASM_BUDGET_PCT` and
  `JS2WASM_PARALLELISM` (auto-detected from in-progress task owners if unset);
  `horizon` cost classes tunable via `JS2WASM_HORIZON_COSTS`. The dev loop +
  `developer.md` run it before claiming.
- **Triggers / wiring:**
  - forward-sync: fire from the existing `post-file-edit.sh` hook when the edited
    path matches `plan/issues/*.md`, **plus** the SessionStart reconcile cycle.
  - freeze / budget source: **RESOLVED** — the statusline
    (`.claude/statusline-command.sh`, which already shows "wkly" % and "d left")
    caches `rate_limits.seven_day` (`used_percentage` + `resets_at`) to
    `~/.claude/js2wasm-budget.json` on every render. `freeze-sprint.mjs` and
    `budget-status.mjs` read that cache (env overrides still take precedence),
    so the `≥99%` and `≤1h` triggers fire automatically off the same weekly
    budget the statusline displays — no manual env-setting needed.
- **Dashboard / sprint-stats**: `sprint: current` is the active window;
  `build:pages` and `sprint-stats` must render it without choking on the
  non-numeric value.
- **CLAUDE.md**: replace the "populate TaskList from `sprint: {N}` frontmatter"
  instruction with the rolling `sprint: current` + freeze model.

## Edge cases

- An issue reopened (`done` → `ready`) after a freeze: it was already numbered N;
  decide whether reopening re-tags it back to `current` (recommended) so it
  re-enters the queue.
- Two freezes racing (TL + cron): freeze must be idempotent and lock the
  lowest-free-N computation (same atomicity concern as `claim-issue.mjs`).
- `wont-fix`/`blocked` issues tagged `current`: excluded from the freeze re-tag
  (only `done` freezes); blocked stays `current` or moves to `Backlog` per PO.

## Acceptance criteria

- [ ] `sprint: current` is a documented, validated sprint value; tooling/dashboard
      handle it.
- [ ] Assigning/updating an issue to `sprint: current` auto-creates/updates its
      team-`js2wasm` TaskList entry (priority-ordered), idempotently, preserving
      owner/status.
- [ ] At budget ≥ 99% **or** ≤ 1h left, `freeze-sprint.mjs` re-tags done `current`
      issues to the lowest-free N, leaves non-done as `current`, and writes
      `sprints/N.md`.
- [ ] Stranding is structurally impossible (unfinished work always rolls forward as
      `current`); the queue is over-provisioned so it cannot run dry mid-window.
- [ ] `horizon:` is a documented, validated field; `budget-status.mjs --pick`
      reports remaining budget + parallelism + per-agent share and recommends an
      adequately-sized task (XL/L first when fresh; only fitting horizons as the
      window drains; S as tail filler); the dev loop runs it before claiming.
- [ ] CLAUDE.md + SCHEMA.md + developer.md describe the new model; the old
      fixed-list sprint instructions are removed.

## Notes

- Sibling to #2750 (process-doc consolidation); the CLAUDE.md edits here should be
  done in the same human-reviewable, one-small-PR-at-a-time spirit.
- This issue dogfoods the model: it is itself tagged `sprint: current`.

## Residual (2026-07-31): `--pick`'s "best-fit claimable tasks" are not claimable

Filed here rather than under a new id — this is `--pick`'s own issue, and the
acceptance box _"`horizon:` is a documented, validated field; `budget-status.mjs
--pick` …"_ above is still open.

`--pick` ranks by `priority` + `horizon` but does **not** filter on claim status,
`task_type`, or `model`. It therefore recommends work the pre-dispatch gate then
refuses. Measured — every one of the five XL entries it offered a **developer**:

| id    | gate verdict | reason                                                           |
| ----- | ------------ | ---------------------------------------------------------------- |
| #2773 | —            | `[EPIC][ARCH]` + `model: fable` — out of a developer's lane      |
| #2865 | **STOP**     | claimed by `ttraenkler/fable-2865`                               |
| #2949 | **STOP**     | claimed by `ttraenkler/codex-ir-array-param` + 3 active overlaps |
| #3029 | CAUTION      | `task_type: architecture`, `model: fable` — out of lane          |
| #3030 | **STOP**     | active claimed overlap (#3520) + `task_type: architecture`       |

**5 of 5 unusable.** This has a real cost: it misdirected a dispatch to #2949,
which was already claimed by another lane.

**The queue is healthy — this is a picker problem, not a dry queue.** Filtering
`sprint: current` + `status: ready` and excluding `model: fable`,
`task_type: architecture|epic`, and `[ARCH]`/`[EPIC]`/`[PO]`/`[SENIOR-DEV]`
subject tags leaves **136** developer-claimable issues. "The picker recommends
unclaimable work" reads very differently from "there is nothing to do", and only
the first is true.

**Suggested fix**, in order of value:

1. Exclude issues with a live claim on the `issue-assignments` ref (`--pick`
   already does network work; one `git show` of the claim ref covers it).
2. Take a `--role` argument (default `developer`) and exclude
   `model: fable`, `task_type: architecture|epic`, and foreign role tags.
3. Failing both, print the gate verdict beside each suggestion so the caller sees
   `STOP` before claiming.

Until then, **always run `pre-dispatch-gate.mjs <id>` on a `--pick` suggestion
before claiming it** — the picker's confidence is not evidence.
