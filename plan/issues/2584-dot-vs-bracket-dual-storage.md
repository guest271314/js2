---
id: 2584
title: "standalone: dot-assign vs bracket-read dual-storage — widened struct invisible to $Object hash (in/keys/bracket)"
status: ready
sprint: 65
created: 2026-06-21
updated: 2026-06-21
priority: high
feasibility: hard
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen
language_feature: object-literals, property model, any-typed receivers
goal: property-model
related: [2186, 2372, 2542, 2179]
origin: "2026-06-21 — surfaced during s64 value-rep keystone work; widened-struct ↔ $Object reconciliation gap."
---

## Problem

Standalone, an `any`-typed object written via **dot-access** but read via
**bracket / `in` / Object.keys / getOwnPropertyDescriptor** returns the wrong
value, because the two sides target different representations of the same
variable:

```ts
const o: any = {};
o.a = 7;
o["a"];        // → 0   (expected 7)
"a" in o;      // → false (expected true)
```

Repro confirmed failing on main HEAD (93e53919f), `--target standalone`.

### The exact asymmetry (measured)

| program                          | result | path                         |
|----------------------------------|--------|------------------------------|
| `o.a=7; o.a`                     | 7  ✅  | struct.set → struct.get      |
| `o["a"]=7; o["a"]`               | 7  ✅  | (bracket-write poisons → $Object) |
| `o["a"]=7; o.a`                  | 7  ✅  | $Object both sides           |
| `o.a=7; o["a"]`                  | 0  ❌  | struct.set → __extern_get    |
| `o.a=7; "a" in o`               | false ❌ | struct.set → $Object `in`   |

The break is NOT "bracket reads are broken." It is: a var written **only via
dot-access** gets **widened to a closed WasmGC struct**, but the
`$Object`-hash-runtime consumers (bracket-read, `in`, `Object.keys`,
`Object.getOwnPropertyDescriptor`, `Object.entries`/`values`) can't see a
widened struct.

### Root cause (WAT-confirmed)

`const o: any = {}` with later `o.a = 7` triggers the empty-object widening
pre-pass (`collectEmptyObjectWidening` → `collectPropsFromStatements`,
`src/codegen/declarations.ts:2008/2128`): it scans the dot-assign, adds `a` as
a widened property, registers an `__anon_N` struct, and records
`widenedVarStructMap.set("o", structName)`. So:

- The initializer `{}` lowers via `compileWidenedEmptyObject`
  (`src/codegen/literals.ts:1499`) → `struct.new <__anon>` (NOT
  `__new_plain_object`). `$o` is that struct boxed to externref.
- `o.a = 7` lowers via `compilePropertyAssignment`
  (`src/codegen/expressions/assignment.ts:2453` — `resolveStructNameForExpr`
  resolves the widened struct) → `struct.set <__anon> 0`. Write lands in the
  struct field.
- `o["a"]` lowers via `compileElementAccessBody`
  (`src/codegen/property-access.ts:5236`). The receiver `compileExpression(o)`
  reports **externref** (the var is declared `externref`), so it takes the
  externref arm (line 5243) → `__extern_get(o, "a")`. `__extern_get`'s
  `ref.test $Object` does NOT match an `__anon` widened struct → null →
  `__unbox_number(null)` → 0.

WAT excerpt (`const o:any={}; o.a=7; return o["a"]`):
```
f64.const 0 / struct.new 12 / extern.convert_any / local.tee $o   ;; widened struct
f64.const 7 / struct.set 12 0                                     ;; o.a = 7 → struct
local.get $o / <build "a"> / call $__extern_get                   ;; o["a"] → $Object miss
call $__unbox_number                                              ;; null → 0
```

`in` / `Object.keys` / GOPD all consult the same `$Object` runtime, so they too
miss the struct.

## Implementation Plan

### Approach — poison widening when a $Object-only consumer is present

The codebase ALREADY has the exact mechanism: `dynamicDescriptorWidenVars`
(declarations.ts:2042/2188) suppresses widening for a var whose
`Object.defineProperty` uses a dynamic descriptor, so the var stays a pure
`$Object` and BOTH write and read route through the native runtime
consistently. Extend the same poison set to cover the dot-vs-bracket gap.

**Decision: poison (steer to `$Object`), do NOT teach bracket-read to resolve
the struct field.** Rationale:
1. `in` / `Object.keys` / `Object.entries` / `getOwnPropertyDescriptor` /
   `Object.assign` / `for-in` all require the `$Object` hash — there is no
   struct equivalent for enumeration. Teaching only bracket-read to read the
   struct would still leave `in`/keys/GOPD broken. One representation (`$Object`)
   fixes the whole family.
2. The poison path is proven (#2372) and keeps the receiver consistent across
   ALL access forms.

### Changes

**File: `src/codegen/declarations.ts`**

Add a new poison set (or reuse `dynamicDescriptorWidenVars` if its name is
acceptably generalized — prefer a new `objectHashConsumerVars` for clarity) and
populate it during the same statement scan that drives widening.

- In `collectEmptyObjectWidening` (line ~2008) / a sibling scanner: walk the
  function body (the same statement tree `collectPropsFromStatements` walks) and
  mark `varName` poisoned when it appears as the **receiver** of any
  `$Object`-only operation:
  - `varName[<expr>]` — an `ElementAccessExpression` whose `.expression` is the
    var (covers `o["a"]` read AND `o[k]` write — though a bracket-write already
    routes to `$Object`, marking it is harmless and simplifies the rule).
  - `<key> in varName` — a `BinaryExpression` with `InKeyword` and `right` =
    the var.
  - `Object.keys(varName)`, `Object.entries(varName)`,
    `Object.values(varName)`, `Object.getOwnPropertyDescriptor(varName, …)`,
    `Object.getOwnPropertyNames(varName)`, `Object.assign(target, varName)` /
    `Object.assign(varName, …)`, `for (… in varName)`
    — `CallExpression` / `ForInStatement` with the var as the relevant arg.

  A focused implementation: add a recursive `markObjectHashConsumers(node,
  varName, poisonSet)` that walks every descendant expression of the function
  body and sets the poison flag on the first match. Run it once per widened
  candidate var alongside `collectPropsFromStatements`.

- At the widening decision point (line ~2042, next to the existing
  `if (ctx.dynamicDescriptorWidenVars.has(varName)) continue;`), add:
  ```ts
  if (ctx.objectHashConsumerVars.has(varName)) continue;
  ```
  so the var skips struct registration entirely and stays on the `$Object`
  representation.

**File: `src/codegen/context/types.ts`** (or wherever `CodegenContext` fields
live)

- Add `objectHashConsumerVars: Set<string>` and initialize it (mirror
  `dynamicDescriptorWidenVars`).

### Why this fixes both the read and the write

Once `o` is NOT widened, the empty-`{}` any-context arm
(literals.ts:944–973) builds it via `__new_plain_object` → a real `$Object`.
Then `o.a = 7` no longer resolves a struct name (`resolveStructNameForExpr`
returns undefined) and `compilePropertyAssignment` (assignment.ts:2454) routes
through `compilePropertyAssignmentExternSet` → `__extern_set(o, "a", box(7))`.
`o["a"]`, `"a" in o`, `Object.keys(o)` all read the same `$Object` hash →
consistent.

### Edge cases

- **Var written via dot only, never bracket/in/keys** — NOT poisoned, keeps the
  struct fast path (byte-identical to main). No regression for the common
  hot-struct case.
- **Var used in BOTH dot-write and bracket-read** — poisoned → `$Object`. This
  is the target fix.
- **Aliasing** (`const p = o; p["a"]`) — out of scope for Slice 1 (the scanner
  is name-based, like the existing widening pre-pass). Note in `## Deferred`;
  the existing widening pre-pass has the same name-based limitation, so this is
  not a regression.
- **Numeric bracket index on a dot-written var** (`o.a=7; o[0]`) — `o[0]` is an
  `ElementAccessExpression` receiver → poisons → `$Object`. Correct (the
  array-like read then goes through `__extern_get_idx`'s `$Object` arm).
- **host / wasi modes** — host keeps the struct fast path via the live-mirror
  Proxy (it reflects struct sidecar reads/writes), so gate the new poison on
  `ctx.standalone` ONLY (match `dynamicDescriptorWidenVars`'s standalone gate at
  declarations.ts:2187). wasi is unaffected.
- **defineProperty interaction** — a var already in `dynamicDescriptorWidenVars`
  stays poisoned regardless; the two sets are additive.

### Test plan

Add `tests/issue-2584-dual-storage.test.ts` (standalone harness):

- `const o:any={}; o.a=7; return o["a"]` → 7
- `const o:any={}; o.a=7; return ("a" in o)?1:0` → 1
- `const o:any={}; o.a=7; o.b=8; const ks=Object.keys(o); return ks.length` → 2
- `const o:any={}; o.a=7; const d=Object.getOwnPropertyDescriptor(o,"a");
   return d.value` → 7
- mixed: `const o:any={}; o.a=7; o["b"]=8; return (o["a"] as number)+(o.b as number)`
  → 15
- regression (struct fast path preserved): a dot-only var with NO
  bracket/in/keys consumer still compiles (assert correct dot-read value;
  ideally also assert via WAT that it uses struct.new/struct.get, or at minimum
  that the value round-trips).
- regression: typed struct var (`const o={a:0}; o.a=7; o.a`) unaffected → 7

Scoped local check before PR; CI validates conformance. Expect positive
test262 delta across object property-model tests that read via bracket/`in`
after dot-init.

## Deferred

- Aliased receivers (`const p = o; p[k]`) — name-based scanner limitation,
  shared with the existing widening pre-pass.
- A future unification could make a single representation serve both fast struct
  access and dynamic keys (a struct with an attached overflow `$Object`), but
  that is a larger property-model redesign; out of scope here.
