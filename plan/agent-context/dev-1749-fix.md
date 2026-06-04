# dev-1749-fix — context summary (2026-06-03)

## Session outcomes

- **PR #1110 (#1732 namespace-call TypeError)** — MERGED 2026-06-03T20:43:00Z.
  Bare-namespace calls (`Math()`/`JSON()`/`Reflect()`/`Atomics()`) now throw
  TypeError. Task #277 completed, worktree removed.

- **#1732 Math descriptors recon (task #61)** — verified empirically on
  origin/main that ALL claimed gaps are already green or unreachable:
  - `Math.max.length===2`, `min===2`, `abs===1`, `pow===2` — correct on main.
  - method `.name` values correct; DontEnum correct; `-0`/Infinity edge cases
    correct.
  - **Symbol-arg "should throw TypeError"** is unreachable: the TS diagnostic
    gate rejects `Math.abs(Symbol())` as a compile error BEFORE codegen, so any
    `compileMathCall` Symbol guard is dead code. With an `as any` cast the
    Symbol's i32 counter leaks (returns `101`) — that's the #1644-adjacent
    Symbol-representation arch gap, NOT a localized Math fix. **No dev PR
    appropriate.** Reported to team-lead.

- **#1320 `__sget_<bool-field>` null-return (task #67)** — fully root-caused,
  handed to sd-846-slice3 → **PR #1111 in queue**. Root cause for the next
  reader:
  - `buildGetterExtract` (`src/codegen/index.ts` ~4125) gates the boolean arm on
    `... && boxBoolIdx !== undefined`.
  - `boxBoolIdx = ctx.funcMap.get("__box_boolean")` (line ~1667) is `undefined`
    for plain JS-host modules — `__box_boolean` is only registered via
    `registerNative` (~line 7709) on the standalone/WASI native-helper path.
  - So boolean fields fall through; with `__box_number` also absent in a minimal
    module the getter ends at `drop` + `ref.null.extern` → returns `null`.
  - `hasBool` is already correctly detected (line ~1684) and forces
    `returnMode = "extern"`. **Fix:** when `hasBool` is true, force-register/
    import `__box_boolean` BEFORE computing `boxBoolIdx`, mirroring the
    guaranteed-present `__box_number` pattern.
  - Probe confirmed bug: `__sget_done({done:true})` → `null`,
    `__sget_done({done:false})` → `null`, `__sget_value({value:5})` → `5` (ok).

## Out-of-lane dispatches declined (pre-claim gate)

Tasks #56 (owned/IR), #59, #62, #66 ([SENIOR-DEV ONLY]) — declined per role
lane. #67 root-caused then handed off rather than self-claimed (senior-tagged).

## Housekeeping notes for tech-lead

- `/workspace` could not be fast-forwarded — pre-existing uncommitted changes
  (test262-run.log, plan/issues/*.md, native-messaging examples; present since
  session start, not mine) block `scripts/sync-workspace-main.sh`.
- Stray worktree `issue-1732-math-symbol` (@1231c8afb) belongs to dev-1599-parse
  (task #280) — left untouched.
