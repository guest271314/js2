---
id: 3647
title: "Object.prototype.propertyIsEnumerable returns true for a non-enumerable class prototype method, contradicting getOwnPropertyDescriptor().enumerable === false"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: property-reflection
goal: core-semantics
related: [3603, 3646, 2984, 3479]
origin: "cohort tracker for failures exposed by #3603 S1 host de-inflation (PR #3635)"
---

# #3647 — `propertyIsEnumerable` contradicts `getOwnPropertyDescriptor().enumerable`

> ## ⚠ Claim status: the `issue-assignments` record is STALE — this issue is UNCLAIMED and AVAILABLE
>
> The record reads `assignee: ttraenkler/dev-es5-coercion`, `status: in-progress`.
> The work was handed off deliberately; the release tooling could not execute it
> (**#3880** — five failures on 2026-07-31 across `claim`, `--allocate` and
> `--release`). The record was **not** hand-edited: rewriting a shared ref other
> lanes read trades a bookkeeping problem for a corruption risk.
>
> **Take this issue freely.** Diagnosis is complete and nothing is half-implemented
> — see the re-measurement below and the "next step is one fact" note.
>
> ## ⚠ THE DEFECT IS HOST-LANE ONLY — standalone already answers `false` correctly
>
> Read this before writing a fix. A change that "corrects" `propertyIsEnumerable`
> globally would **regress the lane that is already right**. Verified both lanes,
> controls passing:
>
> ```
> host:        pIE=true   <- the defect
> standalone:  pIE=false  <- already correct, do not touch
> ```

> **Cohort tracker.** One of the two failure cohorts EXPOSED (not caused) by
> #3603 S1's host-lane de-inflation. Per the #3468 F1 landing recipe, every
> exposed cohort is routed to a tracker — that is what makes a de-inflation
> honest rather than banked. **This defect predates #3603 S1 and reproduces on
> stock `upstream/main`.**

## Problem

`Object.prototype.propertyIsEnumerable.call(C.prototype, "m")` returns **true**
for a class prototype method, while every other reflective route on the _same
object and key_ correctly reports it as non-enumerable.

Class methods are non-enumerable per ES2015+ (§14.6, MethodDefinition →
`DefineMethod` with `enumerable: false`), so `true` is spec-wrong. More
importantly it is **self-inconsistent**: our own `getOwnPropertyDescriptor`
disagrees with our own `propertyIsEnumerable`.

## Re-measured 2026-07-31 — reproduces; host-lane only; two adjacent findings

**Harness:** `runTest262File`, test262-shaped probe, **both lanes**, with controls
that must hold under any spec version. Controls passed in both lanes
(`({a:1}).propertyIsEnumerable("a") === true`, `…("zz") === false`), which is
what licenses reading the rows below (#3885).

```
host:        ctl_own=true  ctl_bogus=false | pIE=true  | hasOwn=true  | keys_has_m=false
standalone:  ctl_own=true  ctl_bogus=false | pIE=false | hasOwn=false | keys_has_m=false
```

**1. The defect is HOST-LANE ONLY.** Host reports `propertyIsEnumerable → true`
while `Object.keys` on the same object+key correctly omits `m` — the filed
self-inconsistency, confirmed. **Standalone already answers `false` correctly.**
Any fix must not "fix" the lane that is already right.

**2. Standalone has a DIFFERENT defect on the same probe:** `hasOwnProperty`
returns **false** for `C.prototype.m`, which does exist. That is #3875's
finding (*gOPD is correct, hasOwnProperty is broken*), not this issue —
recorded so nobody folds the two together.

**3. NEW — `getOwnPropertyDescriptor(C.prototype,"m")` TRAPS on host.** Not the
`null` that #3646 documents: it raises `RuntimeError: illegal cast in
__module_init()`. Two independent probes crashed on that exact line. This is
strictly worse than a wrong value and probably belongs on #3646 as a severity
correction.

### Dispatch paths located (both gate on `_isWasmStruct`)

- `Object_propertyIsEnumerable` — `src/runtime.ts:12628`
- `__propertyIsEnumerable` — `src/runtime.ts:12759`

Both delegate to `_wasmStructPropertyIsEnumerable` (`src/runtime.ts:5258`) when
the receiver is a wasm struct, else fall through to the host's own
`Object.prototype.propertyIsEnumerable`.

### A latent bug found there, which is NOT this defect

`_wasmStructPropertyIsEnumerable` short-circuits `if (sc && prop in sc) return 1`
— *present in the sidecar ⇒ enumerable*, unconditionally, without consulting the
descriptor. Correct for assignment-created properties (§10.1.6.1 gives those
`enumerable:true`) and wrong for anything whose descriptor disagrees.

**Reordering it to read the descriptor first did NOT change the probe**, so the
receiver here is evidently *not* taking that branch — `C.prototype` is likely not
a wasm struct in host mode, so the native JS fallback answers. The reordering was
reverted rather than shipped: an unvalidated change that fixes nothing measurable
should not land. It is recorded here because it is a real latent inconsistency
worth fixing on its own evidence.

**Next step for the implementer:** determine what `C.prototype` actually is in
the host lane (wasm struct vs plain JS object vs wrapper) and which of the two
dispatch paths the call takes. That single fact decides whether the fix belongs
in `_wasmStructPropertyIsEnumerable`, in the fallback, or upstream in how class
methods are installed on the prototype.

## Measured (stock `upstream/main`, host lane, no test262 harness involved)

```js
var C = class {
  m() {
    return 42;
  }
};
```

| query                                                             | observed |      spec |
| ----------------------------------------------------------------- | -------: | --------: |
| `Object.getOwnPropertyDescriptor(C.prototype,'m').enumerable`     |    false |     false |
| `Object.getOwnPropertyDescriptor(C.prototype,'m').writable`       |     true |      true |
| `Object.getOwnPropertyDescriptor(C.prototype,'m').configurable`   |     true |      true |
| for-in over `C.prototype` — key count                             |        0 |         0 |
| `Object.keys(C.prototype).length`                                 |        0 |         0 |
| **`Object.prototype.propertyIsEnumerable.call(C.prototype,'m')`** | **true** | **false** |

Five routes agree; `propertyIsEnumerable` is the lone dissenter. Verified
**identical with #3603 S1 applied and reverted**, so S1 does not influence it.

All observations use a **numeric** return channel — a string channel is
unreliable across lanes, and `typeof X === "..."` comparisons are unreliable on
host (see #3603's probe notes).

## Why it matters

`propertyHelper.js`'s `isEnumerable` is

```js
return stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name);
```

and `verifyProperty` fails when `desc.enumerable !== isEnumerable(obj, name)`.
So a wrong `propertyIsEnumerable` produces a genuine
`obj['m'] descriptor should not be enumerable` failure for any test that
verifies a class method's descriptor — a large share of the `class/elements`
cohort surfaced by #3603 S1.

It also silently corrupts any user program using `propertyIsEnumerable` for
filtering, independently of test262.

## Acceptance criteria

- `Object.prototype.propertyIsEnumerable.call(C.prototype, 'm')` is `false` for
  a class prototype method.
- `propertyIsEnumerable` agrees with `getOwnPropertyDescriptor().enumerable`,
  `Object.keys`, and `for-in` for the same key — assert the **agreement**, not
  each in isolation, so a future divergence is caught.
- Covered for both the direct call and the uncurried
  `Function.prototype.call.bind(Object.prototype.propertyIsEnumerable)` form
  (the shape `propertyHelper.js` actually uses).
- Assert across **shapes** (simple class, computed-name fields, generator/async
  methods, object literal, plain assignment) — #3642's lesson: an unvaried axis
  is an assumption, not a measurement.

## Reproduction

`.tmp/3603/enum-check.mts` and `.tmp/3603/attribution.mts` in the #3603 S1
worktree; self-contained `compile()` + `buildImports()` probes, no harness.
