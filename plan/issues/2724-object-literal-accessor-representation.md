---
id: 2724
title: "Object-literal get/set accessor representation: accessor-bearing literal types mis-register as closed structs (unblocks #1642)"
status: done
completed: 2026-06-26
assignee: ttraenkler/sd-accessor
sprint: 67
created: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
needs_arch_spec: true
owner_role: senior-developer
task_type: bugfix
area: codegen, value-rep
language_feature: object literals, accessors, iteration
goal: test262-conformance
related: [2580, 1642, 1239, 1888]
depends_on: []
---

## Test Results (2026-06-26, sd-accessor)

Implemented a scoped guard in `ensureStructForType` (`src/codegen/index.ts`,
after `tsType.getProperties()`) that early-returns for a type whose own
properties include an object-LITERAL get/set accessor (declaration parent is an
`ObjectLiteralExpression`), leaving it to lower to externref via
`resolveWasmType` → `mapTsTypeToWasm`. Slice 2 was NOT needed.

### merge_group floor fix — narrowed to MIXED accessor literals (2026-06-26)

The first cut of the guard fired for ANY object-literal accessor type. It passed
PR-level CI but FAILED the `merge_group` floor (`check for test262 regressions`,
run 28246424070): **8 regressions** (ratio 22.9% > 10% gate; net was +27), all
**getter-ONLY** literals used as object-REST/spread sources —
`{...x} = { get v() {} }` (assignment-rest), `for await ({...x} of [{ get v() {}
}])` (×6), and RegExpExec's `{ get 0() {} }`. Root cause: the object-rest copy
paths (`assignment.ts` externref branch / `loops.ts` for-await) require the
source to be a **registered struct** (they do `struct → externref →
__extern_rest_object`); externref-lowering a getter-only literal routes it to the
externref-rest path which never runs `__extern_rest_object` (assignment-rest) or
double-wraps via `extern.convert_any` on an already-externref value (for-await),
so the getter is never invoked / re-invoked — breaking CopyDataProperties.

Fix: the guard now fires **only for MIXED literals** (≥1 obj-literal accessor AND
≥1 non-accessor own property). Every #1642 iterator is mixed (an iterator always
has a `next` method), so the acceptance edges stay fixed; every getter-only
rest/RegExp source stays on its working struct path (zero merged-baseline
regressions). Verified locally via the faithful `runTest262File` harness:
**8/8 former regressions now PASS**, **5/5 iterator-close acceptance edges PASS**.
The getter-ONLY return/member-read case (e.g. `const o = { get x() {} }; o.x`)
is deferred to the #2580 externref-rest substrate work. A *mixed* literal used as
an assignment-rest source (`{...x} = { a:1, get v() {} }`) is a latent gap with
**no test262 coverage** (all test262 object-rest-getter sources are getter-only).

- `tests/issue-2724.test.ts` — 12/12 green (9 gc/host + 3 standalone), covering:
  MIXED accessor literal returned from a fn (getter fires); for-of IteratorClose
  with `get return()` throwing / returning null / throw-completion ordering / runs
  once; mixed data+accessor; mixed setter; getter-only object-rest-source
  regression guard; CLASS-getter control (struct preserved, gc + standalone).
- #1642's 3 failing edges flip to PASS in gc (faithful repros): non-throw +
  getter-throws → forwarded; getter-returns-null → no throw; throw-completion +
  getter-throws → original throw wins. The 2 `…-non-callable.js` stay green.
- Regression basket diffed against `origin/main` @ 4b4549d: identical results —
  `tests/issue-1239.test.ts` + `tests/getters-setters.test.ts` carry 7
  pre-existing reds (harness artifacts) on BOTH main and this branch (0 new);
  `tests/accessor-side-effects.test.ts` + `tests/object-literals.test.ts` +
  `tests/iterators.test.ts` + `tests/symbol-iterator-protocol.test.ts` +
  `tests/issue-2162-iterators.test.ts` all green.
- `tsc --noEmit` clean; `prettier --check` clean.
- Standalone direct-accessor reads work (no illegal cast) — the standalone
  accessor *type representation* is now correct. Standalone dynamic-iterable
  for-of remains a separate pre-existing data-path gap (out of scope, #2580).
- Broad-impact representation change → real floor validation is the #2097
  merge_group standalone shard.

Closes #1642 (the actual root cause; its earlier "close-time return-method" and
"#2580 substrate rebuild" framings were stale).

# #2724 — Object-literal get/set accessor representation

## Problem

An object literal that contains a `get x() {}` / `set x(v) {}` accessor **and is
returned from a function** (or otherwise flows through a context where
TypeScript resolves its inferred type to a closed WasmGC struct) mis-represents
the accessor as a plain **data field**. The literal value is built as an
externref `$Object` carrying real accessor descriptors, but the *type* it flows
through is a closed struct whose accessor slot is a data field
(`$return (mut f64)`), so the two representations collide:

- **gc/host**: the externref `$Object` does not match the struct ⇒ the value
  reads back as **`null`**.
- **standalone**: the externref→struct `ref.cast` **traps (`illegal cast`)**.

This is the **root cause of #1642's residual 4 `iterator-close-*-get-method-*`
edges**. The for-of `IteratorClose` cluster fails **upstream of close**: the
iterator object literal `{ next: …, get return() {…} }` is returned from the
`[Symbol.iterator]` factory, registers a closed struct for the factory's return
type, and `__iterator(iterable)` (which invokes the factory via `__call_fn_0`)
gets **`null`** ⇒ `__iterator_next(null)` throws before close is ever reached. It
is part of the **#2580 value-rep dynamic-read substrate** (getter/setter-bearing
object *types* must lower to the dynamic `$Object` representation end to end).

## IMPORTANT — the original framing was stale; corrected by grounding

The original issue framing ("object-literal accessors lower to plain `(mut f64)`
data fields — accessor semantics are dropped; the accessor-driver model
needs to be *built*") is **stale**. Grounded against `origin/main @ 30bc55b2fa01`
with `.tmp/` probes through the real `compile()` + `buildImports` + `setExports`
harness:

1. The **accessor dispatch + driver substrate already exists and works.** Object
   literals with accessors route through `compileObjectLiteralWithAccessors`
   (`src/codegen/literals.ts:411`, gated at `compileObjectLiteral`
   `literals.ts:914`), which emits `__defineProperty_accessor` (host) /
   native `$PropEntry.$get`/`$set` closures dispatched via the **already-built**
   `__call_accessor_get` / `__call_accessor_set` reserve/fill drivers
   (`src/codegen/accessor-driver.ts`, #1888 S5b). **Direct `o.x` reads already
   fire throwing and side-effecting getters in BOTH gc and standalone:**

   | probe (`const o: any = {…}`) | gc | standalone |
   |---|---|---|
   | throwing getter `get x(){throw}` ⇒ caught | 42 ✅ | 42 ✅ |
   | side-effecting `get x(){count++}` read twice ⇒ count | 2 ✅ | 2 ✅ |
   | `get return()` read directly ⇒ counter | 1 ✅ | 1 ✅ |

   So **do NOT build a new accessor-driver model** — it exists. Do NOT chase
   the "side-effecting getter counter stays 0 / throwing getter doesn't throw"
   symptoms as a *dispatch* gap; they only manifest through the **return-type /
   binding-type** path below.

2. The **real gap is the type layer.** `ensureStructForType`
   (`src/codegen/index.ts:11465`, loop at `:11558`) walks
   `tsType.getProperties()` and, for an object-literal **getter symbol**, calls
   `ctx.checker.getTypeOfSymbol(prop)` which returns the getter's **return
   type** (`number`→`f64`). It pushes `{ name:"return", type:f64, mutable:true }`
   — a plain data field — and registers a closed `$__anon_N` struct. The
   accessor-ness is erased at the type level. `resolveWasmType`
   (`index.ts:11384`) then hands that struct type to the function return /
   variable binding, colliding with the literal's externref `$Object`.

### Reproduced smoking gun (current main, `.tmp/probe-wat.mjs`)

```
// accessor literal RETURNED from a function:
function makeIter() { return { next: function(){…}, get return(){ return 5; } }; }
  ⇒ (type $__anon_0 (struct (field $next (mut externref)) (field $return (mut f64))))   ← BUG: $return is a data field

// same literal, plain DATA return (control):
{ next: function(){…}, return: function(){ return 5; } }
  ⇒ (type $__anon_0 (struct (field $next (mut externref)) (field $return (mut externref))))   ← OK
```

### Reproduced end-to-end failure (`.tmp/probe-forof.mjs`, faithful for-of shape)

```
iterable[Symbol.iterator] = function(){ return { next:…, get return(){ returnCalled++; return …; } }; };
for (const x of iterable) { break; }

  forofAccessor/gc          → RUN THREW  TypeError: Cannot read properties of null (reading 'next')   ← #1642
  forofData/gc              → OK -> 1                                                                 ← control
  forofAccessor/standalone  → RUN THREW  RuntimeError: illegal cast
  forofData/standalone      → RUN THREW  RuntimeError: illegal cast                                   ← SEPARATE pre-existing gap
```

Note the **standalone data control ALSO throws illegal cast on unpatched main**
— so for-of over a **dynamically-assigned** `[Symbol.iterator]` is a *separate*
pre-existing standalone substrate gap (a different #2580 slice), **NOT** caused
by accessors and **out of scope** for this issue. This issue restores the
**gc/host** accessor edges and makes the **standalone** accessor *type
representation* correct (so it stops *regressing the floor* and is ready for the
separate dynamic-iterable slice). Do not try to fix standalone dynamic-iterable
for-of here.

## Acceptance criteria

- `forofAccessor/gc` returns `1` (the `get return()` getter fires during
  IteratorClose); `forofData/gc` stays `1`.
- The 3 currently-failing test262 edges flip to PASS in gc/host:
  - `language/statements/for-of/iterator-close-non-throw-get-method-abrupt.js`
  - `language/statements/for-of/iterator-close-non-throw-get-method-is-null.js`
  - `language/statements/for-of/iterator-close-throw-get-method-abrupt.js`
  (the two `…-non-callable.js` already pass — plain data `return:`.)
- Class getters/setters keep the closed-struct + getter-method representation
  (no regression): `tests/accessor-side-effects.test.ts` stays green.
- **Zero** standalone-floor regressions in the `merge_group` standalone shard
  (#2097).

---

## Implementation Plan

### Root cause

`ensureStructForType` (`src/codegen/index.ts:11558`) treats an **object-literal
getter** as a data property of the getter's *return type*, registering a closed
struct that the literal's externref `$Object` (built by
`compileObjectLiteralWithAccessors`) cannot satisfy. Fix: an object type whose
own-properties include an **object-literal** get/set accessor must NOT register
as a closed struct — it must lower to **externref** (the `$Object` dynamic
representation) end to end, exactly like the existing `#2542` pure
string-index-signature guard and the `#1287` `.d.ts` guard already do. When
registration is skipped, `resolveWasmType` (`:11384`) already cascades the type
to `mapTsTypeToWasm` → externref (verified end to end), so **no separate
`resolveWasmType` change is required**.

### Slice 1 — `ensureStructForType` object-literal-accessor guard (the core fix)

**File: `src/codegen/index.ts`**, function `ensureStructForType` (def `:11465`).
Insert the guard immediately after `const props = tsType.getProperties();`
(`:11546`) and **before** the field-building loop (`:11558`):

```ts
// (#2724) An object-LITERAL accessor-bearing type must not become a closed
// struct. getTypeOfSymbol on a getter symbol yields the getter's RETURN type,
// so a getter `return` would be laid out as a plain data field (e.g. f64) — but
// the literal is built as an externref $Object by compileObjectLiteralWithAccessors
// (literals.ts:411). The two representations collide (gc: reads back null;
// standalone: illegal cast). Skip registration → the type lowers to externref
// everywhere (resolveWasmType :11384 falls through to mapTsTypeToWasm), and the
// existing $Object accessor read path (__extern_get → __call_accessor_get) services
// it. SCOPED to object-LITERAL accessors only (declaration parent is an
// ObjectLiteralExpression): a CLASS getter's declaration parent is a
// ClassDeclaration and MUST keep the struct + getter-method representation.
for (const prop of props) {
  if ((prop.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) === 0) continue;
  const isObjLitAccessor = (prop.declarations ?? []).some(
    (d) =>
      (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) &&
      d.parent != null &&
      ts.isObjectLiteralExpression(d.parent),
  );
  if (isObjLitAccessor) return; // leave externref; do not register a struct
}
```

Notes:
- The early `return` leaves `tsType` in `ctx.ensureStructPending` (added at
  `:11535`). This matches the existing early-returns at `:11540`/`:11543`
  (idempotent "already processed, skip"). Harmless — `ensureStructPending` is
  per-`compile()`.
- The `SymbolFlags.GetAccessor | SymbolFlags.SetAccessor` test plus the
  declaration-parent check is the precise, verified discriminator (probe
  `.tmp/probe-sym.mjs`): a class accessor's parent is `ClassDeclaration`, an
  interface accessor's is `InterfaceDeclaration` — only `ObjectLiteralExpression`
  fires the guard.

**Floor risk (Slice 1): MEDIUM.** This changes the *type representation* of
accessor-bearing object literals globally (gc + standalone), so it must be
validated on the **`merge_group` standalone shard (#2097)** before enqueue, not
just the gc equiv suite. Two specific risks to check:
1. A standalone program that currently builds such a literal as a closed struct
   AND happens to read a *default/garbage* value back without trapping (would
   "regress" from a wrong-but-non-trapping value to externref). This is
   semantically impossible to be a *correct* prior pass (the getter never ran),
   but the floor counts raw pass/fail, so confirm the standalone delta is ≥ 0.
2. Structural-dedup interaction (`fieldsHashKey`, `:11637`): an accessor type
   never reaches the hash now, so a data-shaped sibling literal of identical
   field names keeps its own struct. Confirm no dedup collision (there can't be
   — different property sets).

**Validation for Slice 1:**
- `npx tsx .tmp/probe-forof.mjs` → `forofAccessor/gc` must print `OK -> 1`.
- `npx vitest run tests/accessor-side-effects.test.ts tests/issue-1239.test.ts
  tests/issue-1888.test.ts` → no NEW failures vs. the unpatched baseline
  (`tests/issue-1888.test.ts` "passes boxed any arguments…" and
  `tests/getters-setters.test.ts` are **already red on main** — harness
  artifacts, ignore them; diff against baseline).
- Add a focused vitest `tests/issue-2724-objlit-accessor-return.test.ts`
  covering: (a) accessor literal returned from a function, getter fires on read;
  (b) for-of IteratorClose with `get return()` throwing → throw propagates;
  (c) mixed data+accessor literal returned from a function; (d) class getter
  control (struct preserved).
- **Must pass the `merge_group` standalone shard** (broad-impact change ⇒
  full-CI / merge_group validation, never a scoped sweep — `project_broad_impact_validate_full_ci`).

### Slice 2 — extend the externref-tag propagation (optional hardening, separable)

Slice 1 fixes the **type-resolution** collision, which is the load-bearing fix.
Slice 2 (only if a residual edge surfaces in CI) tightens the value-side tag so
member reads off an accessor-literal-typed **return value / parameter** (not just
a directly-assigned variable) take the externref read path deterministically:

**File: `src/codegen/property-access.ts`** (`:983`, `:1026`) — the
`externrefAccessorVars` name-set gates the externref member-read path for
*identifiers* only. After Slice 1 the binding type is already externref, so
`compilePropertyAccess` should resolve the receiver as externref via type, not
name. Verify this holds for: `makeIter().return`, `arr[0].return` where the
element type is the accessor literal, and a parameter typed as the accessor
shape. If any still routes to a struct.get, generalize the externref decision in
`resolveStructNameForExpr` to consult the receiver's *resolved Wasm type*
(externref ⇒ dynamic path), not only `externrefAccessorVars`.

**Floor risk (Slice 2): LOW** (read-path only, gc + standalone symmetric). Gate
behind the same merge_group standalone validation. **Skip this slice entirely if
Slice 1 + the test basket are green** — do not speculatively broaden.

### Explicitly OUT of scope (separate slices / issues)

- **Standalone for-of over a dynamically-assigned `[Symbol.iterator]`**
  (`forofData/standalone` → illegal cast on unpatched main). Pre-existing,
  data-path, NOT accessor-related. Track as a distinct #2580 slice. Do not
  attempt here — it would bloat the change and risk the floor.
- Building a *new* accessor-driver model. It already exists
  (`accessor-driver.ts`, `__defineProperty_accessor`). Do not duplicate.
- Computed-accessor keys whose key is a runtime expression. Already routed to
  the host plain-object path (`_hasRuntimeComputedKey`, `literals.ts:876`); the
  Slice 1 guard is orthogonal (it gates struct *type* registration, which never
  fires for those anyway since the literal value path is already externref).

### Edge cases (must be covered by the new test)

- **Mixed data + accessor literal** returned from a function:
  `{ a: 1, get b() {…} }` — the whole type must lower to externref (the guard
  fires on `b`), and `a` reads back via `__extern_get` (not struct.get).
- **Getter-only** (`get x(){}`) and **setter-only** (`set x(v){}`) — both
  `SymbolFlags` covered; setter-only still skips struct registration.
- **Computed accessor key** that folds to a compile-time string
  (`get [K]() {}` where `K` is `"foo"`): `resolveAccessorPropName`
  already resolves it in the literal path; at the type layer the symbol still
  carries a `GetAccessor` declaration with `ObjectLiteralExpression` parent, so
  the guard fires correctly.
- **Accessor on the any/dynamic-receiver path**: `const o: any = {get x(){}}`
  already worked pre-fix (literal directly assigned ⇒ externref via
  `externrefAccessorVars`); confirm Slice 1 leaves it byte-identical.
- **Class getter/setter** (`class C { get v(){} }`): declaration parent is
  `ClassDeclaration` ⇒ guard does NOT fire ⇒ struct + getter-method preserved.
  Verified: `classGetter` probe returns `14` in gc AND standalone.
- **Interaction with the #2580 `$Object` reader**: an accessor literal now flows
  as a `$Object`, so `__extern_get`'s accessor arm
  (`$PropEntry.$get` → `__call_accessor_get` → `__call_fn_method_0`) services
  the read — the same path direct `o.x` already exercises. No new reader needed.

### Test files to verify (test262, gc/host)

- `test/language/statements/for-of/iterator-close-non-throw-get-method-abrupt.js`
  (getter throws while closing a non-throw completion → must propagate)
- `test/language/statements/for-of/iterator-close-non-throw-get-method-is-null.js`
  (getter returns null → IteratorClose skips return, no throw)
- `test/language/statements/for-of/iterator-close-throw-get-method-abrupt.js`
  (getter throws while closing a throw completion → original throw wins)
- Controls already passing (keep green): `…-get-method-non-callable.js` (×2),
  `iterator-close-via-break/-return/-throw/-continue.js`.

### Grounding provenance

All file:line references and probe results grounded against `origin/main @
30bc55b2fa01` (2026-06-26). Probe scripts used (in `.tmp/`, gitignored):
`probe-acc.mjs` (dispatch works), `probe-wat.mjs` (struct field type smoking
gun), `probe-forof.mjs` (end-to-end for-of failure + the one-guard fix
confirmation), `probe-class.mjs` (class control), `probe-sym.mjs` (accessor
symbol detectability). The Slice-1 guard was applied experimentally and
confirmed: `forofAccessor/gc` flipped `null-throw → 1`, classes preserved
(`14/14`), zero regressions in the object-literal/accessor basket.
