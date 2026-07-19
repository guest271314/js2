---
id: 3474
title: "Host: caught custom-exception instance's .constructor resolves to Array, not its real constructor"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-20
priority: medium
horizon: l
feasibility: hard
task_type: bug
area: codegen
language_feature: error-constructors, exceptions
es_edition: multi
goal: test262-conformance
related: [3429, 3430]
origin: "Found while implementing #3429 (assert.throws expected-constructor name-mangling fix) — isolated repro traced to a separate, deeper bug unrelated to the #3429 fix."
---

# #3474 — caught custom-exception `.constructor` resolves to `Array`, not the real constructor

## Problem

Any user-defined function used as a constructor (`function MyError(msg) {
this.message = msg; }`), when instantiated with `new`, thrown, and caught on
the JS-host side, presents `.constructor` as a function whose `.name` is
`"Array"` — not the real declaring function. This is unrelated to the
`wasmClosureDynamicBridge` argument-identity bug fixed in #3429 (which is
about the *expected*-constructor argument passed *into* a host-delegated
call); this bug is about the *actual thrown value's* constructor identity
once it round-trips through a `try`/`catch` on the host side.

## Isolated repro (zero interaction with #3429's fix — pure try/catch)

```js
function MyError(message) {
  this.message = message;
}
var caught;
try {
  throw new MyError("boom");
} catch (e) {
  caught = e;
}
caught.constructor.name; // === "Array" (WRONG — should be "MyError")
caught.constructor === MyError; // === false (WRONG — should be true)
```

Confirmed via `runTest262File` (host lane): `typeof caught.constructor ===
"function"` (so SOME function is resolved), but it is not `MyError`, and its
`.name` is literally `"Array"`.

## Impact

Potentially high — any test262 test that:
- catches a custom/local error constructor instance and reads
  `.constructor`/`.constructor.name`, or
- uses the extremely common test262 idiom `assert.throws(MyError, fn)` /
  `assert.throws(Test262Error, fn)` (constructor-identity check inside
  `test262/harness/assert.js`'s `assert.throws`),

will still fail even after #3429's expected-constructor-name fix, just with a
different (correct-shaped) message: `"Expected a MyError but got a different
error constructor with the same name"` (when actualName happens to coincide)
or `"Expected a MyError but got a Array"` (the common case, since the actual
resolved name is unconditionally "Array").

This is likely the dominant reason #3429's practical flip count (tests that
go from FAIL to PASS) is much smaller than the raw 544-record count it
originally targeted — most of those records use a custom local error
constructor and will still fail here, just reclassified with the corrected
(non-bridge) constructor name in the message.

## Root cause (hypothesis — not yet investigated in depth)

The exception-catching / host-mirror path for a caught WasmGC struct thrown
from compiled code appears to default `.constructor` resolution to some
generic/Array-shaped mirror when the struct isn't recognized as one of the
specifically-modeled shapes (Error subclasses, plain objects, etc.) — rather
than resolving to the struct's OWN declaring closure (mirroring how a
regular, non-thrown instance's `.constructor` is resolved elsewhere, e.g. via
`_wrapForHost`'s "constructor" key handling or the `_fnctorInstanceCtor`
registry mentioned in `runtime.ts`). Needs investigation into:

- how a `throw`n WasmGC struct crosses into the JS-host `catch` boundary
  (likely `runtime.ts`'s exception-tag / `lastCaughtException` marshaling
  path — search for where a caught wasm exception becomes a JS-visible
  value);
- how `.constructor` is resolved on THAT marshaled value (vs. the
  already-working `_wrapForHost` get-trap or `_fnctorInstanceCtor` path used
  for a directly-`new`'d, not-thrown instance) — the discrepancy suggests the
  exception-catch marshaling path takes a DIFFERENT (and buggy) code path
  than the ordinary property-read path.

`feasibility: hard` because it touches the exception-marshaling boundary,
which #3429's own investigation showed is easy to mis-diagnose without
careful empirical tracing (the architect's original #3429 hypothesis —
receiver-shift — was disproven; expect a similar need for instrumentation-
driven tracing here rather than static reasoning alone).

## Acceptance criteria

- The isolated repro above passes: `caught.constructor === MyError` is
  `true`, `caught.constructor.name === "MyError"`.
- `assert.throws(MyError, () => { throw new MyError(); })` (test262-harness
  style, after #3429 lands) passes end-to-end.
- No regression to `assert.throws(TypeError, ...)` / other native-builtin
  constructor identity checks (already passing).

## Cross-reference

- #3429 (assert.throws expected-constructor name-mangling — the sibling bug
  on the OTHER side of the same `assert.throws` identity check; already
  fixed independently).
- #3430 (integrity-level TypeError-not-thrown triage umbrella) — same
  "oracle v8 newly honest" origin wave, same host-conformance area, may share
  a similar host-mirror-defaulting root cause worth checking together.
