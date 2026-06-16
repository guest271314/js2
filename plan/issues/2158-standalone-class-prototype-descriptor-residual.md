---
id: 2158
title: "Standalone class/prototype/private-name/descriptor conformance residual (~1,388 tests)"
status: in-progress
assignee: ttraenkler/sd1
sprint: 63
created: 2026-06-15
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: classes
goal: standalone-mode
parent: 1591
depends_on: [2101, 1965]
---

# Standalone class/prototype/descriptor conformance residual

## Problem

Class elements, private fields, brand checks, and descriptor fidelity landed
in #1591, #1365, #1364 (all `done`, sprints 51–61). The host-vs-standalone
baseline diff (sha `31fa7e099`, 2026-06-15) shows **1,388 tests pass in host
mode but fail standalone**, attributed to the class/prototype/private-name/
descriptor object model — the second-largest catch-up bucket.

## Evidence

- Concentrated in `built-ins/Object` (compile-error heavy) and class
  language tests; `dynamic_object_property` leaks plus `(none)`-leak compile
  errors in the object model.
- Implementation should consume the #2101 class object-model architecture
  spec and the #1965 base-constructor execution fix.

## Acceptance criteria

- Standalone pass count for `built-ins/Object` + class language tests rises
  toward host parity.
- Descriptor/private-name/brand-check semantics match host mode standalone.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1591. Implements against spec #2101; depends on #1965.
Part of sprint-62 standalone catch-up (rank 2 by gap impact).

## Implementation notes — slice 1 (2026-06-16, sd1)

This 1,388-test gap is a multi-PR epic (spec #2101 phases P0–P4). This slice
lands the two highest-leverage, host-free defects, both diagnosed by WAT-tracing
`--target standalone` repros. The remaining standalone reflection readers
(`Object.getOwnPropertyNames`/`getOwnPropertyDescriptor`/`Object.keys` on class
objects — still hard-errors `#1472 Phase B` in standalone) and `new.target`
(#2023, P2) / dynamic `new K()` (#2026, P3) stay open for follow-up slices.

### Defect 1 — `.constructor` identity returns false in standalone (spec #2101 P1)

`new A().constructor` lowered to `ref.func ${A}_constructor` + `extern.convert_any`
(`property-access.ts` instance `.constructor` arm) — a funcref-as-externref.
But the class identifier `A` resolves to the `__class_<Name>` singleton struct
(`emitLazyClassObjectGet`, via identifiers.ts). So `new A().constructor === A`
compared two different externrefs → always false. **Fix:** route instance
`.constructor` through the SAME `emitLazyClassObjectGet(typeName)` singleton, so
both sides of the `===` are reference-identical. Host-free, so it fixes the
identity in standalone AND host mode. Falls back to the constructor funcref only
when no class-object global exists (externref-backed builtin subclasses).

### Defect 2 — empty-subclass `===` / `typeof` crash with `illegal cast` (#2009)

WAT-traced root cause: an EMPTY class root struct is exactly
`(struct (field $__tag i32))`. The native-string supertype `$AnyString` is also
a single-i32-field OPEN struct (`(struct (field $len i32))`). When the empty
class is a hierarchy ROOT (it has subclasses → left non-final/open), WasmGC
**iso-recursive canonicalization** (#2009's disease) merges the open class root
with `$AnyString`; its `final` subclasses then become subtypes of `$AnyString`,
so `ref.test $AnyString` on a subclass instance / class-object returns TRUE.
That false positive drove the standalone `===` and `typeof === "string"` arms
into `ref.cast $AnyString` + `__str_flatten` on a non-string struct →
`RuntimeError: illegal cast`. This broke EVERY strict-equality and string-typeof
over a subclass value in standalone (`B === B`, `new B() === x`,
`B.prototype === p`, `typeof new B()`), a large slice of the gap. Lone empty
classes escape it because `markLeafStructsFinal` makes them `final` (a final
struct is not subtype-compatible with the non-final `$AnyString`).

**Fix:** append a hidden immutable sentinel field (`__shape_brand` i32) to a
class root struct whose only field would be `$__tag`, making it
`(struct (field i32) (field i32))` — structurally distinct from the single-field
`$AnyString`, breaking the canonical merge. Appended LAST so existing positional
`fieldIdx` for real instance fields is unaffected; constructors and the lazy
proto/class-object inits iterate the field list and default it automatically.
Cost: +4 bytes only on empty-class instances (rare). Classes with ≥1 instance
field are already structurally distinct and get no sentinel. This is the
#2009-family canonicalization-collision fix applied to the class-vs-string
boundary (distinct from #2009's anon-object-literal `$shape` work).

Files: `src/codegen/property-access.ts` (instance `.constructor` → class-object
singleton), `src/codegen/class-bodies.ts` (empty-root sentinel field). Test:
`tests/issue-2158-class-identity-standalone.test.ts` (15 cases — constructor
identity, empty-subclass identity/typeof, plus regression coverage for method
dispatch, super()-inherited fields, getPrototypeOf, instanceof, string equality).
tsc clean; standalone suite green.
