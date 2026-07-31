---
id: 3875
title: "Standalone: built-in prototypes have no reflectable own-property surface (Array.prototype is the exception)"
status: ready
created: 2026-07-31
priority: high
feasibility: medium
task_type: bugfix
area: codegen-standalone
goal: standalone-mode
es_edition: 5
sprint: current
horizon: m
related: [3254, 2908, 1781]
---

# #3875 — in standalone, built-in prototypes are functionally present but not modeled as objects with own properties

## How it was found (the control property is the whole story)

Investigating nine `RegExp/prototype/{global,ignoreCase,multiline}` × `{A8,A9,A10}`
rows — all host-pass / standalone-fail, all flipping together with one identical
symptom, which by the shared-cause discriminator means **one** cause.

The nine all assert `RegExp.prototype.hasOwnProperty('<accessor>')`. A control was
added: **`RegExp.prototype.hasOwnProperty('exec')`** — an own method of
`RegExp.prototype` under every spec version, which should be `true` regardless of
how the accessor question resolves.

**The control came back `false` in standalone.** So the defect was never about the
three accessors.

## Measured (inlined probe, both lanes, same file)

| `X.prototype.hasOwnProperty(m)` | host | standalone |
|---|---|---|
| `RegExp.prototype` `exec` / `global` | true | **false** |
| `String.prototype` `trim` / `charAt` | true | **false** |
| `Object.prototype` `toString` | true | **false** |
| `Number.prototype` `toFixed` | true | **false** |
| `Boolean.prototype` `valueOf` | true | **false** |
| **`Array.prototype` `push`** | true | **TRUE** |
| CONTROL `({a:1}).hasOwnProperty('a')` | true | true |
| CONTROL `({a:1}).hasOwnProperty('zz')` | false | false |
| functional `" x ".trim()`, `/a/.exec("a")`, `[1].push(2)` | work | **all work** |

Both controls are correct, so **`hasOwnProperty` itself is fine**. Every method
works **functionally**. `getOwnPropertyDescriptor` returns `undefined` where host
returns a real descriptor.

**Standalone's built-in prototypes are functionally present but carry no
own-property surface to reflect over.**

## The actionable part

**`Array.prototype` IS reflectable.** So this is not "standalone cannot do this" —
one built-in prototype already registers its own properties and the others do not.
**Find how `Array.prototype` does it and generalize that**, rather than inventing a
mechanism. That likely makes this far cheaper than the symptom count suggests.

## Sizing — deliberately UNMEASURED

Plausibly touches part of the **204 `RegExp/prototype`** gap rows, part of the
**97 `String/prototype`** rows, and part of the **410 `built-ins/Object`** rows —
the single largest area in the ES5 standalone gap.

**"Shares a mechanism" is not "flips on fixing it."** Two sizings on this lane were
already wrong at exactly that step. Needs per-row twin-control treatment before
anyone quotes a delta.

## Contamination warning for adjacent work

Any row currently attributed to **descriptor-fidelity** (#2668) whose target is a
property **of a built-in prototype** is failing for *this* reason, not a descriptor
reason — a descriptor fix will not move it. Re-check that split before sizing
either.

Likewise this may partly dissolve the assigned-method / `trim` receiver-coercion
work (#3254 family): those are receiver-coercion, this is object-model, but they
overlap in which rows they touch.

## Side finding — needs its own row

A probe using a helper function with a **polymorphic object parameter** hit an
unrelated standalone compile error:

```
Invalid types for ref.cast null: extern.convert_any … has to be in the same
reference type hierarchy
```

Structural, unrelated to reflection, not yet filed.

## Acceptance

- `X.prototype.hasOwnProperty(m)` and `Object.getOwnPropertyDescriptor(X.prototype, m)`
  agree between lanes for `RegExp`, `String`, `Object`, `Number`, `Boolean` — as they
  already do for `Array`.
- Functional behaviour unchanged (methods already work; do not regress them).
- Twin-control per-row measurement of what actually flips, with all three
  denominators.
