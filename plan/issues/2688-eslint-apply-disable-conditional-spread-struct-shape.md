---
id: 2688
title: "ESLint apply-disable-directives.js: conditional-spread produces two struct shapes for array.set element type"
status: ready
created: 2026-06-26
priority: medium
area: codegen
goal: npm-library-support
feasibility: hard
related: [1573]
---
# ESLint apply-disable-directives.js — conditional-spread struct-shape mismatch

Carved from the de-staled #1573 ESLint survey (bug B). One of the residual
validation blockers after #1573 bug A (`inferLastType` branch-arm fix) landed.

## Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = await compileProject(
  "/workspace/node_modules/eslint/lib/linter/apply-disable-directives.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                      // passes
expect(WebAssembly.validate(r.binary)).toBe(true); // FAILS
```

## Error (current main, eslint 10.0.3)
```
function #128 "applyDirectives":
  array.set[2] expected type (ref null 107), found call_ref of type (ref null 118)
```

## Root cause (hypothesis)
`applyDirectives` maps over `processed` with a callback returning an object
literal that contains a **conditional spread**:
```js
return {
  ruleId: null, message, line, column, severity,
  ...(options.disableFixes ? {} : { fix }),
};
```
The conditional spread yields **two distinct struct shapes** (one with `fix`,
one without). The result array's element type was inferred as one shape
(struct 107) but the `.map` callback's `call_ref` returns the other (struct
118). Conditional-spread struct-shape unification is missing.

## Fix direction
Either (1) treat the conditional-spread literal as a single struct shape with
`fix` as a nullable/optional field, or (2) widen the result array's element
type to a common-supertype struct covering both branches. Shape inference in
`src/shape-inference.ts` + the `Array#map` element-type computation in
`src/codegen/array-methods.ts` / object-literal lowering in
`src/codegen/literals.ts`.

## Bug class
CODEGEN — struct-shape unification at object-literal level (conditional
spread). Pure JS object-literal feature, not async/generators/Proxy.

## Verify-first findings (sd-2668c, 2026-06-26) — original hypothesis is wrong; root cause is a map-builder element-type bug

Diagnosed by parsing the FINAL binary type section (wabt is too old for GC
types; `.tmp/typeparse.mjs`-style LEB128 walk). Hard evidence:

- The failing `array.set` in `applyDirectives` (#128) is on **array type 108 =
  `array(mut (ref null 107))`**, with `call_ref` returning **struct #118 =
  `struct(externref, externref)`** (2 fields). Element struct **#107 =
  `struct(externref, (ref null 106), externref)`** (3 fields; 106 =
  `struct((ref null 2), externref)`, 2 = `struct(i32, (ref null 1))`).
- **107 and 118 are structurally DIFFERENT (3 fields vs 2 fields)** — NOT two
  copies of one shape, and NOT the conditional-spread `$__anon_24` shape (the
  only `$severity` struct; that one DID unify to a single 6-field struct, so
  the issue's "conditional spread yields two shapes" hypothesis is **wrong** for
  this failure).
- The failing op is a **closure-map** (`call_ref` per element): the
  `disableDirectivesForProblem.map(directive => ({ kind, justification }))`
  (line 346). Its receiver element type is the **`Directive` struct (107,
  3-field)**; its callback correctly returns the 2-field `{kind,justification}`
  (118). The result array was typed with the **RECEIVER's** element struct (107)
  instead of the **callback's return** struct (118) → `array.set` mismatch.

### Per-axis verdict (coordinator's 3 axes)

- **(a) Canonicalize structurally-identical structs** — would NOT fix this. 107
  (3-field) and 118 (2-field) are different shapes, not duplicates. (There IS a
  separate dedup-miss — the 2-field `{externref,externref}` shape exists as 9
  struct types [34,47,49,54,91,103,105,113,118] because the existing anon-struct
  dedup keys on field NAMES, and #2009 `resolveSameShapeFieldNameCollisions`
  *intentionally* keeps same-type/different-name structs distinct via a `$shape`
  stamp — but merging those would not make a 3-field array accept a 2-field
  value.)
- **(b) object-literal single source of truth** — not the locus; the object
  literal (118) is correct. The array TYPE is wrong.
- **(c) map elem-type from the EMITTED struct** — `compileArrayMap`
  (`array-methods.ts:6529`) ALREADY does this correctly (instrumented: its
  `mapResultElemType` always equals `setup.closureInfo.returnType`). **But the
  failing map does NOT go through `compileArrayMap`** — the `case "map"` dispatch
  (`~3097`) only routes f64/i32/externref receivers; a **ref/ref_null
  struct-element receiver** (`Directive[]`) falls through to a generic /
  make_callback-closure array-builder (WAT signature: `global.set` arg-ABI +
  `call_ref 122`) that types the result with the receiver element type.

### Two fix attempts tried + REVERTED (both no-ops for this bug)

1. typeIdx-aware (`valTypesMatch`) reconciliation in `compileArrayMap` — no-op
   (the `.kind` check already fired; reconciliation was already correct).
2. Widening the `case "map"` gate to include ref/ref_null (mirroring #1967
   `sort`) — changed the binary but did NOT fix it: the suppressions map still
   didn't reach `compileArrayMap` (its receiver isn't a resolvable typed vec /
   takes the generic path), so the generic/make_callback builder still mistyped.

### Verdict: BROAD — needs architect spec

The fix must make the **generic / make_callback-closure array-builder** (the
struct-element-receiver `.map` path, and likely `concat`/spread on
heterogeneous-shape arrays) derive the result element type from the **callback
return / a common supertype**, not the receiver element type. This is
multi-path codegen infra touching the WasmGC type-index space (respect
`project_type_index_shift_and_deadelim` / `reference_shared_instr_object_dce_double_remap`).
Escalated for an architect spec rather than a risky partial fix on remaining
budget. The bounded sub-piece (route struct-element `.map` through
`compileArrayMap` AND make that path reachable for non-typed-vec receivers) is
the most promising starting point for the spec.
