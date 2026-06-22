---
id: 2606
title: "Standalone Set: null/undefined element coercion + subclass-of-Set late-import desync (compile errors)"
status: ready
sprint: 65
created: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: collections
language_feature: Set
goal: standalone-mode
parent: 2162
---

# #2606 — Standalone Set: null-element coercion + subclass late-import compile errors

Two distinct **compile-error / invalid-Wasm** bugs (not value-semantics, not
substrate) surfaced by the host-vs-standalone diff on main `6d76f5b2d`. Both are
clean compiler bugs — highest-confidence rows in #2162's residual.

## Bug A — `s.add(null)` / `s.has(null)` / `s.has(undefined)` invalid Wasm (~7 rows)

### Symptom
```
WebAssembly.instantiate(): Compiling function #44:"test" failed:
any.convert_extern[0] expected type externref, found ref.null of type (ref …)
```
from e.g.
```js
var s = new Set(); s.add(null); assert.sameValue(s.has(null), true);
```

### Root cause
`coerceArgToAnyref` (`src/codegen/map-runtime.ts` ~1163, used by
`coerceSetArgToAnyref`/`coerceMapKeyToAnyref`) handles `t === null` (absent arg)
and `f64`/`i32`/`externref`, but its `default` arm assumes any other ValType is
"already an anyref subtype — no conversion". When the element literal is `null`
or `undefined`, `compileExpression` emits a **typed** `ref.null` (e.g.
`ref null $struct` / a concrete bottom that is NOT externref), and the entry
store / `__map_*` helper param expects externref/anyref → the `any.convert_extern`
in the boxing chain (or the helper call) fails to validate.

### Fix
**File: src/codegen/map-runtime.ts**, `coerceArgToAnyref`:
- Add explicit arms for `t.kind === "ref_null"` and the null/undefined literal
  case: emit a canonical `ref.null NONE_HEAP` (the `none` bottom, already used at
  line ~1167 for the absent case) so the value is a uniform anyref-subtype null
  matching the runtime's ABSENT/`undefined` sentinel — the SAME representation
  `__map_set`/`__map_has` already compare with for stored null entries (see the
  `ref.null NONE_HEAP` stores at lines 657/912/919/1120).
- Verify SameValueZero null/undefined equality already works once the
  representation is uniform (the map runtime compares entries by the boxed-any
  path; a `none`-null vs a `none`-null is `ref.eq`-equal).

### Wasm IR pattern
```wasm
;; s.add(null) — element literal is null
ref.null none            ;; NONE_HEAP, an anyref subtype == runtime ABSENT
call $__set_add
;; s.has(null) — same null representation flows to __map_has's SameValueZero
```

### Failing test262 paths
- `test/built-ins/Set/prototype/has/returns-{true-when-value-present,false-when-value-not-present,false-when-undefined-added-deleted-not-present}-{null,undefined}.js`
- (and the Map equivalents if any surface — same helper)

## Bug B — `class X extends Set` → `MySet_size` global index `-1` (~7 rows)

### Symptom
```
L2:1 Binary emit error: Codegen error: global index out of range — -1
(valid: [0, 10)) at function 'MySet_size'. This is the late-import ind[ex shift]
```
from
```js
class MySet extends Set { size(...rest){ return super.size(...rest); } … }
const s1 = new MySet([1,2]); s1.isSubsetOf(new Set([2,3]));
```

### Root cause
A user class extending native `Set` (which resolves to the `$Map` backing
struct, not a real class) generates synthetic accessor functions (`MySet_size`
etc.) whose global/late-import indices are baked, then a subsequent late import
shifts the table but the synthetic-function index is NOT shifted in lockstep —
the same late-import-shift class as the #2043 / `mapHelpers`-shift family already
fixed in #2162's "WeakMap/WeakSet stale-`mapHelpers`-index" slice. The `-1`
global index is the tell: an unresolved/un-shifted reference.

### Fix
**File: src/codegen/index.ts** (and/or the class-emit path for
`extends Set`/`extends Map`)
- Identify where the `extends Set` subclass synthesizes `MySet_size`/`_has`/
  `_keys` and why its global/funcidx resolves to `-1`. Most likely the class
  inherits the native-collection backing but the subclass-accessor registration
  runs BEFORE `ctx.mapHelpers`/`ctx.mapTypeIdx` are finalized, or the
  late-import shift sites (the three `addUnionImports`/`shiftLateImportIndices`
  sites that #2162 already patched for `mapHelpers`) don't cover the subclass
  accessor table.
- Apply the SAME lockstep-shift discipline #2162 used for `mapHelpers`
  (see the "WeakMap/WeakSet stale-`mapHelpers`-index fix" slice in
  `plan/issues/2162-*.md`): add the subclass-of-collection accessor indices to
  every shift site, or defer their registration until after the collection
  runtime + box helpers are registered.
- If the subclass-of-Set machinery is too entangled to fix cleanly, the
  fallback is to make `extends Set`/`extends Map` a clean CE (not an invalid-
  Wasm emit) so it at least doesn't poison the binary — but prefer the real fix.

### Failing test262 paths
- `test/built-ins/Set/prototype/{isSubsetOf,isSupersetOf,isDisjointFrom,difference,intersection}/subclass-receiver-methods.js`

## Estimated rows
~14 total (A ~7, B ~7). Both are compiler-bug fixes, substrate-independent.

## Notes / dispatch
- Bug A: `src/codegen/map-runtime.ts` — shared with #2604/#2607 (all touch
  map-runtime/set-runtime). Bug A is a small localized edit to `coerceArgToAnyref`;
  low conflict risk.
- Bug B: `src/codegen/index.ts` late-import-shift — coordinate with any other
  in-flight index-shift work. This is the higher-risk half; could be split out if
  the subclass machinery proves deep.
- Both gated on `ctx.nativeStrings`; host/gc unchanged.
- Independent of #2580 (no dynamic property reads).
