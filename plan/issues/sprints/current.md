---
sprint: current
status: active
planned: 2026-06-30
---

# Current budget window — FOCUS: close the standalone-vs-js-host test262 gap

> **Stakeholder directive (2026-06-30).** Closing the standalone gap is the TOP
> priority for the current budget window. This is the live planning record for
> the `sprint: current` window; it is frozen into a numbered `sprints/{N}.md` at
> token-budget rollover (`scripts/freeze-sprint.mjs`).

## The goal

The standalone metric was made **honest** in #2879 (via #2360): a standalone
pass is credited only when it is **host-free** (no leaked host imports), not when
a leaky binary is host-satisfied. On the honest metric:

- js-host passes **~34,052** official tests.
- host-free standalone passes **~12,883**.
- The honest **standalone gap is ~20,500 tests** (roughly double the earlier
  ~9,177 figure that counted host-satisfied leaky passes as wins).

Umbrella: **#2860**. The gap decomposes into the carriers (architecture-scale
half) plus the dynamic-object substrate, the proto-glue / CE clusters, and the
de-masked real-failure clusters.

## Top of the sprint — the ordered standalone-gap queue (devs pull these first)

All `priority: high` + `sprint: current` except #2877 (medium). Within the high
tier the **carriers are the biggest lever**, then the substrate/cluster track in
parallel.

### Carrier track (biggest lever — ~2,476 combined)

The carriers share one Wasm-native suspendable **frame substrate** (arch-frame
design; spec lives in #2860 / #2864, `architect_spec: candidate`). Build it once,
then layer the carriers:

1. **Frame substrate** (arch design — #2860/#2864).
2. **#2864** sync generator carrier — 697, horizon xl. First carrier on the
   frame; proves the substrate end-to-end.
3. **#2867** Promise / microtask carrier — 375, horizon l. The microtask
   scheduler the async machinery needs.
4. **#2865** async-generator / for-await carrier — 986, horizon xl.
   `depends_on: [2864, 2867]` (composes the generator frame + microtask
   scheduler).
5. **#2866** Symbol carrier — 418, horizon l. Independent of the frame; parallel
   track.

### Substrate + de-masked cluster track (parallel with carriers)

6. **#2861** built-in static/proto value-read glue — ~882, horizon l. Mechanical,
   start now.
7. **#2863** dynamic-shape `__get_builtin` reflective-read codegen — 365,
   horizon m.
8. **#2878** invalid-Wasm residual (`__str_flatten` + user-body shapes) —
   horizon m. Correctness; follows the #2868 URI-carrier fix.
9. **#2872** TypedArray.prototype.* cluster — 294, horizon m (de-masked from
   #2862).
10. **#2873** language/expressions cluster — 276, horizon m (de-masked).
11. **#2875** String.prototype.* cluster — 159, horizon m (de-masked).
12. **#2876** RegExp cluster — 125, horizon m (de-masked).
13. **#2877** standalone exception message readability — horizon s, medium.
    Triage enabler (lower lever).

## Already done / blocked (not queued)

- **#2868** invalid-Wasm emission (URI/str_flatten carrier) — **done** (via #2350).
- **#2874** getOwnPropertyDescriptor numeric-key coercion — **done** (via #2354).
- **#2879** honest host-free metric — **done** (via #2360); re-based the gap to
  ~20,500.
- **#2856** IR `body-shape-rejected` playground corpus — **done** (31 → 0;
  Sprint 73). The generic reason remains non-strict for wider source coverage.
- **#2862** ToPrimitive over built-in exotics — **blocked** (superseded; the
  de-masked clusters #2872/#2873/#2875/#2876 carry the tractable residual).

## Demoted below the standalone gap (priority: low, kept sprint: current)

These stay claimable as tail-filler but sort under all the standalone-gap work.
Do NOT close them — just lowered priority per the directive:

| Issue | Was | Now | Why demoted |
| ----- | --- | --- | ----------- |
| #2850 | high | low | acorn dogfood regex-validator remnant — non-standalone |
| #2853 | high | low | acorn dogfood self-parse remnant — non-standalone |
| #2855 | high | low | IR-migration tracking epic — non-standalone |
| #2669 | high | low | ES2015 destructuring umbrella — non-standalone conformance |
| #2803 | high | low | callsite param-type inference — non-standalone (platform) |
| #1042 | high | low | async state-machine epic — non-standalone (deferred acceptance owner) |

**In-progress non-standalone work left untouched.** Active claimed tasks
(e.g. #1917, #2106, #2710, #2773, #2838, #2580, #2623, #2660) are not competing
for the next pull, so their priority is unchanged; they finish, and the next
pull lands on the standalone-gap top. (Note: #2029, #2161, #2173, #2175, #2651
are `goal: standalone-mode` — these ARE standalone work and stay as-is.)

## Definition of done (window)

Host-free standalone official_pass climbs from ~12,883 toward the ~34,052 host
figure. Each child issue's test plan = its cluster's standalone-CE/fail tests
flip to host-free pass under full `merge_group` + the standalone high-water floor
(`check-standalone-highwater.mjs`), with zero host-mode regression (all changes
`ctx.standalone`-gated).
