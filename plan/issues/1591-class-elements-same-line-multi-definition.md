---
id: 1591
title: "class/elements: WasmGC-struct ↔ host own-property/identity reconciliation gaps (~294 fails)"
status: blocked
created: 2026-05-24
updated: 2026-05-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, class-elements
goal: spec-completeness
sprint: Backlog
renumbered_from: 779b
parent: 779
test262_fail: 294
test262_category: language/statements/class/elements, language/expressions/class/elements
---
# #1591 — `class/elements` WasmGC-struct ↔ host own-property / method-identity reconciliation gaps

> **MIS-SCOPE CORRECTION (2026-05-27).** The original framing of this issue —
> "same-line / stacked member definitions are *dropped or reordered* by the
> parser / class-body emitter" — is **wrong**. A dev investigation confirmed the
> parser preserves all members in source order, and the class-body emitter does
> not drop or reorder anything. The `after-same-line` / `new-sc-line` /
> `wrapped-in-sc` / `multiple-stacked-definitions` / `multiple-definitions-rs`
> filename prefixes are just the **test262 generator's layout permutations** of
> the *same* member sets; the layout is irrelevant to why they fail. **All 294
> failures are runtime-semantics gaps** in how a WasmGC struct instance is
> reconciled with the host's prototype / own-property model. The sections below
> are rewritten to describe the real problem.

## Problem

A class instance compiles to a **WasmGC struct** (`struct (field $x f64) ...`),
not a host JS object. Methods are funcref struct slots / module functions, not
JS `Function` objects living on a real prototype. Instance fields are struct
slots, not host own data properties. To satisfy `verifyProperty`,
`hasOwnProperty`, `Object.getOwnPropertyDescriptor`, and `===` identity checks,
the runtime (`src/runtime.ts`) maintains a **reconciliation layer** of sidecar
maps that *present* the struct as if it were a spec-compliant host object:

| Map / helper | Purpose |
|--------------|---------|
| `__struct_field_names` export | instance field name set (per struct type) |
| `_prototypeMethodNames` (`__register_prototype`) | allowlist of prototype method names |
| `_wasmStructProps` | sidecar own data properties (set after construction) |
| `_wasmPropDescs` | per-property descriptor flags (enum/config/writable) |
| `_wasmStructAccessors` | get/set accessor functions per key |
| `_wasmStructDeletedKeys` | delete tombstones (§10.1.10) |

The 294 failures are the **gaps in this reconciliation layer** — cases the
sidecar machinery does not yet cover. They split into five sub-clusters:

### Cluster A — instance-field own-property visibility (largest)
`hasOwnProperty(c, "foo")` returns **false** even though `c.foo` *reads*
correctly, and `verifyProperty(c, "foo", {...})` reports the wrong descriptor
(or "not own"). Instance fields are WasmGC struct slots; they are *readable*
via the `__sget_*` getters and *are* listed in `__struct_field_names`, but a
freshly-constructed instance has **no entry in `_wasmStructProps` /
`_wasmPropDescs`**, so:
- `__getOwnPropertyDescriptor` finds no descriptor and returns `undefined`
  (instead of `{writable:true, enumerable:true, configurable:true}` per
  §10.2.x class field semantics), and/or
- enumeration order and descriptor flags don't match the spec.

The struct-field-name fallback in `__hasOwnProperty` (runtime.ts ~5320) papers
over the *presence* check for *some* cases but not the *descriptor* shape that
`verifyProperty` demands, and it is bypassed entirely once the object has been
registered as a class prototype (the `_prototypeMethodNames` branch returns
early, ~5316).

```
multiple-stacked-definitions-rs-field-identifier-initializer.js
  returned 4 — assert(!Object.prototype.hasOwnProperty.call(C, "field"))
  → instance-field own-property descriptor fidelity
```

### Cluster B — method-object identity on the prototype
`c.m === C.prototype.m` fails. Each member access re-derives a *fresh* host
wrapper around the funcref (or returns a different boxed value), so the two
reads are not the same JS object. The spec requires a class method to be a
**single** `Function` object installed once on `C.prototype`, shared by every
`c.m` lookup through the prototype chain.

```
after-same-line-method-computed-symbol-names.js
  verifyProperty(C.prototype, "m", { enumerable:false, configurable:true, writable:true })
  → method present on prototype with stable identity + correct descriptor
```

### Cluster C — private methods / private accessors
`#method`, `get #x()`, `set #x(v)`. Private names are not own properties at all
(they must be **invisible** to `hasOwnProperty` / `getOwnPropertyNames` and to
`verifyProperty`), but must be callable from inside the class and produce a
`TypeError` on a brand-check failure from outside. The current path leaks them
into the struct-field-name set or fails the brand check.

```
new-sc-line-gen-rs-private-setter-alt.js
  returned 5 — verifyProperty(C.prototype, "method", ...)
```

### Cluster D — static private fields / methods
`static #x`, `static #m()`. Same private-name mechanism as Cluster C but keyed
on the **class object** (the constructor) rather than the instance. Brand check
is against `C` itself.

```
multiple-definitions-rs-static-privatename-identifier-initializer-alt.js
  returned 10 — assert.sameValue(c.foo, "foobar")
```

### Cluster E — computed / symbol / string-literal member names with verifyProperty
Computed keys (`[expr]`), `Symbol.*` keys, and string-literal keys must land in
the *same* sidecar maps as identifier keys, with correct descriptors. Symbol
keys in particular bypass `_wasmStructProps` (template-literal CSV can't
stringify a Symbol) and need `_wasmStructAccessors`-style handling.

## Decomposition

This is too large for one fix. Split into sub-issues (rough effort = dev-days):

| Sub | Cluster | Title | Effort | Mechanism |
|-----|---------|-------|--------|-----------|
| 1591a | A | Instance-field materialization as host own properties | M (2-3d) | At end of every class constructor, emit one `Object.defineProperty`-equivalent (`__defineProperty_data` / direct `_wasmStructProps` + `_wasmPropDescs` seed) per declared instance field with `{writable, enumerable, configurable: true}` |
| 1591b | B | Method-object identity on the prototype | M (2-3d) | Install each method as a single host `Function` on the registered prototype object at module init; route `c.m` lookups through that prototype so identity is stable |
| 1591c | C | Private instance methods / accessors | L (3-5d) | Separate private-name brand mechanism (WeakSet/WeakMap brand per class); never enters `_wasmStructProps` or `__struct_field_names`; throw TypeError on brand mismatch |
| 1591d | D | Static private fields / methods | M (2-3d) | Same private-name brand mechanism as 1591c, keyed on the class object; depends on 1591c landing first |
| 1591e | E | Computed / Symbol / string-literal member names | S-M (1-2d) | Funnel computed/symbol keys into the same descriptor sidecars as 1591a/b; Symbol keys via `_wasmStructAccessors` not CSV |

Recommended order: **1591a → 1591b → 1591e → 1591c → 1591d**. A and B together
should clear the bulk of the `field-*` and `method-*` permutations; C/D unblock
the `private*` permutations.

## Implementation Plan

### Root cause
A WasmGC class instance is a struct, not a host object. The runtime's sidecar
reconciliation layer (`_wasmStructProps`, `_wasmPropDescs`, `_prototypeMethodNames`,
`__struct_field_names`) presents a *partial* host view: it covers presence in
some paths but not full descriptor fidelity, not stable method identity, and not
the private-name brand model. `verifyProperty` exercises exactly these gaps.

### 1591a — Instance-field own-property materialization (Cluster A)

**File: `src/codegen/literals.ts`** (class body / instance construction) and
**`src/codegen/index.ts`** (class compilation entry, constructor emission).

- Find where the constructor body finishes initializing struct field slots
  (the per-field `struct.set` / initializer loop in the class-element pipeline).
- After the last field initializer, for **each declared instance field**, emit a
  call that seeds the host descriptor sidecars for `this`. Reuse the existing
  data-property path rather than inventing a new host import:
  - emit `__defineProperty_data(this_extern, "name", value_extern, flags)` where
    `flags = writable|enumerable|configurable` (all true for class fields), OR
  - if a dedicated data-define import does not exist, add one mirroring
    `__defineProperty_accessor` (runtime.ts ~292, ~700) that writes both
    `_wasmStructProps[obj][name] = value` and
    `_wasmPropDescs[obj].set(name, flags)`.
- Standalone mode (`ctx.standalone`): skip the host call (no JS host); the struct
  slot already holds the value and `__hasOwnProperty`'s `__struct_field_names`
  fallback covers presence. Gate exactly like the `__register_prototype` block
  in index.ts ~802.

**File: `src/runtime.ts`**
- In `__getOwnPropertyDescriptor` (~3629) and `__hasOwnProperty` (~5293): when an
  instance is *also* a registered class prototype receiver, do **not** early-return
  on the `_prototypeMethodNames` branch for keys that are seeded instance-field
  descriptors. Check `_wasmStructProps` / `_wasmPropDescs` *before* the
  prototype-method allowlist for own-data keys.

**Edge cases**
- Field initializer is `undefined` → still an own property (present, value `undefined`).
- Field declared but shadowed by a same-name accessor → accessor wins (Cluster E).
- Subclass field added in derived constructor after `super()` → seed after super-init.

### 1591b — Method-object identity on the prototype (Cluster B)

**File: `src/runtime.ts`** — `__register_prototype` handler (~3624 sets
`_prototypeMethodNames`). Extend the registration so the host prototype object
stores the **actual `Function` wrapper** per method (a `Map<name, Function>`),
created **once**. `_wrapForHost` / the prototype getter must return that *same*
function on every `c.m` and `C.prototype.m` read.

**File: `src/codegen/index.ts`** / `src/codegen/closures.ts` — `emitLazyProtoGet`
path. Ensure the lazy prototype init registers method wrappers (funcref → host
`Function`) into the prototype's method map at first access and caches them, so
`emitLazyProtoGet` returns the cached identity rather than re-boxing.

**Wasm/runtime pattern**
```
// __register_prototype(protoExtern, methodsArrayExtern):
//   for each (name, funcref-wrapper) -> protoMethodFns.set(name, hostFn)
//   _prototypeMethodNames.set(proto, [...names])
// prototype get trap / __extern_get on proto:
//   if protoMethodFns.has(key) return protoMethodFns.get(key)   // STABLE identity
```

**Edge cases**
- Method descriptor must be `{writable:true, enumerable:false, configurable:true}`
  (non-enumerable!) — distinct from fields (1591a). Seed `_wasmPropDescs` on the
  *prototype* with `enumerable:false`.
- Generator / async methods: same identity rule, different wrapper kind.
- `constructor` is not enumerated as a normal method.

### 1591e — Computed / Symbol / string-literal names (Cluster E)

**File: `src/codegen/literals.ts`** — class-element name resolution. Computed
names already resolved to a constant must funnel into the *same* define-property
emission as 1591a/1591b. For **Symbol** keys, route through `_wasmStructAccessors`
/ a symbol-keyed descriptor map (runtime.ts ~368 notes Symbols can't go through
the CSV field-name path).

**Edge cases**
- Computed key that is a non-constant expression → evaluate once, define with the
  resulting key (don't re-evaluate per access).
- `Symbol.iterator` / well-known symbols already have bespoke handling
  (runtime.ts ~166) — don't double-register.

### 1591c — Private instance methods / accessors (Cluster C)

**New mechanism — do NOT reuse the own-property sidecars.** Private names are
*not* properties.

**File: `src/runtime.ts`** — add a per-class **brand WeakSet** and a
`Map<privateName, Function>` for private methods/accessors. Construction adds the
instance to the brand set; a `#m()` call brand-checks the receiver (`TypeError`
if absent).

**File: `src/codegen/literals.ts` / `index.ts`** — private members must be
**excluded** from `__struct_field_names` (already partially handled: names
starting with `$`/`__` are filtered at index.ts ~1395 — confirm `#`-mangled
names are filtered too) and from any prototype method allowlist.

**Edge cases**
- `#x in obj` (private-in expression) → brand check, returns boolean, never throws.
- Private accessor with only a getter → set throws TypeError.
- Brand check must run **before** any field access (spec ordering).

### 1591d — Static private fields / methods (Cluster D)

Same brand mechanism as 1591c but the brand set contains exactly the class
object, and private statics live keyed on the constructor. **Depends on 1591c.**

### Test files to verify
- `language/statements/class/elements/multiple-stacked-definitions-rs-field-identifier-initializer.js` (A)
- `language/statements/class/elements/after-same-line-method-computed-symbol-names.js` (B, E)
- `language/statements/class/elements/new-sc-line-gen-rs-private-setter-alt.js` (C)
- `language/statements/class/elements/multiple-definitions-rs-static-privatename-identifier-initializer-alt.js` (D)

## Acceptance criteria

- The `class/elements/*` permutation groups pass once their underlying cluster is
  fixed — **not** as one atomic change. Track per-sub-issue: A+B clear the
  `field-*` / `method-*` permutations; C+D clear the `private*` permutations; E
  clears the `computed-symbol`/string-literal permutations.
- No regressions in equivalence tests.
- Standalone (`--target standalone`) class compilation is unaffected (host
  reconciliation calls are gated off, as `__register_prototype` already is).

## Risks / conflicts

- **Touches `src/runtime.ts` heavily** — the own-property / descriptor handlers
  are shared by plain-object code paths (`Object.defineProperty`,
  `getOwnPropertyDescriptor`, for-in). Any change to the
  `_prototypeMethodNames` early-return ordering risks regressing #1334 (delete
  tombstones), #929 (accessor descriptors), and #1047/#1395 (prototype/class
  registries). Re-run those issues' regression tests.
- **#1364 (method/field descriptor fidelity, sprint 52) is DONE** — it built the
  `_wasmPropDescs` descriptor infrastructure this issue extends. 1591 is the
  *instance-side* and *identity* follow-on, not a re-do. No open dependency, but
  read #1364's diff before touching descriptor flags.
- Cluster ordering matters: 1591d depends on 1591c (shared brand mechanism).

## Notes

- Identified in the #779 bucket decomposition (`plan/issues/1569-779-bucket-decomposition.md`, 2026-05-21) as sub-issue "779b"; formally filed 2026-05-24 after harvest.
- The 1569 decomposition estimated ~290 fails — current measurement 294, consistent.
- **2026-05-27**: dev investigation re-scoped this from a parser/ordering bug to
  the WasmGC-struct ↔ host reconciliation problem above. The filename layout
  prefixes (`same-line`, `stacked`, `rs`) are test262 generator artifacts, not
  the failure cause. `status` set to `blocked` pending sub-issue creation
  (1591a–e). No open `depends_on` — #1364 (the descriptor-infra prerequisite)
  already merged 2026-05-20.
