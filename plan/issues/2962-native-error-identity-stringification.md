---
id: 2962
title: "Native error-object identity + payload stringification: retire `__get_caught_exception` (1,427 opaque standalone fails)"
status: done
assignee: ttraenkler/fable-2
sprint: 69
created: 2026-07-02
updated: 2026-07-16
completed: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen, runtime
language_feature: errors
goal: standalone-mode
related: [1473, 2860, 2864, 2958]
origin: "2026-07-02 July Fable audit §3 cluster 2 (direct win + triage force-multiplier; successor to #1473)"
---

# #2962 — natively-thrown errors are opaque, losing tests and masking every other bug

## Problem

**1,427 standalone executed failures** report only "uncaught Wasm-GC
exception (non-stringifiable payload)" (built-ins/Object 400,
language/expressions 234, String 167, …): natively-thrown error objects
(GC structs) have no host-independent stringification or identity, so the
harness cannot render name/message and assertion mismatches all collapse
into one opaque bucket. `__get_caught_exception` is also the **single most
leaked host import (5,810 binaries)** — catch paths still round-trip
through the host to read the payload. This cluster is both a direct test
win and the triage force-multiplier: until it lands, the real root causes
of the largest fail directory are invisible.

## Approach

1. **Canonical native error shape**: ensure every natively-thrown error is
   (or is wrapped into) a `$Object`-backed Error with `name`/`message` own
   properties (the object runtime + boxed-primitive internal slots already
   support this — reuse, don't mint a parallel `$Error` struct unless the
   audit of throw sites shows it's already universal).
2. **Native stringification**: a `__error_to_string` helper (native string
   concat of `name + ": " + message`, with the typeof-classifier fallback
   for non-Error payloads) used by (a) the uncaught-exception path in
   `_start` (print via fd_write + nonzero exit), (b) `String(err)` /
   template interpolation of caught values, (c) #2958's rejection report.
3. **Retire `__get_caught_exception`**: catch-site payload reads resolve
   the payload from the exception's GC value directly (the tag carries the
   ref); route the residual host-mode fast path through the allowlist with
   this issue as the retiring id.
4. Re-run the standalone lane and re-bucket the 1,427 — the follow-up
   issues this exposes are a deliverable of this issue (file per class).

## Measurements (2026-07-02, current main `affc55523`, fable-2)

Smoke-tested every premise before implementing (`.tmp/probe-2962-*.mjs`):

- **Standalone `throw new TypeError("boom")`**: zero imports; payload is an
  opaque GC struct; host `String(payload)` throws → harness records the
  opaque label. Premise CONFIRMED.
- **In-module reads already work natively**: `e.message`→"boom" ✓,
  `e.name`→"TypeError" ✓, `e instanceof TypeError` ✓ — the `$Error_struct`
  shape (error-types.ts: tag/message/name/stack/userClassId/props) IS the
  canonical native error object. No new struct needed (approach step 1 is
  already satisfied on main).
- **`String(e)` / `` `${e}` `` / `e.toString()` are the gap**: all three
  return `"[object Object]"` (the `__any_to_string` tag-6/residual
  fallback) instead of `"TypeError: boom"`. Host lane (default gc target)
  is already correct (`String(e)` → 1) — standalone-only gap.
- **Opaque bucket (standalone baseline jsonl)**: 5,898 entries now
  (2,476 of them Temporal = skip-family; ~3,422 actionable). Grown since
  the audit's 1,427.
- **`__get_caught_exception` leak: 8,825 binaries — 100% co-occur with
  async/generator host imports** (`Promise_*`, `__gen_*`, …; sampled files
  are async-generator / async-method / dynamic-import constructs).
  Standalone try/catch is already gated (#1473); generator imports are
  gated (`addGeneratorImports` early-returns for standalone/wasi). The
  ONLY remaining emitter is the async host fallback
  (`wrapAsyncCallInTryCatch` and friends), which standalone deliberately
  keeps until PATH B (#2895) makes native async results observable
  (`isStandalonePromiseActive` is wasi-only by measurement — see the
  #2895 reconcile note in async-scheduler.ts). **Criterion 2 (leak→~0) is
  therefore structurally coupled to #2895 and NOT deliverable from this
  issue without re-regressing the measured −32 async harness tests.**
  Scoped here to: confirmed zero non-async leak sites (measured), and the
  retirement rides PATH B.

## Implementation Plan (this PR)

1. **`__error_to_string(anyref) -> ref $AnyString`** (§20.5.3.4, native,
   standalone/wasi only): emitted inside `ensureAnyToStringHelper`
   (native-strings.ts) BEFORE `__any_to_string` bakes. name from
   `$Error_struct.name` (fallback literal "Error"), message: null/
   non-string/empty → name alone; else `__str_concat(name, ": ", msg)`.
   Non-string `message` (e.g. `new Error(42)`) renders name-only for now —
   construction-time ToString per §20.5.1.1 is a documented residual.
   `getOrRegisterErrorStructType` moves to `registry/types.ts` (re-exported
   from error-types.ts) so native-strings.ts can import it without an
   import cycle.
2. **Error arms in `__any_to_string`** at its three "[object Object]" ref
   fallbacks (residual arm, tag-5 boxed-extern recovery, tag-6 refval):
   `ref.test $Error_struct` → `__error_to_string`. Fixes `String(e)`,
   `` `${e}` ``, `e + ""` for all standalone string coercions (they all
   funnel through `__any_to_string`). Host lanes byte-inert: the arm is
   only built when the error struct type is registered (noJsHost).
3. **Harness-readable render exports** (finalize, gated
   `noJsHost && nativeStrings && exnTagIdx >= 0`):
   `__exn_render_prepare(externref) -> i32` (runs the payload through
   `__any_to_string` + `__str_flatten`, stashes the flat string in a
   module global, returns its length; -1 for null) and
   `__exn_render_char(i32) -> i32` (code-unit readback). Same pattern as
   the existing `__sget_*`/`__vec_*` harness-support exports.
4. **Harness**: `extractWasmExceptionMessage` (tests/test262-runner.ts +
   scripts/test262-worker.mjs) tries the native render for object-typed
   payloads before falling back to the #2870 opaque label. De-opaques the
   ~3.4k actionable bucket into real `Name: message` signatures.
5. **Follow-ups filed from this issue**: wasi `_start` catch_all +
   fd_write uncaught printer (needs the linear-memory iovec plumbing —
   separable); construction-time ToString of non-string messages;
   re-bucketing of the newly-visible signatures after the next baseline
   refresh.

## Acceptance criteria

- A standalone binary throwing `new TypeError("x")` uncaught prints
  `TypeError: x` and exits nonzero — no `env::` imports.
- `__get_caught_exception` leak count drops to ~0 in the per-test imports
  data; allowlist entry annotated or removed.
- The opaque-payload fail bucket shrinks measurably (record before/after);
  newly-visible failure classes filed.

## Test Results (fable-2, 2026-07-02)

- `tests/issue-2962.test.ts`: 12/12 pass — in-module `String(e)` /
  `` `${e}` `` / `e.toString()` / `"x" + e` all render "Name: message"
  (standalone, zero imports); §20.5.3.4 empty-message → name-alone;
  subclass renders "Error: m"; render-export readback of uncaught
  `TypeError("x")` → `"TypeError: x"`; JS-host lane control unchanged and
  exports NOT emitted there.
- Adjacent suites green: issue-2870 (formatter contract, 4/4), issue-2072,
  issue-1536/1536c, issue-2102, issue-2188 (+multilevel), issue-2891,
  issue-1910-s2 — 64 tests. issue-1888 has 1 pre-existing failure
  (identical on pristine main `affc55523`); tdz-reference-error has 6
  pre-existing failures (identical on pristine main).
- **Honest-yield sample** (stratified by construct dir, 30 opaque fails +
  30 passing controls, real runner in the standalone lane):
  **29/30 opaque fails now render actionable signatures** (real
  `TypeError:`/`ReferenceError:`/`Test262Error:` messages — e.g.
  "ReferenceError: ctors is not defined", full assert texts); 1 residual
  (generator try-finally payload); **0 behavioral control regressions**
  (1 flagged entry was an in-process-runner Temporal scope-skip
  classification difference, not a status flip).
- Rendering changes fail SIGNATURES, not statuses — the win is triage
  de-masking + in-module String(err) semantics (which can flip tests that
  assert on error strings; none in the sample did).

## Outcome / notes (why, not just what)

- Approach step 1 was ALREADY satisfied on main (`$Error_struct` carries
  name/message and property reads work) — measured before building; the
  real gaps were the three `__any_to_string` "[object Object]" fallbacks
  and the host's inability to read any GC payload.
- Criterion 1 is satisfied through the Node harness (the measured 5.9k
  bucket); the real-WASI-runtime printer is #2968 (needs fd_write iovec
  plumbing, separable).
- Criterion 2 (`__get_caught_exception` → ~0) is structurally coupled to
  PATH B #2895 (100% of leaks co-occur with async/generator imports —
  measured, see Measurements); retiring it here would re-regress the −32
  async harness tests that forced `isStandalonePromiseActive` back to
  wasi-only. Non-async leak sites are already zero.
- In passing: fixed the same #2870 unguarded-`String(err)` hazard one
  level up in `extractWasmCallStack`/`extractWasmFuncName` (both runner
  and worker copies) — my sample run crashed on it mid-loop, which is
  exactly what it would do to a production shard on such a payload.
- Follow-ups filed: #2968 (wasi `_start` printer), #2969 (construction-time
  `ToString(message)` §20.5.1.1 + numeric payload rendering).

## 2026-07-16 harvest-errors residual note (post-completion)

The `/harvest-errors` pass against the 2026-07-16 standalone baseline
(`baseline_sha 6f89a7e8`) still finds **113 official-scope failing records**
rendering as `uncaught Wasm-GC exception (non-stringifiable payload)` —
i.e. the opaque-payload mask persists at scale after this issue, #2968 and
#2969 all landed. The cluster is concentrated in destructuring **error-path**
tests (abrupt-completion steps inside dstr):

- `language/expressions/class/dstr` 20, `language/statements/class/dstr` 20,
  `language/expressions/object/dstr` 13, `language/expressions/async-generator/dstr` 8,
  `language/statements/for-of/dstr` 6, `language/statements/for/dstr` 6,
  generators/function dstr dirs the rest (all `*/dstr`).
- Samples: `test/language/expressions/class/dstr/async-gen-meth-ary-ptrn-elision-step-err.js`,
  `test/language/statements/for-of/dstr/let-ary-ptrn-rest-id-iter-step-err.js`.

This matches the "1 residual (generator try-finally payload)" class named in
the outcome above, but at 113 records it is a whole class, not a single test.
The underlying conformance failures are tracked by the destructuring
error-path issues (#2669 umbrella, #2040, #3245 "error-path mirage"); this
note flags only the persisting **observability mask** — whoever picks up
those slices will be triaging opaque signatures until the generator/dstr
abrupt-completion payload is made stringifiable. If a dedicated fix is
scoped, it should extend this issue's `__error_to_string` coverage to the
generator try/finally throw path.
