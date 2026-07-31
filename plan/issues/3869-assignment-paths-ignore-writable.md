---
id: 3869
title: "Assignment paths do not consult per-property [[Writable]] — non-writable data property writes silently succeed instead of throwing TypeError"
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

# #3869 — `[[Writable]]` is recorded and readable, and no assignment path consults it

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

So `defineProperty` **stores** the attributes ✓, `getOwnPropertyDescriptor` **reads them back** ✓ — and **no assignment path consults `[[Writable]]`** ✗.

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

**The real defect is narrower than "IR vs backend": the static struct-slot
assignment path consults neither source, while the dynamic path consults the
runtime flags correctly.**

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

## Ceiling (NOT a projection)

33 `language/expressions/compound-assignment` + 9 `language/expressions/assignment`
+ an unmeasured share of 230 `Object/defineProperty` / `Object/create` /
`Object/defineProperties` rows, within the standalone ES5 gap (1,015 of 8,087).
**Leaking/failing ≠ flipping** — A/B against a real standalone run before quoting a
delta, as #3420 did (9/13 → 13/13).

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
