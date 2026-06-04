---
id: 1831
title: "_validatePropertyDescriptor resets omitted attributes to false on redefine (residual #1334)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 59
parent: 1334
---
# #1831 — partial redefine clears previously-set descriptor flags

Residual of #1334 (marked done, sprint 50).

## Symptom
After `o.k` is enumerable/writable, `Object.defineProperty(o,"k",{value:5})` clears
`enumerable`/`writable`/`configurable` instead of preserving the absent fields.

## Location
`src/runtime.ts:1262-1272`: `newFlags` built from truthiness of each
`desc.writable/enumerable/configurable` (omitted ⇒ 0); when `existing` is
configurable, `:1272` returns `newFlags` directly.

## Spec
ECMAScript §10.1.6.3 ValidateAndApplyPropertyDescriptor — absent fields are kept.
Scope: the WasmGC-struct sidecar fallback.

## Fix
When `existing !== undefined`, start from `existing` and only overwrite flags whose
descriptor field is explicitly present (`desc.writable !== undefined`, etc.).

