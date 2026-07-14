---
name: project_bloat_reduction_week_of_2026_07_11
description: "Week of 2026-07-11: stakeholder's #1 priority is a bloat-reduction battle plan + execution — src/ is ~320k lines (src/codegen 238k) at 76.0% test262 vs porffor's ~30k lines at comparable pass rate. Burn the weekly Fable budget fast (max parallelism) toward this. Plan doc: plan/bloat-reduction-battle-plan.md."
metadata:
  node_type: memory
  type: project
  originSessionId: ba8f46fe-f3a2-4212-b22a-2f3e64ded7ab
---

**Directive (2026-07-11, new week):** burn the weekly Fable budget as fast as
possible (max parallelism) **until Sunday**; keep the TaskList full the whole
time; the SINGLE most important deliverable is a **battle plan to reduce codebase
bloat** and then execute it. Battle plan DELIVERED: `plan/bloat-reduction-battle-plan.md`
(PR #2885) + issue stubs #3141 (self-hosting pilot — IN FLIGHT, fable-selfhost),
#3142 (module-level IR adoption / clears G3), #3143 (IR-first default flip / clears
G1 → unlocks −60k legacy frontend).

**FLEET SIZE CAP (2026-07-12, user directive): EXACTLY 4 dev agents + 1 shepherd —
do NOT oversubscribe the 8-core box.** More than ~4 heavy dev agents thrashes it
(load spiked 46 from a census sweep + fleet; ~5 agents already push load 11-15).
The merge_group queue is FAST (~4 min/PR) — so the throughput bottleneck is NOT the
queue, it's agent-side: on a thrashed box each dev is slow to produce a green PR.
Fewer agents each getting real CPU = green PRs faster = more merges. So: hold at 4
devs + 1 shepherd; NEVER spawn a 5th dev; when a dev finishes, REDIRECT it (don't
stand down) — net fleet stays 4. BAN heavy in-agent full-corpus runs (census /
run-test262 sweeps) unless load-checked first — they froze the box. Load cap stays
cores-2=6 (spawn gate); never raise JS2WASM_MAX_LOAD.

**STANDING DIRECTIVE (2026-07-11 Sun, updated):** burn to end of Sunday; DEVS DO
NOT STAND DOWN — on PR-land / wall-hit / "next or stand down?", ALWAYS redirect to
the next TaskList task (never send shutdown, never accept a voluntary stand-down)
unless a dev hits a hard context/budget wall. Keep the TaskList FULL (sync +
287-issue backlog + filed issues; re-run scripts/sync-current-tasklist.mjs if low).
REPORT MERGED BLOAT WINS to the user as they land (CPS-engine deletion #2967 2c,
selector-precision slices, #3090 dead-code, self-hosting scale-up, any −LOC PR).

**DEADLINE: the burn window closes SUNDAY (calendar), which as of 2026-07-11 is
TOMORROW — ~1 day left, NOT the 6.1d the budget-status "weekly window" shows (that
is a rolling rate-limit clock, not the calendar deadline the user set).** With
~93% budget unspent and ~1 day: STOP pacing, spend hard, and prioritize
LANDABLE-by-Sunday value + decision-data (esp. the #3141 self-hosting go/no-go
verdict — must land in-window to be actionable) over long-horizon XL work that
can't finish. Do NOT hold big-bang PRs for after the window.

**Operational state (2026-07-11 ~18:45):** budget 96% / (rolling-window 6.2d but
calendar deadline Sunday) — the 5h *sub*-window cycles ~5× before Sunday and its reset KILLS agents
with "session-limit"/"login-expired" API errors (they push progress first; resume
by respawning FRESH on their pushed branches, force-taking stale locks). Queue
depth is handled by `scripts/sync-current-tasklist.mjs` (hook-wired; 63 tasks
queued, 287 ready/in-progress issues available) — re-run it if depth drops.
**Per-tick loop responsibilities for the week:** (1) keep fleet at ~6-8 active
(respawn after window-reset deaths onto the dead agents' pushed branches); (2)
keep TaskList full (re-run sync if low); (3) shepherd the merge queue (keep it fed
3-deep → ~12/hr); (4) surface the #3141 pilot go/no-go + real escalations to the
user. Load cap = cores-2 = 6; do NOT raise JS2WASM_MAX_LOAD without user go
(trades away SSH responsiveness); 6 heavy Fable agents already spike load to 9-15
in compile bursts — that's the ceiling, spawns gate above it. Framing: porffor
is ~30,000 lines at a comparable-or-better test262 pass rate; ours is ~320,000
(`src/codegen/` alone 238k) at 76.0% conformance.

**Measured bloat shape (2026-07-11):** src/ 320k total. src/codegen 238k (74%),
src/ir 33k, codegen-linear 10k. Biggest files: calls.ts 18k, runtime.ts 16k,
codegen/index.ts 15k, object-runtime 10k, array-methods 9.5k, property-access
8.5k, native-strings 7.4k, from-ast (IR) 6.8k.

**Three reducible levers, in leverage order:**
**★ SELF-HOSTING PILOT #3141 VERDICT = GO (2026-07-11, decisive, hard proof).**
fable-selfhost converted 9 Math helpers (sinh/cosh/tanh/asinh/acosh/atanh/cbrt/
expm1/log1p) from hand-emitted Wasm to ordinary TS source (src/stdlib/math.ts)
compiled through our OWN IR pipeline via a reusable driver (src/codegen/
stdlib-selfhost.ts: from-ast → IR passes → BackendEmitter, symbolic-ref lowering
against live ctx). Proof: 36,477-case bit-exact sweep vs exact JS port = ZERO
mismatches; byte-identical containment for non-using programs; standalone+wasi zero
host imports; NO dialect gaps (from-ast accepted everything first try; only quirk =
no NaN/Infinity identifiers in the subset, avoid via x!==x / 0/0 / >MAX_VALUE).
Economics: ~3.3× compression on function bodies (−316 hand → ~95 TS-source);
one-time driver +161 AMORTIZES → marginal cost per additional family = just its TS
source. => the ~45-55k stdlib reduction is VALIDATED as real. Scale-up (convert
array-methods 9.5k / object-runtime 10k / native-strings 7.4k / dataview-native
3.9k / …) is the flagship for the NEXT window; each family byte-inert-proven via the
pilot's bit-exact + containment method. Scale-up plan being written by fable-selfhost.

1. **Self-host the stdlib (the porffor model) — highest leverage, PILOT PROVED GO.**
   ~50-60k lines are hand-written per-builtin Wasm emission (runtime.ts +
   *-methods.ts + object-runtime). Porffor writes builtins as a JS/TS subset it
   compiles through its own pipeline (source-data, not compiler-code). Open
   feasibility question: is our self-compile path stable enough to eat the
   stdlib? Architect (fable-architect) scoping a go/no-go.
2. **Delete the legacy AST→Wasm frontend as IR claims node kinds — ~60k
   deletable, low-risk, incremental, IN MOTION.** #2855 (IR fallback retirement)
   + #3090 (codegen-shrink; Phase 0/2a/2b/2c landed; audit
   `scripts/audit-legacy-reachability.mjs`, list
   `plan/log/3090-phase0-legacy-delete-list.md`). Handler deletion is
   IR-overlay-gated (legacy compiles everything first; a handler stays live until
   IR fully owns that node kind — respect G1-G4). #2967 async-engine convergence
   deletes the CPS engine (emitAsyncStateMachine/splitBodyAtAwait) = concrete
   headline win.
3. **Collapse god-files** (calls.ts 18k, index.ts 15k, property-access 8.5k) via
   the unified emitter/IR contract — lower line-yield.

**NOT reducible:** the WasmGC-vs-linear BACKEND split (both stay, target-dependent
per CLAUDE.md / #1527). Deletion lives in the legacy-vs-IR FRONTEND split only.

**Safety rule for every deletion slice:** byte-inert (prove-emit-identity /
sha-identical both string modes) OR measured-net-non-negative via the equivalence
gate + merge_group — pass rate must not regress. See [[project_broad_impact_validate_full_ci]].
Related: [[feedback_devs_default_opus]] (devs run fable), the load cap ~cores-2,
and the queue-throughput note: keep the merge queue fed 3-deep (shepherd) — it
merges ~12/hr back-to-back when fed, ~2/hr when it idles between rebases.
