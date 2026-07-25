---
id: 3486
title: "Host: caught custom-exception instance's .constructor resolves to Array, not its real constructor"
status: ready
sprint: current
created: 2026-07-20
updated: 2026-07-25
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
language_feature: error-constructors, exceptions
es_edition: multi
goal: test262-conformance
related: [3429, 3430, 3628, 3614]
origin: "Found while implementing #3429 (assert.throws expected-constructor name-mangling fix) — isolated repro traced to a separate, deeper bug unrelated to the #3429 fix."
---

# #3486 — caught custom-exception `.constructor` resolves to `Array`, not the real constructor

## Problem

Any user-defined function used as a constructor (`function MyError(msg) {
this.message = msg; }`), when instantiated with `new`, thrown, and caught on
the JS-host side, presents `.constructor` as a function whose `.name` is
`"Array"` — not the real declaring function. This is unrelated to the
`wasmClosureDynamicBridge` argument-identity bug fixed in #3429 (which is
about the _expected_-constructor argument passed _into_ a host-delegated
call); this bug is about the _actual thrown value's_ constructor identity
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

## ES3 edition impact — measured 2026-07-25 (priority raised medium → high)

**This single defect is 95 % of the remaining ≤ES3 gap.** It contributes to
**#3628 (close the ≤ES3 edition)**, which is the edition closest to complete.

Host (`gc`) lane, fresh baseline, classified with the exact `classifyEdition`
rules from `scripts/generate-editions.ts` (reproduces the published editions
figure exactly — 273 scored / 43 failing, so the attribution is validated):

| ≤ES3                          |        count |
| ----------------------------- | -----------: |
| scored                        |          273 |
| passing                       | 230 (84.2 %) |
| failing                       |           43 |
| compile errors                |        **0** |
| **failing due to THIS issue** |       **41** |

The 41 are 33 × `language/expressions/compound-assignment/S11.13.2_A7.*` and
8 × prefix/postfix `++`/`--` (`S11.4.4_A6`, `S11.4.5_A6`, `S11.3.1_A6`,
`S11.3.2_A6`). All fail with the identical message:

```
Expected a DummyError but got a Array
```

Representative source — a left-to-right evaluation-order test whose property key
throws a user-defined error:

```js
function DummyError() {}
assert.throws(DummyError, function () {
  var base = null;
  var prop = function () {
    throw new DummyError();
  };
  base[prop()] *= expr();
});
```

**The correct exception is thrown; the harness cannot identify it.** So the
evaluation-order semantics these tests actually target are very likely already
correct, and are being masked. Expect the fix to flip all 41 at once — but
**measure rather than assume**, since a cluster sharing one root cause is a
population, not a forecast (proven repeatedly on 2026-07-25).

### Cross-lane note — a fix for the sibling defect already landed

**#3614** is the standalone-lane twin: `Test262Error`'s `.constructor` read
`undefined` there, for the same structural reason, and the harness's
`thrown.constructor !== expectedErrorConstructor` check therefore rejected
correct throws (up to 854 tests; fixed 2026-07-25, PR #3607).

Its remedy is worth reading before starting here: answer `.constructor` with the
same `__fn_closure_<Name>` global the bare identifier resolves to, so `===`
holds by `ref.eq` — and **only read** that global, never materialise it, which
avoids minting a `ref.func` trampoline at finalize (the late-funcidx-shift
hazard). Whether the host lane can use the same mechanism is the first question
to answer.

**#3617** tracks the standalone residual (non-`Test262Error` fnctor instances)
and is described there as the counterpart of this issue — the two are the same
defect on opposite lanes and should be kept in sync.

### Scope beyond ES3

Any test using a **custom error constructor** with `assert.throws` hits this,
so the true blast radius is larger than the ES3 number. Quantify it across all
editions when fixing, and report the ES3 subset separately so #3628 can be
closed against a measured figure.
