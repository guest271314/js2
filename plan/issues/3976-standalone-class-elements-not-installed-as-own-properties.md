---
id: 3976
title: "standalone: class elements are not installed as own properties on the prototype/constructor — invisible to getOwnPropertyDescriptor/hasOwnProperty"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
assignee: ttraenkler/sendev-p3-uncurry
priority: high
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES6
language_feature: class-elements
goal: standalone
horizon: l
parent: 2860
related: [3571, 3603, 2742, 3642]
origin: "measured while REFUTING #3571's P3 uncurryThis seam (sendev-p3-uncurry, 2026-08-01)"
---

# standalone: class elements are not installed as own properties

Under `--target standalone`, a class method/accessor is **callable** but is not
an **own property** of the object it belongs to. `C.prototype` and `C` exist and
are inspectable, but

```js
Object.getOwnPropertyDescriptor(C.prototype, "m")   // -> undefined  (should be a descriptor)
Object.prototype.hasOwnProperty.call(C.prototype, "m")  // -> false  (should be true)
```

Per §15.7.14 (ClassElementEvaluation → `MethodDefinitionEvaluation` →
`DefinePropertyOrThrow`) every non-private class element is installed with
`{writable: true, enumerable: false, configurable: true}`. We install something
that dispatches on call but is not reachable through the ordinary
own-property/descriptor surface.

## Why this issue exists — it is the residual of a REFUTED framing

This was found while measuring **#3571's "P3 uncurryThis/propertyHelper seam"**,
which was scheduled as an XL target on the figure *"1,810 standalone-only
failures route through `harness/propertyHelper.js`"*. That figure is a **routing**
bound. Measured causally, the uncurryThis idiom is worth **1.7 %** of it; this
issue is worth roughly **28×** more. Full refutation in #3571. **Do not re-derive
either result by reading — both were measured with controls.**

## Measured population (full census, not a sample)

Source: `.test262-cache/test262-standalone-current.jsonl` and
`test262-current.jsonl`, same baseline run `20260801-010858`.
**Instrument calibrated first**: standalone official rows **43,106 / 25,460 pass
(59.1 %)** — exact match to the published baseline.

Of the **1,810** files that include `propertyHelper.js`, fail standalone and
pass on host:

| n         | bucket                                                  |
| --------- | ------------------------------------------------------- |
| **1,136** | `Test262Error: obj should have an own property X` (63 %) |
| 217       | receiver nullish / non-reified builtin (12 %)           |
| 114       | standalone host-import leak                             |
| 25        | invalid Wasm (`__bindfn_*` — see #3571, separate)       |

Of those 1,136, **826 (73 %) are `language/{statements,expressions}/class`**.
Class areas are **998 of the whole 1,810 (55 %)**.

`verifyProperty` receiver across the class cluster:

| n   | receiver      | meaning                            |
| --- | ------------- | ---------------------------------- |
| 690 | `C.prototype` | instance methods / accessors       |
| 276 | `c`           | instance fields on an instance     |
| 204 | `C`           | static methods / static fields     |
| 192 | `rest`        | object-rest destructuring (adjacent) |

## Root cause, measured — not inferred

Instrument: `runTest262File(abs, cat, 60000, "standalone")` (**status only** is
trustworthy; its error category and source location are artifacts — see
`reference_runtest262file_not_ci_path_status_only`). A **probe arm** patches the
real `test262/harness/propertyHelper.js` to distinguish *where* the failure
originates. This matters because propertyHelper reaches line 48
`__getOwnPropertyDescriptor(obj, name)` **before** line 64's uncurried
`__hasOwnProperty(obj, name)`, and line 27 captures gOPD **directly**, not via
uncurryThis.

Stratified sample, 40 of the 826, seeded; **6 embedded positive controls green
(6/6)**, so the reading is load-bearing:

| n         | origin                                                     |
| --------- | ---------------------------------------------------------- |
| **40/40** | `obj` EXISTS, property genuinely ABSENT (gOPD → `undefined`) |
| 0         | `obj` already nullish at entry                              |

**Unanimous.** The receiver is fine; the property is not installed.

## Ceiling — and read the caveat before quoting it

A second arm makes `verifyProperty` an immediate `return true`, i.e. simulates
*"class elements are installed perfectly with the expected descriptor"*.

- **40/40 of the class sample pass** ⇒ the own-property gap is the **sole**
  blocker in every sampled file (95 % lower bound ≈ 91 %).
- **Discriminator control**: the same arm on the 40-file receiver-nullish sample
  gives **32/40**, not 40/40 — so this arm is **not** trivially green and the
  40/40 above is informative.

⚠️ **This arm is VACUOUS BY CONSTRUCTION and is an UPPER BOUND only.** It also
skips *descriptor correctness* (`writable`/`enumerable`/`configurable`), so an
implementation that installs the property with the **wrong** attributes will
score below this ceiling. Never quote 40/40 as a flip prediction.

## Acceptance criteria

- `Object.getOwnPropertyDescriptor(C.prototype, "m")` returns a descriptor with
  `{writable: true, enumerable: false, configurable: true}` for a non-private
  instance method; likewise on `C` for a static method.
- `Object.prototype.hasOwnProperty.call(C.prototype, "m")` is `true`;
  `Object.keys(C.prototype)` does **not** include `m` (non-enumerable).
- Private elements (`#m`) remain **absent** from the own-property surface —
  several tests in this cluster assert exactly that
  (`!hasOwnProperty.call(C.prototype, "m")` for the private name).
- **Report measured fail→pass / pass→fail on a standalone run with the sample
  above**, plus the ceiling shortfall (how far below 40/40 the real fix lands and
  why). Do not report the ceiling as the result.
- Sizing discipline: **826 is the population GATED, not a forecast.** Measure the
  attributable ratio on a seeded sample with controls before committing to a size
  — that is exactly the step that refuted #3571.

## Reproduction

```js
class C { m() { return 42; } static s() { return 1; } }
// standalone: both are `undefined`; host: both are descriptors
Object.getOwnPropertyDescriptor(C.prototype, "m");
Object.getOwnPropertyDescriptor(C, "s");
```

## Notes

- The **192 `rest`** files (object-rest destructuring skipping non-enumerable
  properties) are in the same census bucket but are a **different** mechanism —
  they need enumerability to be observable, which this issue supplies, but they
  should be verified separately rather than counted as this issue's yield.
- The 217 receiver-nullish files are a **separate** root cause (builtin objects
  such as `Number`/`Date` not reified as values). Tracked in #3571; do not
  double-attribute.
