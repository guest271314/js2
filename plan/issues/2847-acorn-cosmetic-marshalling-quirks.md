---
id: 2847
title: "compiled-acorn cosmetic marshalling quirks — spurious `sourceFile: null` on every node + booleans as i32 0/1"
status: ready
sprint: current
priority: low
horizon: m
feasibility: medium
updated: 2026-07-03
created: 2026-06-29
task_type: bugfix
area: runtime
language_feature: host-marshalling
goal: acorn-dogfood
related: [1712]
umbrella: 1712
---

# #2847 — compiled-acorn cosmetic marshalling quirks (sourceFile + i32 booleans)

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella). These are **cosmetic** —
they do NOT corrupt tree structure or drop identifiers — but they make every
compiled-acorn AST differ from node-acorn on nearly every node, which is why the
corpus harness classifies them as a dedicated `QUIRK` bucket so the REAL gaps
stay legible. Tracking them in one low-priority issue.

## Quirk A — spurious `sourceFile` extra field

Compiled-acorn marshals a `sourceFile` field (value `null`) onto **every** node;
node-acorn (parsed with no `sourceFile` option) does not emit the field at all.

```
extra-field   $.body[*]...sourceFile   expected (absent)   actual null
```

Seen on essentially every node of every input (45–85 occurrences per corpus
file). Fix: omit `sourceFile` from the marshalled node when unset, matching
node-acorn (it only appears when `options.sourceFile` is set).

## Quirk B — booleans marshalled as i32 0/1

Boolean AST fields (`computed`, `optional`, `static`, `generator`, `async`,
`prefix`, `delegate`, `tail`, `method`, `shorthand`, …) marshal across the host
boundary as the **number** `0`/`1` instead of a JS `false`/`true`.

```
primitive-mismatch  $...computed   expected false   actual 0
primitive-mismatch  $...optional   expected false   actual 0
```

Seen 2–31 times per corpus file. Fix: coerce i32-backed boolean node fields to
real JS booleans during host marshalling (a field-name allowlist, or a typed
`bool` marker in the export signatures).

## Why low priority

Neither quirk changes the SHAPE of the tree or the identity/value of any
identifier or literal — a consumer that reads `node.computed` still gets a
truthy/falsy value, and `sourceFile: null` is ignorable. They are tracked
because they block a _byte-exact_ differential pass and clutter the diff, not
because they break parsing.

## Acceptance

- Marshalled boolean node fields are JS booleans; `sourceFile` is absent when
  unset.
- `tests/dogfood/acorn-corpus.mjs` reports `quirkCounts` ≈ 0 across the corpus.
- No test262 regression.

## Investigation (2026-07-03, dev-team-a) — sizing correction + root causes

Measured against current `upstream/main` (e29c8c5b2) with the corpus harness
(`ACORN_CORPUS_NO_ACORN_SELF=1 npx tsx tests/dogfood/acorn-corpus.mjs --json`).
**Correction: this is NOT a host-marshalling fix, and NOT horizon-`s`.** The
original "fix in host marshalling — a field-name allowlist or typed `bool`
marker in the export signatures" framing is wrong for both quirks; the marshaller
already does the right thing when it has the information, and it fundamentally
cannot for the rest.

### Current state (verified)

| quirk               | count | notes                                    |
| ------------------- | ----- | ---------------------------------------- |
| `quirk-sourceFile`  | 2298  | dominant                                 |
| `quirk-bool-as-i32` | 467   | fields: `async await computed delegate generator optional` |

Corpus is `equal-modulo-quirks` on 21/22 inputs, **0 real divergences** — so any
fix must drive quirks down without introducing real divergences.

### Quirk B (bool-as-i32) is a CODEGEN brand-preservation gap, NOT a marshalling gap

The `__box_boolean` path (#1788) already boxes a **boolean-branded** i32 struct
field (`{kind:"i32", boolean:true}`) as a JS boolean on the host read — verified
directly: both a TS-typed `boolean` field AND a simple untyped-JS
(`skipSemanticDiagnostics`) `this.computed = false` / `this.optional = false`
constructor marshal back as real JS booleans (`typeof === "boolean"`). So the
runtime marshalling layer is NOT where this bites.

The 6 acorn fields degrade because their boolean **brand is lost during
struct-field-type computation** across acorn's many untyped assignment sites —
these fields are assigned via boolean-returning method calls
(`node.generator = this.eat(types.star)`, `node.delegate = this.eat(...)`,
`node.await = …`) whose return type is inferred as plain `f64`/`i32`-number, not
boolean-branded, in the untyped `.mjs`. When a field is assigned by a mix of
boolean literals and unbranded method-call results, the merged field type drops
`boolean:true`, and the getter emits raw-i32/`__box_number` instead of
`__box_boolean` (getter emission at `src/codegen/index.ts:_emitStructFieldGettersInner`
— the `hasBool` fork keys off `(fieldType as {boolean?:true}).boolean`).

- **Real fix location**: `src/codegen` struct-field-type inference /
  brand-preservation (and/or branding boolean-returning method returns), NOT
  `src/runtime.ts`. A field-name allowlist or `sourceFile`/`bool` special-case
  in the generic marshaller would regress real user programs (a legit struct
  field named `computed`/`sourceFile`, or a genuine 0/1-valued field) and
  violates the no-bespoke-builtins principle.
- **Blast radius**: branding changes flow into `typeof`/boxing across the whole
  test262 surface (exactly what #1788 had to be careful about) — must validate
  IN BATCH. Not locally verifiable by a dev agent.

### Quirk A (sourceFile) has no clean runtime signal — needs per-instance presence tracking

acorn's `Node` constructor assigns `sourceFile` (and `loc`, `range`) **only
conditionally** (`if (parser.options.directSourceFile) this.sourceFile = …`,
acorn.mjs Node ctor). With the option off, node-acorn never creates the property;
compiled WasmGC has a **fixed struct shape**, so the `sourceFile` slot always
exists and defaults to `null`. (`loc`/`range` are the same class but the differ's
`ignorePositions` hides them.)

At marshalling time a never-assigned ref field (`null`) is **indistinguishable**
from a legitimately assigned-`null` field (`FunctionExpression.id = null`,
`SwitchCase.test = null`) — both are `null` struct slots, and node-acorn *keeps*
the latter (verified: 0 real divergences, so those null fields agree). So there
is **no runtime signal** that lets the generic marshaller
(`_structToPlainObject` in `src/runtime.ts`) omit `sourceFile` while keeping
`id`/`test`. A correct general fix needs a **per-instance field-presence bitmap**
for conditionally-assigned fields (a real feature, not a one-liner) — or the
quirk is accepted as cosmetic per this issue's own "why low priority" section.

### Sizing verdict

Re-size from `horizon: s` → at least `m`, split into two independent codegen
tracks: (B) struct-field boolean brand-preservation (validate IN BATCH), and
(A) per-instance presence tracking for conditionally-assigned fields (larger;
arguably not worth it for a cosmetic dogfood quirk). Neither is a bounded,
locally-test262-validatable slice; the marshalling-layer framing was the
mis-scope. Banked so the next attempt starts from the mechanism.
