---
id: 3045
title: "class private-element brand check emits Reflect.has on a non-object receiver (private methods/generators/static-private)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: class-private-methods
es_edition: 6
goal: spec-completeness
parent: 3022
related: [3022]
---

# #3045 — class private brand-check `Reflect.has` on non-object

Split from the #3022 umbrella (the "called on non-object" cluster — the
`Reflect.has called on non-object` sub-group). **Developer-scoped.**

## Root cause

The private-element **brand check** (used for private methods/accessors — the
`#m in obj` membership test and the implicit brand check on private-method
access) lowers to an internal `Reflect.has(receiver, key)`. In the private-
method / private-generator / static-private paths the `receiver` reaching that
`Reflect.has` is a **non-object** in our representation (undefined / an unboxed
value), so the runtime helper throws `Reflect.has called on non-object` instead
of performing the brand check. `built-ins`/`language` class tests that install
private *methods* (not just fields) hit this.

## Failing files (8)

`prod-private-async-method.js`, `prod-private-async-generator.js`,
`prod-private-method.js`, `prod-private-method-initialize-order.js`,
`fields-multiple-definitions-static-private-methods-proxy.js`,
`prod-private-generator.js`,
`static-private-methods-proxy-default-handler-throws.js`,
`static-private-fields-proxy-default-handler-throws.js`.

## Layer to fix

`src/codegen` private-element brand-check lowering — ensure the receiver is the
boxed object (or emit the brand check without routing through
`Reflect.has` on a non-object). Check how private *methods* differ from private
*fields* (fields work; methods don't) in the brand-check emit path.

## Acceptance

- The listed private-method/generator class tests pass; no regression in
  private-field tests. Scope: **DEV**.
