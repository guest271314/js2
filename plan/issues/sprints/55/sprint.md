---
sprint: 55
status: active
created: 2026-05-23
started: 2026-05-23
baseline_pass: 29239
baseline_total: 43159
baseline_pct: 67.75
target_pass: 29650
expected_gain: 411
authors: product-owner
---

# Sprint 55 Plan — IR foundation + carry-in harvest

## Goal

**Two parallel tracks.** (1) Lay the **IR ownership/allocation foundation**
(#1586 → #1587/#1588 → #747) that future memory-management and Component-Model
interop work builds on — strategic, low direct test262 yield. (2) **Harvest the
carry-in backlog** that slipped through the compressed sprint 53/54 cycle —
the destructuring decl-mode chain (#1553b/c/d), the async-gen-meth cast bug
(#820d), the host-independence series (#1471–#1474), and two array/Promise
semantics issues (#1130, #1116). Track 2 is where the test262 pass-rate gain
comes from; track 1 is investment in the IR retirement direction (#1530).

## Baseline & projection

- **Baseline (sprint-55/begin tag):** 29,239 / 43,159 pass = **67.75%**
  (latest committed CI run 20260523-151557 reports 29,089; baseline figure is
  the authoritative sprint-open number per task brief — treat the ~150 delta as
  run-to-run flake).
- **Target:** ~29,650 pass (+411 conservative addressable).
- **Conservative addressable by issue** (test262 FAIL→PASS):
  #820d ≈ +80, #1553b/c/d chain ≈ +60, #1130 ≈ +60, #1116 ≈ +80,
  #1589A ≈ +0 (tests skipped — see note), host-indep #1471–#1474 ≈ +0
  (standalone/WASI strategic, no JS-host test262 movement),
  IR foundation #1586/#1587/#1588/#747 ≈ +0 (strategic). Headroom from
  chain-unlock + indirect dstr cases is upside, not baked into the target.

## Validation (2026-05-23, against origin/main post ~90-PR landing)

Method: merge-history audit + frontmatter/status review. No candidate issue's
fix has landed on main (only **#1553a** merged, PR #453 — that is a *dependency*
of #1553b, not a sprint-55 deliverable; and the **#1589 timeout work** landed as
PRs #509/#515/#520, which *skipped* the 3 hot-spot tests rather than fixing the
underlying #1589A bug). A fix that never merged cannot have resolved its failure,
so every live issue below still reproduces.

| ID | Validation result | Status set |
|----|-------------------|------------|
| #1586 | live — IR allocation-site plumbing not yet in tree | ready |
| #1587 | live — no ownership pass in tree; **needs architect spec** | ready |
| #1588 | live — no encoding-tracking pass in tree | ready |
| #747 | live — escape analysis not in tree; has spec (re-scope to #1587) | ready |
| #1589A | **partially obsoleted** — root cause unfixed, but the 3 timeout tests were *skipped* by PR #520, removing the urgency. Demoted to P3. | ready |
| #1553b | live — #1553a (dep) landed; this slice un-started | ready |
| #1553c | live — blocked on #1553b | blocked |
| #1553d | live — blocked on #1553c | blocked |
| #820d | live — async-gen-meth-dflt `unresolvable` cluster still fails | ready |
| #1471 | live — #1470 (sibling) landed, #1471 boxing/unboxing untouched | ready |
| #1472 | live — host object/property ops untouched | ready |
| #1473 | live — host error/exception ops untouched | ready |
| #1474 | live — pure-Wasm RegExp untouched | ready |
| #1130 | live — array accessor-observability untouched | ready |
| #1116 | live — Promise/async-error subset untouched (#436 landed an earlier slice) | ready |

**Validated-live: 14. Marked-done: 0.** (#1589A re-prioritised, not closed —
its acceptance criteria still describe an unfixed bug.)

## Priority buckets

### P1 — primary test262 / unblocking value (dispatch first)

| ID | Title | Feasibility | Spec? | Est. | Depends on |
|----|-------|-------------|-------|------|------------|
| [#820d](820d-async-gen-meth-unresolvable-cast.md) | async-gen-meth-dflt `unresolvable` illegal cast | medium | yes (in-issue) | +80 | — |
| [#1553b](1553b.md) | decl-dstr typed-struct object delegation | medium | yes (in-issue) | +18 (chain +60) | #1553a (done) |
| _(note: #1553b was carried as `in-progress` but no work landed; reset to `ready`)_ | | | | | |
| [#1586](1586-explicit-allocation-sites-in-ir.md) | IR explicit allocation sites (foundation gate) | medium | **NO** | strategic | — |

Rationale: #820d is the single biggest direct test262 win (~80) and is
self-contained. #1553b unblocks the whole decl-dstr chain (1553c → 1553d). #1586
is the hard gate for all of track 1 — nothing in #1587/#1588/#747 can start
until it lands, so it must be in P1 despite zero direct test262 yield.

### P2 — high value, dependent or strategic

| ID | Title | Feasibility | Spec? | Est. | Depends on |
|----|-------|-------------|-------|------|------------|
| [#1553c](1553c.md) | decl-dstr externref-fallback object delegation | medium | partial | chain | #1553b |
| [#1553d](1553d.md) | decl-dstr array delegation | hard | partial | chain | #1553c |
| [#1116](1116-promise-resolution-and-async-error.md) | Promise resolution & async error handling | hard | **NO** | +80 | — |
| [#1130](1130-array-methods-getter-observing-property.md) | array getter-observing property access | hard | **NO** | +60 | — |
| [#1587](1587-ownership-and-access-semantics-analysis.md) | IR ownership/access semantics pass | hard | **NO** | strategic | #1586 |
| [#1588](1588-string-encoding-tracking-utf8-wtf16.md) | IR string-encoding (UTF-8/WTF-16) tracking | medium | **NO** | strategic | #1586 |

### P3 — strategic / deferred-urgency

| ID | Title | Feasibility | Spec? | Est. | Depends on |
|----|-------|-------------|-------|------|------------|
| [#1471](1471-no-js-host-boxing-unboxing.md) | host-indep: boxing/unboxing | medium | yes (in-issue) | +0 (WASI) | — |
| [#1472](1472-no-js-host-object-property-ops.md) | host-indep: object/property ops | medium | yes (in-issue) | +0 (WASI) | #1471 (soft) |
| [#1473](1473-no-js-host-error-exceptions.md) | host-indep: error/exception ops | medium | yes (in-issue) | +0 (WASI) | — |
| [#1474](1474-no-js-host-regex-standalone.md) | host-indep: pure-Wasm RegExp (Phase 1 — done) | medium | yes (in-issue) | +0 (WASI) | — |
| [#1539](1539-wasm-native-regex-engine-regress.md) | standalone regex engine via regress (Phase 2 of #1474) | hard | yes (in-issue) | +400–800 (WASI) | #1474 ✓ |
| [#747](747-escape-analysis-for-stack-allocation.md) | escape analysis for stack alloc (Phase 1 of #652) | hard | yes (re-scope) | strategic | #1586, #1587 |
| [#1589A](1589A-object-literal-field-type-and-has-idx.md) | object-literal field-type + has_idx null semantics | hard | yes (fix plan) | +0 (tests skipped) | — |

## Dispatch manifest (for tech lead)

- **Single-owner serialization required:**
  - **decl-dstr chain** (#1553b → #1553c → #1553d) — one dev, sequential, same
    `src/codegen/statements/destructuring.ts` + `destructure-params.ts` regions.
  - **host-independence series** (#1471 → #1472 → #1473 → #1474 → #1539) — one "runtime
    owner" dev; all touch overlapping `src/runtime.ts` / `codegen/index.ts`
    import-registration regions (per s54 conflict analysis). #1539 depends on #1474 and
    must follow it; #1474 Phase 1 is already merged so #1539 is unblocked once
    #1471–#1473 land (or can run in parallel with them since Phase 1 gate is in place).
  - **IR foundation** (#1586 first, then #1587/#1588 in parallel, then #747) —
    #1586 is the gate; do not dispatch #1587/#1588/#747 until #1586 merges.
- **Parallelisable now:** #820d, #1130, #1116 are independent of each other and
  of the chains — three separate devs can take them concurrently.
- **#820d** is the recommended first dispatch (highest direct yield, in-issue
  spec, self-contained).

## Architect specs needed before dev dispatch

Issues marked `feasibility: hard` or core-codegen that **lack** a `## Implementation
Plan` and must be spec'd by the architect first:

1. **#1586** — IR explicit allocation sites. P1 gate; medium but core-IR. No spec
   yet — **spec this first**, it blocks #1587/#1588/#747.
2. **#1587** — IR ownership/access semantics pass. `hard`, no spec.
3. **#1588** — IR string-encoding tracking. medium but core-IR, no spec.
4. **#1116** — Promise-subclass / Wasm-class-as-JS-ctor bridge. `hard`, no spec.
5. **#1130** — array getter-observability. `hard`, no spec.

Already-spec'd (dispatch-ready): #820d (in-issue), #1553b (in-issue),
#1553c/#1553d (in-issue partial), #747 (has spec, re-scope to #1587 substrate),
#1589A (has fix plan), #1471–#1474 (in-issue specs), #1539 (in-issue spec).

## Theme

**IR foundation for ownership-based optimization** + **carry-in harvest.** #1586
introduces stable allocation identity in the IR; #1587 derives ownership/access
semantics; #747 uses those to scalar-replace non-escaping allocations; #1588 is a
parallel encoding-tracking track on the same IR base. Alongside, sprint 55 clears
the test262 carry-in that the compressed 53/54 cycle never reached.

## Notes

- #1586 must land first; #1587, #1588, and #747 all depend on it.
- #1587 is `feasibility: hard` — needs architect spec before dispatch.
- #747 `feasibility: hard`. Original spec (2026-05-21) targets #743 + #746 as
  deps. For s55 the architect should re-scope #747 onto the new IR ownership pass
  (#1587) as analysis substrate — cleaner than the original AST-walk approach.
- #652 (compile-time ARC, full) and #746 (inline property tables) remain backlog
  follow-ups; #747 is the narrower Phase 1.
- **#1589A demotion rationale:** PR #520 skipped the 3 Array.indexOf.call hot-spot
  tests that were pinning the compile_timeout budget. The underlying field-type /
  `__extern_has_idx` bug is unfixed and the issue stays open, but with no test262
  pressure it drops to P3.

## Carry-in provenance (added at sprint 54 closeout, 2026-05-23)

The sprint 54 compressed cycle did not execute its planned W1–W3 harvest.
All carry-in issues were physically moved into `plan/issues/sprints/55/` at the
s54 closeout (#1471–#1474 from s52, #1116/#1130 from backlog, #1589A/#1553*/#820d
from s53/s54) and have `sprint: 55` set. #1553b's `in-progress` status is stale —
no work landed; it is `ready` for this sprint.
