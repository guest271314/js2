---
id: 2402
title: "Object.prototype.toString [object X] builtin tag — Array/Function/Date missing (host) + standalone CE (~151 test262)"
status: ready
assignee: ttraenkler/sd3
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: object-builtins
goal: spec-completeness
test262_bucket: object-tostring-tag
test262_count: 151
---

# #2402 — `Object.prototype.toString` `[object X]` builtin tag

## Problem (§20.1.3.6)

`Object.prototype.toString.call(v)` must return `[object X]` where X is the
spec builtin tag. Current state (verified, sd3 2026-06-19):

| receiver | spec | current host | current standalone |
|---|---|---|---|
| `{}` | `[object Object]` | ✅ `[object Object]` | ❌ compile error |
| `[]` | `[object Array]` | ❌ `[object Object]` | ❌ CE |
| `function(){}` | `[object Function]` | ❌ `[object Object]` | ❌ CE |
| `new Date()` | `[object Date]` | ❌ `[object Object]` | ❌ CE |
| `42` | `[object Number]` | ✅ | ❌ CE |
| `"s"` | `[object String]` | ✅ | ❌ CE |
| `true` | `[object Boolean]` | ✅ | ❌ CE |
| `/x/` | `[object RegExp]` | ✅ | ❌ CE |
| `null` | `[object Null]` | ✅ | ❌ CE |
| `undefined` | `[object Undefined]` | ✅ | ❌ CE |

So host mode is **partial** (Array/Function/Date wrong → `[object Object]`), and
**standalone hard-errors** on the whole `Object.prototype.toString.call(...)`
form (~151 test262 fails, the jsonl `Object_toString` cluster).

## Two parts

### Part A — host-mode missing tags (smaller)
The `Object.prototype.toString.call` tag dispatch is at
`src/codegen/expressions/calls.ts` ~8430-8458: it has an `isArray`/`isFunc`
branch but `isArray` (`resolveArrayInfo`) doesn't fire for the `.call(arr)`
receiver path, and Date isn't checked. The Number/Boolean/String/RegExp/Null/
Undefined tags come from a different (working) path — confirm which, then add
the **Array / Function / Date** arms to the SAME classifier so they return
`[object Array]` / `[object Function]` / `[object Date]`. (Function arm exists
above but returns the source-text toString, not the tag — the `.call`-as-Object-
toString case must take the tag branch, not the function-source branch.)

### Part B — standalone native classifier (larger)
The whole `Object.prototype.toString.call(...)` is a `reportError` compile-error
under `--target standalone` (no host `Object_toString`). Emit a native §20.1.3.6
classifier: a static type-check switch on the receiver's TS/Wasm type producing
the right `[object X]` string constant (the per-builtin tag is statically known
in nearly all test262 cases — `compile away`). Order per §20.1.3.6:
undefined → `Undefined`; null → `Null`; isArray → `Array`; callable →
`Function`; Error → `Error`; Boolean/Number/String wrapper → that tag; Date →
`Date`; RegExp → `RegExp`; arguments exotic → `Arguments`; else `Object`.

**Defer Symbol.toStringTag (phase 2):** §20.1.3.6 step 15 reads
`@@toStringTag` off the receiver, which needs dynamic property lookup — route to
the dynamic-property epic, not this issue. Banks most of the 151 without it.

## Acceptance criteria

- Host + standalone: `Object.prototype.toString.call(v)` returns the right
  `[object X]` for Object/Array/Function/Number/String/Boolean/Date/RegExp/Null/
  Undefined.
- Standalone: no `env.Object_toString` leak / no compile error for the
  `.call(...)` form.
- No regression in the already-correct host tags.

## Source

#2376/#2379 jsonl sweep, sd3 2026-06-19. Routed by tech-lead from the
[object X]-tag cluster (~151, the 2nd-largest bounded standalone-feature group).
Scoped (parts A/B identified) but NOT implemented this session.
