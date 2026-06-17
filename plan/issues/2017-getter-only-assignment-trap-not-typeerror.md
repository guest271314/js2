---
id: 2017
title: "assignment to a getter-only object-literal property traps 'illegal cast' instead of throwing strict-mode TypeError"
status: done
completed: 2026-06-17
assignee: sd-b
sprint: 63
created: 2026-06-10
updated: 2026-06-17
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [1092, 1932, 2024]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2017 — [[Set]] failure check missing on accessor-literal write path

## Problem

```ts
const o: any = { get x() { return 1; } };
o.x = 99;
// wasm: RuntimeError: illegal cast (uncatchable)
// node: TypeError: Cannot set property x ... which has only a getter
```

## Root cause

The accessor-literal path (`src/codegen/literals.ts:258+`) defines real
host accessors, but the compiled assignment path casts/writes without the
strict-mode [[Set]] failure check (§13.15.2 → §10.1.9). Same family as
#1092 (wrong error type, done) and the class-side #2024.

## Fix direction

When the static property model says get-only, emit a throw of TypeError
instead of the struct write.

## Acceptance criteria

- Repro throws catchable TypeError; getter+setter pairs unchanged

## Dupe check

#1092 done; #1932 is accessor double-get (different). New (borderline
low/wont-fix severity — filed for completeness).

## Implementation notes (#2017, sd-b, 2026-06-17) ✓

On current main the write no longer traps "illegal cast" — it silently no-ops
(the getter keeps shadowing), so `o.x = 99; o.x` read `1` instead of throwing.
Spec (ESM is strict) requires a catchable TypeError (§13.15.2 → §10.1.9).

**Fix — the `__extern_set_strict` split (keystone).** Added a strict [[Set]]
host import that mirrors `__extern_set` but throws a CATCHABLE TypeError on the
three §10.1.9 failure cases instead of silently failing:
- getter-only accessor (real JS descriptor with `get`/no `set`, OR sidecar
  `__get_<k>` with no `__set_<k>`, OR symbol-keyed accessor-map entry);
- non-writable own data property;
- new property on a non-extensible object.

`_safeSet` gained a `strict` param; the failure sites that previously `return`ed
silently now `throw` when `strict`. For plain JS objects an explicit descriptor
pre-check (own → prototype walk) makes the throw deterministic regardless of the
bundled runtime's ambient strictness. The throw is catchable in the user's
try/catch via the existing host-import exception bridge (`lastCaughtException` +
the compiled `catch_all`).

The new import carries its own intent type (`extern_set_strict`) so the
intent-driven `resolveImport` switch routes it to the strict handler rather than
sharing `__extern_set`'s sloppy case. Codegen routes only the
accessor-detected property-assignment path
(`compilePropertyAssignmentExternSet`) to it — the path reached precisely when
an accessor descriptor was detected for the property at compile time — so
writable data properties and getter+setter pairs are unaffected. Standalone
aliases `__extern_set_strict` to the native `__extern_set` helper (no host
TypeError bridge there yet; the getter-only throw is host-mode for now).

**Files:** `src/runtime.ts` (`_safeSet` strict param + throws, by-name +
intent-switch `__extern_set_strict` handlers), `src/index.ts` (ImportIntent
union), `src/compiler/import-manifest.ts` (classify → `extern_set_strict`),
`src/codegen/object-runtime.ts` (standalone alias + helper-name set),
`src/codegen/expressions/assignment.ts` (route accessor write to strict).

**Tests:** `tests/issue-2017.test.ts` — getter-only write throws (catchable,
`instanceof TypeError`), getter survives the rejected write, getter+setter pair
still routes to the setter. Regression-checked getters-setters /
accessor-side-effects / define-property-patterns (the 3 accessor-side-effects
failures are pre-existing on main — bare host-bridge harness, unrelated).

**Family:** #1092 (wrong error type, done), #2024 (class-side get-only, done),
#1456 (private get-only, done) — this completes the object-literal side.
