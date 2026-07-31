---
id: 3872
title: "Non-writable data-property write does not throw in strict mode (standalone); host also fails to suppress the store"
status: ready
created: 2026-07-31
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: es5
es_edition: 5
sprint: current
horizon: m
related: [3420, 2668, 2744, 3776]
---

# #3872 — the strict-mode TypeError is missing; the two lanes fail differently

## ⚠️ THE TWO LANES FAIL FOR DIFFERENT REASONS — read before implementing

The decisive observable is *does the non-writable write actually land?*

```js
Object.defineProperty(o, "p", {value: 10, writable: false, enumerable: true, configurable: true});
o.p = 20;
return o.p;                     // spec: 10

  host       -> 20   // write LANDED — wrong
  standalone -> 10   // write correctly SUPPRESSED
```

**Standalone already consults `[[Writable]]` enough to suppress the store. What it
never does is emit the strict-mode TypeError.** Host does neither.

So the framing "no assignment path consults `[[Writable]]`" is **wrong for
standalone** — the consult is there, the *throw* is missing.

**Consequence for the fix:** since the standalone ES5 score is the objective, the
work is **emit the strict-mode TypeError on a non-writable data-property write**,
NOT write-suppression. Implementing suppression would add something standalone
already does — a no-op against the target, and a possible regression. This was
caught by probing the intermediate observable *before* writing code.

Host additionally needs the suppression, but that is a **host-lane** defect and
should be scoped separately.

## Measured

Probe, both lanes, plain-object twin controls in the same harness:

| probe | host | standalone |
|---|---|---|
| `gOPD` reads back `writable:false` | PASS | PASS |
| `gOPD` reads back `enumerable` | PASS | PASS |
| `defineProperty` value readable | PASS | PASS |
| **`writable:false` then `o.p = 20` → TypeError** | **FAIL (no throw)** | **FAIL (no throw)** |
| **`writable:false` value preserved** | **FAIL (became 20)** | PASS |
| **`writable:false` then `o.p %= 20` → TypeError** | **FAIL** | **FAIL** |
| `writable:false` computed `o[k] = 20` → TypeError | PASS | **FAIL** |
| CTRL frozen elem/prop write (#3420, fixed) | PASS | PASS |

So `defineProperty` **stores** the attributes ✓ and `getOwnPropertyDescriptor` **reads them back** ✓ in both lanes.
Neither lane emits the strict-mode **TypeError** ✗ — and additionally the **host**
lane fails to suppress the store (see the lane-asymmetry section above; standalone
suppresses correctly).

## Where the bit lives (both places, verified)

1. **Runtime bit-flags in the native descriptor companion table** — `FLAG_WRITABLE = 0x01`
   (`src/codegen/object-runtime.ts:130`); the define/redefine state machine is
   `src/codegen/object-runtime-descriptors.ts`. **The dynamic `__extern_set` path
   already consults it** (`object-runtime.ts:2516`, `2685`) — which is exactly why
   `writable:false` + computed `o[k]=20` throws correctly on host while the dot
   write does not.
2. **A partial compile-time mirror** — `ctx.definedPropertyFlags: Map<string, number>`
   (`context/types.ts:3160`, `PROP_FLAG_WRITABLE = 1<<0` at `object-ops.ts:915`),
   but it is **inline-literal-only** (`object-ops.ts:1133`), and
   `definePropertyReceiverKeys` carries an explicit comment that it **"never feeds
   descriptor-flag logic"** (`object-ops.ts:1134-1137`).

**The real defect is narrower than "IR vs backend": on the STANDALONE lane the
consult already happens (the store is suppressed) and only the throw is missing.
On HOST the static struct-slot path consults neither source, while the dynamic
path consults the runtime flags correctly.**

## Layout decision (agreed, do not re-litigate without measurement)

- The **semantic rule** — a non-writable data property makes `[[Set]]` fail, strict
  throws TypeError — is IR-shaped: no `ValType` content, identical answer under
  WasmGC and linear.
- The **fact it depends on** — is *this* receiver+key writable? — is **runtime state
  in an emitted companion table**, not a static front-end fact.

Therefore: **semantic rule in `src/ir/` for the statically-known subset**
(`definedPropertyFlags`), **backend keeps the runtime enforcement**, documented.
That subset is not a corner case — it is the corpus shape: the compound-assignment
tests are a literal `Object.defineProperty(obj,"prop",{writable:false})` followed by
an assignment in the same function.

Forcing the general case into the IR would mean building a **static mirror of
runtime descriptor state**, which is the failure mode `definePropertyReceiverKeys`'
comment exists to prevent.

## Ceiling — **≤24 standalone rows**, NOT 91 (and NOT a single figure)

Re-classified on **construct-under-test**, not keyword match:

| n | class | owner |
|---:|---|---|
| 28 | descriptor attrs, non-assign (defineProperty fidelity) | #2668 |
| **≤24** | **write-enforcement — 22 `compound-assignment`, 1 `assignment`, 1 `types/reference`** | **this issue** |
| 18 | defineProperty other | — |
| 20 | unresolved | — |
| 1 | call/apply receiver coercion | String/prototype lane |

**`≤24`, not 24** — spot-checking found `compound-assignment/11.13.2-54-s` has **no
`writable:false` in source at all** (it is a frozen/sealed variant), so even the
refined classifier over-includes. Quote a measured range with the method attached,
never a single number.

Spot-check of 4 rows, both lanes — note two **pass host** and all four **fail
standalone**, confirming this is standalone-specific:

| test | `writable:false` in source | host | standalone |
|---|---|---|---|
| `compound-assignment/11.13.2-25-s` | yes | FAIL | FAIL |
| `compound-assignment/11.13.2-54-s` | **no** | PASS | FAIL |
| `assignment/11.13.1-1-s` | yes | FAIL | FAIL |
| `types/reference/8.7.2-3-s` | yes | PASS | FAIL |

### Superseded sizings (kept so nobody re-derives them)

`91` → `~19 confirmed / ~41` → **`≤24`**. Each revision was downward and each came
from checking sources or intermediate observables rather than normalized error
strings.


**Leaking/failing ≠ flipping** — A/B against a real standalone run before quoting a
delta, as #3420 did (9/13 → 13/13).

> **Method note, learned three times over on this issue:** message-normalized
> clusters **over-merge**. Only source inspection splits them. Every sizing on this
> lane that was revised was revised *downward*, and every revision came from
> someone checking the sources rather than the error strings.

## This is an OUTLIER, not a pattern — hypothesis tested and disconfirmed

A "systematic gap" framing was proposed — that wherever a #2744-style
integrity/descriptor **query** shipped, the matching **enforcement** would be
missing. **It was probed and is mostly WRONG.** Recorded here so nobody hunts for
instances that were already checked:

| predicted sibling | result |
|---|---|
| `[[Extensible]]` enforcement (preventExtensions / seal blocking new properties, strict throw) | **4/4 PASS both lanes — REFUTED** |
| `[[Configurable]]` strict-mode `delete` throws | PASS both lanes |
| query side (configurable read-back, `isExtensible`, `isSealed`) | 3/3 PASS both lanes |

The one real sibling found is narrow and **host-lane only**: sloppy-mode `delete`
of a non-configurable/sealed property actually deletes it (standalone correctly
refuses). Not standalone-ES5-relevant, does not compete with this slice.

**So `[[Writable]]`-on-assignment is a genuine outlier — the one integrity bit
whose enforcement never got wired — not the first of a series.** That makes this a
**bounded fix**, scoped and sized as one job.

The accurate narrow statement: *`Object.freeze` and `Object.defineProperty` both
record `[[Writable]]`-class state that the **static** assignment path never
consults, while the **dynamic** path does. `[[Extensible]]` and strict-mode
`[[Configurable]]` enforcement are correctly wired.*

(#3420 — `frozenVars` unconsulted on ElementAccess, both consult sites testing
`ts.isPropertyAccessExpression` — is the one genuine precedent for the shape.)

## Acceptance

- Non-writable data property: sloppy write is a silent no-op, strict write throws
  TypeError, value preserved — in **both** lanes, for dot, computed and compound
  assignment forms.
- A permanent regression test (`tests/issue-3869.test.ts`), with standalone cases
  asserting `imports.length === 0`.
- A/B against stock main quoted with all three denominators.
- `Object.seal` / `Object.isFrozen` / `gOPD` behaviour not regressed.
