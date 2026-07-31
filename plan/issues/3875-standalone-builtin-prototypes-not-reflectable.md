---
id: 3875
title: "Standalone: reflection routes disagree on built-in prototype properties — hasOwnProperty false and getOwnPropertyNames short while getOwnPropertyDescriptor is spec-exact"
status: blocked
created: 2026-07-31
priority: high
feasibility: medium
task_type: bugfix
area: codegen-standalone
goal: standalone-mode
es_edition: 5
sprint: current
horizon: m
related: [3254, 2908, 1781, 3647]
---

# #3875 — three reflection routes, three different answers for the same property

## 🛑 BLOCKED — DO NOT IMPLEMENT OR SIZE. The measurements disagree with each other.

**Three agents produced three mutually inconsistent pictures of this one mechanism.
The disagreement is almost certainly methodological, not about the compiler.**

The suspected cause: one agent measured through **`runTest262File`** (which
assembles test262 frontmatter and pulls in `propertyHelper.js`); another measured
through bare **`compile()`**. If the harness path polyfills or injects
`hasOwnProperty`, then **the harness is masking the very defect being chased**, and
a "positive control" through it was measuring the polyfill rather than the compiler.

The clearest symptom of the conflict:

| `Array.prototype.hasOwnProperty('push')` in standalone | result |
|---|---|
| via `runTest262File` | **true** — "Array is the exception, replicate it" |
| via raw `compile()` | **0** — same as every other built-in; **no reference to copy** |

Both cannot be right. The entire "bounded fix — replicate the Array registration"
routing rests on the first, and it has been **retracted** by the agent who relayed
it.

**Worse, one host control is provably broken:** `({a:1}).hasOwnProperty('a')`
returned **false on host** in the raw-`compile()` harness — plainly wrong, so every
*host* reading from that run is untrustworthy. (Its *standalone* controls pass — own
key 1, bogus key 0 — so the standalone column there is sound.) That failing host
control is likely a **separate real host-lane `hasOwnProperty` bug** and deserves
its own investigation.

### Required before this issue is actionable

1. **Reconcile `runTest262File` vs raw `compile()` on ONE property** (suggest
   `Array.prototype.hasOwnProperty('push')`). Determine whether the test262 harness
   injects/polyfills `hasOwnProperty`.
2. Re-establish which routes are actually broken **using whichever harness is shown
   to reflect the compiler**, not the polyfill.
3. Only then size, and only then route.

**Everything below was measured before that discrepancy was known. Treat every
specific claim in it as provisional.** The one finding that survived all four
revisions is that `getOwnPropertyNames` returns a constant **6** in standalone for
Array/RegExp/String where host returns **40/15/52** — reproduced independently in
both harnesses.

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

Both controls are correct, so **`hasOwnProperty` itself is not broken in general**
— it is correct on user objects. Every method works **functionally**.

## ⚠️ CORRECTED — the fix direction is the OPPOSITE of the first reading

An independent verification (decoding `10*hasOwnProperty + (gOPD !== undefined)`,
standalone reads **`1`**, not `0`) inverted the original claim:

| route | built-in prototype, standalone |
|---|---|
| `getOwnPropertyDescriptor` | **returns a REAL descriptor — spec-exact, identical to host** ✓ |
| `hasOwnProperty` | **returns `false`** ✗ |
| `getOwnPropertyNames` | **6 keys vs host's 40, omits `push`** ✗ |

**This is NOT "built-in prototypes have no reflection surface."** It is **multiple
reflection routes contradicting each other on the same property** — the same shape
as the **#3647** `propertyIsEnumerable`-vs-`gOPD` trap.

**Consequence for implementation: a fix aimed at `getOwnPropertyDescriptor` would
land on a route that already works and flip nothing.** The broken routes are
`hasOwnProperty` and `getOwnPropertyNames`.

Anyone bucketing rows by "gOPD returns undefined" will get a signal that **does not
reproduce** — classify on `hasOwnProperty` instead.

## ⚠️ This is TWO separable defects — and only one has a working reference

The first framing here said "`Array.prototype` works, so replicate it." That was
built on a **single data point** (`push`) and is **half wrong**. Probed properly,
both lanes, same file:

```
host:       push/pop/slice/map/indexOf/join = all true | length=false | bogus=false
            desc.push = value:function, enum:false, writ:true, conf:true
            getOwnPropertyNames(Array.prototype).length = 40, includes push = TRUE

standalone: push/pop/slice/map/indexOf/join = all true | length=false | bogus=false
            desc.push = value:function, enum:false, writ:true, conf:true   <- IDENTICAL to host
            getOwnPropertyNames(Array.prototype).length = 6,  includes push = FALSE
```

**What survives:** not a `push` fluke — six methods reflect, negative cases
(`length`, a bogus key) are correctly false, and the descriptor is **spec-exact and
identical to host**. The lookup mechanism genuinely exists and is genuinely correct.

**What breaks the story:** `getOwnPropertyNames(Array.prototype)` returns **6** vs
host's **40**, and **omits `push`** — the very property whose full descriptor it had
just returned correctly. **The two reflection paths disagree with each other inside
the one built-in that supposedly works.**

### Defect 1 — `hasOwnProperty` on built-in prototypes

Correct for `Array.prototype`, **returns `false`** for RegExp / String / Object /
Number / Boolean prototypes. **Bounded** — "replicate whatever registers
`Array.prototype`" is a fair routing call, and the reference implementation is real.

**`getOwnPropertyDescriptor` is NOT part of this defect** — it already returns a
spec-exact descriptor on every built-in prototype in both lanes. Do not touch it.

### Defect 2 — own-key enumeration (`getOwnPropertyNames` and friends)

**Broken even for `Array.prototype`** (6 keys vs 40, omitting the very property
whose descriptor `gOPD` returns correctly). **No in-repo reference exists** —
copying Array wholesale would propagate this bug rather than fix it. Unscoped;
needs its own sizing before anyone commits to it.

**So the three routes disagree pairwise**: `gOPD` is right everywhere,
`hasOwnProperty` is right only on `Array.prototype`, and `getOwnPropertyNames` is
wrong everywhere including `Array.prototype`.

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

- `hasOwnProperty`, `getOwnPropertyDescriptor` and `getOwnPropertyNames` **agree with
  each other** on built-in prototype properties, and match host, for `RegExp`,
  `String`, `Object`, `Number`, `Boolean` **and `Array`**.
- Do NOT "fix" `getOwnPropertyDescriptor` — it is already correct.
- Functional behaviour unchanged (methods already work; do not regress them).
- Twin-control per-row measurement of what actually flips, with all three
  denominators.
