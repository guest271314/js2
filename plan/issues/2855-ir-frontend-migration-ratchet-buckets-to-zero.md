---
id: 2855
title: "IR front-end migration: ratchet unintended fallback buckets to zero + promote to STRICT_IR_REASONS"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-06-30
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
depends_on: [2856, 2857, 2858, 2859]
related: [1376, 2089, 1923]
---

# #2855 — IR front-end migration: drive the unintended fallback buckets to zero

> **Tracking epic — not a single dev task.** This is the narrative anchor for
> the direct-AST→Wasm → typed-IR front-end migration. The actionable work is in
> the per-bucket child issues (`depends_on`). Kept `status: backlog` so it stays
> visible in planning without being offered as a code task in the TaskList; the
> children carry `status: ready` and are the queued, dev-claimable slices.

## Why this exists / supersedes the stale `#1530` reference

The compiler has two front-ends: the legacy direct AST→Wasm path (accumulated
hacks under `src/codegen/`) and the typed IR (`src/ir/`). **IR is meant to
replace the hacks, adopted per-AST-kind.** A `FunctionDeclaration` (the IR claim
unit) that the selector cannot fully lower demotes to the legacy path via the
demote-to-warning channel (`src/codegen/index.ts`), bucketed by an
`IrFallbackReason` (`src/ir/select.ts`).

The retirement is governed by the **IR fallback budget gate** (`pnpm run
check:ir-fallbacks`, built in **#1376**, the ratchet mechanism) which counts
each rejection reason against `scripts/ir-fallback-baseline.json`. The direction
is to drive every **unintended** bucket to zero, then add the retired reason to
`STRICT_IR_REASONS` (`src/codegen/index.ts:1511`, currently the **empty set** —
no reason promoted yet; see the #3341 outcome note for why it stays empty) so
any future regression becomes a hard compile error instead of a silent legacy
fallback.

**Stale-reference note (#1530):** `CLAUDE.md`, `docs/architecture/codegen-axes.md`,
and `plan/log/ir-adoption.md` all cite **#1530** as "the issue that phases out
the demote-to-warning channel / drives the unintended buckets to zero."
**`#1530` is actually a WASI Native-Messaging host example** — an unrelated,
already-`done` issue. The real ratchet _mechanism_ is **#1376** (the telemetry
gate, done) + **#2089** (silent-fallback ratchet, done) + **#1923** (post-claim
demotion metering, done). This epic (#2855) is the live tracking owner for the
remaining _content_ work — driving the buckets to zero. `plan/log/ir-adoption.md`
has been repointed to #2855; **`CLAUDE.md` and
`docs/architecture/codegen-axes.md` still carry the stale `#1530` citation and
need a one-line repoint to #2855 by an agent that may edit non-`plan/` files**
(PO is plan-only).

## Live bucket snapshot (verified against `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose`:

| Bucket                      | Count | Category     | Child issue      | Priority |
| --------------------------- | ----- | ------------ | ---------------- | -------- |
| `body-shape-rejected`       | 31    | unintended   | **#2856**        | high     |
| `call-graph-closure`        | 7     | unintended   | **#2858**        | medium   |
| `class-method`              | 6     | unintended   | **#2857**        | medium   |
| `param-type-not-resolvable` | 1     | unintended   | **#2859**        | low      |
| `async-function`            | 4     | **deferred** | #1373b (blocked) | —        |

`async-function` is a **deferred** bucket (documented decision, not a TODO) —
the CPS lowering is gated on standalone microtask drain and tracked in **#1373b**
(`status: backlog`, blocked on #1326c). **Not queued here.** All other
unintended buckets that previously had values (`external-call`,
`param-shape-rejected`, `return-type-not-resolvable`, `type-resolution-failure`,
`destructuring-param-complex`) are **already at zero** — retired by #1371 / #1372
/ #1374 / #1375 / #1370 (all done) — so they are **not** queued.

## Acceptance criteria

This epic is `done` when, for every unintended bucket:

1. The bucket count in `scripts/ir-fallback-baseline.json` is `0`.
2. The corresponding `IrFallbackReason` is added to `STRICT_IR_REASONS`
   (`src/codegen/index.ts:1511`), so a regression hard-errors — **but only
   when zero-on-corpus genuinely means architectural completeness for that
   class** (see the #3341 outcome note below; AC-2 is NOT satisfied by
   corpus-zero alone).
3. The matching row in `plan/log/ir-adoption.md` is promoted `mixed → ir-owned`
   (regenerate via `pnpm run gen:ir-adoption`).
4. Once all unintended buckets are zero + strict, the demote-to-warning channel
   (resolve-time `src/codegen/index.ts:~1891`, post-claim `~2420`) can be
   removed for the affected kinds — the final goal the stale #1530 citation
   referred to.

## Children

- **#2856** — `body-shape-rejected` (31) → 0. Dominant bucket. high / horizon L.
- **#2857** — `class-method` (6) → 0. #1370 Phase C/D/E residual. medium / horizon M.
- **#2858** — `call-graph-closure` (7) → 0. Derivative of #2856 + #2857. medium / horizon M.
- **#2859** — `param-type-not-resolvable` (1) → 0. TypeMap propagation. low / horizon S.

## References

- Gate mechanism: #1376 (telemetry gate), #2089 (silent-fallback ratchet),
  #1923 (post-claim demotion metering) — all done.
- `docs/architecture/codegen-axes.md` — the two-axis codegen model.
- `plan/log/ir-adoption.md` — per-AST-kind adoption status (selector-bucket
  table at the bottom maps reasons → promotable rows).
- `src/ir/select.ts` — `IrFallbackReason` union + the per-function claim checks.

## Audit note 2026-07-17 (IR audit 01)

Bucket-zeroing half is ahead of plan: `call-graph-closure`, `class-method`,
`param-type-not-resolvable` all hit 0 since 07-02 (baseline now only
`body-shape-rejected` 14 + deferred `async-function` 4 + moduleLevel 2).
But the PROMOTION half has not started: `STRICT_IR_REASONS`
(`src/codegen/index.ts:1511`) is still the empty set — none of the ~8
zeroed reasons has been promoted, so the demote-to-warning channel still
silently covers all of them. This is now the cheapest hardening step in
the program. Caveat: baseline zero is corpus-zero (13 playground files),
not strict-zero — per-reason promotion needs the corpus-vs-strict check
the `class-method` row in `ir-adoption.md` flags. See
`plan/log/analysis-2026-07/01-ir-audit-2026-07-17.md` §2. Also untracked
post-#2953 residue for a follow-up slice here or a new issue: 5 GC-op
literals left in `lower.ts` (`class.get`/`class.set`/instanceof-tag via
pushRaw at ~1797/1815/1908 — should use the existing
`emitFieldGet`/`emitFieldSet` primitives like `obj.get` does) plus
`forof.str` pushing `struct.get` on the RAW sink (`lower.ts:2614/2674`),
invisible to the `check:pushraw` ratchet (§3).

## #3341 outcome 2026-07-17 — promotion slice done: **promote NONE** (AC-2 refined)

The promotion slice (#3341) is **done against its own AC**: every currently
zeroed unintended reason was evaluated for STRICT promotion and **none was
promoted**, which is the correct, issue-sanctioned result — not a skip.
Root cause: `STRICT_IR_REASONS` promotion is a **global** hard error
(`selection.fallbacks` in `select.ts` records EVERY non-claimed unit with its
reason; the index.ts loop reports each matching one on ALL user code, not just
the corpus). So corpus-zero (10-file `website/playground/examples/`) is
NECESSARY but NOT SUFFICIENT. A reason is only safe when zero means
"architecturally complete," so any occurrence is a genuine regression.

Every candidate FAILS that test — each was given a minimal valid TS program
that compiles today via graceful fallback but would hard-error if promoted
(repros in the #3341 PR body):

- `external-call` — `isNaN(x)` (whitelist is Math.{abs,sqrt,floor,ceil,trunc}+parseInt by design)
- `call-graph-closure` — claimed fn calling a still-direct-only local (`for(;;)`/switch/async)
- `param-type-not-resolvable` — union / non-move-dynamic param
- `return-type-not-resolvable` — union-typed / unresolvable return
- `param-shape-rejected` — optional `x?` / rest / default-initializer param
- `destructuring-param-complex` — rest/nested destructuring param
- `class-method` — computed/generator/abstract name, static super, subclass-of-builtin
- `type-resolution-failure` — **dead/unreachable** (nothing *produces* it; only the union decl + the `check:ir-fallbacks` category list mention it) → promotion vacuous + a landmine if re-wired

Consequence for this epic: AC-2 cannot be satisfied by driving buckets to zero
alone. For a reason to become strict, the underlying IR path must reach
**completeness** for its whole class (e.g. the whitelist must expand to cover
all externals, or all param shapes must lower). Until then the demote-to-warning
channel is load-bearing and stays. `STRICT_IR_REASONS` remains `new Set()` with
an in-code explanation; `ir-adoption.md` bucket rows and `codegen-axes.md` now
carry the "corpus-0 but NOT strict" note. `body-shape-rejected` (14) stays open
via **#2856**; #2855 remains open (not closed by #3341).
