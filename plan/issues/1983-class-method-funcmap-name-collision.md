---
id: 1983
title: "synthetic class-method names collide with user functions: class A { m() {} } + function A_m() breaks both paths"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compilable
related: [1370]
origin: "2026-06-10 deep-audit sweep (IR agent, secondary observation): verified on main @ 0c753ea88, both paths"
---

# #1983 — `${ClassName}_${method}` funcMap keying is not collision-free

## Problem

A class method `A.m` is registered under the synthetic name `A_m`; a
user-defined top-level `function A_m()` collides with it. Legacy: runtime
null-ref trap; IR: module-wide CompileError (`argument type mismatch in
call`). Node: works (`12`).

```ts
class A { m(): number { return 10; } }
function A_m(): number { return 2; }
export function test(): number { return new A().m() + A_m(); }
```

## Root cause (area)

funcMap keys use the `${ClassName}_${method}` convention
(`src/codegen/class-bodies.ts`, #1370 keying) with no mangling/uniquing
against user identifiers.

## Fix direction

Use a non-collidable separator in synthetic names (e.g. `A#m` or a reserved
prefix that is not a valid TS identifier), or unique-ify on collision at
registration time. Audit other synthetic name factories (getters/setters,
statics, closure wrappers) for the same convention.

## Acceptance criteria

- Repro returns `12` on both paths
- Mangled names don't leak into exports/WIT
- Other `_`-joined synthetic name sites audited

## Dupe check

#1370 (class-method IR adoption — keying origin). No collision issue on file.


## Root-cause confirmation + scope (2026-06-15, sdev5)

Repro confirmed on main (`39a63edf0`): `class A { m(){return 10} }` +
`function A_m(){return 2}` → both compile to a wasm func literally NAMED `A_m`
(WAT shows two `(func $A_m …)` — wasm permits duplicate names). The defect is in
the **funcMap key**, not the emitted name: both register under the key `A_m`, so
`funcMap.get("A_m")` returns whichever registered LAST, and the other call site
(`new A().m()` vs `A_m()`) baked the wrong funcIdx → null-ref trap (legacy) /
arg-type CompileError (IR). Getter variant (`B.get v` vs `function B_get_v`) and
ctor (`A_new`) collide the same way.

**Why this is bigger than "medium" / NOT a clean isolated PR right now:**

- The `${className}_${method}` key convention is computed at **~103 call sites
  across ~20 files** (grep `\${[A-Za-z]*[Nn]ame}_\${`): both the *producer*
  (class-bodies.ts registration) and every *consumer* (property-access.ts,
  calls.ts, closures.ts, accessor-driver.ts, struct-accessor-closure.ts,
  object-ops.ts, fixups.ts, …) independently recompute the same string. A
  collision-free key (e.g. a separator invalid in TS identifiers, or
  uniquify-on-collision with a redirect map) must be threaded through ALL of
  them consistently, or producer/consumer disagree and EVERY class method call
  breaks.
- **Active-lane conflict:** sdev3's #2158 (standalone class/prototype/descriptor
  residual, in_progress) is editing `class-bodies.ts` — the producer file. A
  103-site naming refactor landed underneath an in-flight #2158 PR is a
  guaranteed merge conflict and a destabilization risk to the larger class work.

**Recommended approach (for whoever takes it, AFTER #2158 lands):**

Introduce one helper `classSyntheticKey(className, kind, name)` (kind =
`method`/`get`/`set`/`new`/`init`/`static`) returning a key with a
**reserved-prefix or invalid-identifier separator** (e.g. `\x00C\x00m` or
`#cls#A#m`) that can never collide with a user identifier, and route BOTH the
class-bodies producers and all consumers through it. Audit the emitted-name vs
funcMap-key split: keep a readable emitted wasm name (debugging) but key funcMap
by the mangled key. Acceptance: repro returns 12, getter variant 8, no mangled
key leaks to exports/WIT. This is a focused 1-day refactor once the file is
quiescent — should be **sequenced after sdev3's #2158**, not landed concurrently.

Releasing the task back to the queue with this scope note (verified, not
abandoned) so the lead can sequence it after #2158. Repro file:
tests-style cases above all reproduce on main.
