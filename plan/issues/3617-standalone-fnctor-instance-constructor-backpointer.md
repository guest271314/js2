---
id: 3617
title: "Standalone: a plain fnctor instance's .constructor reads undefined (standalone counterpart of #3486)"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: medium
horizon: l
feasibility: hard
task_type: bug
area: codegen
language_feature: error-constructors, exceptions
es_edition: multi
goal: standalone-mode
related: [3486, 3614, 2660, 2026, 3592]
origin: "Residual of #3614: the 70 non-Test262Error members of the 924-test `assert.throws` cluster in the post-#3592 standalone de-vacuification."
---

# #3617 — standalone fnctor instance `.constructor` reads `undefined`

## Problem

#3614 fixed `.constructor` for values built by `new Test262Error(...)`, which
the compiler lowers to an `$Error_struct` (#2902) — a special, name-keyed path.
**A user constructor with any other name is not lowered that way**: `function
MyError(msg) { this.message = msg; }` + `new MyError()` produces an ordinary
fnctor instance, and reading `.constructor` on it still yields `undefined`.

Measured on the post-#3592 standalone merged report, within the 924-test
`Expected a undefined but got a different error constructor with the same name`
cluster:

| Count | Expected constructor         | Covered by #3614 |
| ----: | ---------------------------- | ---------------- |
|   854 | `Test262Error`               | yes              |
|    33 | `DummyError` + `TypeError`   | **no**           |
|    14 | `DummyError`                 | **no**           |
|     9 | `ExpectedError`              | **no**           |
|     5 | `MyError`                    | **no**           |
|     5 | `Test262Error` + `TypeError` | partially        |
|     3 | `CustomError`                | **no**           |
|     1 | `StopReverse`                | **no**           |

So **~70 tests** remain. The mechanism is identical to #3614's: upstream
`harness/assert.js` runs `thrown.constructor !== expectedErrorConstructor` on
every caught value, so a missing back-pointer rejects a throw that was exactly
correct.

Verified repro (standalone, `nativeStrings: true`, probe
`.tmp/probes/ctor-identity.js` run through the CI-equivalent pool path):

| Probe                               | result  |
| ----------------------------------- | ------- |
| `thrown.constructor === undefined`  | `true`  |
| `thrown.constructor === DummyError` | `false` |
| `DummyError === DummyError`         | `true`  |
| `DummyError.name === 'DummyError'`  | `false` |

Note the identity substrate is already sound — the closure singleton is stable
across textual occurrences and through function parameters. Only the
instance→constructor back-pointer is absent.

## Relationship to #3486

#3486 is the **JS-host** version of this defect (there, `.constructor` resolves
to `Array` rather than to `undefined`). This issue is its **standalone**
counterpart. They are likely to want a shared design — an instance→constructor
link established at `new F()` — but the two lanes have different substrates
(host: `_fnctorInstanceCtor` WeakMap in `runtime.ts`; standalone: WasmGC struct
fields), so they are tracked separately.

## Candidate approach (not a spec — needs design)

`#2660 S2/S3` already establishes a per-fnctor prototype `$Object`
(`src/codegen/expressions/fnctor-prototype.ts`) and seeds an instance's
`$proto` from it at `new F()` — a single link location and a single walk. If
the fnctor prototype object carried a `constructor` slot pointing at the
`__fn_closure_<Name>` singleton, an inherited read would resolve naturally
without a parallel mechanism.

Two known obstacles:

1. `resolveUserFnctorName` is gated on `ctx.fnctorEscapeGate.approvedNames` —
   only constructors with a `reconstruct`-classified `new F()` site
   participate. The file records that an UNSCOPED interception previously cost
   the standalone floor −40 (species `Ctor.prototype` identity in
   `Array/prototype/*/create-proxy`, and `Test262Error.prototype.toString`).
   The marker-error constructors in this cluster are `keep-typed`, i.e.
   currently outside the gate — widening it is the risky part.
2. A `constructor` slot must not become an enumerable own property, or
   `Object.keys` / `for-in` / `JSON.stringify` on such instances change.

## Acceptance criteria

- [ ] For a user `function MyError(m) { this.message = m; }`, standalone
      `(new MyError()).constructor === MyError` is `true` when compared through
      a function parameter (the `assert.throws` shape).
- [ ] Genuine, not vacuous: the same comparison against a DIFFERENT compiled
      constructor is `false`, and `.constructor` is not `undefined`.
- [ ] `Object.keys(new MyError())` is unchanged (no new enumerable own prop).
- [ ] No standalone floor regression; the #2660 `keep-typed` / species
      `Ctor.prototype` identity cases named above stay green.
- [ ] JS-host lane untouched (that is #3486).

## Reproduction

`runTest262File` is **not** the CI path and mangles standalone thrown payloads —
see #3614's Reproduction section for the `CompilerPool("unified")` harness and
the two esbuild bundle prerequisites.
