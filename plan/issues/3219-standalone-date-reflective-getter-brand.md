---
id: 3219
title: "standalone: reflective Date.prototype.<getter>.call brand check + host-free native body (getters slice of #3174)"
status: done
completed: 2026-07-13
assignee: ttraenkler/opus-date
created: 2026-07-13
updated: 2026-07-13
priority: high
task_type: bug
area: codegen
es_edition: multi
language_feature: date
goal: standalone
umbrella: 2860
parent: 3174
sprint: 71
horizon: m
related: [2860, 3174, 2875, 2979]
loc-budget-allow:
  - src/codegen/expressions/builtins.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls.ts
---

# #3219 — standalone reflective Date prototype getter: brand check + native body

## Problem

Slice of #3174 (Date brand checks). Under `--target standalone`, a **reflective**
`Date.prototype.<getter>.call(recv)` (value-materialized member closure) does NOT
reach the native Date kernel:

```
const f = Date.prototype.getTime;
f.call(new Date(1000));   // measured: returns 0 (WRONG — should be 1000)
f.call({});               // measured: returns 0 (WRONG — should throw TypeError)
```

Root cause (verify-first, pristine main, process-isolated standalone lane):

1. `tryEmitNativeProtoReflectiveCall` (`src/codegen/expressions/calls.ts`) maps
   `Array`/`Object`/`String`/`DataView` interface names to their native-proto
   glue, but **omits `Date`** — so the reflective Date call is not recognised and
   falls through to the legacy value-erased `.call` lowering, which drops
   `thisArg` and returns `0`.
2. Even with routing, `Date`'s glue member bodies were `emitProtoMemberBodyRefusal`
   (no native reflective body), so `ensureStandaloneNativeMethodClosure` returned
   null → still fell through.

The bulk of the #3174 gap (52 rows: `this-value-non-date.js` /
`this-value-non-object.js` brand tests across `Date/prototype/*`) fail on
**assert #2** — `assert.throws(TypeError, () => getX.call(nonDate))` — because
the reflective call returns 0 instead of throwing.

## Fix (this slice — zero-arg getters only)

1. **Route** `Date` → `ensureDateNativeProtoGlue` in
   `tryEmitNativeProtoReflectiveCall`.
2. **Native reflective body** `emitDateProtoMemberBody` (array-object-proto.ts,
   wired via `makeGlue` for `name === "Date"`), scoped to the **zero-arg
   getters** (`getTime`/`valueOf`/`getTimezoneOffset`/`getFullYear`/`getYear`/
   `getMonth`/`getDate`/`getDay`/`getHours`/`getMinutes`/`getSeconds`/
   `getMilliseconds` + UTC variants):
   - **[[DateValue]]-brand preamble**: recover the receiver via
     `any.convert_extern` + `ref.test $Date`; if not a Date struct → throw
     TypeError (§thisTimeValue step 2). This is the shared preamble #3174 asks
     for, applied to the reflective getter arm.
   - For a genuine Date receiver: read `[[DateValue]]` (field 0), then compute
     the getter and box `f64 → externref` via `__box_number`.
3. **Anti-bloat**: the calendar/time getter arithmetic is EXTRACTED from the
   direct-call kernel (`compileDateMethodCall`) into a shared
   `emitDateZeroArgGetterFromTsLocal(ctx, fctx, methodName, tsLocal)` in
   builtins.ts, called by BOTH the direct path (byte-identical) and the
   reflective body. No duplicated Date kernel.

Setters, `toISOString`/`toString`/`toJSON`/`toLocale*` reflective bodies stay
refusals (return null → fall through to legacy, exactly as today — **no vacuity
introduced**: the setter brand tests still fail on assert #2, unchanged). They
are a documented follow-on under #3174.

All additions are `ctx.standalone`-gated by construction (the reflective-proto
body path only emits in standalone) → zero host-mode impact.

## Acceptance criteria

- Reflective `Date.prototype.<getter>.call(validDate)` returns the correct value
  host-free; `.call(nonDate)` throws TypeError.
- The `Date/prototype/*/this-value-non-date.js` + `this-value-non-object.js`
  brand tests for the getter family flip to host-free standalone passes.
- Zero host-mode regressions; `prove-emit-identity` byte-identical for unrelated
  modules; direct-call Date host-mode path byte-identical.
- Genuine fail→pass only (per-file process-isolated measure vs pristine-main
  control); no vacuous passes.

## Result (measured 2026-07-13, `runTest262File` standalone, branch vs pristine-main)

Full `built-ins/Date/prototype/<getter>/` suite (18 getters, 144 files):

| lane                  |    pass |  fail |
| --------------------- | ------: | ----: |
| pristine-main control |     108 |    36 |
| this branch           | **144** | **0** |

**+36 genuine fail→pass, ZERO pass→fail regressions.** The 36 flips are the
reflective `this-value-non-date.js` + `this-value-non-object.js` brand rows (18
getters × 2) — pre-fix they returned 0 / did not throw (assert #2 failed);
post-fix the reflective call throws TypeError on a non-Date receiver and returns
the correct value host-free on a Date. The 108 already-passing rows (direct-call
`this-value-valid-date.js` / `this-value-invalid-date.js`) are unchanged.

**Non-vacuity**: `tests/issue-3215.test.ts` asserts the reflective happy path
returns the CORRECT component value (getTime=1000, getUTCHours=1, getFullYear=1970,
…) and Invalid Date → NaN, not merely that non-Date throws.

**Byte-identity**: `prove-emit-identity` IDENTICAL across gc/standalone/wasi for
the example corpus + a dedicated Date-getters module (direct-call kernel emission
unchanged by the extraction).

Remaining Date brand rows (setters, `S15.9.5_A6` top-level, toISOString/
Symbol.toPrimitive, coercion-order) stay under #3174 as documented follow-on.
