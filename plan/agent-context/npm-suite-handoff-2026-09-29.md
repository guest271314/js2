# npm-suite effort — handoff (2026-09-29)

Supersedes `npm-suite-handoff-2026-09-24.md` for the standalone lane. Lead
session `npm-unit-test-failures-420ca0`, 2026-09-05 → 09-29.

**Scope since 09-23 (stakeholder order): STANDALONE lane only** — the
npm-compat `standaloneDynamic` perf lane (`--target standalone`, no JS host).
JS-host unit-test work is not being dispatched; the parked JS-host branches
listed in the 09-24 handoff are unchanged.

## Standalone-dynamic lane — per-package state

| package | state | next blocker |
|---|---|---|
| uuid | **measured** (#6047) | — |
| react | **measured** (#6087, #6097) | — |
| moment | **measured** (#6125, #6170) | perf ~2,400× slower than Node (#6702) |
| marked | **measured** (#6095, #6151, #6164) | perf only |
| hono | **measured** (#6120, #6148, #6163) | perf only |
| lodash-es | measured once (#6218, #6262); now optimization-error | wasm-opt -O4 dominates compile; CI child budget 120 s (#6737, PR #6288) |
| acorn, cookie, clsx, redux | measured (pre-existing) | — |
| axios | valid raw module (#6212, #6257) | wasm-opt Flatten crash on `try_table` → PR #6288 (budget-aware level) |
| lodash | module init reaches line 17127/17226 (#6208, #6265) | `F.prototype.length` reads a number (#6736) — wave-8 agent running |
| prettier | codegen succeeds (#6260) | invalid Wasm in `printDocToString` (#6730) — wave-8 agent running |
| jest | links (#6267) | `import()` inside async functions (#6735) — wave-8 agent running |
| tailwindcss | past #1472 (#6269) | generator residual shapes (#6731) — wave-8 agent running |
| three | past JSON.stringify (#6264) | class-callable signature on inherited getter (#6733) — wave-8 agent running |
| jsdom, stylelint, eslint | in-graph `import()` works (#6279) | jsdom compile never finished (census quadratic, #6741 → PR #6289 merged); re-measure |
| webpack, typescript | compile > 600 s | re-measure after #6289 |
| styled-components | 18 DOM-global host imports | #6664 family |
| lit | skipped by design (JS-host-only probe) | — |

## In flight at handoff

- Workflow `wf_b24477e7-474` (wave 8, 8 Opus 5.5 agents). Done: #6289
  (census re-derived per entry, merged, carries a stale `hold` label — check
  it), #6288 (budget-aware wasm-opt level, open, DIRTY — needs a main merge).
  Still running: #6736, #6730, #6735, #6731, #6733, #6738. Results land in
  its journal:
  `~/.claude/projects/-Users-thomas-Code-js2--claude-worktrees-npm-unit-test-failures-420ca0/ff1eafdb-376d-4510-b9db-2ae45f5b023f/subagents/workflows/wf_b24477e7-474/journal.jsonl`
- Each agent opens its own PR; auto-enqueue takes CLEAN ones.

## Open follow-ups (filed, not dispatched)

#6701/#6718/#6719 any-receiver array residuals (splice done; shift/unshift,
numeric-key sets remain) · #6702 moment standalone perf · #6727/#6728
TextEncoder encodeInto / subview byteOffset · #6738 `new (a||B)()` (wave 8) ·
styled-components DOM globals · webpack/typescript compile time.

## Lessons from waves 2–8 (add to briefs)

- A new standalone value body can silently re-route an existing static fold
  (#6175 broke 125 class-field test262 rows via `hasOwnProperty.call`): run
  the scoped standalone test262 for every builtin whose value body you add.
- Regressions reach main between waves (#6720, culprit #6208) — re-measure a
  package's lane on current main before trusting a prior "measured".
- The box ran at load 150–390: lane timeouts under load are not regressions.
- `claude-opus-5-5` needs Claude Code ≥ 2.1.280.
- Environment traps from the 09-24 handoff still apply.
