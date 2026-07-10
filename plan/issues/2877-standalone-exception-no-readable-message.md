---
id: 2877
title: "Standalone exceptions expose no JS-readable message (__sget_message returns null) — blocks message-level triage"
status: done
created: 2026-06-30
updated: 2026-07-03
completed: 2026-07-02
assignee: ttraenkler/dev-2912f
resolved_by: 2962
priority: medium
task_type: enhancement
area: tooling
goal: standalone
sprint: 69
horizon: s
related: [2870, 2862, 2860, 2962]
umbrella: 2860
---

# Standalone exceptions expose no JS-readable message

## Problem

A `--target standalone` module throws a Wasm-GC error struct as the exception
payload. From the JS test harness the payload is opaque: `String(payload)` throws
(fixed in #2870 by guarding it), and the obvious accessor
`instance.exports.__sget_message(payload)` returns **null** for the thrown
payloads sampled in #2870's de-mask. So the harness cannot recover the REAL
per-test failure message — the #2870 de-mask falls back to a stable label
(`uncaught Wasm-GC exception (non-stringifiable payload)`).

### Why it matters

Without a readable message, standalone-gap triage can only cluster by **test
path/feature**, not by the actual error (`x is not a function`, a specific
TypeError text, a trap reason). A readable message would let triage group the
~2,014 de-masked failures (#2870) by real signature and pinpoint shared root
causes far faster.

## Investigation / fix sketch

1. Determine what the standalone throw payload actually is for these cases
   (a `__new_TypeError` struct with a null message field? a non-error value? the
   null/undefined access sentinel?). `__sget_message` returning null suggests
   either the message field is unset at throw time or the payload is not the
   error struct `__sget_message` expects.
2. Either (a) ensure native error constructors populate a readable `message`
   field reachable via an exported accessor, or (b) export a dedicated
   `__exn_message(payload) -> externref(nativeString)` helper the harness can
   call (returning the flattened message or a class label), and wire
   `extractWasmExceptionMessage` (both `tests/test262-runner.ts` and
   `scripts/test262-worker.mjs`) to prefer it over the #2870 stable fallback.

## Acceptance

The harness records the real error message (or a precise class label) for a
standalone-thrown exception instead of the generic #2870 fallback, with zero
pass/fail movement (tooling-only). Enables message-level re-triage of #2862's
de-masked clusters.

## Resolution (2026-07-02, dev-2912f) — satisfied by #2962

**Closed as done-via-#2962** (PR #2481, merged 2026-07-02): the "native
error-object identity + payload stringification" work landed a strict
superset of this issue's fix sketch while a parallel #2877 implementation was
in flight in this session. #2962's mechanism:

- in-module `__error_to_string` (§20.5.3.4) + Error arms in
  `__any_to_string`, so `String(e)` / `` `${e}` `` render `"Name: message"`
  natively;
- harness render exports `__exn_render_prepare(externref) -> i32` /
  `__exn_render_char(i32) -> i32` (finalize, gated
  `noJsHost && nativeStrings && exnTagIdx >= 0`) — the payload runs through
  the module's OWN `__any_to_string` chain, superior to a dedicated
  message-field accessor because it spec-formats any payload kind;
- `extractWasmExceptionMessage` wired in BOTH mandated sites
  (`tests/test262-runner.ts` + `scripts/test262-worker.mjs`).

**Acceptance verified against main `46e390c` (probe, this session):**
`throw new TypeError("boom")` → `"TypeError: boom"`; rope message
(`"hello " + x + "!"`) → `"RangeError: hello world!"`; `new Error()` →
`"Error"` (spec name-only); `throw "bare string payload"` → decoded raw;
Test262Error → `"Test262Error: Expected a to equal b"`. Known residual
(documented in #2962): a thrown boxed number renders `"[object Object]"`
(construction-time ToString residual class) — still a stable, non-crashing
label.

This session's parallel implementation (dedicated `__exn_msg_*`/`__exn_name_*`
per-char accessors + `$Error_struct` root-cause analysis: the struct is
registered directly in `mod.types`, invisible to `emitStructFieldGetters`,
which is WHY `__sget_message` never covered it) was verified working (7/7
tests) but **discarded unlanded** — two parallel export families would
duplicate binary surface and harness decode paths for zero additional triage
value. The harness-level acceptance test for THIS issue's criteria rides the
closeout PR as `tests/issue-2877.test.ts`, pinned to the #2962 mechanism.
